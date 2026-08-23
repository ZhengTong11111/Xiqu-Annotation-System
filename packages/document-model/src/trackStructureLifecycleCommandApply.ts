import {
  getTrackStructureLifecycleTargetKey,
  parseAttachedPointTrackLifecycleCommandEnvelope,
  parseBuiltinTrackLifecycleCommandEnvelope,
  parseCustomTrackLifecycleCommandEnvelope,
  type AttachedPointTrackLifecycleCommandEnvelope,
  type AttachedPointTrackLifecycleUpdateItem,
  type AttachedPointTrackSnapshot,
  type BuiltinTrackLifecycleCommandEnvelope,
  type BuiltinTrackLifecycleSnapshot,
  type BuiltinTrackLifecycleUpdateItem,
  type CustomTrackStructureBranchLane,
  type CustomTrackLifecycleCommandEnvelope,
  type CustomTrackLifecycleSnapshot,
  type CustomTrackLifecycleUpdateItem,
  type TrackStructureCollectionPosition,
} from "@xiqu/shared";
import type { AttachedPointTrack, BranchLane, BuiltinTrack, CustomTrack, ProjectData } from "./projectData.js";
import { areProjectValuesEqual } from "./projectValueEquality.js";
import {
  resolveAttachedPointTrackLifecycleContext,
  resolveBuiltinTrackLifecycleState,
  resolveCustomTrackLifecycleState,
} from "./trackStructureLifecycleCommand.js";

type StructureLifecycleEnvelope =
  | CustomTrackLifecycleCommandEnvelope
  | AttachedPointTrackLifecycleCommandEnvelope
  | BuiltinTrackLifecycleCommandEnvelope;

export type TrackStructureLifecycleApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked"; issues: Array<{ code: "target_missing" | "before_mismatch" | "result_invalid"; targetKey: string }> }
  | { status: "applied"; project: ProjectData; envelope: StructureLifecycleEnvelope };

export function applyTrackStructureLifecycleCommandToProject(
  project: ProjectData,
  value: unknown,
): TrackStructureLifecycleApplyResult {
  const customEnvelope = parseCustomTrackLifecycleCommandEnvelope(value);
  if (customEnvelope) return applyCustomTrackLifecycle(project, customEnvelope);
  const pointEnvelope = parseAttachedPointTrackLifecycleCommandEnvelope(value);
  if (pointEnvelope) return applyAttachedPointTrackLifecycle(project, pointEnvelope);
  const builtinEnvelope = parseBuiltinTrackLifecycleCommandEnvelope(value);
  if (builtinEnvelope) return applyBuiltinTrackLifecycle(project, builtinEnvelope);
  return { status: "invalid_command" };
}

function applyBuiltinTrackLifecycle(
  project: ProjectData,
  envelope: BuiltinTrackLifecycleCommandEnvelope,
): TrackStructureLifecycleApplyResult {
  const issues = [];
  for (const item of envelope.command.items) {
    const current = resolveBuiltinTrackLifecycleState(project, item.trackId);
    const idOccursInBuiltinTracks = project.builtinTracks.some((track) => track.id === item.trackId);
    const idOccursInActiveOrder = project.activeTrackOrder.includes(item.trackId);
    const invalidAbsentState = item.before === null && (idOccursInBuiltinTracks || idOccursInActiveOrder);
    if (invalidAbsentState || !areProjectValuesEqual(current, item.before)) {
      issues.push({
        code: current === null && item.before !== null ? "target_missing" as const : "before_mismatch" as const,
        targetKey: getTrackStructureLifecycleTargetKey(item),
      });
    }
  }
  if (issues.length > 0) return { status: "blocked", issues };

  // 内建轨实体与活动排序必须作为一个原子容器变化恢复，避免删除后留下不可见的幽灵排序项。
  const builtinTracks = rebuildCollection(
    project.builtinTracks,
    envelope.command.items,
    (item) => item.before,
    (item) => item.after,
    (state) => restoreBuiltinTrackSnapshot(state.entity),
    (state) => state.entity.id,
  );
  const activeTrackOrder = rebuildStringCollection(
    project.activeTrackOrder,
    envelope.command.items,
    (item) => item.before?.activeTrackPosition ?? null,
    (item) => item.after?.activeTrackPosition ?? null,
    (item) => item.trackId,
  );
  if (!builtinTracks || !activeTrackOrder) return blockedResult(envelope.command.items);
  const nextProject = { ...project, builtinTracks: builtinTracks as BuiltinTrack[], activeTrackOrder };
  return validateTrackContainerIntegrity(nextProject)
    ? { status: "applied", project: nextProject, envelope }
    : blockedResult(envelope.command.items);
}

