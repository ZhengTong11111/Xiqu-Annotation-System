import assert from "node:assert/strict";
import test from "node:test";
import {
  AnnotationOperationCursorError,
  encodeAnnotationOperationCursor,
  MAX_OPERATION_PAGE_LIMIT,
  normalizeAnnotationOperationPage,
} from "../src/annotationOperationPagination.js";

// 默认页从序号 0 开始，显式 cursor 可稳定恢复 afterSequence。
test("operation page 规范化默认值并往返文件绑定游标", () => {
  assert.deepEqual(normalizeAnnotationOperationPage({ annotationFileId: "file-1" }), {
    afterSequence: 0,
    limit: 100,
    sourceCursor: null,
  });
  const cursor = encodeAnnotationOperationCursor("file-1", 42);
  assert.deepEqual(normalizeAnnotationOperationPage({
    annotationFileId: "file-1",
    cursor,
    limit: "25",
  }), { afterSequence: 42, limit: 25, sourceCursor: cursor });
});

// 坏格式、跨文件、未知版本和越界 limit 都不能静默退回第一页。
test("operation page 对坏游标和 limit fail closed", () => {
  const invalidInputs = [
    { annotationFileId: "file-2", cursor: encodeAnnotationOperationCursor("file-1", 1) },
    { annotationFileId: "file-1", cursor: "not-json" },
    {
      annotationFileId: "file-1",
      cursor: Buffer.from(JSON.stringify({ version: 2, annotationFileId: "file-1", afterSequence: 1 })).toString("base64url"),
    },
    { annotationFileId: "file-1", limit: 0 },
    { annotationFileId: "file-1", limit: MAX_OPERATION_PAGE_LIMIT + 1 },
    { annotationFileId: "file-1", limit: "1.5" },
  ];
  for (const input of invalidInputs) {
    assert.throws(() => normalizeAnnotationOperationPage(input), AnnotationOperationCursorError);
  }
});
