import { z } from "zod";
import {
  canonicalAlignmentTrainingJson,
  type AlignmentTrainingSha256Hex,
} from "./alignmentTrainingManifest.js";

export const ALIGNMENT_TRAINING_SOURCE_FORMAT = "xiqu-alignment-training-source";
export const ALIGNMENT_TRAINING_SOURCE_VERSION = 1;
export const ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT = "xiqu-alignment-training-input-manifest";
export const ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION = 1;
export const ALIGNMENT_TRAINING_INPUT_MAX_ITEMS = 200;
export const ALIGNMENT_TRAINING_INPUT_MAX_TOTAL_CHARACTERS = 500_000;
export const ALIGNMENT_TRAINING_INPUT_MAX_TARGET_BYTES = 64 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safeIntegerSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const uuidSchema = z.string().regex(UUID_PATTERN);
const boundedString = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "字符串含控制字符。");

const sourceBaseShape = {
  format: z.literal(ALIGNMENT_TRAINING_SOURCE_FORMAT),
  version: z.literal(ALIGNMENT_TRAINING_SOURCE_VERSION),
  sourceMediaResourceId: uuidSchema,
  sourceFingerprint: sha256Schema,
  mediaKind: z.enum(["audio", "video"]),
  audioOffsetMicros: safeIntegerSchema,
};
const uploadedSourceSchema = z.object({
  ...sourceBaseShape,
  kind: z.literal("uploaded"),
  fileId: uuidSchema,
  fileChecksum: sha256Schema,
  fileSize: positiveSafeIntegerSchema,
  mimeType: boundedString(200),
}).strict();
const vodSourceSchema = z.object({
  ...sourceBaseShape,
  kind: z.literal("aliyun_vod"),
  region: boundedString(100),
  videoId: boundedString(200),
  renditionJobId: boundedString(200).nullable(),
  durationMicros: nonNegativeSafeIntegerSchema.nullable(),
}).strict();
const sourceSchema = z.discriminatedUnion("kind", [uploadedSourceSchema, vodSourceSchema]);

export type AlignmentTrainingSourceSnapshot = z.infer<typeof sourceSchema>;

export type AlignmentTrainingInputManifestItemDraft = {
  alignmentApplicationId: string;
  alignmentArtifactId: string;
  artifactChecksum: string;
  targetSnapshotChecksum: string;
  targetSentenceCount: number;
  targetCharacterCount: number;
  targetSnapshotBytes: number;
  sourceSnapshotChecksum: string;
};

export type AlignmentTrainingInputManifest = {
  format: typeof ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT;
  version: typeof ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION;
  checksum: string;
  provenanceManifestChecksum: string;
  itemCount: number;
  targetSentenceCount: number;
  targetCharacterCount: number;
  targetSnapshotBytes: number;
  items: AlignmentTrainingInputManifestItemDraft[];
};

type AlignmentTrainingInputManifestContent = Omit<AlignmentTrainingInputManifest, "checksum">;

export type AlignmentTrainingInputManifestResult =
  | { ok: true; manifest: AlignmentTrainingInputManifest; canonicalJson: string }
  | { ok: false; issues: string[] };

const itemSchema = z.object({
  alignmentApplicationId: uuidSchema,
  alignmentArtifactId: uuidSchema,
  artifactChecksum: sha256Schema,
  targetSnapshotChecksum: sha256Schema,
  targetSentenceCount: positiveSafeIntegerSchema,
  targetCharacterCount: positiveSafeIntegerSchema,
  targetSnapshotBytes: positiveSafeIntegerSchema,
  sourceSnapshotChecksum: sha256Schema,
}).strict();
const inputManifestSchema = z.object({
  format: z.literal(ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT),
  version: z.literal(ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION),
  checksum: sha256Schema,
  provenanceManifestChecksum: sha256Schema,
  itemCount: positiveSafeIntegerSchema.max(ALIGNMENT_TRAINING_INPUT_MAX_ITEMS),
  targetSentenceCount: positiveSafeIntegerSchema,
  targetCharacterCount: positiveSafeIntegerSchema.max(ALIGNMENT_TRAINING_INPUT_MAX_TOTAL_CHARACTERS),
  targetSnapshotBytes: positiveSafeIntegerSchema.max(ALIGNMENT_TRAINING_INPUT_MAX_TARGET_BYTES),
  items: z.array(itemSchema).min(1).max(ALIGNMENT_TRAINING_INPUT_MAX_ITEMS),
}).strict();

