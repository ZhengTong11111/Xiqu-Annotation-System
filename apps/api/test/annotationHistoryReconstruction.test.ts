import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectAnnotationContentCommand,
  type ProjectData,
} from "@xiqu/document-model";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
import {
  buildAnnotationHistoryRecipe,
  buildAnnotationHistoryRevisionValidations,
} from "../src/annotationHistoryCompactionReplay.js";
import type { AnnotationHistoryOperationFact } from "../src/annotationHistoryCompactionTypes.js";
import { reconstructAnnotationHistoryPayload } from "../src/annotationHistoryReconstruction.js";

const FILE_ID = "00000000-0000-4000-8000-000000000001";
const DATE = new Date("2026-01-01T00:00:00.000Z");

test("统一内核按多 revision 命令链无损重建且不修改输入", () => {
  const before = createProject("甲");
  const middle = createProject("乙");
  const after = createProject("丙");
  const operations = [
    createOperation(before, middle, 1, 2),
    createOperation(middle, after, 2, 3),
  ];
  const checkpoint = createSnapshot("checkpoint-1", 1, before);
  const target = createSnapshot("target-3", 3, after);
  const recipe = createRecipe(checkpoint, target, operations);
  const frozenInput = structuredClone({ checkpoint, target, operations, recipe });

  const result = reconstructAnnotationHistoryPayload({
    annotationFileId: FILE_ID,
    expectedTargetSnapshotId: target.id,
    checkpoint,
    target,
    inlineTargetPayload: target.payload,
    operations,
    expectedRecipe: recipe,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.payload, after);
  assert.equal(result.payloadHash, createAnnotationHistoryCanonicalHash(after));
  assert.deepEqual({ checkpoint, target, operations, recipe }, frozenInput);
});

test("checkpoint、target 和 recipe 身份漂移使用固定错误码", () => {
  const fixture = createFixture();
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    checkpoint: { ...fixture.checkpoint, annotationFileId: "other-file" },
  }), { ok: false, code: "checkpoint_identity_mismatch" });
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    target: { ...fixture.target, revision: 3 },
  }), { ok: false, code: "target_identity_mismatch" });
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    expectedRecipe: { ...fixture.expectedRecipe, version: 2 as 1 },
  }), { ok: false, code: "recipe_invalid" });
});

test("inline 目标只作为 HC3a 额外证据，格式或 hash 漂移均会阻断", () => {
  const fixture = createFixture();
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    inlineTargetPayload: { invalid: true },
  }), { ok: false, code: "target_payload_invalid" });
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    inlineTargetPayload: createProject("目标已变"),
  }), { ok: false, code: "target_payload_hash_changed" });
});

test("缺失、重复和跨文件 operation 都由现有 revision validator 阻断", () => {
  const fixture = createFixture();
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    operations: [],
  }), { ok: false, code: "operation_revision_missing" });
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    operations: [{ ...fixture.operations[0]!, annotationFileId: "other-file" }],
  }), { ok: false, code: "operation_file_mismatch" });

  const middle = createProject("乙");
  const after = createProject("丙");
  const multiOperations = [
    createOperation(fixture.checkpoint.payload, middle, 1, 2),
    { ...createOperation(middle, after, 2, 3), sequence: 1 },
  ];
  const target = createSnapshot("target-3", 3, after);
  const validRangeRecipe = {
    ...createRecipe(fixture.checkpoint, target, [
      multiOperations[0]!,
      { ...multiOperations[1]!, sequence: 2 },
    ]),
  };
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    annotationFileId: FILE_ID,
    expectedTargetSnapshotId: target.id,
    checkpoint: fixture.checkpoint,
    target,
    operations: multiOperations,
    expectedRecipe: validRangeRecipe,
  }), { ok: false, code: "operation_sequence_duplicate" });
});

test("apply 失败、最终 hash 和 operation 范围漂移不会生成近似结果", () => {
  const fixture = createFixture();
  const wrongBefore = createProject("不是检查点内容");
  const applyFailureOperation = createOperation(wrongBefore, fixture.target.payload, 1, 2);
  const applyFailureRecipe = createRecipe(
    fixture.checkpoint,
    fixture.target,
    [applyFailureOperation],
  );
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    annotationFileId: FILE_ID,
    expectedTargetSnapshotId: fixture.target.id,
    checkpoint: fixture.checkpoint,
    target: fixture.target,
    operations: [applyFailureOperation],
    expectedRecipe: applyFailureRecipe,
  }), { ok: false, code: "operation_apply_failed" });

  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    inlineTargetPayload: undefined,
    expectedRecipe: { ...fixture.expectedRecipe, targetPayloadHash: "0".repeat(64) },
  }), { ok: false, code: "canonical_hash_mismatch" });
  assert.deepEqual(reconstructAnnotationHistoryPayload({
    ...fixture,
    inlineTargetPayload: undefined,
    expectedRecipe: {
      ...fixture.expectedRecipe,
      operationSequenceEnd: 2,
      operationCount: 2,
    },
  }), { ok: false, code: "recipe_changed" });
});

function createFixture() {
  const before = createProject("甲");
  const after = createProject("乙");
  const checkpoint = createSnapshot("checkpoint-1", 1, before);
  const target = createSnapshot("target-2", 2, after);
  const operations = [createOperation(before, after, 1, 2)];
  return {
    annotationFileId: FILE_ID,
    expectedTargetSnapshotId: target.id,
    checkpoint,
    target,
    inlineTargetPayload: target.payload,
    operations,
    expectedRecipe: createRecipe(checkpoint, target, operations),
  };
}

function createRecipe(
  checkpoint: ReturnType<typeof createSnapshot>,
  target: ReturnType<typeof createSnapshot>,
  operations: readonly AnnotationHistoryOperationFact[],
) {
  return buildAnnotationHistoryRecipe({
    checkpoint,
    target,
    targetPayloadHash: createAnnotationHistoryCanonicalHash(target.payload),
    revisions: buildAnnotationHistoryRevisionValidations(
      FILE_ID,
      operations,
      checkpoint.revision,
      target.revision,
    ),
  });
}

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

function createOperation(
  before: ProjectData,
  after: ProjectData,
  baseRevision: number,
  committedRevision: number,
): AnnotationHistoryOperationFact {
  const envelope = buildProjectAnnotationContentCommand(before, after, [{
    entityType: "sentence",
    entityId: "line-1",
    field: "text",
  }]);
  assert.ok(envelope);
  return {
    id: `operation-${committedRevision}`,
    annotationFileId: FILE_ID,
    sequence: committedRevision - 1,
    baseRevision,
    action: envelope.command.type,
    payload: envelope,
    status: "accepted",
    committedRevision,
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
