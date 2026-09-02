import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectAnnotationContentCommand,
  type ProjectData,
} from "@xiqu/document-model";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
import { buildAnnotationHistoryRecipe, buildAnnotationHistoryRevisionValidations } from "../src/annotationHistoryCompactionReplay.js";
import type { AnnotationHistoryOperationFact } from "../src/annotationHistoryCompactionTypes.js";
import { parseAnnotationHistoryShadowRecipeCliOptions } from "../src/annotationHistoryShadowRecipeCliOptions.js";
import { verifyAnnotationHistoryShadowRecipe } from "../src/annotationHistoryShadowRecipe.js";

const FILE_ID = "00000000-0000-4000-8000-000000000001";
const DATE = new Date("2026-01-01T00:00:00.000Z");

test("影子 recipe 使用同一领域命令重放并精确验证目标 hash", () => {
  const before = createProject("甲");
  const after = createProject("乙");
  const operation = createOperation(before, after);
  const checkpoint = createSnapshot("checkpoint-1", 1, before);
  const target = createSnapshot("target-2", 2, after);
  const revisions = buildAnnotationHistoryRevisionValidations(FILE_ID, [operation], 1, 2);
  const recipe = buildAnnotationHistoryRecipe({
    checkpoint,
    target,
    targetPayloadHash: createAnnotationHistoryCanonicalHash(after),
    revisions,
  });

  const result = verifyAnnotationHistoryShadowRecipe({
    annotationFileId: FILE_ID,
    expectedTargetSnapshotId: target.id,
    checkpoint,
    target,
    operations: [operation],
    expectedRecipe: recipe,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payloadHash, createAnnotationHistoryCanonicalHash(after));
  assert.equal(result.recipe.checkpointSnapshotId, checkpoint.id);
});

test("目标 payload 或 operation 范围漂移会稳定阻断而不是更新 recipe", () => {
  const before = createProject("甲");
  const after = createProject("乙");
  const operation = createOperation(before, after);
  const checkpoint = createSnapshot("checkpoint-1", 1, before);
  const target = createSnapshot("target-2", 2, after);
  const revisions = buildAnnotationHistoryRevisionValidations(FILE_ID, [operation], 1, 2);
  const recipe = buildAnnotationHistoryRecipe({
    checkpoint,
    target,
    targetPayloadHash: createAnnotationHistoryCanonicalHash(after),
    revisions,
  });

  assert.deepEqual(verifyAnnotationHistoryShadowRecipe({
    annotationFileId: FILE_ID,
    expectedTargetSnapshotId: target.id,
    checkpoint,
    target: { ...target, payload: createProject("目标已变") },
    operations: [operation],
    expectedRecipe: recipe,
  }), { ok: false, code: "target_payload_hash_changed" });
  assert.deepEqual(verifyAnnotationHistoryShadowRecipe({
    annotationFileId: FILE_ID,
    expectedTargetSnapshotId: target.id,
    checkpoint,
    target,
    operations: [],
    expectedRecipe: recipe,
  }), { ok: false, code: "operation_revision_missing" });
});

test("影子 CLI 默认 dry-run、只接受单文件并限制候选批次", () => {
  const dryRun = parseAnnotationHistoryShadowRecipeCliOptions([
    "--annotation-file-id",
    FILE_ID,
  ]);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.limitCandidates, 16);

  const apply = parseAnnotationHistoryShadowRecipeCliOptions([
    "--annotation-file-id",
    FILE_ID,
    "--apply",
    "--limit-candidates",
    "3",
  ]);
  assert.equal(apply.apply, true);
  assert.equal(apply.limitCandidates, 3);
  assert.throws(() => parseAnnotationHistoryShadowRecipeCliOptions(["--all"]), /只允许/u);
  assert.throws(() => parseAnnotationHistoryShadowRecipeCliOptions([
    "--annotation-file-id",
    FILE_ID,
    "--limit-candidates",
    "101",
  ]), /1 到 100/u);
});

function createSnapshot(id: string, revision: number, payload: ProjectData) {
  return {
    id,
    annotationFileId: FILE_ID,
    revision,
    reason: "save",
    createdAt: DATE,
    payload,
  };
}

function createOperation(before: ProjectData, after: ProjectData): AnnotationHistoryOperationFact {
  const envelope = buildProjectAnnotationContentCommand(before, after, [{
    entityType: "sentence",
    entityId: "line-1",
    field: "text",
  }]);
  assert.ok(envelope);
  return {
    id: "operation-2",
    annotationFileId: FILE_ID,
    sequence: 1,
    baseRevision: 1,
    action: envelope.command.type,
    payload: envelope,
    status: "accepted",
    committedRevision: 2,
    committedAt: DATE,
  };
}

function createProject(text: string): ProjectData {
  return {
    video: { url: "", name: null, source: "url" },
    sentenceAnnotationConfig: { roleOptions: [] },
    subtitleLines: [{
      id: "line-1",
      text,
      startTime: 0,
      endTime: 1,
      deliveryMode: null,
      roleTypes: [],
    }],
    characterAnnotations: [],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字",
      type: "character",
      attachedPointTracks: [],
    }],
    customTracks: [],
    activeTrackOrder: ["character-track"],
  };
}
