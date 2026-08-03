import {
  buildAnnotationLifecycleUpdateEnvelope,
  getAnnotationLifecycleTargetKey,
  type AnnotationLifecycleCommandEnvelope,
  type AnnotationLifecycleState,
  type AnnotationLifecycleUpdateItem,
  type AttachedPointLifecycleSnapshot,
  type CustomBlockLifecycleSnapshot,
} from "@xiqu/shared";
import type {
  AttachedPointAnnotation,
  AttachedPointTrack,
  CustomTrack,
  ProjectData,
} from "../types";
import { areProjectValuesEqual } from "./projectValueEquality";

export type AnnotationLifecycleTarget = Pick<
  AnnotationLifecycleUpdateItem,
  "entityType" | "entityId" | "trackId"
>;

type LifecycleSnapshot = CustomBlockLifecycleSnapshot | AttachedPointLifecycleSnapshot;

type ResolvedLifecycleTarget<TSnapshot extends LifecycleSnapshot = LifecycleSnapshot> = {
  parentExists: boolean;
  ambiguous: boolean;
  current: AnnotationLifecycleState<TSnapshot> | null;
};

// UI 只声明稳定目标；builder 从 base/next 权威提取实体与位置，并用 apply 反证命令覆盖了完整项目差异。
export function buildProjectAnnotationLifecycleCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AnnotationLifecycleTarget[],
): AnnotationLifecycleCommandEnvelope | null {
  const uniqueTargets = new Map<string, AnnotationLifecycleTarget>();
  for (const target of targets) uniqueTargets.set(getAnnotationLifecycleTargetKey(target), target);
  const items: AnnotationLifecycleUpdateItem[] = [];
  for (const target of uniqueTargets.values()) {
    const before = resolveProjectAnnotationLifecycleTarget(baseProject, target);
    const after = resolveProjectAnnotationLifecycleTarget(nextProject, target);
    if (!before.parentExists || !after.parentExists || before.ambiguous || after.ambiguous ||
      (before.current === null) === (after.current === null)) return null;
    items.push(createLifecycleItem(target, before.current, after.current));
  }
  const envelope = buildAnnotationLifecycleUpdateEnvelope(items);
  if (!envelope) return null;
  const reconstructedProject = applyAnnotationLifecycleItems(baseProject, envelope.command.items);
  return reconstructedProject && areProjectValuesEqual(reconstructedProject, nextProject) ? envelope : null;
}

// resolver 同时确认父容器唯一性；重复 track id 或重复实体 id 都不能被“取第一个”掩盖。
export function resolveProjectAnnotationLifecycleTarget(
  project: ProjectData,
  target: AnnotationLifecycleTarget,
): ResolvedLifecycleTarget {
  if (target.entityType === "custom-block") {
    const tracks = project.customTracks.filter((track) => track.id === target.trackId);
    if (tracks.length !== 1) return { parentExists: false, ambiguous: tracks.length > 1, current: null };
    return resolveCollectionTarget(
      tracks[0].blocks,
      target.entityId,
      createCustomBlockSnapshot,
    );
  }

  const pointTracks = [...project.builtinTracks, ...project.customTracks]
    .flatMap((track) => track.attachedPointTracks)
    .filter((track) => track.id === target.trackId);
  if (pointTracks.length !== 1) {
    return { parentExists: false, ambiguous: pointTracks.length > 1, current: null };
  }
  return resolveCollectionTarget(pointTracks[0].points, target.entityId, createAttachedPointSnapshot);
}

