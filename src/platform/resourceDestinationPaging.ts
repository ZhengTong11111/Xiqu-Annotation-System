import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";
import { isResourceContainer } from "./resourceColumnModel";

export type DestinationContainerPage = {
  items: ResourceEntry[];
  breadcrumbs: ResourceListPage["breadcrumbs"];
  nextCursor: string | null;
};

// 目标选择器按有限页数跳过纯文件页面，避免第 201 项后的目录永久不可达，也避免一次抓取全集。
export async function collectDestinationContainers(
  fetchPage: (cursor: string | null) => Promise<ResourceListPage>,
  startCursor: string | null,
  maxScannedPages = 4,
): Promise<DestinationContainerPage> {
  const items: ResourceEntry[] = [];
  const seen = new Set<string>();
  let cursor = startCursor;
  let breadcrumbs: ResourceListPage["breadcrumbs"] = [];

  // 每次用户动作最多扫描固定页数；若仍未找到目录，保留 cursor 让用户明确继续。
  for (let pageIndex = 0; pageIndex < maxScannedPages; pageIndex += 1) {
    const page = await fetchPage(cursor);
    if (!breadcrumbs.length) breadcrumbs = page.breadcrumbs;
    for (const item of page.items) {
      if (!isResourceContainer(item) || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    cursor = page.nextCursor;
    if (items.length > 0 || !cursor) break;
  }

  return { items, breadcrumbs, nextCursor: cursor };
}
