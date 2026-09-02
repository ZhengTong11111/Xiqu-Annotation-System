import type { ProjectData } from "./projectData.js";

const MAX_ALIGNMENT_SENTENCES = 100_000;
const MAX_ALIGNMENT_CHARACTERS = 1_000_000;
const MAX_SENTENCE_TEXT_LENGTH = 20_000;
const MAX_CHARACTER_TEXT_LENGTH = 64;

export type AlignmentTextProjection = {
  version: 1;
  sentences: Array<{
    sentenceId: string;
    text: string;
    startMicros: number;
    endMicros: number;
    deliveryMode: "spoken" | "sung" | null;
    roleTypes: string[];
    characters: Array<{ characterId: string; text: string }>;
  }>;
};

export type AlignmentTextProjectionResult =
  | {
      ok: true;
      projection: AlignmentTextProjection;
      sentenceCount: number;
      characterCount: number;
    }
  | {
      ok: false;
      code:
        | "alignment_input_empty"
        | "alignment_sentence_without_characters"
        | "alignment_character_orphaned"
        | "alignment_input_invalid"
        | "alignment_input_too_large";
      entityId?: string;
    };

/**
 * 将当前标注文档投影为强制对齐的稳定最小输入。正文只在调用内存中参与 hash/模型输入，不能直接持久化到 AlignmentRun。
 * 时间排序与 ID tie-break 让等价数组顺序得到同一投影；逐字时间故意排除，因为它正是模型要预测的结果。
 */
export function buildAlignmentTextProjection(project: ProjectData): AlignmentTextProjectionResult {
  if (
    project.subtitleLines.length > MAX_ALIGNMENT_SENTENCES ||
    project.characterAnnotations.length > MAX_ALIGNMENT_CHARACTERS
  ) return { ok: false, code: "alignment_input_too_large" };

  const sentenceIds = new Set(project.subtitleLines.map(({ id }) => id));
  const orphan = project.characterAnnotations.find(({ lineId }) => !sentenceIds.has(lineId));
  if (orphan) return { ok: false, code: "alignment_character_orphaned", entityId: orphan.id };

  const charactersBySentence = new Map<string, typeof project.characterAnnotations>();
  for (const character of project.characterAnnotations) {
    const current = charactersBySentence.get(character.lineId) ?? [];
    current.push(character);
    charactersBySentence.set(character.lineId, current);
  }
  const orderedSentences = [...project.subtitleLines].sort(compareTimedEntities);
  const sentences: AlignmentTextProjection["sentences"] = [];
  let characterCount = 0;
  for (const sentence of orderedSentences) {
    if (!isValidText(sentence.text, MAX_SENTENCE_TEXT_LENGTH) ||
        !isValidTimeRange(sentence.startTime, sentence.endTime)) {
      return { ok: false, code: "alignment_input_invalid", entityId: sentence.id };
    }
    const characters = [...(charactersBySentence.get(sentence.id) ?? [])].sort(compareTimedEntities);
    // D2d 必须把预测映射回已有稳定 character id；不能在应用阶段猜测如何拆字或悄悄跳过句子。
    if (characters.length === 0) {
      return { ok: false, code: "alignment_sentence_without_characters", entityId: sentence.id };
    }
    if (characters.some((character) => !isValidText(character.char, MAX_CHARACTER_TEXT_LENGTH))) {
      const invalid = characters.find((character) => !isValidText(character.char, MAX_CHARACTER_TEXT_LENGTH));
      return { ok: false, code: "alignment_input_invalid", entityId: invalid?.id };
    }
    characterCount += characters.length;
    sentences.push({
      sentenceId: sentence.id,
      text: sentence.text,
      startMicros: toExactMicros(sentence.startTime),
      endMicros: toExactMicros(sentence.endTime),
      deliveryMode: sentence.deliveryMode,
      roleTypes: [...sentence.roleTypes],
      characters: characters.map((character) => ({
        characterId: character.id,
        text: character.char,
      })),
    });
  }
  if (sentences.length === 0 || characterCount === 0) {
    return { ok: false, code: "alignment_input_empty" };
  }
  return {
    ok: true,
    projection: { version: 1, sentences },
    sentenceCount: sentences.length,
    characterCount,
  };
}

function compareTimedEntities(
  left: { startTime: number; endTime: number; id: string },
  right: { startTime: number; endTime: number; id: string },
) {
  return left.startTime - right.startTime || left.endTime - right.endTime || left.id.localeCompare(right.id);
}

function isValidText(value: string, maxLength: number) {
  return value.length > 0 && value.length <= maxLength && !/[\u0000]/u.test(value);
}

function isValidTimeRange(startTime: number, endTime: number) {
  return Number.isFinite(startTime) && Number.isFinite(endTime) && startTime >= 0 && endTime >= startTime &&
    Number.isSafeInteger(Math.round(startTime * 1_000_000)) &&
    Number.isSafeInteger(Math.round(endTime * 1_000_000));
}

function toExactMicros(seconds: number) {
  return Math.round(seconds * 1_000_000);
}
