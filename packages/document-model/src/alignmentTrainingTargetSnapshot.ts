import { z } from "zod";
import { buildAlignmentTextProjection } from "./alignmentTextProjection.js";
import type { ProjectData } from "./projectData.js";

export const ALIGNMENT_TRAINING_TARGET_FORMAT = "xiqu-alignment-training-target";
export const ALIGNMENT_TRAINING_TARGET_VERSION = 1;
export const ALIGNMENT_TRAINING_TARGET_MAX_SENTENCES_PER_ITEM = 100_000;
export const ALIGNMENT_TRAINING_TARGET_MAX_CHARACTERS_PER_ITEM = 100_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_ENTITY_ID_LENGTH = 200;

export type AlignmentTrainingTargetSnapshot = {
  format: typeof ALIGNMENT_TRAINING_TARGET_FORMAT;
  version: typeof ALIGNMENT_TRAINING_TARGET_VERSION;
  inputTextFingerprint: string;
  sentenceCount: number;
  characterCount: number;
  sentences: Array<{
    sentenceId: string;
    startMicros: number;
    endMicros: number;
    characters: Array<{
      characterId: string;
      startMicros: number;
      endMicros: number;
    }>;
  }>;
};

export type AlignmentTrainingTargetSnapshotResult =
  | { ok: true; snapshot: AlignmentTrainingTargetSnapshot }
  | { ok: false; code: AlignmentTrainingTargetSnapshotErrorCode };

export type AlignmentTrainingTargetSnapshotParseResult =
  | { ok: true; value: AlignmentTrainingTargetSnapshot }
  | { ok: false; issues: string[] };

export type AlignmentTrainingTargetSnapshotErrorCode =
  | "target_input_invalid"
  | "target_input_too_large"
  | "target_identity_invalid"
  | "target_timing_invalid";

const safeMicrosSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const stableEntityIdSchema = z.string()
  .min(1)
  .max(MAX_ENTITY_ID_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "实体 ID 含控制字符。");
const characterSchema = z.object({
  characterId: stableEntityIdSchema,
  startMicros: safeMicrosSchema,
  endMicros: safeMicrosSchema,
}).strict();
const sentenceSchema = z.object({
  sentenceId: stableEntityIdSchema,
  startMicros: safeMicrosSchema,
  endMicros: safeMicrosSchema,
  characters: z.array(characterSchema)
    .min(1)
    .max(ALIGNMENT_TRAINING_TARGET_MAX_CHARACTERS_PER_ITEM),
}).strict();
const targetSchema = z.object({
  format: z.literal(ALIGNMENT_TRAINING_TARGET_FORMAT),
  version: z.literal(ALIGNMENT_TRAINING_TARGET_VERSION),
  inputTextFingerprint: z.string().regex(SHA256_PATTERN),
  sentenceCount: z.number().int().positive().max(ALIGNMENT_TRAINING_TARGET_MAX_SENTENCES_PER_ITEM),
  characterCount: z.number().int().positive().max(ALIGNMENT_TRAINING_TARGET_MAX_CHARACTERS_PER_ITEM),
  sentences: z.array(sentenceSchema)
    .min(1)
    .max(ALIGNMENT_TRAINING_TARGET_MAX_SENTENCES_PER_ITEM),
}).strict();

/**
 * 从一个已经严格解析的历史 ProjectData 提取训练标签。正文只参与上游 projection 指纹校验，
 * 返回值仅保留稳定 ID 与整数微秒，避免把完整标注文档复制进训练治理表。
 */
