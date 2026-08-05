import type { ResourceListPage } from "@xiqu/shared";

// 下一页按服务器顺序追加，并以资源 id 去重，抵御并发 mutation 导致的跨页短暂重复。
export function appendResourceListPage(
  current: ResourceListPage,
  incoming: ResourceListPage,
): ResourceListPage {
  const seen = new Set(current.items.map((item) => item.id));
  const appended = incoming.items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  return {
    items: [...current.items, ...appended],
    // 当前路径没有变化时保留最新面包屑；空响应也不应擦除已知路径。
    breadcrumbs: incoming.breadcrumbs.length > 0
      ? incoming.breadcrumbs
      : current.breadcrumbs,
    nextCursor: incoming.nextCursor,
  };
}
