import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceEntry } from "@xiqu/shared";
import {
  appendColumnPage,
  createEmptyColumnPageState,
  failColumnAppend,
  replaceColumnPage,
} from "./resourceColumnPageState";

// 测试数据只保留列分页纯函数使用的资源标识。
const resource = (id: string) => ({ id }) as ResourceEntry;

test("首屏替换后可以追加去重的后续页", () => {
  const first = replaceColumnPage({
    items: [resource("a"), resource("b")],
    breadcrumbs: [],
    nextCursor: "cursor-a",
  });
  const next = appendColumnPage(first, {
    items: [resource("b"), resource("c")],
    breadcrumbs: [],
    nextCursor: null,
  });
  assert.deepEqual(next.items.map(({ id }) => id), ["a", "b", "c"]);
  assert.equal(next.nextCursor, null);
});

test("追加失败保留资源和 cursor 供重试", () => {
  const current = {
    ...createEmptyColumnPageState(),
    items: [resource("a")],
    nextCursor: "cursor-a",
    loading: false,
    loadingMore: true,
  };
  const failed = failColumnAppend(current, "网络错误");
  assert.deepEqual(failed.items, current.items);
  assert.equal(failed.nextCursor, "cursor-a");
  assert.equal(failed.loadMoreError, "网络错误");
});
