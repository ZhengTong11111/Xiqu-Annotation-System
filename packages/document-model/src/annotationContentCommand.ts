import {
  buildAnnotationContentUpdateEnvelope,
  getAnnotationContentTargetKey,
  type AnnotationContentCommandEnvelope,
  type AnnotationContentUpdateItem,
} from "@xiqu/shared";
import type { CustomTrack, ProjectData } from "./projectData.js";
import { areProjectValuesEqual } from "./projectValueEquality.js";

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
  const envelope = buildProjectAnnotationContentEnvelope(baseProject, nextProject, targets);
  if (!envelope) return null;
  const reconstructedProject = applyAnnotationContentItems(baseProject, envelope.command.items);
  return areProjectValuesEqual(reconstructedProject, nextProject) ? envelope : null;
}

// 依赖事务复用同一 before/after 提取器；完整项目覆盖证明由 transaction builder 统一执行。
export function buildProjectAnnotationContentEnvelope(
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
  return envelope;
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
    const character = project.characterAnnotations.find((item) => item.id === target.entityId);
    if (!character) return null;
    return target.field === "singingStyle" ? character.singingStyle : character.char;
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
    characterAnnotations: updates.characterChars.size === 0 && updates.characterSingingStyles.size === 0
      ? project.characterAnnotations
      : project.characterAnnotations.map((item) => {
          const char = updates.characterChars.get(item.id);
          const singingStyle = updates.characterSingingStyles.get(item.id);
          return char === undefined && singingStyle === undefined
            ? item
            : {
                ...item,
                ...(char === undefined ? {} : { char }),
                ...(singingStyle === undefined ? {} : { singingStyle }),
              };
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
    characterChars: new Map<string, string>(),
    characterSingingStyles: new Map<string, string>(),
    actions: new Map<string, string>(),
    customBlockText: new Map<string, string>(),
    customBlockType: new Map<string, string>(),
    attachedPoints: new Map<string, string>(),
  };
  for (const item of items) {
    if (item.entityType === "sentence") groups.sentences.set(item.entityId, item.after);
    else if (item.entityType === "character") {
      if (item.field === "singingStyle") groups.characterSingingStyles.set(item.entityId, item.after);
      else groups.characterChars.set(item.entityId, item.after);
    }
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

function assertNever(value: never): never {
  throw new Error(`未处理的内容目标：${JSON.stringify(value)}`);
}
