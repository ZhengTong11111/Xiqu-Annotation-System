import type { ResourceEntry } from "@xiqu/shared";

export type ResourceRestoreFailure = {
  resource: ResourceEntry;
  error: unknown;
};

export type ResourceRestoreResult = {
  restored: ResourceEntry[];
  failed: ResourceRestoreFailure[];
};

export function orderResourcesForRestore(
  resources: ResourceEntry[],
): ResourceEntry[] {
  const selectedById = new Map(resources.map((resource) => [resource.id, resource]));
  const originalIndex = new Map(
    resources.map((resource, index) => [resource.id, index]),
  );
  const depthCache = new Map<string, number>();

  function selectedAncestorDepth(resource: ResourceEntry): number {
    const cached = depthCache.get(resource.id);
    if (cached !== undefined) return cached;

    let depth = 0;
    let parentId = resource.parentId;
    const visited = new Set([resource.id]);
    while (parentId && selectedById.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = selectedById.get(parentId)?.parentId ?? null;
    }
    depthCache.set(resource.id, depth);
    return depth;
  }

  // 父子项不能并发恢复：父目录仍在回收站时，子项必须失败。祖先优先可让一次多选符合用户预期。
  return resources
    .map((resource) => ({
      resource,
      depth: selectedAncestorDepth(resource),
      index: originalIndex.get(resource.id) ?? 0,
    }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .map(({ resource }) => resource);
}

export async function restoreResourcesSequentially(
  resources: ResourceEntry[],
  restoreResource: (resourceId: string) => Promise<ResourceEntry>,
): Promise<ResourceRestoreResult> {
  const result: ResourceRestoreResult = { restored: [], failed: [] };
  for (const resource of orderResourcesForRestore(resources)) {
    try {
      result.restored.push(await restoreResource(resource.id));
    } catch (error) {
      // 多选恢复采用可部分成功语义；一个名称冲突不应阻止其他互不相关的资源恢复。
      result.failed.push({ resource, error });
    }
  }
  return result;
}
