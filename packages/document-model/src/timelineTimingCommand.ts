import {
  buildTimelineTimingUpdateEnvelope,
  getTimelineTimingTargetKey,
  type TimelineTimingCommandEnvelope,
  type TimelineEntityType,
  type TimelineTimingUpdateItem,
} from "@xiqu/shared";
import type { ProjectData } from "./projectData.js";
import type { AnnotationStateTarget } from "./annotationStateCommand.js";

// UI 调用点只描述目标身份，before/after 必须由纯 helper 从两份项目中权威读取。
export type TimelineTimingTarget = {
  entityType: TimelineEntityType;
  entityId: string;
  trackId?: string;
};

type GongcheParentTimingTransactionTargets = {
  timingTargets: TimelineTimingTarget[];
  stateTargets: Array<Extract<AnnotationStateTarget, { entityType: "gongche-symbol" }>>;
};

// 文字父块移动会按比例同步工尺块及其内部符号。两类目标必须进入同一 transaction，
// 否则命令重放只能恢复外层块边界，无法解释当前 ProjectData 中已经移动的符号时间。
export function getGongcheTransactionTargetsForParents(
  baseProject: ProjectData,
  nextProject: ProjectData,
  parentTrackId: string,
  parentBlockIds: readonly string[],
): GongcheParentTimingTransactionTargets {
  const parentIdSet = new Set(parentBlockIds);
  const timingTargets = new Map<string, TimelineTimingTarget>();
  for (const project of [baseProject, nextProject]) {
    for (const block of project.gongcheAnnotations) {
      if (block.parentTrackId !== parentTrackId || !parentIdSet.has(block.parentBlockId)) continue;
      const target: TimelineTimingTarget = {
        entityType: "gongche-block",
        entityId: block.id,
        trackId: parentTrackId,
      };
      timingTargets.set(getTimelineTimingTargetKey(target), target);
    }
  }

  const stateTargets = new Map<
    string,
    Extract<AnnotationStateTarget, { entityType: "gongche-symbol" }>
  >();
  for (const target of timingTargets.values()) {
    const baseBlock = baseProject.gongcheAnnotations.find((block) =>
      block.id === target.entityId && block.parentTrackId === target.trackId,
    );
    const nextBlock = nextProject.gongcheAnnotations.find((block) =>
      block.id === target.entityId && block.parentTrackId === target.trackId,
    );
    // 父块时间编辑不负责工尺生命周期；只收集前后都存在的稳定 symbol，创建/删除继续走 lifecycle。
    if (!baseBlock || !nextBlock) continue;
    const nextSymbolIds = new Set(nextBlock.symbols.map((symbol) => symbol.id));
    for (const symbol of baseBlock.symbols) {
      if (!nextSymbolIds.has(symbol.id)) continue;
      const stateTarget: Extract<AnnotationStateTarget, { entityType: "gongche-symbol" }> = {
        entityType: "gongche-symbol",
        entityId: symbol.id,
        trackId: baseBlock.id,
      };
      stateTargets.set(`${baseBlock.id}:${symbol.id}`, stateTarget);
    }
  }

  return {
    timingTargets: [...timingTargets.values()],
    stateTargets: [...stateTargets.values()],
  };
}

// 事务叶级 builder 只从同一次 history 的真实 base/next 提取 before/after，不单独证明完整 ProjectData。
// UI 必须调用 timelineTimingCommandBuilder 中的安全 builder；本函数只供高层 transaction 组合子命令。
export function buildProjectTimelineTimingEnvelope(
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
