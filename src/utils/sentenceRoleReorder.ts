export type SentenceRoleDropEdge = "before" | "after";

/**
 * 角色拖拽以唯一名称定位当前列表，而不是持有拖拽开始时的旧索引。
 * 返回 null 表示来源/目标已经失效，或落点换算后顺序没有变化。
 */
export function reorderSentenceRoleOptions(
  roleOptions: readonly string[],
  sourceRole: string,
  targetRole: string,
  edge: SentenceRoleDropEdge,
): string[] | null {
  const sourceIndex = roleOptions.indexOf(sourceRole);
  const targetIndex = roleOptions.indexOf(targetRole);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return null;

  // 先按原数组计算目标缝隙；来源位于缝隙之前时，删除来源会让最终索引左移一位。
  const insertionIndex = targetIndex + (edge === "after" ? 1 : 0);
  const finishIndex = insertionIndex - (sourceIndex < insertionIndex ? 1 : 0);
  if (finishIndex === sourceIndex) return null;

  // 拖拽行为由 Atlaskit 接管；这里只保留无副作用的数组排序，避免业务测试依赖浏览器入口。
  const reorderedOptions = [...roleOptions];
  const [movedRole] = reorderedOptions.splice(sourceIndex, 1);
  reorderedOptions.splice(finishIndex, 0, movedRole);
  return reorderedOptions;
}
