import {
  buildAnnotationLifecycleUpdateEnvelope,
  getAnnotationLifecycleTargetKey,
  type AnnotationLifecycleCommandEnvelope,
  type AnnotationLifecycleState,
  type AnnotationLifecycleUpdateItem,
  type AttachedPointLifecycleSnapshot,
  type CharacterLifecycleSnapshot,
  type CustomBlockLifecycleSnapshot,
  type GongcheBlockLifecycleSnapshot,
  type SentenceLifecycleSnapshot,
} from "@xiqu/shared";
import type {
  AttachedPointAnnotation,
  AttachedPointTrack,
  CharacterAnnotation,
  CustomTrack,
  GongcheAnnotation,
  ProjectData,
  SubtitleLine,
} from "../types";
import { areProjectValuesEqual } from "./projectValueEquality";

export type AnnotationLifecycleTarget = Pick<
  AnnotationLifecycleUpdateItem,
  "entityType" | "entityId" | "trackId"
>;

type LifecycleSnapshot =
  | SentenceLifecycleSnapshot
  | CharacterLifecycleSnapshot
  | CustomBlockLifecycleSnapshot
  | AttachedPointLifecycleSnapshot
  | GongcheBlockLifecycleSnapshot;

type ResolvedLifecycleTarget<TSnapshot extends LifecycleSnapshot = LifecycleSnapshot> = {
  parentExists: boolean;
  ambiguous: boolean;
  current: AnnotationLifecycleState<TSnapshot> | null;
};

// 独立 lifecycle 提交仍需证明覆盖完整项目差异；依赖事务使用下方 envelope builder 后由事务做总门禁。
export function buildProjectAnnotationLifecycleCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AnnotationLifecycleTarget[],
): AnnotationLifecycleCommandEnvelope | null {
  const envelope = buildProjectAnnotationLifecycleEnvelope(baseProject, nextProject, targets);
  if (!envelope) return null;
  const reconstructedProject = applyAnnotationLifecycleItems(baseProject, envelope.command.items);
  return reconstructedProject && areProjectValuesEqual(reconstructedProject, nextProject) ? envelope : null;
}

// 事务 builder 复用这一提取器生成单域事实；它不单独声称覆盖完整 next，避免复制实体快照逻辑。
export function buildProjectAnnotationLifecycleEnvelope(
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
    const item = createLifecycleItem(target, before.current, after.current);
    if (!item) return null;
    items.push(item);
  }
  return buildAnnotationLifecycleUpdateEnvelope(items);
}

// 每种实体只在这一处解释物理集合。全局集合没有可删除的父容器，引用完整性在批次重建后统一检查。
export function resolveProjectAnnotationLifecycleTarget(
  project: ProjectData,
  target: AnnotationLifecycleTarget,
): ResolvedLifecycleTarget {
  if (target.entityType === "sentence") {
    return resolveCollectionTarget(project.subtitleLines, target.entityId, createSentenceSnapshot);
  }
  if (target.entityType === "character") {
    return resolveCollectionTarget(project.characterAnnotations, target.entityId, createCharacterSnapshot);
  }
  if (target.entityType === "gongche-block") {
    const resolved = resolveCollectionTarget(project.gongcheAnnotations, target.entityId, createGongcheBlockSnapshot);
    if (resolved.current && resolved.current.entity.parentTrackId !== target.trackId) {
      return { parentExists: true, ambiguous: true, current: null };
    }
    return resolved;
  }
  if (target.entityType === "custom-block") {
    const tracks = project.customTracks.filter((track) => track.id === target.trackId);
    if (tracks.length !== 1) return { parentExists: false, ambiguous: tracks.length > 1, current: null };
    return resolveCollectionTarget(tracks[0].blocks, target.entityId, createCustomBlockSnapshot);
  }

  const pointTracks = [...project.builtinTracks, ...project.customTracks]
    .flatMap((track) => track.attachedPointTracks)
    .filter((track) => track.id === target.trackId);
  if (pointTracks.length !== 1) {
    return { parentExists: false, ambiguous: pointTracks.length > 1, current: null };
  }
  return resolveCollectionTarget(pointTracks[0].points, target.entityId, createAttachedPointSnapshot);
}