export function buildAlignmentTrainingTargetSnapshot(
  project: ProjectData,
  inputTextFingerprint: string,
): AlignmentTrainingTargetSnapshotResult {
  if (!SHA256_PATTERN.test(inputTextFingerprint)) {
    return { ok: false, code: "target_input_invalid" };
  }
  const projected = buildAlignmentTextProjection(project);
  if (!projected.ok) {
    return {
      ok: false,
      code: projected.code === "alignment_input_too_large"
        ? "target_input_too_large"
        : "target_input_invalid",
    };
  }
  if (
    projected.sentenceCount > ALIGNMENT_TRAINING_TARGET_MAX_SENTENCES_PER_ITEM ||
    projected.characterCount > ALIGNMENT_TRAINING_TARGET_MAX_CHARACTERS_PER_ITEM
  ) {
    return { ok: false, code: "target_input_too_large" };
  }

  const characterById = new Map<string, ProjectData["characterAnnotations"][number]>();
  for (const character of project.characterAnnotations) {
    if (!isStableEntityId(character.id) || characterById.has(character.id)) {
      return { ok: false, code: "target_identity_invalid" };
    }
    characterById.set(character.id, character);
  }
  const sentenceIds = new Set<string>();
  const consumedCharacters = new Set<string>();
  const sentences: AlignmentTrainingTargetSnapshot["sentences"] = [];
  for (const sentence of projected.projection.sentences) {
    if (!isStableEntityId(sentence.sentenceId) || sentenceIds.has(sentence.sentenceId)) {
      return { ok: false, code: "target_identity_invalid" };
    }
    sentenceIds.add(sentence.sentenceId);
    const characters: AlignmentTrainingTargetSnapshot["sentences"][number]["characters"] = [];
    for (const projectedCharacter of sentence.characters) {
      const character = characterById.get(projectedCharacter.characterId);
      if (
        !character ||
        character.lineId !== sentence.sentenceId ||
        consumedCharacters.has(character.id)
      ) {
        return { ok: false, code: "target_identity_invalid" };
      }
      const timing = toMicrosRange(character.startTime, character.endTime);
      if (!timing) return { ok: false, code: "target_timing_invalid" };
      consumedCharacters.add(character.id);
      characters.push({ characterId: character.id, ...timing });
    }
    sentences.push({
      sentenceId: sentence.sentenceId,
      startMicros: sentence.startMicros,
      endMicros: sentence.endMicros,
      characters,
    });
  }
  if (consumedCharacters.size !== characterById.size) {
    return { ok: false, code: "target_identity_invalid" };
  }
  return {
    ok: true,
    snapshot: {
      format: ALIGNMENT_TRAINING_TARGET_FORMAT,
      version: ALIGNMENT_TRAINING_TARGET_VERSION,
      inputTextFingerprint,
      sentenceCount: projected.sentenceCount,
      characterCount: projected.characterCount,
      sentences,
    },
  };
}

/** unknown 入口不仅校验字段类型，还要求计数、全局身份和稳定时间顺序完全自洽。 */
export function parseAlignmentTrainingTargetSnapshot(
  value: unknown,
): AlignmentTrainingTargetSnapshotParseResult {
  const parsed = targetSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 50).map((issue) =>
        `${issue.path.join(".") || "target"}: ${issue.message}`),
    };
  }
  const snapshot = parsed.data as AlignmentTrainingTargetSnapshot;
  const issues: string[] = [];
  const sentenceIds = new Set<string>();
  const characterIds = new Set<string>();
  let characterCount = 0;
  for (const [sentenceIndex, sentence] of snapshot.sentences.entries()) {
    const prefix = `sentences.${sentenceIndex}`;
    if (sentenceIds.has(sentence.sentenceId)) issues.push(`${prefix}.sentenceId 重复。`);
    sentenceIds.add(sentence.sentenceId);
    if (sentence.endMicros < sentence.startMicros) issues.push(`${prefix} 时间范围反向。`);
    if (sentenceIndex > 0 && compareTimedSnapshotEntity(snapshot.sentences[sentenceIndex - 1]!, sentence) > 0) {
      issues.push(`${prefix} 未按稳定时间顺序排列。`);
    }
    for (const [characterIndex, character] of sentence.characters.entries()) {
      const characterPrefix = `${prefix}.characters.${characterIndex}`;
      if (characterIds.has(character.characterId)) issues.push(`${characterPrefix}.characterId 重复。`);
      characterIds.add(character.characterId);
      if (character.endMicros < character.startMicros) issues.push(`${characterPrefix} 时间范围反向。`);
      if (characterIndex > 0 &&
          compareTimedSnapshotEntity(sentence.characters[characterIndex - 1]!, character) > 0) {
        issues.push(`${characterPrefix} 未按稳定时间顺序排列。`);
      }
      characterCount += 1;
    }
  }
  if (snapshot.sentenceCount !== snapshot.sentences.length) {
    issues.push("sentenceCount 与 sentences 数量不一致。");
  }
  if (snapshot.characterCount !== characterCount) {
    issues.push("characterCount 与逐字数量不一致。");
  }
  return issues.length > 0
    ? { ok: false, issues: issues.slice(0, 50) }
    : { ok: true, value: snapshot };
}

function isStableEntityId(value: string) {
  return value.length >= 1 && value.length <= MAX_ENTITY_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function toMicrosRange(startSeconds: number, endSeconds: number) {
  const startMicros = Math.round(startSeconds * 1_000_000);
  const endMicros = Math.round(endSeconds * 1_000_000);
  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    !Number.isSafeInteger(startMicros) ||
    !Number.isSafeInteger(endMicros) ||
    startMicros < 0 ||
    endMicros < startMicros
  ) return null;
  return { startMicros, endMicros };
}

function compareTimedSnapshotEntity(
  left: { startMicros: number; endMicros: number; sentenceId?: string; characterId?: string },
  right: { startMicros: number; endMicros: number; sentenceId?: string; characterId?: string },
) {
  return left.startMicros - right.startMicros ||
    left.endMicros - right.endMicros ||
    (left.sentenceId ?? left.characterId ?? "").localeCompare(
      right.sentenceId ?? right.characterId ?? "",
    );
}
