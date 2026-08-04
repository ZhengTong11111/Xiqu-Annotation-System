import {
  buildTimelineTimingUpdateEnvelope,
  getTimelineTimingTargetKey,
  type TimelineTimingCommandEnvelope,
  type TimelineEntityType,
  type TimelineTimingUpdateItem,
} from "@xiqu/shared";
import type { ProjectData } from "./projectData.js";

// UI 调用点只描述目标身份，before/after 必须由纯 helper 从两份项目中权威读取。
export type TimelineTimingTarget = {
  entityType: TimelineEntityType;
  entityId: string;
  trackId?: string;
};

// 文字父块移动会同步工尺块；把派生块纳入同一命令，未来重放不会只移动父块而遗漏工尺时间。
export function getGongcheTimingTargetsForParents(
  projects: readonly ProjectData[],
  parentTrackId: string,
  parentBlockIds: readonly string[],
): TimelineTimingTarget[] {
  const parentIdSet = new Set(parentBlockIds);
  const targets = new Map<string, TimelineTimingTarget>();
  for (const project of projects) {
    for (const block of project.gongcheAnnotations) {
      if (block.parentTrackId !== parentTrackId || !parentIdSet.has(block.parentBlockId)) continue;
      const target: TimelineTimingTarget = {
        entityType: "gongche-block",
        entityId: block.id,
        trackId: parentTrackId,
      };
      targets.set(getTimelineTimingTargetKey(target), target);
    }
  }
  return [...targets.values()];
}

// 从同一次 history 的真实 base/next 项目提取 before/after，避免 pointer-up 使用已被 transient 改写的旧值。
export function buildProjectTimelineTimingCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly TimelineTimingTarget[],
): TimelineTimingCommandEnvelope | null {
  const uniqueTargets = new Map<string, TimelineTimingTarget>();
  for (const target of targets) {
    uniqueTargets.set(getTimelineTimingTargetKey(target), target);
  }
  const items: TimelineTimingUpdateItem[] = [];
  for (const target of uniqueTargets.values()) {
    const before = resolveProjectTimelineTiming(baseProject, target);
    const after = resolveProjectTimelineTiming(nextProject, target);
    // 创建/删除或身份错配不是 timing.update，调用点必须回退到受控 snapshot commit。
    if (!before || !after) return null;
    items.push({ ...target, before, after });
  }
  return buildTimelineTimingUpdateEnvelope(items);
}

// 每种时间轴实体只在这里解释其时间字段；UI 和 operation 序列化不能各自猜测。
export function resolveProjectTimelineTiming(project: ProjectData, target: TimelineTimingTarget) {
  if (target.entityType === "sentence") {
    const line = project.subtitleLines.find((item) => item.id === target.entityId);
    return line ? { startTime: line.startTime, endTime: line.endTime } : null;
  }
  if (target.entityType === "character") {
    const character = project.characterAnnotations.find((item) => item.id === target.entityId);
    return character ? { startTime: character.startTime, endTime: character.endTime } : null;
  }
  if (target.entityType === "action") {
    const action = project.actionAnnotations.find((item) =>
      item.id === target.entityId && item.trackId === target.trackId,
    );
    return action ? { startTime: action.startTime, endTime: action.endTime } : null;
  }
  if (target.entityType === "custom-block") {
    const track = project.customTracks.find((item) => item.id === target.trackId);
    const block = track?.blocks.find((item) => item.id === target.entityId);
    return block ? { startTime: block.startTime, endTime: block.endTime } : null;
  }
  if (target.entityType === "attached-point") {
    const pointTrack = [...project.builtinTracks, ...project.customTracks]
      .flatMap((track) => track.attachedPointTracks ?? [])
      .find((item) => item.id === target.trackId);
    const point = pointTrack?.points.find((item) => item.id === target.entityId);
    return point ? { startTime: point.time, endTime: point.time } : null;
  }
  if (target.entityType === "gongche-block") {
    const block = project.gongcheAnnotations.find((item) =>
      item.id === target.entityId && item.parentTrackId === target.trackId,
    );
    return block ? { startTime: block.startTime, endTime: block.endTime } : null;
  }
  if (target.entityType === "banyan-mark") {
    const mark = project.banyanMarks.find((item) => item.id === target.entityId);
    return mark ? { startTime: mark.time, endTime: mark.time } : null;
  }
  return assertNever(target.entityType);
}

// 新增实体类型时强制同步扩展 ProjectData resolver，不能静默落入错误集合。
function assertNever(value: never): never {
  throw new Error(`未处理的时间轴实体类型：${String(value)}`);
}
