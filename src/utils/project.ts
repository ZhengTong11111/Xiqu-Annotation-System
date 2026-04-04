import type {
  AttachedPointTrack,
  BuiltinTrack,
  BuiltinTrackId,
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

export const defaultBuiltinTracks: BuiltinTrack[] = [
  {
    id: "character-track",
    name: "逐字文字轨",
    type: "character",
    options: [...singingStyleOptions],
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
    snapToWaveformKeypoints: false,
  },
  {
    id: "hand-action",
    name: "手部动作轨",
    type: "action",
    options: ["抬手", "落手", "指向", "翻腕", "水袖动作", "其他"],
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
    snapToWaveformKeypoints: false,
  },
  {
    id: "body-action",
    name: "肢体动作轨",
    type: "action",
    options: ["转身", "移步", "屈伸", "亮相", "前倾", "后仰", "其他"],
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
    snapToWaveformKeypoints: false,
  },
];

export function getDefaultBuiltinTracks(): BuiltinTrack[] {
  return defaultBuiltinTracks.map((track) => ({
    ...track,
    options: track.options ? [...track.options] : undefined,
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
    snapToWaveformKeypoints: false,
  }));
}

export function getBuiltinTrackDefinition(trackId: BuiltinTrackId): BuiltinTrack {
  const track = defaultBuiltinTracks.find((item) => item.id === trackId);
  if (!track) {
    throw new Error(`Unknown builtin track: ${trackId}`);
  }
  return {
    ...track,
    options: track.options ? [...track.options] : undefined,
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
    snapToWaveformKeypoints: false,
  };
}

export function buildTimelineTrackDefinitions(
  builtinTracks: BuiltinTrack[],
  customTracks: CustomTrack[],
  activeTrackOrder: string[],
): TrackDefinition[] {
  const trackEntries: Array<[string, TrackDefinition]> = [
    ...builtinTracks.map((track) => [
      track.id,
      {
        ...track,
        isBuiltin: true,
      } satisfies TrackDefinition,
    ] as [string, TrackDefinition]),
    ...customTracks.map((track) => [
      track.id,
      {
        id: track.id,
        name: track.name,
        type: (track.trackType === "text" ? "custom-text" : "custom-action") as TrackDefinition["type"],
        options: track.typeOptions,
        isCustom: true,
      } satisfies TrackDefinition,
    ] as [string, TrackDefinition]),
  ];
  const trackMap = new Map<string, TrackDefinition>(trackEntries);

  const orderedIds = activeTrackOrder.length > 0
    ? activeTrackOrder.filter((trackId) => trackMap.has(trackId))
    : [...builtinTracks.map((track) => track.id), ...customTracks.map((track) => track.id)];

  return orderedIds.flatMap((trackId) => {
    const track = trackMap.get(trackId);
    if (!track) {
      return [];
    }
    const parentTrack = builtinTracks.find((item) => item.id === trackId) ??
      customTracks.find((item) => item.id === trackId);
    const attachedPointTrackDefinitions = parentTrack?.attachedPointTracksExpanded
      ? (parentTrack.attachedPointTracks ?? []).map((pointTrack) => ({
          id: pointTrack.id,
          name: pointTrack.name,
          type: "attached-point" as const,
          options: pointTrack.typeOptions,
          isAttachedPointTrack: true,
          parentTrackId: parentTrack.id,
          parentTrackName: parentTrack.name,
        }))
      : [];
    return [track, ...attachedPointTrackDefinitions];
  });
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
  const track = defaultBuiltinTracks.find((item) => item.id === trackId);
  return track?.options?.[0] ?? "其他";
}

export function getBuiltinTrackOptions(
  builtinTracks: BuiltinTrack[],
  trackId: BuiltinTrackId,
) {
  return builtinTracks.find((track) => track.id === trackId)?.options ?? [];
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

export function getDefaultAttachedPointTrackName(attachedPointTracks: AttachedPointTrack[]): string {
  return `打点轨 ${attachedPointTracks.length + 1}`;
}

export function getDefaultAttachedPointTypeOptions(): string[] {
  return ["标记 1"];
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
  video: ProjectData["video"],
): ProjectData {
  return {
    video,
    subtitleLines,
    characterAnnotations: subtitleLines.flatMap(splitLineIntoCharacters),
    actionAnnotations: [],
    builtinTracks: getDefaultBuiltinTracks(),
    customTracks: [],
    activeTrackOrder: getDefaultBuiltinTracks().map((track) => track.id),
  };
}

export function getProjectDuration(project: ProjectData): number {
  const customBlockEndTimes = flattenCustomTrackBlocks(project.customTracks).map((block) => block.endTime);
  const attachedPointTimes = [
    ...project.builtinTracks.flatMap((track) =>
      (track.attachedPointTracks ?? []).flatMap((pointTrack) => pointTrack.points.map((point) => point.time)),
    ),
    ...project.customTracks.flatMap((track) =>
      (track.attachedPointTracks ?? []).flatMap((pointTrack) => pointTrack.points.map((point) => point.time)),
    ),
  ];
  const lineDuration = Math.max(
    0,
    ...project.subtitleLines.map((line) => line.endTime),
    ...project.characterAnnotations.map((char) => char.endTime),
    ...project.actionAnnotations.map((action) => action.endTime),
    ...customBlockEndTimes,
    ...attachedPointTimes,
  );
  return Math.max(lineDuration, 30);
}

export function getMissingBuiltinTracks(activeBuiltinTracks: BuiltinTrack[]) {
  const activeIds = new Set(activeBuiltinTracks.map((track) => track.id));
  return defaultBuiltinTracks.filter((track) => !activeIds.has(track.id));
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
