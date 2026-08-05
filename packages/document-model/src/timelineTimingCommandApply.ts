import {
  assessTimelineTimingExecution,
  parseTimelineTimingCommandEnvelope,
  type TimelineTimingCommandEnvelope,
  type TimelineTimingActual,
  type TimelineTimingPreconditionIssue,
  type TimelineTimingUpdateItem,
} from "@xiqu/shared";
import type { CustomTrack, ProjectData } from "./projectData.js";
import {
  resolveProjectTimelineTiming,
  type TimelineTimingTarget,
} from "./timelineTimingCommand.js";

export type TimelineTimingCommandApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked"; issues: TimelineTimingPreconditionIssue[] }
  | {
      status: "applied";
      project: ProjectData;
      envelope: TimelineTimingCommandEnvelope;
    };

// ProjectData adapter 先解析并核对全部 before，只有 ready 才统一写 after，避免批量命令部分落地。
export function applyTimelineTimingCommandToProject(
  project: ProjectData,
  value: unknown,
): TimelineTimingCommandApplyResult {
  const envelope = parseTimelineTimingCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const actuals: TimelineTimingActual[] = [];
  for (const item of envelope.command.items) {
    const target = toTimelineTarget(item);
    const current = resolveProjectTimelineTiming(project, target);
    if (!current) continue;
    actuals.push({ ...target, current });
  }
  const assessment = assessTimelineTimingExecution(envelope, actuals);
  if (assessment.status === "invalid_command") return assessment;
  if (assessment.status === "blocked") {
    return { status: "blocked", issues: assessment.issues };
  }

  // 每类目标先收成 map，再对相关集合做一次 immutable map；未涉及的集合保留原引用和顺序。
  const updates = groupTimingUpdates(assessment.envelope.command.items);
  const nextProject: ProjectData = {
    ...project,
    subtitleLines: updates.sentences.size === 0
      ? project.subtitleLines
      : project.subtitleLines.map((item) => {
          const timing = updates.sentences.get(item.id);
          return timing ? { ...item, ...timing.after } : item;
        }),
    characterAnnotations: updates.characters.size === 0
      ? project.characterAnnotations
      : project.characterAnnotations.map((item) => {
          const timing = updates.characters.get(item.id);
          return timing ? { ...item, ...timing.after } : item;
        }),
    actionAnnotations: updates.actions.size === 0
      ? project.actionAnnotations
      : project.actionAnnotations.map((item) => {
          const timing = updates.actions.get(getTrackEntityKey(item.trackId, item.id));
          return timing ? { ...item, ...timing.after } : item;
        }),
    builtinTracks: updates.attachedPoints.size === 0
      ? project.builtinTracks
      : project.builtinTracks.map((track) => ({
          ...track,
          attachedPointTracks: track.attachedPointTracks.map((pointTrack) => ({
            ...pointTrack,
            points: pointTrack.points.map((point) => {
              const timing = updates.attachedPoints.get(getTrackEntityKey(pointTrack.id, point.id));
              return timing ? { ...point, time: timing.after.startTime } : point;
            }),
          })),
        })),
    customTracks: applyCustomTrackTiming(project.customTracks, updates),
    gongcheAnnotations: updates.gongcheBlocks.size === 0
      ? project.gongcheAnnotations
      : project.gongcheAnnotations.map((item) => {
          const timing = updates.gongcheBlocks.get(getTrackEntityKey(item.parentTrackId, item.id));
          return timing ? { ...item, ...timing.after } : item;
        }),
    banyanMarks: updates.banyanMarks.size === 0
      ? project.banyanMarks
      : project.banyanMarks.map((item) => {
          const timing = updates.banyanMarks.get(item.id);
          if (!timing) return item;
          const time = timing.after.startTime;
          // 板眼人工移动必须同步派生偏移和置信状态，否则时间与审校元数据会互相矛盾。
          return {
            ...item,
            time,
            manualOffset: time - item.estimatedTime,
            confidence: "manual" as const,
          };
        }),
  };
  return { status: "applied", project: nextProject, envelope: assessment.envelope };
}

type TimingUpdateGroups = ReturnType<typeof groupTimingUpdates>;

// 自定义轨同时承载 block 与附属点；两类更新在一次轨道映射中完成，避免重复遍历和覆盖。
function applyCustomTrackTiming(
  tracks: CustomTrack[],
  updates: TimingUpdateGroups,
): CustomTrack[] {
  if (updates.customBlocks.size === 0 && updates.attachedPoints.size === 0) {
    return tracks;
  }
  return tracks.map((track) => ({
    ...track,
    blocks: track.blocks.map((block) => {
      const timing = updates.customBlocks.get(getTrackEntityKey(track.id, block.id));
      return timing ? { ...block, ...timing.after } : block;
    }) as CustomTrack["blocks"],
    attachedPointTracks: track.attachedPointTracks.map((pointTrack) => ({
      ...pointTrack,
      points: pointTrack.points.map((point) => {
        const timing = updates.attachedPoints.get(getTrackEntityKey(pointTrack.id, point.id));
        return timing ? { ...point, time: timing.after.startTime } : point;
      }),
    })),
  })) as CustomTrack[];
}

// 命令已经由 shared 去重，分组只负责为 ProjectData 集合提供 O(1) 查找。
function groupTimingUpdates(items: readonly TimelineTimingUpdateItem[]) {
  const groups = {
    sentences: new Map<string, TimelineTimingUpdateItem>(),
    characters: new Map<string, TimelineTimingUpdateItem>(),
    actions: new Map<string, TimelineTimingUpdateItem>(),
    customBlocks: new Map<string, TimelineTimingUpdateItem>(),
    attachedPoints: new Map<string, TimelineTimingUpdateItem>(),
    gongcheBlocks: new Map<string, TimelineTimingUpdateItem>(),
    banyanMarks: new Map<string, TimelineTimingUpdateItem>(),
  };
  for (const item of items) {
    const scopedKey = getTrackEntityKey(item.trackId ?? "", item.entityId);
    if (item.entityType === "sentence") groups.sentences.set(item.entityId, item);
    else if (item.entityType === "character") groups.characters.set(item.entityId, item);
    else if (item.entityType === "action") groups.actions.set(scopedKey, item);
    else if (item.entityType === "custom-block") groups.customBlocks.set(scopedKey, item);
    else if (item.entityType === "attached-point") groups.attachedPoints.set(scopedKey, item);
    else if (item.entityType === "gongche-block") groups.gongcheBlocks.set(scopedKey, item);
    else if (item.entityType === "banyan-mark") groups.banyanMarks.set(item.entityId, item);
    else assertNever(item.entityType);
  }
  return groups;
}

function toTimelineTarget(item: TimelineTimingUpdateItem): TimelineTimingTarget {
  return {
    entityType: item.entityType,
    entityId: item.entityId,
    ...(item.trackId === undefined ? {} : { trackId: item.trackId }),
  };
}

function getTrackEntityKey(trackId: string, entityId: string) {
  return `${trackId}:${entityId}`;
}

// command union 扩展时要求 adapter 同步扩展，避免新实体被错误写进现有集合。
function assertNever(value: never): never {
  throw new Error(`未处理的时间轴实体类型：${String(value)}`);
}
