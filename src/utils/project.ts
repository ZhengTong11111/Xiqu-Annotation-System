import type {
  AttachedPointTrack,
  BranchLane,
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
import { getBranchLaneCount } from "./trackBranching";

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
    autoSetLoopRangeOnSelect: false,
  },
];

export function getDefaultBuiltinTracks(): BuiltinTrack[] {
  return defaultBuiltinTracks.map((track) => ({
    ...track,
    options: track.options ? [...track.options] : undefined,
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
    snapToWaveformKeypoints: false,
    autoSetLoopRangeOnSelect: false,
  }));
}

// 新建空白标注工程必须返回彼此隔离的可编辑对象，不能复用示例数据或共享轨道数组。
export function createEmptyProjectData(): ProjectData {
  const builtinTracks = getDefaultBuiltinTracks();
  return {
    video: {
      url: "",
      name: null,
      source: "url",
      filePath: null,
      requiresManualImport: false,
    },
    subtitleLines: [],
    characterAnnotations: [],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks,
    customTracks: [],
    activeTrackOrder: builtinTracks.map((track) => track.id),
  };
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
    autoSetLoopRangeOnSelect: false,
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
        branching: track.branching,
        color: track.color,
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
    const branchLaneTrackDefinitions =
      parentTrack &&
      "trackType" in parentTrack &&
      parentTrack.branching?.enabled &&
      parentTrack.branching.displayMode === "expanded"
        ? flattenBranchLanes(parentTrack.branching.lanes).map((lane) => ({
            id: getBranchLaneTrackId(parentTrack.id, lane.id),
            name: lane.name,
            type: "branch-lane" as const,
            options: parentTrack.typeOptions,
            isBranchLaneTrack: true,
            parentTrackId: parentTrack.id,
            parentTrackName: parentTrack.name,
            branchLaneId: lane.id,
            branchDepth: lane.depth,
            branchTrackType: parentTrack.trackType,
            color: lane.color ?? parentTrack.color,
          }))
        : [];
    const gongcheTrackDefinitions = parentTrack &&
      (("type" in parentTrack && parentTrack.type === "character") ||
        ("trackType" in parentTrack && parentTrack.trackType === "text"))
      ? [{
          id: getGongcheTrackId(parentTrack.id),
          name: "工尺谱附属轨",
          type: "gongche-attached" as const,
          isGongcheTrack: true,
          parentTrackId: parentTrack.id,
          parentTrackName: parentTrack.name,
        }]
      : [];
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
    // 分叉子轨道是从自定义轨道派生出来的显示层，不写入 activeTrackOrder。
    return [track, ...branchLaneTrackDefinitions, ...gongcheTrackDefinitions, ...attachedPointTrackDefinitions];
  });
}

// 轨道增删会派生出吸附开关 key；该规范化结果既用于初始化，也用于原子确认时推进 UI 保存基线。
export function normalizeTrackSnapEnabledForProject(
  project: ProjectData,
  trackSnapEnabled?: Record<string, boolean>,
) {
  return Object.fromEntries(
    buildTimelineTrackDefinitions(
      project.builtinTracks,
      project.customTracks,
      project.activeTrackOrder,
    ).map((track) => [track.id, trackSnapEnabled?.[track.id] ?? true]),
  );
}

export function getGongcheTrackId(parentTrackId: string) {
  return `gongche:${parentTrackId}`;
}

export function getParentTrackIdFromGongcheTrackId(trackId: string) {
  return trackId.startsWith("gongche:") ? trackId.slice("gongche:".length) : null;
}

export function getBranchLaneTrackId(parentTrackId: string, branchLaneId: string) {
  return `branch-lane:${parentTrackId}:${branchLaneId}`;
}

export function getBranchLaneTrackParts(trackId: string) {
  if (!trackId.startsWith("branch-lane:")) {
    return null;
  }
  const [, parentTrackId, branchLaneId] = trackId.split(":");
  return parentTrackId && branchLaneId ? { parentTrackId, branchLaneId } : null;
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
      branchScope: block.branchScope,
      branchGroupId: block.branchGroupId,
      branchParentBlockId: block.branchParentBlockId,
    })),
  );
}

export function getTrackBranchSummary(track: CustomTrack) {
  if (!track.branching?.enabled) {
    return null;
  }
  const branchCount = getBranchLaneCount(track.branching.lanes);
  return {
    displayMode: track.branching.displayMode,
    branchCount,
    label: branchCount > 0
      ? `${branchCount} 个分叉 · ${track.branching.displayMode === "expanded" ? "展开" : "合并"}`
      : "已启用分叉",
  };
}

export function flattenBranchLanes(lanes: BranchLane[], depth = 0): Array<BranchLane & { depth: number }> {
  return lanes.flatMap((lane) => [
    { ...lane, depth },
    ...flattenBranchLanes(lane.children ?? [], depth + 1),
  ]);
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
      // 句级 SRT 拆字时不带四声信息，统一留空，由用户在逐字属性中手动标注。
      tone: null,
    };
  });
}

export function buildProjectFromLines(
  subtitleLines: SubtitleLine[],
  video: ProjectData["video"],
): ProjectData {
  const emptyProject = createEmptyProjectData();
  return {
    ...emptyProject,
    video,
    subtitleLines,
    characterAnnotations: subtitleLines.flatMap(splitLineIntoCharacters),
  };
}

export function getProjectDuration(project: ProjectData): number {
  const customBlockEndTimes = flattenCustomTrackBlocks(project.customTracks).map((block) => block.endTime);
  const gongcheEndTimes = (project.gongcheAnnotations ?? []).map((block) => block.endTime);
  const banyanTimes = (project.banyanMarks ?? []).map((mark) => mark.time);
  const banyanSectionEndTimes = (project.banyanSections ?? []).map((section) => section.endTime);
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
    ...gongcheEndTimes,
    ...banyanTimes,
    ...banyanSectionEndTimes,
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
