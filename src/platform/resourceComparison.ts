import type { ResourceEntry } from "@xiqu/shared";

// 比较命令只接受两个具备读取权限的标注文件，并保留用户实际选择的左右顺序。
export function getComparableAnnotationFiles(
  selectedIds: string[],
  availableResources: ResourceEntry[],
  options: {
    isTrashView: boolean;
    interactionDisabled: boolean;
  },
): [ResourceEntry, ResourceEntry] | null {
  if (
    options.isTrashView ||
    options.interactionDisabled ||
    selectedIds.length !== 2
  ) {
    return null;
  }

  // 通过 id 回放选择顺序，避免列表排序改变比较中的左、右文件。
  const byId = new Map(availableResources.map((resource) => [
    resource.id,
    resource,
  ]));
  const resources = selectedIds.map((id) => byId.get(id));
  if (resources.some((resource) => !resource)) return null;

  const [left, right] = resources as [ResourceEntry, ResourceEntry];
  if (
    left.type !== "annotation_file" ||
    right.type !== "annotation_file" ||
    !left.permission.capabilities.includes("read") ||
    !right.permission.capabilities.includes("read")
  ) {
    return null;
  }
  return [left, right];
}
