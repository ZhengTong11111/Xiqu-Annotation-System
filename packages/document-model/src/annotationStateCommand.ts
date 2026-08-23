import {
  buildAnnotationStateUpdateEnvelope,
  getAnnotationStateTargetKey,
  type BanyanMarkStateSnapshot,
  type BanyanSectionStateSnapshot,
  type GongcheSymbolLifecycleSnapshot,
  type SentenceAnnotationConfigStateSnapshot,
  type AnnotationStateCommandEnvelope,
  type AnnotationStateUpdateItem,
} from "@xiqu/shared";
import type { ProjectData } from "./projectData.js";
import {
  createBanyanMarkSnapshot,
  createBanyanSectionSnapshot,
  createGongcheSymbolSnapshot,
  restoreBanyanMarkSnapshot,
  restoreBanyanSectionSnapshot,
  restoreGongcheSymbolSnapshot,
} from "./annotationCompositeSnapshots.js";
import { validateBanyanGongcheReferences } from "./banyanReferenceIntegrity.js";
import { areProjectValuesEqual } from "./projectValueEquality.js";

export type AnnotationStateTarget =
  | { entityType: "sentence-annotation-config"; entityId: "sentence-annotation-config" }
  | { entityType: "gongche-symbol"; entityId: string; trackId: string }
  | { entityType: "banyan-section"; entityId: string }
  | { entityType: "banyan-mark"; entityId: string };

// 独立 state 命令仍须从 base 完整重建 next；事务则复用 envelope builder 并在更高层做总门禁。
export function buildProjectAnnotationStateCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AnnotationStateTarget[],
): AnnotationStateCommandEnvelope | null {
  const envelope = buildProjectAnnotationStateEnvelope(baseProject, nextProject, targets);
  if (!envelope) return null;
  const reconstructed = applyAnnotationStateItems(baseProject, envelope.command.items);
  return reconstructed && areProjectValuesEqual(reconstructed, nextProject) ? envelope : null;
}

export function buildProjectAnnotationStateEnvelope(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AnnotationStateTarget[],
): AnnotationStateCommandEnvelope | null {
  const uniqueTargets = new Map<string, AnnotationStateTarget>();
  for (const target of targets) uniqueTargets.set(getAnnotationStateTargetKey(target), target);
  const items: AnnotationStateUpdateItem[] = [];
  for (const target of uniqueTargets.values()) {
    if (target.entityType === "sentence-annotation-config") {
      const before = resolveProjectAnnotationState(baseProject, target);
      const after = resolveProjectAnnotationState(nextProject, target);
      items.push({ entityType: target.entityType, entityId: target.entityId, before, after });
    } else if (target.entityType === "gongche-symbol") {
      const before = resolveProjectAnnotationState(baseProject, target);
      const after = resolveProjectAnnotationState(nextProject, target);
      if (!before || !after) return null;
      items.push({ ...target, before, after });
    } else if (target.entityType === "banyan-section") {
      const before = resolveProjectAnnotationState(baseProject, target);
      const after = resolveProjectAnnotationState(nextProject, target);
      if (!before || !after) return null;
      items.push({ entityType: "banyan-section", entityId: target.entityId, before, after });
    } else {
      const before = resolveProjectAnnotationState(baseProject, target);
      const after = resolveProjectAnnotationState(nextProject, target);
      if (!before || !after) return null;
      items.push({ entityType: "banyan-mark", entityId: target.entityId, before, after });
    }
  }
  return buildAnnotationStateUpdateEnvelope(items);
}

