import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationRecoverySnapshotSummary } from "@xiqu/shared";
import { applyRecoverySnapshotPage } from "./recoverySnapshotPaging";

function summary(id: string, revision: number): AnnotationRecoverySnapshotSummary {
  return {
    id,
    annotationFileId: "file-1",
    revision,
    creator: { id: "user-1", accountName: "user", displayName: "用户" },
    reason: "save",
    createdAt: `2026-09-01T00:00:${String(revision).padStart(2, "0")}.000Z`,
  };
}

test("恢复历史续页按 id 去重并保持服务端顺序", () => {
  const first = applyRecoverySnapshotPage(
    { summaries: [], nextCursor: null },
    { snapshots: [summary("s3", 3), summary("s2", 2)], nextCursor: "cursor-2" },
    "replace",
  );
  const next = applyRecoverySnapshotPage(first, {
    snapshots: [summary("s2", 2), summary("s1", 1)],
    nextCursor: null,
  }, "append");
  assert.deepEqual(next.summaries.map(({ id }) => id), ["s3", "s2", "s1"]);
  assert.equal(next.nextCursor, null);
});

test("恢复历史刷新完全替换旧页面和 cursor", () => {
  const result = applyRecoverySnapshotPage(
    { summaries: [summary("old", 1)], nextCursor: "old-cursor" },
    { snapshots: [summary("new", 4), summary("new", 4)], nextCursor: "new-cursor" },
    "replace",
  );
  assert.deepEqual(result.summaries.map(({ id }) => id), ["new"]);
  assert.equal(result.nextCursor, "new-cursor");
});
