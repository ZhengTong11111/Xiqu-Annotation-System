import assert from "node:assert/strict";
import test from "node:test";
import { parseAnnotationHistoryStoredRecipeVerificationCliOptions } from "../src/annotationHistoryStoredRecipeVerificationCliOptions.js";
import { readStoredRecipe } from "../src/annotationHistoryStoredRecipeVerificationService.js";

const FILE_ID = "00000000-0000-4000-8000-000000000001";

test("已存 recipe 只读 CLI 只接受单文件和有界参数", () => {
  assert.deepEqual(parseAnnotationHistoryStoredRecipeVerificationCliOptions([
    "--annotation-file-id",
    FILE_ID,
  ]), {
    annotationFileId: FILE_ID,
    limitCandidates: 16,
    statementTimeoutMs: 30_000,
  });
  assert.deepEqual(parseAnnotationHistoryStoredRecipeVerificationCliOptions([
    "--annotation-file-id",
    FILE_ID,
    "--limit-candidates",
    "3",
    "--statement-timeout-ms",
    "5000",
    "--output",
    "report.json",
  ]), {
    annotationFileId: FILE_ID,
    limitCandidates: 3,
    statementTimeoutMs: 5_000,
    outputPath: "report.json",
  });

  assert.throws(() => parseAnnotationHistoryStoredRecipeVerificationCliOptions([]), /annotation-file-id/u);
  assert.throws(() => parseAnnotationHistoryStoredRecipeVerificationCliOptions(["--all"]), /未知参数/u);
  assert.throws(() => parseAnnotationHistoryStoredRecipeVerificationCliOptions([
    "--annotation-file-id", "bad-id",
  ]), /完整/u);
  assert.throws(() => parseAnnotationHistoryStoredRecipeVerificationCliOptions([
    "--annotation-file-id", FILE_ID, "--limit-candidates", "101",
  ]), /1 到 100/u);
  assert.throws(() => parseAnnotationHistoryStoredRecipeVerificationCliOptions([
    "--annotation-file-id", FILE_ID, "--annotation-file-id", FILE_ID,
  ]), /不能重复/u);
});

test("数据库 recipe 必须整组存在，checkpoint revision 由 operation 起点确定", () => {
  const complete = {
    payloadSha256: "a".repeat(64),
    checkpointSnapshotId: "checkpoint-1",
    operationRevisionStart: 2,
    operationRevisionEnd: 3,
    operationSequenceStart: 4,
    operationSequenceEnd: 5,
    operationCount: 2,
    compactionVersion: 1,
    recipeVerifiedAt: new Date("2026-09-02T00:00:00.000Z"),
  };
  const recipe = readStoredRecipe(complete);
  assert.ok(recipe);
  assert.equal(recipe.checkpointRevision, 1);
  assert.equal(recipe.operationRevisionEnd, 3);
  assert.equal(readStoredRecipe({ ...complete, payloadSha256: null }), null);
  assert.equal(readStoredRecipe({ ...complete, recipeVerifiedAt: null }), null);
});