function applyCustomTrackLifecycle(
  project: ProjectData,
  envelope: CustomTrackLifecycleCommandEnvelope,
): TrackStructureLifecycleApplyResult {
  const issues = [];
  for (const item of envelope.command.items) {
    const current = resolveCustomTrackLifecycleState(project, item.trackId);
    const idOccursInCustomTracks = project.customTracks.some((track) => track.id === item.trackId);
    const idOccursInActiveOrder = project.activeTrackOrder.includes(item.trackId);
    const invalidAbsentState = item.before === null && (idOccursInCustomTracks || idOccursInActiveOrder);
    if (invalidAbsentState || !areProjectValuesEqual(current, item.before)) {
      issues.push({
        code: current === null && item.before !== null ? "target_missing" as const : "before_mismatch" as const,
        targetKey: getTrackStructureLifecycleTargetKey(item),
      });
    }
  }
  if (issues.length > 0) return { status: "blocked", issues };
  const customTracks = rebuildCollection(
    project.customTracks,
    envelope.command.items,
    (item) => item.before,
    (item) => item.after,
    (state) => restoreCustomTrackSnapshot(state.entity),
    (state) => state.entity.structure.id,
  );
  const activeTrackOrder = rebuildStringCollection(
    project.activeTrackOrder,
    envelope.command.items,
    (item) => item.before?.activeTrackPosition ?? null,
    (item) => item.after?.activeTrackPosition ?? null,
    (item) => item.trackId,
  );
  if (!customTracks || !activeTrackOrder) return blockedResult(envelope.command.items);
  const nextProject = { ...project, customTracks: customTracks as CustomTrack[], activeTrackOrder };
  return validateTrackContainerIntegrity(nextProject)
    ? { status: "applied", project: nextProject, envelope }
    : blockedResult(envelope.command.items);
}

