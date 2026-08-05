import assert from "node:assert/strict";
import test from "node:test";
import {
  ResourceCursorError,
  buildResourceOrderBy,
  decodeResourceCursor,
  encodeResourceCursor,
  getResourceScanBatchSize,
  mapWithConcurrency,
  normalizeResourceQuery,
} from "../src/resourcePagination.js";

// 基础查询覆盖默认值、空白搜索和 limit 不参与 cursor 上下文的规则。
const BASE_QUERY = normalizeResourceQuery({
  parentId: "project-1",
  query: "  寻梦  ",
  limit: 20,
});

test("资源 cursor 在同一规范化查询中可往返且不受 limit 影响", () => {
  const cursor = encodeResourceCursor("resource-1", BASE_QUERY);
  assert.equal(
    decodeResourceCursor(cursor, normalizeResourceQuery({
      parentId: "project-1",
      query: "寻梦",
      limit: 100,
    })),
    "resource-1",
  );
});

test("资源 cursor 拒绝坏格式、未知版本和查询上下文变化", () => {
  assert.throws(() => decodeResourceCursor("not-json", BASE_QUERY), ResourceCursorError);
  const unknownVersion = Buffer.from(JSON.stringify({
    version: 2,
    resourceId: "resource-1",
    queryFingerprint: "x",
  })).toString("base64url");
  assert.throws(() => decodeResourceCursor(unknownVersion, BASE_QUERY), ResourceCursorError);

  const cursor = encodeResourceCursor("resource-1", BASE_QUERY);
  for (const changed of [
    { parentId: "project-2", query: "寻梦" },
    { parentId: "project-1", query: "牡丹亭" },
    { parentId: "project-1", query: "寻梦", view: "favorites" as const },
    { parentId: "project-1", query: "寻梦", type: "media_file" as const },
    { parentId: "project-1", query: "寻梦", sortBy: "updatedAt" as const },
    { parentId: "project-1", query: "寻梦", direction: "desc" as const },
  ]) {
    assert.throws(
      () => decodeResourceCursor(cursor, normalizeResourceQuery(changed)),
      ResourceCursorError,
    );
  }
});

test("数据库排序始终追加同方向 id 作为稳定 tie-break", () => {
  assert.deepEqual(buildResourceOrderBy(BASE_QUERY), [
    { name: "asc" },
    { id: "asc" },
  ]);
  assert.deepEqual(buildResourceOrderBy(normalizeResourceQuery({
    sortBy: "size",
    direction: "desc",
  })), [
    { mediaFile: { size: "desc" } },
    { id: "desc" },
  ]);
});

test("扫描批次具有 50 到 200 的明确边界", () => {
  assert.equal(getResourceScanBatchSize(1), 50);
  assert.equal(getResourceScanBatchSize(60), 120);
  assert.equal(getResourceScanBatchSize(200), 200);
});

test("有限并发映射保持输入顺序", async () => {
  const result = await mapWithConcurrency([3, 1, 2], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value));
    return value * 2;
  });
  assert.deepEqual(result, [6, 2, 4]);
});