// 同一 lifecycle 批次先重建所有集合，再验证逐字→句和工尺→父块引用；父子可在同批创建或删除。
export function applyAnnotationLifecycleItems(
  project: ProjectData,
  items: readonly AnnotationLifecycleUpdateItem[],
): ProjectData | null {
  const sentenceItems = filterLifecycleItems(items, "sentence");
  const characterItems = filterLifecycleItems(items, "character");
  const gongcheItems = filterLifecycleItems(items, "gongche-block");
  const customGroups = groupScopedLifecycleItems(items, "custom-block");
  const pointGroups = groupScopedLifecycleItems(items, "attached-point");

  const subtitleLines = sentenceItems.length === 0
    ? project.subtitleLines
    : rebuildLifecycleCollection(project.subtitleLines, sentenceItems, (state) => ({ ...state.entity }));
  const characterAnnotations = characterItems.length === 0
    ? project.characterAnnotations
    : rebuildLifecycleCollection(project.characterAnnotations, characterItems, restoreCharacterSnapshot);
  const gongcheAnnotations = gongcheItems.length === 0
    ? project.gongcheAnnotations
    : rebuildLifecycleCollection(project.gongcheAnnotations, gongcheItems, restoreGongcheBlockSnapshot);
  if (!subtitleLines || !characterAnnotations || !gongcheAnnotations) return null;

  const nextCustomBlocks = new Map<string, CustomTrack["blocks"]>();
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

  const nextPointCollections = new Map<string, AttachedPointAnnotation[]>();
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

  const nextProject: ProjectData = {
    ...project,
    subtitleLines,
    characterAnnotations,
    gongcheAnnotations,
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
  return validateLifecycleReferences(nextProject) ? nextProject : null;
}

// 判别联合后组装对应快照，禁止通过不安全断言把全局实体误装入轨道作用域。
function createLifecycleItem(
  target: AnnotationLifecycleTarget,
  before: AnnotationLifecycleState<LifecycleSnapshot> | null,
  after: AnnotationLifecycleState<LifecycleSnapshot> | null,
): AnnotationLifecycleUpdateItem | null {
  if (target.entityType === "sentence") {
    return { entityType: "sentence", entityId: target.entityId,
      before: before as AnnotationLifecycleState<SentenceLifecycleSnapshot> | null,
      after: after as AnnotationLifecycleState<SentenceLifecycleSnapshot> | null };
  }
  if (target.entityType === "character") {
    return { entityType: "character", entityId: target.entityId,
      before: before as AnnotationLifecycleState<CharacterLifecycleSnapshot> | null,
      after: after as AnnotationLifecycleState<CharacterLifecycleSnapshot> | null };
  }
  if (!target.trackId) return null;
  if (target.entityType === "custom-block") {
    return { entityType: "custom-block", entityId: target.entityId, trackId: target.trackId,
      before: before as AnnotationLifecycleState<CustomBlockLifecycleSnapshot> | null,
      after: after as AnnotationLifecycleState<CustomBlockLifecycleSnapshot> | null };
  }
  if (target.entityType === "gongche-block") {
    return { entityType: "gongche-block", entityId: target.entityId, trackId: target.trackId,
      before: before as AnnotationLifecycleState<GongcheBlockLifecycleSnapshot> | null,
      after: after as AnnotationLifecycleState<GongcheBlockLifecycleSnapshot> | null };
  }
  return { entityType: "attached-point", entityId: target.entityId, trackId: target.trackId,
    before: before as AnnotationLifecycleState<AttachedPointLifecycleSnapshot> | null,
    after: after as AnnotationLifecycleState<AttachedPointLifecycleSnapshot> | null };
}

// 位置事实由目标集合现场生成；重复稳定 id 标为 ambiguous，不能悄悄采用第一个实体。
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

function createSentenceSnapshot(line: SubtitleLine): SentenceLifecycleSnapshot {
  return { ...line };
}

function createCharacterSnapshot(character: CharacterAnnotation): CharacterLifecycleSnapshot {
  return {
    id: character.id,
    lineId: character.lineId,
    char: character.char,
    startTime: character.startTime,
    endTime: character.endTime,
    singingStyle: character.singingStyle,
    tone: character.tone
      ? { toneClass: character.tone.toneClass, yxlzShangSubtype: character.tone.yxlzShangSubtype ?? null }
      : null,
  };
}

function createCustomBlockSnapshot(block: CustomTrack["blocks"][number]): CustomBlockLifecycleSnapshot {
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

function createAttachedPointSnapshot(point: AttachedPointAnnotation): AttachedPointLifecycleSnapshot {
  return { ...point };
}

function createGongcheBlockSnapshot(block: GongcheAnnotation): GongcheBlockLifecycleSnapshot {
  return {
    id: block.id,
    parentTrackId: block.parentTrackId,
    parentBlockId: block.parentBlockId,
    startTime: block.startTime,
    endTime: block.endTime,
    symbols: block.symbols.map((symbol) => ({
      id: symbol.id,
      label: symbol.label,
      notation: symbol.notation ?? null,
      rawText: symbol.rawText ?? null,
      parenthesized: symbol.parenthesized ?? false,
      startTime: symbol.startTime,
      endTime: symbol.endTime,
      assetUrl: symbol.assetUrl ?? null,
    })),
  };
}

function restoreCharacterSnapshot(state: AnnotationLifecycleState<CharacterLifecycleSnapshot>): CharacterAnnotation {
  const snapshot = state.entity;
  return {
    id: snapshot.id,
    lineId: snapshot.lineId,
    char: snapshot.char,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    singingStyle: snapshot.singingStyle,
    tone: snapshot.tone
      ? {
          toneClass: snapshot.tone.toneClass,
          ...(snapshot.tone.yxlzShangSubtype ? { yxlzShangSubtype: snapshot.tone.yxlzShangSubtype } : {}),
        }
      : null,
  };
}

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

function restoreGongcheBlockSnapshot(
  state: AnnotationLifecycleState<GongcheBlockLifecycleSnapshot>,
): GongcheAnnotation {
  const snapshot = state.entity;
  return {
    id: snapshot.id,
    parentTrackId: snapshot.parentTrackId,
    parentBlockId: snapshot.parentBlockId,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    symbols: snapshot.symbols.map((symbol) => ({
      id: symbol.id,
      label: symbol.label,
      notation: symbol.notation ?? "",
      rawText: symbol.rawText ?? symbol.label,
      parenthesized: symbol.parenthesized,
      startTime: symbol.startTime,
      endTime: symbol.endTime,
      assetUrl: symbol.assetUrl,
    })),
  };
}

// 同一集合一次完成全部删除与创建，避免多个 splice 使 inverse 的最终索引漂移。
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
    if (state.position.collectionLength !== complete.length || complete[index]?.id !== state.entity.id ||
      (complete[index - 1]?.id ?? null) !== state.position.previousEntityId ||
      (complete[index + 1]?.id ?? null) !== state.position.nextEntityId) return null;
  }
  return complete;
}

