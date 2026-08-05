import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";

export type ResourcePickerPage = {
  items: ResourceEntry[];
  breadcrumbs: ResourceListPage["breadcrumbs"];
  nextCursor: string | null;
};

// 资源选择窗口可能只接纳目录、媒体等部分类型。有限跨页扫描可以跳过纯无关页，
// 同时保留服务端 cursor，让用户明确继续，而不是为了找一个目标偷偷抓取整个目录。
export async function collectResourcePickerItems(
  fetchPage: (cursor: string | null) => Promise<ResourceListPage>,
  startCursor: string | null,
  accepts: (resource: ResourceEntry) => boolean,
  maxScannedPages = 4,
): Promise<ResourcePickerPage> {
  const items: ResourceEntry[] = [];
  const seen = new Set<string>();
  let cursor = startCursor;
  let breadcrumbs: ResourceListPage["breadcrumbs"] = [];

  for (let pageIndex = 0; pageIndex < maxScannedPages; pageIndex += 1) {
    const page = await fetchPage(cursor);
    if (!breadcrumbs.length) breadcrumbs = page.breadcrumbs;
    for (const item of page.items) {
      if (!accepts(item) || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    cursor = page.nextCursor;
    if (items.length > 0 || !cursor) break;
  }

  return { items, breadcrumbs, nextCursor: cursor };
}
