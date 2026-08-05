import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";
import { appendResourceListPage } from "./resourcePageState";

// 单列分页状态与 React 请求生命周期分离，便于稳定复用追加、失败保留和重试语义。
export type ResourceColumnPageState = {
  items: ResourceEntry[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
};

// 新列从空状态开始，首屏和后续页的错误分别展示，避免下一页失败覆盖已有内容。
export function createEmptyColumnPageState(): ResourceColumnPageState {
  return {
    items: [],
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: null,
    loadMoreError: null,
  };
}

// 首屏响应替换旧列内容；refresh 后服务器路径和 cursor 都以新响应为准。
export function replaceColumnPage(
  page: ResourceListPage,
): ResourceColumnPageState {
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
  };
}

// 后续页按服务器顺序追加并去重，同时保留列级首屏错误边界。
export function appendColumnPage(
  current: ResourceColumnPageState,
  page: ResourceListPage,
): ResourceColumnPageState {
  const appended = appendResourceListPage({
    items: current.items,
    breadcrumbs: [],
    nextCursor: current.nextCursor,
  }, page);
  return {
    ...current,
    items: appended.items,
    nextCursor: appended.nextCursor,
    loadingMore: false,
    loadMoreError: null,
  };
}

// 下一页失败只记录可重试错误，不清空已加载项或消费 cursor。
export function failColumnAppend(
  current: ResourceColumnPageState,
  message: string,
): ResourceColumnPageState {
  return {
    ...current,
    loadingMore: false,
    loadMoreError: message,
  };
}