function filterLifecycleItems<TEntityType extends AnnotationLifecycleUpdateItem["entityType"]>(
  items: readonly AnnotationLifecycleUpdateItem[],
  entityType: TEntityType,
) {
  return items.filter((item): item is Extract<AnnotationLifecycleUpdateItem, { entityType: TEntityType }> =>
    item.entityType === entityType);
}

// 只有真正位于子集合中的实体按 trackId 分组；工尺块始终重建项目级 gongcheAnnotations 数组。
function groupScopedLifecycleItems(
  items: readonly AnnotationLifecycleUpdateItem[],
  entityType: "custom-block",
): Map<string, Extract<AnnotationLifecycleUpdateItem, { entityType: "custom-block" }>[]>;
function groupScopedLifecycleItems(
  items: readonly AnnotationLifecycleUpdateItem[],
  entityType: "attached-point",
): Map<string, Extract<AnnotationLifecycleUpdateItem, { entityType: "attached-point" }>[]>;
function groupScopedLifecycleItems(
  items: readonly AnnotationLifecycleUpdateItem[],
  entityType: "custom-block" | "attached-point",
) {
  type ScopedItem = Extract<AnnotationLifecycleUpdateItem, {
    entityType: "custom-block" | "attached-point";
  }>;
  const groups = new Map<string, ScopedItem[]>();
  for (const item of items) {
    if ((item.entityType !== "custom-block" && item.entityType !== "attached-point") ||
      item.entityType !== entityType) continue;
    const group = groups.get(item.trackId) ?? [];
    group.push(item);
    groups.set(item.trackId, group);
  }
  return groups;
}

// 批次完成后的引用图才是权威结果；父子同批删除不应被中间态误判为孤儿。
function validateLifecycleReferences(project: ProjectData) {
  const lineIds = new Set(project.subtitleLines.map((line) => line.id));
  if (lineIds.size !== project.subtitleLines.length ||
    new Set(project.characterAnnotations.map((character) => character.id)).size !== project.characterAnnotations.length ||
    project.characterAnnotations.some((character) => !lineIds.has(character.lineId))) return false;

  const gongcheIds = new Set(project.gongcheAnnotations.map((block) => block.id));
  if (gongcheIds.size !== project.gongcheAnnotations.length) return false;
  const characterIds = new Set(project.characterAnnotations.map((character) => character.id));
  const customTracks = new Map(project.customTracks.map((track) => [track.id, track]));
  return project.gongcheAnnotations.every((block) => {
    if (block.parentTrackId === "character-track") return characterIds.has(block.parentBlockId);
    const track = customTracks.get(block.parentTrackId);
    return Boolean(track?.blocks.some((candidate) => candidate.id === block.parentBlockId));
  });
}

type PointTrackOccurrence = { pointTrack: AttachedPointTrack };

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

function replacePointCollections(
  tracks: AttachedPointTrack[],
  replacements: ReadonlyMap<string, AttachedPointAnnotation[]>,
) {
  return tracks.map((track) => {
    const points = replacements.get(track.id);
    return points ? { ...track, points } : track;
  });
}