// 已通过 shared parser/precondition 的 items 按父集合一次重建；任何集合计划失败都返回 null，不写半成品。
export function applyAnnotationLifecycleItems(
  project: ProjectData,
  items: readonly AnnotationLifecycleUpdateItem[],
): ProjectData | null {
  const customGroups = groupLifecycleItems(items, "custom-block");
  const pointGroups = groupLifecycleItems(items, "attached-point");
  const nextCustomBlocks = new Map<string, CustomTrack["blocks"]>();
  const nextPointCollections = new Map<string, AttachedPointAnnotation[]>();

  for (const [trackId, group] of customGroups) {
    const tracks = project.customTracks.filter((track) => track.id === trackId);
    if (tracks.length !== 1) return null;
    const rebuilt = rebuildLifecycleCollection<CustomTrack["blocks"][number], CustomBlockLifecycleSnapshot>(
      tracks[0].blocks,
      group,
      (state) => restoreCustomBlockSnapshot(tracks[0], state.entity),
    );
    if (!rebuilt) return null;
    nextCustomBlocks.set(trackId, rebuilt as CustomTrack["blocks"]);
  }

  const pointTrackOccurrences = collectPointTrackOccurrences(project);
  for (const [trackId, group] of pointGroups) {
    const occurrences = pointTrackOccurrences.get(trackId) ?? [];
    if (occurrences.length !== 1) return null;
    const rebuilt = rebuildLifecycleCollection<AttachedPointAnnotation, AttachedPointLifecycleSnapshot>(
      occurrences[0].pointTrack.points,
      group,
      (state) => ({ ...state.entity }),
    );
    if (!rebuilt) return null;
    nextPointCollections.set(trackId, rebuilt);
  }

  return {
    ...project,
    builtinTracks: nextPointCollections.size === 0
      ? project.builtinTracks
      : project.builtinTracks.map((track) => ({
          ...track,
          attachedPointTracks: replacePointCollections(track.attachedPointTracks, nextPointCollections),
        })),
    customTracks: project.customTracks.map((track) => ({
      ...track,
      blocks: nextCustomBlocks.get(track.id) ?? track.blocks,
      attachedPointTracks: replacePointCollections(track.attachedPointTracks, nextPointCollections),
    }) as CustomTrack),
  };
}

// 判别目标类型后收窄快照联合，避免把文字块状态错误装入附属点命令。
function createLifecycleItem(
  target: AnnotationLifecycleTarget,
  before: AnnotationLifecycleState<LifecycleSnapshot> | null,
  after: AnnotationLifecycleState<LifecycleSnapshot> | null,
): AnnotationLifecycleUpdateItem {
  if (target.entityType === "custom-block") {
    return {
      entityType: "custom-block",
      entityId: target.entityId,
      trackId: target.trackId,
      before: before as AnnotationLifecycleState<CustomBlockLifecycleSnapshot> | null,
      after: after as AnnotationLifecycleState<CustomBlockLifecycleSnapshot> | null,
    };
  }
  return {
    entityType: "attached-point",
    entityId: target.entityId,
    trackId: target.trackId,
    before: before as AnnotationLifecycleState<AttachedPointLifecycleSnapshot> | null,
    after: after as AnnotationLifecycleState<AttachedPointLifecycleSnapshot> | null,
  };
}

// 位置事实由目标所在集合现场生成，不由 UI 猜测；重复 id 标为 ambiguous 并拒绝命令。
function resolveCollectionTarget<TEntity extends { id: string }, TSnapshot extends LifecycleSnapshot>(
  collection: readonly TEntity[],
  entityId: string,
  createSnapshot: (entity: TEntity) => TSnapshot,
): ResolvedLifecycleTarget<TSnapshot> {
  const indexes = collection.flatMap((entity, index) => entity.id === entityId ? [index] : []);
  if (indexes.length === 0) return { parentExists: true, ambiguous: false, current: null };
  if (indexes.length !== 1) return { parentExists: true, ambiguous: true, current: null };
  const index = indexes[0];
  return {
    parentExists: true,
    ambiguous: false,
    current: {
      entity: createSnapshot(collection[index]),
      position: {
        index,
        collectionLength: collection.length,
        previousEntityId: collection[index - 1]?.id ?? null,
        nextEntityId: collection[index + 1]?.id ?? null,
      },
    },
  };
}

// 块快照把运行时 optional 字段规范成 null，同时复制递归分叉归属数组。
function createCustomBlockSnapshot(
  block: CustomTrack["blocks"][number],
): CustomBlockLifecycleSnapshot {
  return {
    id: block.id,
    startTime: block.startTime,
    endTime: block.endTime,
    text: "text" in block ? block.text : null,
    type: block.type,
    branchScope: block.branchScope
      ? block.branchScope.mode === "lanes"
        ? { mode: "lanes", laneIds: [...block.branchScope.laneIds] }
        : { mode: "root" }
      : null,
    branchGroupId: block.branchGroupId ?? null,
    branchParentBlockId: block.branchParentBlockId ?? null,
  };
}

// 点快照只保留持久化实体字段，父轨身份由 lifecycle item 的 trackId 单独表达。
function createAttachedPointSnapshot(point: AttachedPointAnnotation): AttachedPointLifecycleSnapshot {
  return { id: point.id, time: point.time, label: point.label };
}

