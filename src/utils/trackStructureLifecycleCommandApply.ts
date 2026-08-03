import {
  getTrackStructureLifecycleTargetKey,
  parseAttachedPointTrackLifecycleCommandEnvelope,
  parseCustomTrackLifecycleCommandEnvelope,
  type AttachedPointTrackLifecycleCommandEnvelope,
  type AttachedPointTrackLifecycleUpdateItem,
  type AttachedPointTrackSnapshot,
  type CustomTrackStructureBranchLane,
  type CustomTrackLifecycleCommandEnvelope,
  type CustomTrackLifecycleSnapshot,
  type CustomTrackLifecycleUpdateItem,
  type TrackStructureCollectionPosition,
} from "@xiqu/shared";
import type { AttachedPointTrack, BranchLane, CustomTrack, ProjectData } from "../types";
import { areProjectValuesEqual } from "./projectValueEquality";
import {
  resolveAttachedPointTrackLifecycleContext,
  resolveCustomTrackLifecycleState,
} from "./trackStructureLifecycleCommand";

type StructureLifecycleEnvelope =
  | CustomTrackLifecycleCommandEnvelope
  | AttachedPointTrackLifecycleCommandEnvelope;

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
  return { status: "invalid_command" };
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
    new Set(project.activeTrackOrder).size !== project.activeTrackOrder.length) return false;

  // 每条自定义轨必须在活动排序中恰好出现一次；否则创建、删除及 inverse 无法恢复同一个逻辑位置。
  if (customTrackIds.some((trackId) =>
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
    const position = "customTrackPosition" in state
      ? (state as TState & { customTrackPosition: TrackStructureCollectionPosition }).customTrackPosition
      : state.position;
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
    const position = "customTrackPosition" in state
      ? (state as TState & { customTrackPosition: TrackStructureCollectionPosition }).customTrackPosition
      : state.position!;
    const entity = restore(state);
    if (complete[position.index]?.id !== entity.id ||
      (complete[position.index - 1]?.id ?? null) !== position.previousEntityId ||
      (complete[position.index + 1]?.id ?? null) !== position.nextEntityId) return null;
  }
  return complete;
}

function rebuildStringCollection(
  current: readonly string[],
  items: readonly CustomTrackLifecycleUpdateItem[],
  beforeOf: (item: CustomTrackLifecycleUpdateItem) => TrackStructureCollectionPosition | null,
  afterOf: (item: CustomTrackLifecycleUpdateItem) => TrackStructureCollectionPosition | null,
  idOf: (item: CustomTrackLifecycleUpdateItem) => string,
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
  items: readonly (CustomTrackLifecycleUpdateItem | AttachedPointTrackLifecycleUpdateItem)[],
): TrackStructureLifecycleApplyResult {
  return {
    status: "blocked",
    issues: items.map((item) => ({
      code: "result_invalid" as const,
      targetKey: getTrackStructureLifecycleTargetKey(item),
    })),
  };
}
