import type { CharacterAnnotation, ProjectData, SubtitleLine } from "../types";

const TIME_EPSILON = 0.02;

export type SentenceCharacterAlignmentLineIssue = {
  line: SubtitleLine;
  characters: CharacterAnnotation[];
};

export type SentenceCharacterAlignmentCharacterIssue = {
  character: CharacterAnnotation;
  line?: SubtitleLine;
};

export type SentenceCharacterAlignmentReport = {
  lineCount: number;
  characterCount: number;
  missingLineCharacters: SentenceCharacterAlignmentLineIssue[];
  textMismatchLines: SentenceCharacterAlignmentLineIssue[];
  timeOutOfRangeCharacters: SentenceCharacterAlignmentCharacterIssue[];
  orphanCharacters: SentenceCharacterAlignmentCharacterIssue[];
  overlappingCharacters: SentenceCharacterAlignmentLineIssue[];
  emptyTextLines: SubtitleLine[];
};

export type SentenceCharacterRepairResult = {
  project: ProjectData;
  createdCharacters: CharacterAnnotation[];
};

export function analyzeSentenceCharacterAlignment(project: ProjectData): SentenceCharacterAlignmentReport {
  const charactersByLineId = groupCharactersByLineId(project.characterAnnotations);
  const lineById = new Map(project.subtitleLines.map((line) => [line.id, line]));
  const missingLineCharacters: SentenceCharacterAlignmentLineIssue[] = [];
  const textMismatchLines: SentenceCharacterAlignmentLineIssue[] = [];
  const timeOutOfRangeCharacters: SentenceCharacterAlignmentCharacterIssue[] = [];
  const orphanCharacters: SentenceCharacterAlignmentCharacterIssue[] = [];
  const overlappingCharacters: SentenceCharacterAlignmentLineIssue[] = [];
  const emptyTextLines: SubtitleLine[] = [];

  for (const line of project.subtitleLines) {
    const lineCharacters = sortCharactersByTime(charactersByLineId.get(line.id) ?? []);
    if (normalizeSubtitleText(line.text).length === 0) {
      emptyTextLines.push(line);
    }
    if (lineCharacters.length === 0) {
      missingLineCharacters.push({ line, characters: [] });
      continue;
    }
    if (normalizeSubtitleText(lineCharacters.map((character) => character.char).join("")) !== normalizeSubtitleText(line.text)) {
      textMismatchLines.push({ line, characters: lineCharacters });
    }
    if (hasOverlappingCharacters(lineCharacters)) {
      overlappingCharacters.push({ line, characters: lineCharacters });
    }
  }

  for (const character of project.characterAnnotations) {
    const line = lineById.get(character.lineId);
    if (!line) {
      orphanCharacters.push({ character });
      continue;
    }
    if (
      character.startTime < line.startTime - TIME_EPSILON ||
      character.endTime > line.endTime + TIME_EPSILON
    ) {
      timeOutOfRangeCharacters.push({ character, line });
    }
  }

  return {
    lineCount: project.subtitleLines.length,
    characterCount: project.characterAnnotations.length,
    missingLineCharacters,
    textMismatchLines,
    timeOutOfRangeCharacters,
    orphanCharacters,
    overlappingCharacters,
    emptyTextLines,
  };
}

export function createSentenceCharacterRepairs(
  project: ProjectData,
  report: SentenceCharacterAlignmentReport,
): SentenceCharacterRepairResult {
  const existingIds = new Set(project.characterAnnotations.map((character) => character.id));
  const createdCharacters = report.missingLineCharacters
    .filter(({ line }) => normalizeSubtitleText(line.text).length > 0)
    .map(({ line }) => createSentenceCharacterBlock(line, existingIds));

  return {
    project: {
      ...project,
      characterAnnotations: [...project.characterAnnotations, ...createdCharacters],
    },
    createdCharacters,
  };
}

export function formatSentenceCharacterAlignmentSummary(report: SentenceCharacterAlignmentReport) {
  return [
    `句级字幕：${report.lineCount} 条`,
    `逐字文字块：${report.characterCount} 个`,
    `缺少逐字块的句：${report.missingLineCharacters.length} 条`,
    `文本不一致的句：${report.textMismatchLines.length} 条`,
    `时间超出句级范围的逐字块：${report.timeOutOfRangeCharacters.length} 个`,
    `指向不存在句级字幕的逐字块：${report.orphanCharacters.length} 个`,
    `同句内时间重叠的句：${report.overlappingCharacters.length} 条`,
  ];
}

function createSentenceCharacterBlock(line: SubtitleLine, existingIds: Set<string>): CharacterAnnotation {
  const id = createUniqueSentenceCharacterId(line.id, existingIds);
  return {
    id,
    lineId: line.id,
    char: line.text.trim(),
    startTime: line.startTime,
    endTime: line.endTime,
    singingStyle: "普通唱",
  };
}

function createUniqueSentenceCharacterId(lineId: string, existingIds: Set<string>) {
  const baseId = `${lineId}-sentence-block`;
  if (!existingIds.has(baseId)) {
    existingIds.add(baseId);
    return baseId;
  }
  let index = 2;
  while (existingIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  const id = `${baseId}-${index}`;
  existingIds.add(id);
  return id;
}

function groupCharactersByLineId(characters: CharacterAnnotation[]) {
  const groups = new Map<string, CharacterAnnotation[]>();
  for (const character of characters) {
    const group = groups.get(character.lineId);
    if (group) {
      group.push(character);
      continue;
    }
    groups.set(character.lineId, [character]);
  }
  return groups;
}

function sortCharactersByTime(characters: CharacterAnnotation[]) {
  return [...characters].sort((left, right) =>
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id),
  );
}

function normalizeSubtitleText(value: string) {
  return Array.from(value)
    .filter((char) => char.trim().length > 0)
    .join("");
}

function hasOverlappingCharacters(characters: CharacterAnnotation[]) {
  for (let index = 1; index < characters.length; index += 1) {
    if (characters[index].startTime < characters[index - 1].endTime - TIME_EPSILON) {
      return true;
    }
  }
  return false;
}
