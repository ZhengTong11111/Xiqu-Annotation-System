import assert from "node:assert/strict";
import test from "node:test";
import {
  AnnotationRecoverySnapshotCursorError,
  encodeAnnotationRecoverySnapshotCursor,
  normalizeAnnotationRecoverySnapshotPage,
} from "../src/annotationRecoverySnapshotPagination.js";

test("恢复历史游标绑定文件和 revision/time/id 复合锚点", () => {
  const source = {
    annotationFileId: "file-1",
    revision: 17,
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    id: "snapshot-17",
  };
  const token = encodeAnnotationRecoverySnapshotCursor(source);
  assert.deepEqual(normalizeAnnotationRecoverySnapshotPage({
    annotationFileId: "file-1",
    cursor: token,
    limit: "25",
  }), { cursor: source, limit: 25 });
  assert.throws(
    () => normalizeAnnotationRecoverySnapshotPage({ annotationFileId: "file-2", cursor: token }),
    AnnotationRecoverySnapshotCursorError,
  );
});

test("恢复历史分页拒绝含糊 cursor 与越界 limit", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const base = {
    version: 1,
    annotationFileId: "file-1",
    revision: 1,
    createdAt: "2026-09-01T12:00:00.000Z",
    id: "snapshot-1",
  };
  for (const cursor of [
    "",
    "not-json",
    "x".repeat(2_049),
    encode({ ...base, extra: true }),
    encode({ ...base, revision: 0 }),
    encode({ ...base, createdAt: "2026-09-01" }),
    encode({ ...base, id: "" }),
  ]) {
    assert.throws(
      () => normalizeAnnotationRecoverySnapshotPage({ annotationFileId: "file-1", cursor }),
      AnnotationRecoverySnapshotCursorError,
    );
  }
  for (const limit of [0, 101, 1.5, "1.5", "", "abc", null]) {
    assert.throws(
      () => normalizeAnnotationRecoverySnapshotPage({ annotationFileId: "file-1", limit }),
      AnnotationRecoverySnapshotCursorError,
    );
  }
  assert.equal(normalizeAnnotationRecoverySnapshotPage({
    annotationFileId: "file-1",
  }).limit, 50);
});
