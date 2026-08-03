import {
  buildAnnotationContentUpdateEnvelope,
  getAnnotationContentTargetKey,
  type AnnotationContentCommandEnvelope,
  type AnnotationContentUpdateItem,
} from "@xiqu/shared";
import type { CustomTrack, ProjectData } from "../types";

// UI 只声明稳定目标身份，字符串 before/after 始终由 base/next ProjectData 权威读取。
export type AnnotationContentTarget = AnnotationContentUpdateItem extends infer TItem
  ? TItem extends AnnotationContentUpdateItem
    ? Omit<TItem, "before" | "after">
    : never
  : never;

// builder 从两份项目权威提取字符串，并验证命令重建的项目就是完整 next，合同外变化自动回退 snapshot。
export function buildProjectAnnotationContentCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AnnotationContentTarget[],
): AnnotationContentCommandEnvelope | null {
  const uniqueTargets = new Map<string, AnnotationContentTarget>();
  for (const target of targets) uniqueTargets.set(getAnnotationContentTargetKey(target), target);
  const items: AnnotationContentUpdateItem[] = [];
  for (const target of uniqueTargets.values()) {
    const before = resolveProjectAnnotationContent(baseProject, target);
    const after = resolveProjectAnnotationContent(nextProject, target);
    if (before === null || after === null) return null;
    items.push({ ...target, before, after } as AnnotationContentUpdateItem);
  }
  const envelope = buildAnnotationContentUpdateEnvelope(items);
  if (!envelope) return null;

  // builder 必须证明命令可以完整重建 next；若同一次编辑还改变了时间或结构，就回退 snapshot operation。
  const reconstructedProject = applyAnnotationContentItems(baseProject, envelope.command.items);
  return areProjectValuesEqual(reconstructedProject, nextProject) ? envelope : null;
}

// 每类稳定实体只在这一处解释内容字段，UI 和 apply 不各自猜测路径。
export function resolveProjectAnnotationContent(
  project: ProjectData,
  target: AnnotationContentTarget,
): string | null {
  if (target.entityType === "sentence") {
    return project.subtitleLines.find((item) => item.id === target.entityId)?.text ?? null;
  }
  if (target.entityType === "character") {
    return project.characterAnnotations.find((item) => item.id === target.entityId)?.char ?? null;
  }
  if (target.entityType === "action") {
    return project.actionAnnotations.find((item) =>
      item.id === target.entityId && item.trackId === target.trackId,
    )?.label ?? null;
  }
  if (target.entityType === "custom-block") {
    const track = project.customTracks.find((item) => item.id === target.trackId);
    const block = track?.blocks.find((item) => item.id === target.entityId);
    if (!block) return null;
    if (target.field === "type") return block.type;
    const text = "text" in block ? block.text : null;
    return typeof text === "string" ? text : null;
  }
  if (target.entityType === "attached-point") {
    const pointTrack = [...project.builtinTracks, ...project.customTracks]
      .flatMap((track) => track.attachedPointTracks)
      .find((item) => item.id === target.trackId);
    return pointTrack?.points.find((item) => item.id === target.entityId)?.label ?? null;
  }
  return assertNever(target);
}

// 已通过 shared parser 与 precondition 的内容项统一从这里写入，builder 和 replay 不得维护两套路径。
export function applyAnnotationContentItems(
  project: ProjectData,
  items: readonly AnnotationContentUpdateItem[],
): ProjectData {
  const updates = groupAnnotationContentUpdates(items);
  return {
    ...project,
    subtitleLines: updates.sentences.size === 0
      ? project.subtitleLines
      : project.subtitleLines.map((item) => {
          const text = updates.sentences.get(item.id);
          return text === undefined ? item : { ...item, text };
        }),
    characterAnnotations: updates.characters.size === 0
      ? project.characterAnnotations
      : project.characterAnnotations.map((item) => {
          const char = updates.characters.get(item.id);
          return char === undefined ? item : { ...item, char };
        }),
    actionAnnotations: updates.actions.size === 0
      ? project.actionAnnotations
      : project.actionAnnotations.map((item) => {
          const label = updates.actions.get(getScopedEntityKey(item.trackId, item.id));
          return label === undefined ? item : { ...item, label };
        }),
    builtinTracks: updates.attachedPoints.size === 0
      ? project.builtinTracks
      : project.builtinTracks.map((track) => ({
          ...track,
          attachedPointTracks: applyPointLabels(track.attachedPointTracks, updates.attachedPoints),
        })),
    customTracks: applyCustomTrackContent(project.customTracks, updates),
  };
}

