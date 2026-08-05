export const MAX_BATCH_RESOURCE_SELECTION = 200;

export type ResourceSelectionNode = {
  id: string;
  parentId: string | null;
};

export type NormalizedResourceSelection = {
  rootIds: string[];
  collapsedDescendantIds: string[];
};

/**
 * 把同时包含父资源和后代资源的选择压缩成逻辑根。
 *
 * 移动或移入回收站时，后代会自然跟随已选中的祖先。若再单独处理后代，会破坏子树内部关系，
 * 也会让权限、审计和并发校验产生歧义。这里不依赖具体 mutation，可由所有资源树批处理复用。
 */
export function normalizeResourceSelection(
  requestedIds: readonly string[],
  nodes: readonly ResourceSelectionNode[],
): NormalizedResourceSelection {
  const uniqueIds = [...new Set(requestedIds)];
  const selectedIds = new Set(uniqueIds);
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const rootIds: string[] = [];
  const collapsedDescendantIds: string[] = [];

  for (const resourceId of uniqueIds) {
    let parentId = parentById.get(resourceId) ?? null;
    let hasSelectedAncestor = false;
    const visited = new Set<string>();

    while (parentId) {
      // 数据异常不应让批处理陷入无限循环；真正的树一致性仍由 service 和数据库约束负责。
      if (visited.has(parentId)) break;
      visited.add(parentId);
      if (selectedIds.has(parentId)) {
        hasSelectedAncestor = true;
        break;
      }
      parentId = parentById.get(parentId) ?? null;
    }

    if (hasSelectedAncestor) collapsedDescendantIds.push(resourceId);
    else rootIds.push(resourceId);
  }

  return { rootIds, collapsedDescendantIds };
}