function applyAttachedPointTrackLifecycle(
  project: ProjectData,
  envelope: AttachedPointTrackLifecycleCommandEnvelope,
): TrackStructureLifecycleApplyResult {
  const issues = [];
  for (const item of envelope.command.items) {
    const current = resolveAttachedPointTrackLifecycleContext(project, item);
    const occurrenceCount = [...project.builtinTracks, ...project.customTracks]
      .reduce((count, track) => count + track.attachedPointTracks
        .filter((pointTrack) => pointTrack.id === item.pointTrackId).length, 0);
    if (!current || (item.before.entity === null && occurrenceCount > 0) ||
      (item.before.entity !== null && occurrenceCount !== 1)) {
      issues.push({ code: "target_missing" as const, targetKey: getTrackStructureLifecycleTargetKey(item) });
    } else if (!areProjectValuesEqual(current, item.before)) {
      issues.push({ code: "before_mismatch" as const, targetKey: getTrackStructureLifecycleTargetKey(item) });
    }
  }
  if (issues.length > 0) return { status: "blocked", issues };

  const groups = new Map<string, AttachedPointTrackLifecycleUpdateItem[]>();
  for (const item of envelope.command.items) {
    const key = `${item.parentTrackType}:${item.parentTrackId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  let nextProject = project;
  for (const group of groups.values()) {
    const sample = group[0];
    const expandedValues = new Set(group.map((item) => item.after.parentAttachedPointTracksExpanded));
    if (expandedValues.size !== 1) return blockedResult(envelope.command.items);
    const expanded = group[0].after.parentAttachedPointTracksExpanded;
    if (sample.parentTrackType === "builtin") {
      const matches = nextProject.builtinTracks.filter((track) => track.id === sample.parentTrackId);
      if (matches.length !== 1) return blockedResult(envelope.command.items);
      const parent = matches[0];
      const attachedPointTracks = rebuildAttachedPointTrackCollection(parent.attachedPointTracks, group);
      if (!attachedPointTracks) return blockedResult(envelope.command.items);
      const { attachedPointTracksExpanded: _expanded, ...stableParent } = parent;
      nextProject = {
        ...nextProject,
        builtinTracks: nextProject.builtinTracks.map((track) => track.id === sample.parentTrackId
          ? {
              ...stableParent,
              attachedPointTracks,
              ...(expanded === null ? {} : { attachedPointTracksExpanded: expanded }),
            }
          : track),
      };
      continue;
    }
    const matches = nextProject.customTracks.filter((track) => track.id === sample.parentTrackId);
    if (matches.length !== 1) return blockedResult(envelope.command.items);
    const parent = matches[0];
    const attachedPointTracks = rebuildAttachedPointTrackCollection(parent.attachedPointTracks, group);
    if (!attachedPointTracks) return blockedResult(envelope.command.items);
    const { attachedPointTracksExpanded: _expanded, ...stableParent } = parent;
    nextProject = {
      ...nextProject,
      customTracks: nextProject.customTracks.map((track) => track.id === sample.parentTrackId
        ? {
            ...stableParent,
            attachedPointTracks,
            ...(expanded === null ? {} : { attachedPointTracksExpanded: expanded }),
          } as CustomTrack
        : track) as CustomTrack[],
    };
  }
  return validateTrackContainerIntegrity(nextProject)
    ? { status: "applied", project: nextProject, envelope }
    : blockedResult(envelope.command.items);
}

// 结构事务会被 undo、草稿恢复和远端追赶重复应用，因此所有稳定 id 与轨道容器关系都必须无歧义。
export function validateTrackContainerIntegrity(project: ProjectData) {
  const builtinTrackIds = project.builtinTracks.map((track) => track.id);
  const customTrackIds = project.customTracks.map((track) => track.id);
  const allTrackIds = [...builtinTrackIds, ...customTrackIds];
  if (new Set(allTrackIds).size !== allTrackIds.length ||
    new Set(project.activeTrackOrder).size !== project.activeTrackOrder.length ||
    project.activeTrackOrder.length !== allTrackIds.length) return false;

  // 每条可编辑轨必须在活动排序中恰好出现一次；否则创建、删除及 inverse 无法恢复同一个逻辑位置。
  if (allTrackIds.some((trackId) =>
    project.activeTrackOrder.filter((activeId) => activeId === trackId).length !== 1)) return false;

  const allTracks = [...project.builtinTracks, ...project.customTracks];
  const pointTrackIds = allTracks
    .flatMap((track) => track.attachedPointTracks.map((pointTrack) => pointTrack.id));
  return new Set(pointTrackIds).size === pointTrackIds.length &&
    project.customTracks.every((track) =>
      new Set(track.blocks.map((block) => block.id)).size === track.blocks.length) &&
    allTracks.every((track) =>
      track.attachedPointTracks.every((pointTrack) =>
        new Set(pointTrack.points.map((point) => point.id)).size === pointTrack.points.length));
}

function rebuildAttachedPointTrackCollection(
  current: readonly AttachedPointTrack[],
  group: readonly AttachedPointTrackLifecycleUpdateItem[],
) {
  return rebuildCollection(
    current,
    group,
    (item) => item.before.entity,
    (item) => item.after.entity,
    (state) => restoreAttachedPointTrackSnapshot(state.entity),
    (state) => state.entity.id,
  );
}

// 删除先移除目标，创建再按最终位置落槽；相邻锚点验证可阻止把 stale 命令插入错误位置。
function rebuildCollection<
  TEntity extends { id: string },
  TItem,
  TState extends { entity: unknown; position?: TrackStructureCollectionPosition },
>(
  current: readonly TEntity[],
  items: readonly TItem[],
  beforeOf: (item: TItem) => TState | null,
  afterOf: (item: TItem) => TState | null,
  restore: (state: TState) => TEntity,
  idOf: (state: TState) => string,
): TEntity[] | null {
  const deletedIds = new Set(items.flatMap((item) => {
    const before = beforeOf(item);
    const after = afterOf(item);
    return before && !after ? [idOf(before)] : [];
  }));
  const remaining = current.filter((entity) => !deletedIds.has(entity.id));
  const creations = items.flatMap((item) => {
    const before = beforeOf(item);
    const after = afterOf(item);
    return after && !before ? [after] : [];
  });
  const finalLength = current.length - deletedIds.size + creations.length;
  const result: Array<TEntity | undefined> = Array(finalLength);
  for (const state of creations) {
    const position = getLifecycleCollectionPosition(state);
    if (!position || position.collectionLength !== finalLength || result[position.index]) return null;
    result[position.index] = restore(state);
  }
  let remainingIndex = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (!result[index]) result[index] = remaining[remainingIndex++];
  }
  if (remainingIndex !== remaining.length || result.some((entity) => !entity)) return null;
  const complete = result as TEntity[];
  for (const state of creations) {
    const position = getLifecycleCollectionPosition(state)!;
    const entity = restore(state);
    if (complete[position.index]?.id !== entity.id ||
      (complete[position.index - 1]?.id ?? null) !== position.previousEntityId ||
      (complete[position.index + 1]?.id ?? null) !== position.nextEntityId) return null;
  }
  return complete;
}

// 三类 lifecycle state 的集合位置字段不同；统一收口后，重建算法不再依赖不安全的调用方分支。
function getLifecycleCollectionPosition<TState extends { position?: TrackStructureCollectionPosition }>(
  state: TState,
) {
  if ("customTrackPosition" in state) {
    return (state as TState & { customTrackPosition: TrackStructureCollectionPosition }).customTrackPosition;
  }
  if ("builtinTrackPosition" in state) {
    return (state as TState & { builtinTrackPosition: TrackStructureCollectionPosition }).builtinTrackPosition;
  }
  return state.position;
}

function rebuildStringCollection<TItem>(
  current: readonly string[],
  items: readonly TItem[],
  beforeOf: (item: TItem) => TrackStructureCollectionPosition | null,
  afterOf: (item: TItem) => TrackStructureCollectionPosition | null,
  idOf: (item: TItem) => string,
): string[] | null {
  const deletedIds = new Set(items.flatMap((item) => beforeOf(item) && !afterOf(item) ? [idOf(item)] : []));
  const remaining = current.filter((id) => !deletedIds.has(id));
  const creations = items.filter((item) => afterOf(item) && !beforeOf(item));
  const finalLength = current.length - deletedIds.size + creations.length;
  const result: Array<string | undefined> = Array(finalLength);
  for (const item of creations) {
    const position = afterOf(item)!;
    if (position.collectionLength !== finalLength || result[position.index]) return null;
    result[position.index] = idOf(item);
  }
  let remainingIndex = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (!result[index]) result[index] = remaining[remainingIndex++];
  }
  if (remainingIndex !== remaining.length || result.some((id) => !id)) return null;
  const complete = result as string[];
  for (const item of creations) {
    const position = afterOf(item)!;
    if (complete[position.index] !== idOf(item) ||
      (complete[position.index - 1] ?? null) !== position.previousEntityId ||
      (complete[position.index + 1] ?? null) !== position.nextEntityId) return null;
  }
  return complete;
}

function restoreCustomTrackSnapshot(snapshot: CustomTrackLifecycleSnapshot): CustomTrack {
  const structureByBlock = new Map(snapshot.structure.blocks.map((block) => [block.id, block]));
  const blocks = snapshot.blocks.map((block) => {
    const structure = structureByBlock.get(block.id)!;
    const common = {
      id: block.id,
      startTime: block.startTime,
      endTime: block.endTime,
      type: block.type,
      ...(structure.branchScope ? { branchScope: structuredClone(structure.branchScope) } : {}),
      ...(structure.branchGroupId ? { branchGroupId: structure.branchGroupId } : {}),
      ...(structure.branchParentBlockId ? { branchParentBlockId: structure.branchParentBlockId } : {}),
    };
    return snapshot.structure.trackType === "text" ? { ...common, text: block.text! } : common;
  });
  const structure = snapshot.structure;
  return {
    id: structure.id,
    name: structure.name,
    trackType: structure.trackType,
    typeOptions: [...structure.typeOptions],
    blocks,
    attachedPointTracks: snapshot.attachedPointTracks.map(restoreAttachedPointTrackSnapshot),
    ...(structure.color ? { color: structure.color } : {}),
    ...(structure.attachedPointTracksExpanded === null
      ? {}
      : { attachedPointTracksExpanded: structure.attachedPointTracksExpanded }),
    ...(structure.snapToWaveformKeypoints === null
      ? {}
      : { snapToWaveformKeypoints: structure.snapToWaveformKeypoints }),
    ...(structure.autoSetLoopRangeOnSelect === null
      ? {}
      : { autoSetLoopRangeOnSelect: structure.autoSetLoopRangeOnSelect }),
    ...(structure.branching
      ? {
          branching: {
            enabled: structure.branching.enabled,
            ...(structure.branching.rootLabel === null ? {} : { rootLabel: structure.branching.rootLabel }),
            displayMode: structure.branching.displayMode,
            lanes: structure.branching.lanes.map(restoreBranchLane),
          },
        }
      : {}),
  } as CustomTrack;
}

function restoreAttachedPointTrackSnapshot(snapshot: AttachedPointTrackSnapshot): AttachedPointTrack {
  return {
    id: snapshot.id,
    name: snapshot.name,
    typeOptions: [...snapshot.typeOptions],
    points: snapshot.points.map((point) => ({ ...point })),
    ...(snapshot.snapToWaveformKeypoints === null ? {} : { snapToWaveformKeypoints: snapshot.snapToWaveformKeypoints }),
    ...(snapshot.snapToParentBoundaries === null ? {} : { snapToParentBoundaries: snapshot.snapToParentBoundaries }),
    ...(snapshot.autoSetLoopRangeOnSelect === null ? {} : { autoSetLoopRangeOnSelect: snapshot.autoSetLoopRangeOnSelect }),
  };
}

function restoreBuiltinTrackSnapshot(snapshot: BuiltinTrackLifecycleSnapshot): BuiltinTrack {
  return {
    id: snapshot.id as BuiltinTrack["id"],
    name: snapshot.name,
    type: snapshot.trackType,
    // 旧命令可能仍携带内建逐字轨 options；v6 已由项目级角色配置接管，恢复时明确忽略。
    attachedPointTracks: snapshot.attachedPointTracks.map(restoreAttachedPointTrackSnapshot),
    ...(snapshot.attachedPointTracksExpanded === null
      ? {}
      : { attachedPointTracksExpanded: snapshot.attachedPointTracksExpanded }),
    ...(snapshot.snapToWaveformKeypoints === null
      ? {}
      : { snapToWaveformKeypoints: snapshot.snapToWaveformKeypoints }),
    ...(snapshot.autoSetLoopRangeOnSelect === null
      ? {}
      : { autoSetLoopRangeOnSelect: snapshot.autoSetLoopRangeOnSelect }),
  };
}

function restoreBranchLane(lane: CustomTrackStructureBranchLane): BranchLane {
  return {
    id: lane.id,
    name: lane.name,
    parentId: lane.parentId,
    ...(lane.color ? { color: lane.color } : {}),
    children: lane.children.map(restoreBranchLane),
  };
}

function blockedResult(
  items: readonly (
    CustomTrackLifecycleUpdateItem |
    AttachedPointTrackLifecycleUpdateItem |
    BuiltinTrackLifecycleUpdateItem
  )[],
): TrackStructureLifecycleApplyResult {
  return {
    status: "blocked",
    issues: items.map((item) => ({
      code: "result_invalid" as const,
      targetKey: getTrackStructureLifecycleTargetKey(item),
    })),
  };
}
