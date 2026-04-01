import type {
  CharacterAnnotation,
  CustomTrack,
  CustomTrackType,
  ProjectData,
  ResolvedCustomTrackBlock,
  SingingStyle,
  SubtitleLine,
  TrackDefinition,
} from "../types";

export const singingStyleOptions: SingingStyle[] = [
  "普通唱",
  "拖腔",
  "顿音",
  "装饰音",
  "念白式",
  "其他",
];

export const trackDefinitions: TrackDefinition[] = [
  {
    id: "character-track",
    name: "逐字文字轨",
    type: "character",
  },
  {
    id: "hand-action",
    name: "手部动作轨",
    type: "action",
    options: ["抬手", "落手", "指向", "翻腕", "水袖动作", "其他"],
  },
  {
    id: "body-action",
    name: "肢体动作轨",
    type: "action",
    options: ["转身", "移步", "屈伸", "亮相", "前倾", "后仰", "其他"],
  },
];

export function buildTimelineTrackDefinitions(customTracks: CustomTrack[]): TrackDefinition[] {
  return [
    ...trackDefinitions,
    ...customTracks.map((track) => ({
      id: track.id,
      name: track.name,
      type: (track.trackType === "text" ? "custom-text" : "custom-action") as TrackDefinition["type"],
      options: track.typeOptions,
      isCustom: true,
    })),
  ];
}

export function flattenCustomTrackBlocks(customTracks: CustomTrack[]): ResolvedCustomTrackBlock[] {
  return customTracks.flatMap((track) =>
    track.blocks.map((block) => ({
      id: block.id,
      trackId: track.id,
      trackType: track.trackType,
      startTime: block.startTime,
      endTime: block.endTime,
      type: block.type,
      text: "text" in block ? block.text : undefined,
    })),
  );
}

export function getDefaultFixedActionLabel(trackId: string): string {
  const track = trackDefinitions.find((item) => item.id === trackId);
  return track?.options?.[0] ?? "其他";
}

export function getDefaultCustomTrackName(
  customTracks: CustomTrack[],
  trackType: CustomTrackType,
): string {
  const prefix = trackType === "text" ? "文字轨" : "动作轨";
  const nextIndex = customTracks.filter((track) => track.trackType === trackType).length + 1;
  return `${prefix} ${nextIndex}`;
}

export function getDefaultCustomTrackTypeOptions(): string[] {
  return ["类型 1"];
}

export function getNextCustomTrackTypeOptionName(typeOptions: string[]): string {
  return `类型 ${typeOptions.length + 1}`;
}

export function splitLineIntoCharacters(line: SubtitleLine): CharacterAnnotation[] {
  const characters = Array.from(line.text).filter((char) => char.trim().length > 0);
  const duration = Math.max(line.endTime - line.startTime, 0.001);
  const step = duration / Math.max(characters.length, 1);

  return characters.map((char, index) => {
    const startTime = line.startTime + index * step;
    const endTime = index === characters.length - 1 ? line.endTime : startTime + step;
    return {
      id: `${line.id}-char-${index + 1}`,
      lineId: line.id,
      char,
      startTime,
      endTime,
      singingStyle: "普通唱",
    };
  });
}

export function buildProjectFromLines(
  subtitleLines: SubtitleLine[],
  videoUrl: string,
): ProjectData {
  return {
    videoUrl,
    subtitleLines,
    characterAnnotations: subtitleLines.flatMap(splitLineIntoCharacters),
    actionAnnotations: [],
    customTracks: [],
  };
}

export function getProjectDuration(project: ProjectData): number {
  const customBlockEndTimes = flattenCustomTrackBlocks(project.customTracks).map((block) => block.endTime);
  const lineDuration = Math.max(
    0,
    ...project.subtitleLines.map((line) => line.endTime),
    ...project.characterAnnotations.map((char) => char.endTime),
    ...project.actionAnnotations.map((action) => action.endTime),
    ...customBlockEndTimes,
  );
  return Math.max(lineDuration, 30);
}

export function clampRange(
  startTime: number,
  endTime: number,
  minDuration = 0.04,
): { startTime: number; endTime: number } {
  if (endTime - startTime < minDuration) {
    return { startTime, endTime: startTime + minDuration };
  }
  return { startTime, endTime };
}
