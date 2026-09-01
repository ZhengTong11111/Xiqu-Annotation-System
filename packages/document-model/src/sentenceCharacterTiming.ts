import type { CharacterAnnotation, ProjectData } from "./projectData.js";

export type SentenceCharacterTimingResetIssue =
  | "sentence_not_found"
  | "no_characters"
  | "invalid_sentence_range";

export type SentenceCharacterTimingResetResult =
  | { ok: false; issue: SentenceCharacterTimingResetIssue }
  | {
      ok: true;
      changed: boolean;
      project: ProjectData;
      characterIds: string[];
    };

// 把当前句已有逐字块按时间轴顺序平均铺入句级范围；实体身份、内容和数组顺序均保持不变。
export function resetSentenceCharactersToEvenTiming(
  project: ProjectData,
  lineId: string,
): SentenceCharacterTimingResetResult {
  const line = project.subtitleLines.find((candidate) => candidate.id === lineId);
  if (!line) return { ok: false, issue: "sentence_not_found" };
  if (
    !Number.isFinite(line.startTime) ||
    !Number.isFinite(line.endTime) ||
    line.endTime <= line.startTime
  ) {
    return { ok: false, issue: "invalid_sentence_range" };
  }

  const indexedCharacters = project.characterAnnotations
    .map((character, index) => ({ character, index }))
    .filter(({ character }) => character.lineId === lineId)
    .sort((left, right) =>
      left.character.startTime - right.character.startTime ||
      left.character.endTime - right.character.endTime ||
      left.index - right.index,
    );
  if (indexedCharacters.length === 0) return { ok: false, issue: "no_characters" };

  const duration = line.endTime - line.startTime;
  const step = duration / indexedCharacters.length;
  const timingById = new Map<string, Pick<CharacterAnnotation, "startTime" | "endTime">>();
  indexedCharacters.forEach(({ character }, index) => {
    const startTime = line.startTime + index * step;
    // 最后一块直接使用句尾，避免浮点累计让整体范围留下微小缝隙。
    const endTime = index === indexedCharacters.length - 1
      ? line.endTime
      : line.startTime + (index + 1) * step;
    timingById.set(character.id, { startTime, endTime });
  });

  let changed = false;
  const characterAnnotations = project.characterAnnotations.map((character) => {
    const timing = timingById.get(character.id);
    if (!timing) return character;
    if (character.startTime === timing.startTime && character.endTime === timing.endTime) {
      return character;
    }
    changed = true;
    return { ...character, ...timing };
  });

  return {
    ok: true,
    changed,
    project: changed ? { ...project, characterAnnotations } : project,
    characterIds: indexedCharacters.map(({ character }) => character.id),
  };
}
