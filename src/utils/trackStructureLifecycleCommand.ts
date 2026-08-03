import {
  buildAttachedPointTrackLifecycleUpdateEnvelope,
  buildBuiltinTrackLifecycleUpdateEnvelope,
  buildCustomTrackLifecycleUpdateEnvelope,
  type AttachedPointTrackLifecycleCommandEnvelope,
  type AttachedPointTrackLifecycleContext,
  type AttachedPointTrackSnapshot,
  type BuiltinTrackLifecycleCommandEnvelope,
  type BuiltinTrackLifecycleSnapshot,
  type BuiltinTrackLifecycleState,
  type CustomTrackLifecycleCommandEnvelope,
  type CustomTrackLifecycleSnapshot,
  type CustomTrackLifecycleState,
  type TrackStructureCollectionPosition,
} from "@xiqu/shared";
import type { AttachedPointTrack, BuiltinTrack, CustomTrack, ProjectData } from "../types";
import { createCustomTrackStructureSnapshot } from "./customTrackStructureCommand";

export type CustomTrackLifecycleTarget = { trackId: string };
export type BuiltinTrackLifecycleTarget = { trackId: string };

export type AttachedPointTrackLifecycleTarget = {
  pointTrackId: string;
  parentTrackId: string;
  parentTrackType: "builtin" | "custom";
};

export function buildProjectCustomTrackLifecycleEnvelope(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly CustomTrackLifecycleTarget[],
): CustomTrackLifecycleCommandEnvelope | null {
  const items = [];
  for (const target of new Map(targets.map((item) => [item.trackId, item])).values()) {
    const before = resolveCustomTrackLifecycleState(baseProject, target.trackId);
    const after = resolveCustomTrackLifecycleState(nextProject, target.trackId);
    // null 既可能表示真正不存在，也可能表示 customTracks / activeTrackOrder 已经失配；
    // builder 必须先区分两者，不能把畸形项目误编码成合法的创建或删除命令。
    if (!matchesResolvedCustomTrackPresence(baseProject, target.trackId, before) ||
      !matchesResolvedCustomTrackPresence(nextProject, target.trackId, after)) return null;
    items.push({ trackId: target.trackId, before, after });
  }
  return buildCustomTrackLifecycleUpdateEnvelope(items);
}

export function buildProjectAttachedPointTrackLifecycleEnvelope(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AttachedPointTrackLifecycleTarget[],
): AttachedPointTrackLifecycleCommandEnvelope | null {
  const unique = new Map(targets.map((target) => [
    `${target.parentTrackType}:${target.parentTrackId}:${target.pointTrackId}`,
    target,
  ]));
  const items = [];
  for (const target of unique.values()) {
    const before = resolveAttachedPointTrackLifecycleContext(baseProject, target);
    const after = resolveAttachedPointTrackLifecycleContext(nextProject, target);
    // 点轨 id 在整个项目内唯一。若同一 id 已落在其他父轨，局部父轨快照看似“缺失”也不能视为创建。
    if (!before || !after ||
      !matchesResolvedPointTrackPresence(baseProject, target.pointTrackId, before.entity !== null) ||
      !matchesResolvedPointTrackPresence(nextProject, target.pointTrackId, after.entity !== null)) return null;
    items.push({
      pointTrackId: target.pointTrackId,
      parentTrackId: target.parentTrackId,
      parentTrackType: target.parentTrackType,
      before,
      after,
    });
  }
  return buildAttachedPointTrackLifecycleUpdateEnvelope(items);
}

export function buildProjectBuiltinTrackLifecycleEnvelope(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly BuiltinTrackLifecycleTarget[],
): BuiltinTrackLifecycleCommandEnvelope | null {
  const items = [];
  for (const target of new Map(targets.map((item) => [item.trackId, item])).values()) {
    const before = resolveBuiltinTrackLifecycleState(baseProject, target.trackId);
    const after = resolveBuiltinTrackLifecycleState(nextProject, target.trackId);
    // 内建轨也必须同时且唯一存在于实体集合与活动顺序；畸形容器不能被解释成正常创建/删除。
    if (!matchesResolvedBuiltinTrackPresence(baseProject, target.trackId, before) ||
      !matchesResolvedBuiltinTrackPresence(nextProject, target.trackId, after)) return null;
    items.push({ trackId: target.trackId, before, after });
  }
  return buildBuiltinTrackLifecycleUpdateEnvelope(items);
}

export function resolveCustomTrackLifecycleState(
  project: ProjectData,
  trackId: string,
): CustomTrackLifecycleState | null {
  const trackIndexes = findIndexes(project.customTracks, trackId);
  const activeIndexes = findStringIndexes(project.activeTrackOrder, trackId);
  if (trackIndexes.length === 0 && activeIndexes.length === 0) return null;
  if (trackIndexes.length !== 1 || activeIndexes.length !== 1) return null;
  const trackIndex = trackIndexes[0];
  const activeIndex = activeIndexes[0];
  return {
    entity: createCustomTrackLifecycleSnapshot(project.customTracks[trackIndex]),
    customTrackPosition: createCollectionPosition(project.customTracks, trackIndex),
    activeTrackPosition: createStringCollectionPosition(project.activeTrackOrder, activeIndex),
  };
}

export function resolveAttachedPointTrackLifecycleContext(
  project: ProjectData,
  target: AttachedPointTrackLifecycleTarget,
): AttachedPointTrackLifecycleContext | null {
  const parents = target.parentTrackType === "builtin"
    ? project.builtinTracks.filter((track) => track.id === target.parentTrackId)
    : project.customTracks.filter((track) => track.id === target.parentTrackId);
  if (parents.length !== 1) return null;
  const parent = parents[0];
  const indexes = findIndexes(parent.attachedPointTracks, target.pointTrackId);
  if (indexes.length > 1) return null;
  const index = indexes[0];
  return {
    entity: index === undefined
      ? null
      : {
          entity: createAttachedPointTrackSnapshot(parent.attachedPointTracks[index]),
          position: createCollectionPosition(parent.attachedPointTracks, index),
        },
    parentAttachedPointTracksExpanded: parent.attachedPointTracksExpanded ?? null,
  };
}

