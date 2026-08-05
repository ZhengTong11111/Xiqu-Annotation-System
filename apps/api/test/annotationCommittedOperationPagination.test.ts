import assert from "node:assert/strict";
import test from "node:test";
import {
  AnnotationCommittedOperationCursorError,
  encodeAnnotationCommittedOperationCursor,
  encodeAnnotationSnapshotOperationCursor,
  MAX_COMMITTED_OPERATION_PAGE_LIMIT,
  normalizeAnnotationCommittedOperationPage,
} from "../src/annotationCommittedOperationPagination.js";

// 默认读取全部已提交历史；页尾 cursor 可在同 revision 内续读，快照 cursor 则跳过整个当前 revision。
test("committed operation cursor 区分页尾和快照起点", () => {
  assert.deepEqual(normalizeAnnotationCommittedOperationPage({ annotationFileId: "file-1" }), {
    afterCommittedRevision: 0,
    afterSequence: 0,
    limit: 100,
    sourceCursor: null,
  });

  const pageCursor = encodeAnnotationCommittedOperationCursor("file-1", 7, 42);
  assert.deepEqual(normalizeAnnotationCommittedOperationPage({
    annotationFileId: "file-1",
    cursor: pageCursor,
    limit: "25",
  }), {
    afterCommittedRevision: 7,
    afterSequence: 42,
    limit: 25,
    sourceCursor: pageCursor,
  });

  const snapshotCursor = encodeAnnotationSnapshotOperationCursor("file-1", 7);
  assert.equal(
    normalizeAnnotationCommittedOperationPage({
      annotationFileId: "file-1",
      cursor: snapshotCursor,
    }).afterSequence,
    2_147_483_647,
  );
});

// 跨文件、坏结构、未知版本和越界数值必须 fail closed，不能回退到全量第一页。
test("committed operation cursor 拒绝含糊输入", () => {
  const invalidInputs = [
    {
      annotationFileId: "file-2",
      cursor: encodeAnnotationCommittedOperationCursor("file-1", 1, 1),
    },
    { annotationFileId: "file-1", cursor: "broken" },
    {
      annotationFileId: "file-1",
      cursor: Buffer.from(JSON.stringify({
        version: 2,
        annotationFileId: "file-1",
        afterCommittedRevision: 1,
        afterSequence: 1,
      })).toString("base64url"),
    },
    { annotationFileId: "file-1", limit: 0 },
    { annotationFileId: "file-1", limit: MAX_COMMITTED_OPERATION_PAGE_LIMIT + 1 },
    { annotationFileId: "file-1", limit: "1.5" },
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => normalizeAnnotationCommittedOperationPage(input),
      AnnotationCommittedOperationCursorError,
    );
  }
});
