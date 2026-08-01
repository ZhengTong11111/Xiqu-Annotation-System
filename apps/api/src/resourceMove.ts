export const MAX_BATCH_MOVE_RESOURCES = 200;

export type MoveSelectionNode = {
  id: string;
  parentId: string | null;
};

export type NormalizedMoveSelection = {
  rootIds: string[];
  collapsedDescendantIds: string[];
};

/**
 * 把包含父子节点的选择压缩成逻辑根。
 *
 * 资源管理器允许用户同时选中目录及其后代。后代会自然随父目录移动，若再单独更新后代，
 * 不但会破坏原有树形关系，还会让权限和同名检查产生歧义。因此这里沿父链寻找最近的已选祖先，
 * 服务层只对没有已选祖先的节点执行移动。
 */
export function normalizeMoveSelection(
  requestedIds: readonly string[],
  nodes: readonly MoveSelectionNode[],
): NormalizedMoveSelection {
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
      // 数据库约束之外再做防御，避免异常树结构让请求陷入无限循环。
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