export function resolveBuiltinTrackLifecycleState(
  project: ProjectData,
  trackId: string,
): BuiltinTrackLifecycleState | null {
  const trackIndexes = findIndexes(project.builtinTracks, trackId);
  const activeIndexes = findStringIndexes(project.activeTrackOrder, trackId);
  if (trackIndexes.length === 0 && activeIndexes.length === 0) return null;
  if (trackIndexes.length !== 1 || activeIndexes.length !== 1) return null;
  const trackIndex = trackIndexes[0];
  const activeIndex = activeIndexes[0];
  const entity = createBuiltinTrackLifecycleSnapshot(project.builtinTracks[trackIndex]);
  if (!entity) return null;
  return {
    entity,
    builtinTrackPosition: createCollectionPosition(project.builtinTracks, trackIndex),
    activeTrackPosition: createStringCollectionPosition(project.activeTrackOrder, activeIndex),
  };
}

// 整轨 lifecycle 快照保存其拥有子树；根级工尺/板眼仍由结构事务中的独立命令表达。
export function createCustomTrackLifecycleSnapshot(track: CustomTrack): CustomTrackLifecycleSnapshot {
  return {
    structure: createCustomTrackStructureSnapshot(track),
    blocks: track.blocks.map((block) => ({
      id: block.id,
      startTime: block.startTime,
      endTime: block.endTime,
      text: "text" in block ? block.text : null,
      type: block.type,
    })),
    attachedPointTracks: track.attachedPointTracks.map(createAttachedPointTrackSnapshot),
  };
}

export function createAttachedPointTrackSnapshot(track: AttachedPointTrack): AttachedPointTrackSnapshot {
  return {
    id: track.id,
    name: track.name,
    typeOptions: [...track.typeOptions],
    points: track.points.map((point) => ({ ...point })),
    snapToWaveformKeypoints: track.snapToWaveformKeypoints ?? null,
    snapToParentBoundaries: track.snapToParentBoundaries ?? null,
    autoSetLoopRangeOnSelect: track.autoSetLoopRangeOnSelect ?? null,
  };
}

// 内建轨 lifecycle 只拥有轨道配置和附属点子树；逐字/动作/工尺由有依赖顺序的普通 lifecycle child 表达。
export function createBuiltinTrackLifecycleSnapshot(track: BuiltinTrack): BuiltinTrackLifecycleSnapshot | null {
  // 当前文件合同只有逐字内建轨；历史畸形的 action 内建轨不能被伪装成可重放生命周期命令。
  if (track.id !== "character-track" || track.type !== "character") return null;
  return {
    id: track.id,
    name: track.name,
    trackType: track.type,
    options: track.options ? [...track.options] : null,
    attachedPointTracks: track.attachedPointTracks.map(createAttachedPointTrackSnapshot),
    attachedPointTracksExpanded: track.attachedPointTracksExpanded ?? null,
    snapToWaveformKeypoints: track.snapToWaveformKeypoints ?? null,
    autoSetLoopRangeOnSelect: track.autoSetLoopRangeOnSelect ?? null,
  };
}

function createCollectionPosition<T extends { id: string }>(
  collection: readonly T[],
  index: number,
): TrackStructureCollectionPosition {
  return {
    index,
    collectionLength: collection.length,
    previousEntityId: collection[index - 1]?.id ?? null,
    nextEntityId: collection[index + 1]?.id ?? null,
  };
}

function createStringCollectionPosition(
  collection: readonly string[],
  index: number,
): TrackStructureCollectionPosition {
  return {
    index,
    collectionLength: collection.length,
    previousEntityId: collection[index - 1] ?? null,
    nextEntityId: collection[index + 1] ?? null,
  };
}

function findIndexes<T extends { id: string }>(collection: readonly T[], id: string) {
  return collection.flatMap((item, index) => item.id === id ? [index] : []);
}

function findStringIndexes(collection: readonly string[], id: string) {
  return collection.flatMap((item, index) => item === id ? [index] : []);
}

function matchesResolvedCustomTrackPresence(
  project: ProjectData,
  trackId: string,
  resolved: CustomTrackLifecycleState | null,
) {
  const trackCount = project.customTracks.filter((track) => track.id === trackId).length;
  const orderCount = project.activeTrackOrder.filter((id) => id === trackId).length;
  return resolved === null
    ? trackCount === 0 && orderCount === 0
    : trackCount === 1 && orderCount === 1;
}

function matchesResolvedBuiltinTrackPresence(
  project: ProjectData,
  trackId: string,
  resolved: BuiltinTrackLifecycleState | null,
) {
  const trackCount = project.builtinTracks.filter((track) => track.id === trackId).length;
  const orderCount = project.activeTrackOrder.filter((id) => id === trackId).length;
  return resolved === null
    ? trackCount === 0 && orderCount === 0
    : trackCount === 1 && orderCount === 1;
}

function matchesResolvedPointTrackPresence(
  project: ProjectData,
  pointTrackId: string,
  expectedPresent: boolean,
) {
  const occurrenceCount = [...project.builtinTracks, ...project.customTracks]
    .reduce((count, track) => count + track.attachedPointTracks
      .filter((pointTrack) => pointTrack.id === pointTrackId).length, 0);
  return occurrenceCount === (expectedPresent ? 1 : 0);
}
