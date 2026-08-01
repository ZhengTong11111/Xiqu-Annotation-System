import type {
  ResourceBreadcrumb,
  ResourceEntry,
  ResourceListView,
} from "@xiqu/shared";

export type ResourceColumnDescriptor = {
  key: string;
  parentId: string | null;
  view: ResourceListView;
  openedByResourceId: string | null;
};

export function createRootResourceColumn(
  view: ResourceListView,
): ResourceColumnDescriptor {
  return {
    key: `root:${view}`,
    parentId: null,
    view,
    openedByResourceId: null,
  };
}

export function createChildResourceColumn(
  resourceId: string,
): ResourceColumnDescriptor {
  return {
    key: `children:${resourceId}`,
    parentId: resourceId,
    view: "children",
    openedByResourceId: resourceId,
  };
}

export function buildResourceColumnPath(
  view: ResourceListView,
  breadcrumbs: ResourceBreadcrumb[],
): ResourceColumnDescriptor[] {
  const columns = [createRootResourceColumn(view)];
  for (const breadcrumb of breadcrumbs) {
    if (!isResourceContainer(breadcrumb)) continue;
    columns.push(createChildResourceColumn(breadcrumb.id));
  }
  return columns;
}

export function updateResourceColumnPath(
  columns: ResourceColumnDescriptor[],
  columnIndex: number,
  resource: Pick<ResourceEntry, "id" | "type">,
): ResourceColumnDescriptor[] {
  const retained = columns.slice(0, columnIndex + 1);
  if (!isResourceContainer(resource)) return retained;
  return [...retained, createChildResourceColumn(resource.id)];
}

export function truncateResourceColumnPath(
  columns: ResourceColumnDescriptor[],
  columnIndex: number,
): ResourceColumnDescriptor[] {
  return columns.slice(0, Math.max(0, columnIndex + 1));
}

export function getColumnLocationParentId(
  columns: ResourceColumnDescriptor[],
): string | null {
  return columns[columns.length - 1]?.parentId ?? null;
}

export function getColumnPathSelection(
  columns: ResourceColumnDescriptor[],
  columnIndex: number,
): string | null {
  return columns[columnIndex + 1]?.openedByResourceId ?? null;
}

export function getValidResourceColumnPathLength(
  columns: ResourceColumnDescriptor[],
  itemsByColumnKey: Record<string, ResourceEntry[]>,
  erroredColumnKeys: ReadonlySet<string>,
): number {
  let validLength = columns.length;
  for (let index = 0; index < columns.length - 1; index += 1) {
    const sourceColumn = columns[index]!;
    // 网络错误无法证明目录已被移动或删除。此时保留现有路径，避免一次临时失败让用户丢失工作位置。
    if (erroredColumnKeys.has(sourceColumn.key)) continue;
    const openedId = columns[index + 1]?.openedByResourceId;
    const sourceItems = itemsByColumnKey[sourceColumn.key] ?? [];
    if (!openedId || !sourceItems.some(({ id }) => id === openedId)) {
      validLength = index + 1;
      break;
    }
  }
  return validLength;
}

export function isResourceContainer(
  resource: Pick<ResourceEntry, "type"> | Pick<ResourceBreadcrumb, "type">,
) {
  return resource.type === "folder" || resource.type === "project";
}