type AnnotationContentUpdateGroups = ReturnType<typeof groupAnnotationContentUpdates>;

// 自定义块与附属点同属 customTracks；一次映射完成两类更新，避免后写结果覆盖前写结果。
function applyCustomTrackContent(
  tracks: CustomTrack[],
  updates: AnnotationContentUpdateGroups,
): CustomTrack[] {
  if (updates.customBlockText.size === 0 &&
    updates.customBlockType.size === 0 &&
    updates.attachedPoints.size === 0) return tracks;
  return tracks.map((track) => ({
    ...track,
    blocks: track.blocks.map((block) => {
      const key = getScopedEntityKey(track.id, block.id);
      const text = updates.customBlockText.get(key);
      const type = updates.customBlockType.get(key);
      return text === undefined && type === undefined
        ? block
        : {
            ...block,
            ...(text === undefined ? {} : { text }),
            ...(type === undefined ? {} : { type }),
          };
    }) as CustomTrack["blocks"],
    attachedPointTracks: applyPointLabels(track.attachedPointTracks, updates.attachedPoints),
  })) as CustomTrack[];
}

// 附属点可挂在内建轨或自定义轨下，但命令身份始终以 point-track id 为 scope。
function applyPointLabels<T extends { id: string; points: Array<{ id: string; label: string }> }>(
  tracks: T[],
  updates: Map<string, string>,
): T[] {
  if (updates.size === 0) return tracks;
  return tracks.map((track) => ({
    ...track,
    points: track.points.map((point) => {
      const label = updates.get(getScopedEntityKey(track.id, point.id));
      return label === undefined ? point : { ...point, label };
    }),
  }));
}

// shared 已保证命令目标不重复；这里仅按 ProjectData 集合分组，为不可变更新提供 O(1) 查找。
function groupAnnotationContentUpdates(items: readonly AnnotationContentUpdateItem[]) {
  const groups = {
    sentences: new Map<string, string>(),
    characters: new Map<string, string>(),
    actions: new Map<string, string>(),
    customBlockText: new Map<string, string>(),
    customBlockType: new Map<string, string>(),
    attachedPoints: new Map<string, string>(),
  };
  for (const item of items) {
    if (item.entityType === "sentence") groups.sentences.set(item.entityId, item.after);
    else if (item.entityType === "character") groups.characters.set(item.entityId, item.after);
    else if (item.entityType === "action") {
      groups.actions.set(getScopedEntityKey(item.trackId, item.entityId), item.after);
    } else if (item.entityType === "custom-block") {
      if (item.field === "text") {
        groups.customBlockText.set(getScopedEntityKey(item.trackId, item.entityId), item.after);
      } else {
        groups.customBlockType.set(getScopedEntityKey(item.trackId, item.entityId), item.after);
      }
    } else if (item.entityType === "attached-point") {
      groups.attachedPoints.set(getScopedEntityKey(item.trackId, item.entityId), item.after);
    } else assertNever(item);
  }
  return groups;
}

function getScopedEntityKey(trackId: string, entityId: string) {
  return `${trackId}:${entityId}`;
}

// ProjectData 是无环纯数据；引用相同的巨大媒体 URL 会立即返回，变化集合才递归比较。
function areProjectValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!areProjectValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length || leftKeys.some(
    (key) => !Object.prototype.hasOwnProperty.call(rightRecord, key),
  )) return false;
  return leftKeys.every((key) => areProjectValuesEqual(leftRecord[key], rightRecord[key]));
}

function assertNever(value: never): never {
  throw new Error(`未处理的内容目标：${JSON.stringify(value)}`);
}
