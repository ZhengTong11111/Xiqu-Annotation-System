import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnotationHistoryDependencyProtection,
  isAnnotationHistoryOperationRangeProtected,
  isAnnotationHistorySnapshotProtected,
  type AnnotationHistoryDependencyRecipeRow,
} from "../src/annotationHistoryDependencyProtection.js";

const FILE_ID = "annotation-file-1";

test("合法 recipe 保护 checkpoint 与相交 operation 边界", () => {
  const protection = buildAnnotationHistoryDependencyProtection({
    annotationFileId: FILE_ID,
    rows: [createRecipe("recipe-2", "checkpoint-1", 2, 10, 11)],
    checkpointRevisions: new Map([["checkpoint-1", 1]]),
  });

  assert.equal(protection.valid, true);
  assert.equal(isAnnotationHistorySnapshotProtected(protection, "checkpoint-1"), true);
  assert.equal(isAnnotationHistorySnapshotProtected(protection, "unrelated"), false);
  assert.equal(isAnnotationHistoryOperationRangeProtected(protection, {
    revisionStart: 2,
    revisionEnd: 2,
    sequenceStart: 11,
    sequenceEnd: 11,
  }), true);
  assert.equal(isAnnotationHistoryOperationRangeProtected(protection, {
    revisionStart: 3,
    revisionEnd: 4,
    sequenceStart: 12,
    sequenceEnd: 20,
  }), false);
});

test("畸形、跨文件或截断扫描都 fail closed", () => {
  const protection = buildAnnotationHistoryDependencyProtection({
    annotationFileId: FILE_ID,
    rows: [
      { ...createRecipe("cross-file", "checkpoint-1", 2, 10, 11), annotationFileId: "other-file" },
      { ...createRecipe("bad-range", "checkpoint-1", 2, 10, 11), operationSequenceEnd: 9 },
    ],
    checkpointRevisions: new Map([["checkpoint-1", 1]]),
    truncated: true,
  });

  assert.equal(protection.valid, false);
  assert.deepEqual(new Set(protection.issues.map(({ code }) => code)), new Set([
    "malformed_recipe",
    "recipe_scan_truncated",
  ]));
  assert.equal(isAnnotationHistorySnapshotProtected(protection, "unrelated"), true);
  assert.equal(isAnnotationHistoryOperationRangeProtected(protection, {
    revisionStart: 100,
    revisionEnd: 100,
    sequenceStart: 100,
    sequenceEnd: 100,
  }), true);
});

test("缺失 checkpoint 单独报告且禁止清理", () => {
  const protection = buildAnnotationHistoryDependencyProtection({
    annotationFileId: FILE_ID,
    rows: [createRecipe("recipe-2", "missing-checkpoint", 2, 10, 11)],
    checkpointRevisions: new Map(),
  });

  assert.equal(protection.valid, false);
  assert.deepEqual(protection.issues, [{ code: "checkpoint_missing", snapshotId: "recipe-2" }]);
  assert.equal(isAnnotationHistorySnapshotProtected(protection, "anything"), true);
});

test("非法候选范围与空 snapshot 身份默认视为受保护", () => {
  const protection = buildAnnotationHistoryDependencyProtection({
    annotationFileId: FILE_ID,
    rows: [createRecipe("recipe-2", "checkpoint-1", 2, 10, 11)],
    checkpointRevisions: new Map([["checkpoint-1", 1]]),
  });

  assert.equal(isAnnotationHistorySnapshotProtected(protection, ""), true);
  assert.equal(isAnnotationHistoryOperationRangeProtected(protection, {
    revisionStart: 3,
    revisionEnd: 2,
    sequenceStart: 11,
    sequenceEnd: 10,
  }), true);
});

function createRecipe(
  id: string,
  checkpointSnapshotId: string,
  revision: number,
  operationSequenceStart: number,
  operationSequenceEnd: number,
): AnnotationHistoryDependencyRecipeRow {
  return {
    id,
    annotationFileId: FILE_ID,
    revision,
    checkpointSnapshotId,
    operationRevisionStart: revision,
    operationRevisionEnd: revision,
    operationSequenceStart,
    operationSequenceEnd,
    operationCount: operationSequenceEnd - operationSequenceStart + 1,
    compactionVersion: 1,
    compactedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}