// 轨道类型决定 text 是否必需；命令快照与父轨类型矛盾时整批 apply 失败。
function restoreCustomBlockSnapshot(
  track: CustomTrack,
  snapshot: CustomBlockLifecycleSnapshot,
): CustomTrack["blocks"][number] | null {
  const common = {
    id: snapshot.id,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    type: snapshot.type,
    ...(snapshot.branchScope ? { branchScope: structuredClone(snapshot.branchScope) } : {}),
    ...(snapshot.branchGroupId ? { branchGroupId: snapshot.branchGroupId } : {}),
    ...(snapshot.branchParentBlockId ? { branchParentBlockId: snapshot.branchParentBlockId } : {}),
  };
  if (track.trackType === "text") return snapshot.text === null ? null : { ...common, text: snapshot.text };
  return snapshot.text === null ? common : null;
}

// 同一集合先删除全部 before 目标，再按 after 的最终 index 放入创建目标，避免多次 splice 引起索引漂移。
type LifecycleCollectionItem<TSnapshot extends LifecycleSnapshot> = {
  entityId: string;
  before: AnnotationLifecycleState<TSnapshot> | null;
  after: AnnotationLifecycleState<TSnapshot> | null;
};

function rebuildLifecycleCollection<TEntity extends { id: string }, TSnapshot extends LifecycleSnapshot>(
  current: readonly TEntity[],
  items: readonly LifecycleCollectionItem<TSnapshot>[],
  restoreEntity: (state: AnnotationLifecycleState<TSnapshot>) => TEntity | null,
): TEntity[] | null {
  const deletedIds = new Set(items.flatMap((item) => item.before && !item.after ? [item.entityId] : []));
  const remaining = current.filter((entity) => !deletedIds.has(entity.id));
  const creations = items.flatMap((item) => item.after && !item.before ? [item.after] : []);
  const finalLength = current.length - deletedIds.size + creations.length;
  const result: Array<TEntity | undefined> = Array(finalLength);
  for (const state of creations) {
    const entity = restoreEntity(state);
    if (!entity || result[state.position.index]) return null;
    result[state.position.index] = entity;
  }
  let remainingIndex = 0;
  for (let index = 0; index < result.length; index += 1) {
    if (!result[index]) result[index] = remaining[remainingIndex++];
  }
  if (remainingIndex !== remaining.length || result.some((entity) => !entity)) return null;
  const complete = result as TEntity[];
  for (const state of creations) {
    const index = state.position.index;
    if (state.position.collectionLength !== complete.length ||
      complete[index]?.id !== state.entity.id ||
      (complete[index - 1]?.id ?? null) !== state.position.previousEntityId ||
      (complete[index + 1]?.id ?? null) !== state.position.nextEntityId) return null;
  }
  return complete;
}

// 先按实体类型和父轨分组，确保每个集合只执行一次重建。
function groupLifecycleItems<TEntityType extends AnnotationLifecycleUpdateItem["entityType"]>(
  items: readonly AnnotationLifecycleUpdateItem[],
  entityType: TEntityType,
) {
  const groups = new Map<string, Extract<AnnotationLifecycleUpdateItem, { entityType: TEntityType }>[]>();
  for (const item of items) {
    if (item.entityType !== entityType) continue;
    const group = groups.get(item.trackId) ?? [];
    group.push(item as Extract<AnnotationLifecycleUpdateItem, { entityType: TEntityType }>);
    groups.set(item.trackId, group);
  }
  return groups;
}

type PointTrackOccurrence = { pointTrack: AttachedPointTrack };

// 附属点轨 id 必须在全项目唯一；保留全部 occurrence 才能识别并拒绝旧数据中的重复父轨。
function collectPointTrackOccurrences(project: ProjectData) {
  const result = new Map<string, PointTrackOccurrence[]>();
  for (const parentTrack of [...project.builtinTracks, ...project.customTracks]) {
    for (const pointTrack of parentTrack.attachedPointTracks) {
      const occurrences = result.get(pointTrack.id) ?? [];
      occurrences.push({ pointTrack });
      result.set(pointTrack.id, occurrences);
    }
  }
  return result;
}

// 已规划的 points 仅替换命中的附属点轨，其余轨道和设置保持原值。
function replacePointCollections(
  tracks: AttachedPointTrack[],
  replacements: ReadonlyMap<string, AttachedPointAnnotation[]>,
) {
  return tracks.map((track) => {
    const points = replacements.get(track.id);
    return points ? { ...track, points } : track;
  });
}
