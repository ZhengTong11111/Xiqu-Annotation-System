import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAnnotationRangeCommentCursor,
  encodeAnnotationRangeCommentCursor,
} from "../src/annotationRangeCommentPagination.js";

test("范围评论游标绑定文件、撤回筛选和复合排序锚点", () => {
  const source = {
    annotationFileId: "file-1",
    includeWithdrawn: true,
    createdAt: new Date("2026-08-22T00:00:00.000Z"),
    id: "comment-1",
  };
  const encoded = encodeAnnotationRangeCommentCursor(source);
  assert.deepEqual(decodeAnnotationRangeCommentCursor(encoded, {
    annotationFileId: "file-1",
    includeWithdrawn: true,
  }), source);
  assert.equal(decodeAnnotationRangeCommentCursor(encoded, {
    annotationFileId: "file-2",
    includeWithdrawn: true,
  }), null);
  assert.equal(decodeAnnotationRangeCommentCursor(encoded, {
    annotationFileId: "file-1",
    includeWithdrawn: false,
  }), null);
  assert.equal(decodeAnnotationRangeCommentCursor("not-a-cursor", {
    annotationFileId: "file-1",
    includeWithdrawn: true,
  }), null);
});
