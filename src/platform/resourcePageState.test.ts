import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceEntry, ResourceListPage } from "@xiqu/shared";
import { appendResourceListPage } from "./resourcePageState";

// 测试资源只保留分页 helper 关心的 id，其他 DTO 字段不参与该纯函数行为。
function resource(id: string): ResourceEntry {
  return { id } as ResourceEntry;
}

test("下一页按服务器顺序追加并更新 cursor", () => {
  const current: ResourceListPage = {
    items: [resource("a")],
    breadcrumbs: [{ id: "root", parentId: null, type: "project", name: "根" }],
    nextCursor: "cursor-a",
  };
  const incoming: ResourceListPage = {
    items: [resource("b"), resource("c")],
    breadcrumbs: current.breadcrumbs,
    nextCursor: null,
  };
  const result = appendResourceListPage(current, incoming);
  assert.deepEqual(result.items.map(({ id }) => id), ["a", "b", "c"]);
  assert.equal(result.nextCursor, null);
});

test("跨页重复资源去重且空面包屑不擦除当前路径", () => {
  const current: ResourceListPage = {
    items: [resource("a"), resource("b")],
    breadcrumbs: [{ id: "root", parentId: null, type: "project", name: "根" }],
    nextCursor: "cursor-b",
  };
  const result = appendResourceListPage(current, {
    items: [resource("b"), resource("c")],
    breadcrumbs: [],
    nextCursor: "cursor-c",
  });
  assert.deepEqual(result.items.map(({ id }) => id), ["a", "b", "c"]);
  assert.deepEqual(result.breadcrumbs, current.breadcrumbs);
});