// symbol 的 trackId 是父 Gongche block id；板眼实体则使用项目级稳定 id。
export function resolveProjectAnnotationState(
  project: ProjectData,
  target: Extract<AnnotationStateTarget, { entityType: "sentence-annotation-config" }>,
): SentenceAnnotationConfigStateSnapshot;
export function resolveProjectAnnotationState(
  project: ProjectData,
  target: Extract<AnnotationStateTarget, { entityType: "gongche-symbol" }>,
): GongcheSymbolLifecycleSnapshot | null;
export function resolveProjectAnnotationState(
  project: ProjectData,
  target: Extract<AnnotationStateTarget, { entityType: "banyan-section" }>,
): BanyanSectionStateSnapshot | null;
export function resolveProjectAnnotationState(
  project: ProjectData,
  target: Extract<AnnotationStateTarget, { entityType: "banyan-mark" }>,
): BanyanMarkStateSnapshot | null;
export function resolveProjectAnnotationState(
  project: ProjectData,
  target: AnnotationStateTarget,
): AnnotationStateUpdateItem["before"] | null;
export function resolveProjectAnnotationState(
  project: ProjectData,
  target: AnnotationStateTarget,
): AnnotationStateUpdateItem["before"] | null {
  if (target.entityType === "sentence-annotation-config") {
    return {
      id: "sentence-annotation-config",
      roleOptions: [...project.sentenceAnnotationConfig.roleOptions],
    };
  }
  if (target.entityType === "gongche-symbol") {
    const blocks = project.gongcheAnnotations.filter((block) => block.id === target.trackId);
    if (blocks.length !== 1) return null;
    const symbols = blocks[0].symbols.filter((symbol) => symbol.id === target.entityId);
    return symbols.length === 1 ? createGongcheSymbolSnapshot(symbols[0]) : null;
  }
  if (target.entityType === "banyan-section") {
    const sections = project.banyanSections.filter((section) => section.id === target.entityId);
    return sections.length === 1 ? createBanyanSectionSnapshot(sections[0]) : null;
  }
  const marks = project.banyanMarks.filter((mark) => mark.id === target.entityId);
  return marks.length === 1 ? createBanyanMarkSnapshot(marks[0]) : null;
}

// shared 已验证目标唯一；这里按实体类型一次映射集合，未涉及的集合保持原引用与原顺序。
export function applyAnnotationStateItems(
  project: ProjectData,
  items: readonly AnnotationStateUpdateItem[],
): ProjectData | null {
  const symbolUpdates = new Map<
    string,
    Map<string, Extract<AnnotationStateUpdateItem, { entityType: "gongche-symbol" }>>
  >();
  let sentenceConfigUpdate: Extract<AnnotationStateUpdateItem, { entityType: "sentence-annotation-config" }> | null = null;
  const sectionUpdates = new Map<string, Extract<AnnotationStateUpdateItem, { entityType: "banyan-section" }>>();
  const markUpdates = new Map<string, Extract<AnnotationStateUpdateItem, { entityType: "banyan-mark" }>>();
  for (const item of items) {
    if (item.entityType === "sentence-annotation-config") {
      sentenceConfigUpdate = item;
    } else if (item.entityType === "gongche-symbol") {
      // 使用两级 Map 保留两个稳定 id 的边界；字符串拼接会让含分隔符的合法 id 发生碰撞。
      const blockUpdates = symbolUpdates.get(item.trackId) ?? new Map();
      blockUpdates.set(item.entityId, item);
      symbolUpdates.set(item.trackId, blockUpdates);
    } else if (item.entityType === "banyan-section") sectionUpdates.set(item.entityId, item);
    else markUpdates.set(item.entityId, item);
  }

  let foundSymbolCount = 0;
  const expectedSymbolCount = [...symbolUpdates.values()].reduce((total, updates) => total + updates.size, 0);
  const gongcheAnnotations = symbolUpdates.size === 0
    ? project.gongcheAnnotations
    : project.gongcheAnnotations.map((block) => {
        const blockUpdates = symbolUpdates.get(block.id);
        if (!blockUpdates) return block;
        return {
          ...block,
          symbols: block.symbols.map((symbol) => {
            const update = blockUpdates.get(symbol.id);
            if (!update) return symbol;
            foundSymbolCount += 1;
            return restoreGongcheSymbolSnapshot(update.after);
          }),
        };
      });
  if (foundSymbolCount !== expectedSymbolCount) return null;

  const foundSections = new Set<string>();
  const banyanSections = sectionUpdates.size === 0
    ? project.banyanSections
    : project.banyanSections.map((section) => {
        const update = sectionUpdates.get(section.id);
        if (!update) return section;
        foundSections.add(section.id);
        return restoreBanyanSectionSnapshot(update.after);
      });
  if (foundSections.size !== sectionUpdates.size) return null;

  const foundMarks = new Set<string>();
  const banyanMarks = markUpdates.size === 0
    ? project.banyanMarks
    : project.banyanMarks.map((mark) => {
        const update = markUpdates.get(mark.id);
        if (!update) return mark;
        foundMarks.add(mark.id);
        return restoreBanyanMarkSnapshot(update.after);
      });
  if (foundMarks.size !== markUpdates.size) return null;

  const nextProject = {
    ...project,
    sentenceAnnotationConfig: sentenceConfigUpdate
      ? { roleOptions: [...sentenceConfigUpdate.after.roleOptions] }
      : project.sentenceAnnotationConfig,
    gongcheAnnotations,
    banyanSections,
    banyanMarks,
  };
  return validateBanyanGongcheReferences(nextProject) ? nextProject : null;
}
