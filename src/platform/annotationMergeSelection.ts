import type {
  AnnotationDiffEntry,
  AnnotationDiffGroup,
  AnnotationDiffResult,
} from "./annotationDiff";
import type { AnnotationMergeDirection } from "./annotationMergePlan";
import { getAnnotationDiffEntryKey } from "./annotationDiffTimeline";

// 分组选择状态集中计算，React 只负责把 checked/indeterminate 映射到原生 checkbox。
export type AnnotationMergeGroupSelectionState = {
  selectableCount: number;
  selectedCount: number;
  checked: boolean;
  indeterminate: boolean;
};

// 可选性由真实来源侧决定；未变化实体只作为自动依赖，不扩大用户的显式选择面。
export function isMergeEntrySelectable(
  entry: AnnotationDiffEntry,
  direction: AnnotationMergeDirection,
) {
  if (entry.domain === "project" || entry.changeType === "unchanged") {
    return false;
  }
  if (direction === "left-to-right") return entry.changeType !== "added";
  return entry.changeType !== "removed";
}

// 方向切换或 diff 重载后裁剪幽灵 key，并保留新方向仍有真实来源的选择。
export function normalizeMergeSelection(
  diff: AnnotationDiffResult,
  direction: AnnotationMergeDirection,
  selectedEntryKeys: ReadonlySet<string> | readonly string[],
) {
  const selectableKeys = new Set<string>();
  for (const group of diff.groups) {
    for (const entry of group.entries) {
      if (isMergeEntrySelectable(entry, direction)) {
        selectableKeys.add(getAnnotationDiffEntryKey(entry));
      }
    }
  }
  return new Set([...selectedEntryKeys]
    .filter((entryKey) => selectableKeys.has(entryKey))
    .sort());
}

// 单项选择使用不可变 Set，避免 checkbox 事件原地修改 React state。
export function setMergeEntrySelection(
  current: ReadonlySet<string>,
  entryKey: string,
  selected: boolean,
) {
  const next = new Set(current);
  if (selected) next.add(entryKey);
  else next.delete(entryKey);
  return next;
}

// 分组批选只作用于该组当前方向可用的变化实体，不受 Canvas 领域/变化筛选影响。
export function setMergeGroupSelection(
  current: ReadonlySet<string>,
  group: AnnotationDiffGroup,
  direction: AnnotationMergeDirection,
  selected: boolean,
) {
  const next = new Set(current);
  for (const entry of group.entries) {
    if (!isMergeEntrySelectable(entry, direction)) continue;
    const entryKey = getAnnotationDiffEntryKey(entry);
    if (selected) next.add(entryKey);
    else next.delete(entryKey);
  }
  return next;
}

// checked 与 indeterminate 由同一组可选条目推导，避免 JSX 分别计算造成状态不一致。
export function getMergeGroupSelectionState(
  selectedEntryKeys: ReadonlySet<string>,
  group: AnnotationDiffGroup,
  direction: AnnotationMergeDirection,
): AnnotationMergeGroupSelectionState {
  const selectableKeys = group.entries
    .filter((entry) => isMergeEntrySelectable(entry, direction))
    .map(getAnnotationDiffEntryKey);
  const selectedCount = selectableKeys.filter((entryKey) =>
    selectedEntryKeys.has(entryKey)).length;
  return {
    selectableCount: selectableKeys.length,
    selectedCount,
    checked: selectableKeys.length > 0 && selectedCount === selectableKeys.length,
    indeterminate: selectedCount > 0 && selectedCount < selectableKeys.length,
  };
}