/** 来源快照由 API 权威数据库事实构造；严格 parser 防止 worker 信任任意 JSON。 */
export function parseAlignmentTrainingSourceSnapshot(value: unknown) {
  const parsed = sourceSchema.safeParse(value);
  return parsed.success
    ? { ok: true as const, value: parsed.data as AlignmentTrainingSourceSnapshot }
    : {
        ok: false as const,
        issues: parsed.error.issues.slice(0, 50).map((issue) =>
          `${issue.path.join(".") || "source"}: ${issue.message}`),
      };
}

/** 输入 manifest 只聚合轻量 checksum/计数，不把 target/source 快照本体复制一遍。 */
export function buildAlignmentTrainingInputManifest(
  input: {
    provenanceManifestChecksum: string;
    items: AlignmentTrainingInputManifestItemDraft[];
  },
  sha256Hex: AlignmentTrainingSha256Hex,
): AlignmentTrainingInputManifestResult {
  const normalizedItems = [...input.items].sort((left, right) =>
    left.alignmentApplicationId.localeCompare(right.alignmentApplicationId));
  const aggregate = aggregateItems(normalizedItems);
  const withoutChecksum: AlignmentTrainingInputManifestContent = {
    format: ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT,
    version: ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION,
    provenanceManifestChecksum: input.provenanceManifestChecksum,
    itemCount: normalizedItems.length,
    ...aggregate,
    items: normalizedItems,
  };
  const parsed = inputManifestSchema.omit({ checksum: true }).safeParse(withoutChecksum);
  if (!parsed.success) return formatZodFailure(parsed.error, "inputManifest");
  const duplicate = normalizedItems.find((item, index) =>
    index > 0 && item.alignmentApplicationId === normalizedItems[index - 1]?.alignmentApplicationId);
  if (duplicate) return { ok: false, issues: ["alignmentApplicationId 不能重复。"] };
  const checksum = checkedSha256(canonicalAlignmentTrainingJson(withoutChecksum), sha256Hex);
  if (!checksum) return { ok: false, issues: ["input manifest checksum 计算结果无效。"] };
  const manifest: AlignmentTrainingInputManifest = { ...withoutChecksum, checksum };
  return { ok: true, manifest, canonicalJson: canonicalAlignmentTrainingJson(manifest) };
}

export function parseAlignmentTrainingInputManifest(
  value: unknown,
  sha256Hex: AlignmentTrainingSha256Hex,
): AlignmentTrainingInputManifestResult {
  const parsed = inputManifestSchema.safeParse(value);
  if (!parsed.success) return formatZodFailure(parsed.error, "inputManifest");
  const manifest = parsed.data as AlignmentTrainingInputManifest;
  const issues: string[] = [];
  for (const [index, item] of manifest.items.entries()) {
    if (index > 0 && item.alignmentApplicationId <= manifest.items[index - 1]!.alignmentApplicationId) {
      issues.push(`items.${index} 未按 applicationId 严格排序。`);
    }
  }
  const aggregate = aggregateItems(manifest.items);
  if (
    manifest.itemCount !== manifest.items.length ||
    manifest.targetSentenceCount !== aggregate.targetSentenceCount ||
    manifest.targetCharacterCount !== aggregate.targetCharacterCount ||
    manifest.targetSnapshotBytes !== aggregate.targetSnapshotBytes
  ) issues.push("input manifest 聚合计数不一致。");
  const { checksum: _checksum, ...withoutChecksum } = manifest;
  const expectedChecksum = checkedSha256(
    canonicalAlignmentTrainingJson(withoutChecksum),
    sha256Hex,
  );
  if (!expectedChecksum || expectedChecksum !== manifest.checksum) {
    issues.push("input manifest checksum 与规范内容不一致。");
  }
  return issues.length > 0
    ? { ok: false, issues: issues.slice(0, 50) }
    : { ok: true, manifest, canonicalJson: canonicalAlignmentTrainingJson(manifest) };
}

function aggregateItems(items: readonly AlignmentTrainingInputManifestItemDraft[]) {
  return items.reduce((total, item) => ({
    targetSentenceCount: total.targetSentenceCount + item.targetSentenceCount,
    targetCharacterCount: total.targetCharacterCount + item.targetCharacterCount,
    targetSnapshotBytes: total.targetSnapshotBytes + item.targetSnapshotBytes,
  }), { targetSentenceCount: 0, targetCharacterCount: 0, targetSnapshotBytes: 0 });
}

function checkedSha256(value: string, sha256Hex: AlignmentTrainingSha256Hex) {
  try {
    const result = sha256Hex(value);
    return SHA256_PATTERN.test(result) ? result : null;
  } catch {
    return null;
  }
}

function formatZodFailure(error: z.ZodError, prefix: string): AlignmentTrainingInputManifestResult {
  return {
    ok: false,
    issues: error.issues.slice(0, 50).map((issue) =>
      `${prefix}.${issue.path.join(".")}: ${issue.message}`),
  };
}
