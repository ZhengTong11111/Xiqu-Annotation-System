import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeProcessingJobCursor,
  encodeProcessingJobCursor,
  normalizeProcessingJobQuery,
} from "../src/processingJobQuery.js";

test("后台任务搜索词规范化并绑定分页游标", () => {
  const query = normalizeProcessingJobQuery({
    scope: "related",
    query: "  寻梦分析  ",
    limit: 25,
  });
  assert.equal(query.query, "寻梦分析");
  const token = encodeProcessingJobCursor({
    requestedAt: new Date("2026-08-30T12:00:00.000Z"),
    id: "request-1",
  }, query);
  assert.deepEqual(decodeProcessingJobCursor(token, query), {
    requestedAt: new Date("2026-08-30T12:00:00.000Z"),
    id: "request-1",
  });
  assert.throws(
    () => decodeProcessingJobCursor(token, normalizeProcessingJobQuery({
      scope: "related",
      query: "另一项任务",
      limit: 25,
    })),
    /分页游标无效/,
  );
});

test("后台任务搜索拒绝越界输入并把空白视为未筛选", () => {
  assert.equal(normalizeProcessingJobQuery({ query: "   " }).query, null);
  assert.throws(
    () => normalizeProcessingJobQuery({ query: "字".repeat(101) }),
    /不能超过 100 个字符/,
  );
});
