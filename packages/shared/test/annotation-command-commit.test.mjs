import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS,
  isValidAnnotationClientOperationId,
  parseAnnotationCommandBatchRequest,
} from "../dist/index.js";

function timingEnvelope(entityId, beforeStart, afterStart) {
  return {
    version: 1,
    command: {
      type: "timeline.items.timing.update",
      items: [{
        entityType: "character",
        entityId,
        before: { startTime: beforeStart, endTime: beforeStart + 1 },
        after: { startTime: afterStart, endTime: afterStart + 1 },
      }],
    },
  };
}

function operation(id, payload = timingEnvelope("char-1", 1, 2)) {
  return {
    clientOperationId: id,
    localRevision: 3,
    action: payload.command.type,
    payload,
  };
}

test("原子命令批次保留合法多命令链的请求顺序", () => {
  const first = timingEnvelope("char-1", 1, 2);
  const second = timingEnvelope("char-1", 2, 3);
  const result = parseAnnotationCommandBatchRequest({
    baseRevision: 7,
    operations: [operation("op-first", first), operation("op-second", second)],
    mutationLeaseToken: "lease-token-placeholder",
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    result.success ? result.data.operations.map((item) => item.clientOperationId) : [],
    ["op-first", "op-second"],
  );
  assert.deepEqual(result.success ? result.data.operations[1]?.payload : null, second);
});

test("原子命令批次拒绝空数组、超限和重复 client id", () => {
  assert.equal(parseAnnotationCommandBatchRequest({ baseRevision: 1, operations: [] }).success, false);
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: 1,
    operations: Array.from(
      { length: MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS + 1 },
      (_, index) => operation(`op-${index}`),
    ),
  }).success, false);
  const duplicate = parseAnnotationCommandBatchRequest({
    baseRevision: 1,
    operations: [operation("op-same"), operation("op-same")],
  });
  assert.equal(duplicate.success, false);
  assert.ok(!duplicate.success && duplicate.issues.some(
    (issue) => issue.code === "duplicate_client_operation_id" && issue.operationIndex === 1,
  ));
});

test("原子命令批次拒绝非法 revision、local revision 和额外字段", () => {
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: Number.MAX_SAFE_INTEGER + 1,
    operations: [operation("op-1")],
  }).success, false);
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: 2_147_483_648,
    operations: [operation("op-db-overflow")],
  }).success, false);
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: 1,
    operations: [{ ...operation("op-local-overflow"), localRevision: 2_147_483_648 }],
  }).success, false);
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: 1,
    operations: [{ ...operation("op-1"), localRevision: -1 }],
  }).success, false);
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: 1,
    operations: [{ ...operation("op-1"), hidden: true }],
  }).success, false);
});

test("原子命令批次拒绝 action 不匹配、legacy 和 snapshot boundary", () => {
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: 1,
    operations: [{ ...operation("op-1"), action: "annotation.items.content.update" }],
  }).success, false);
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: 1,
    operations: [{
      clientOperationId: "op-legacy",
      action: "project.commit",
      payload: { historyAction: "edit" },
    }],
  }).success, false);
  assert.equal(parseAnnotationCommandBatchRequest({
    baseRevision: 1,
    operations: [{
      clientOperationId: "op-snapshot",
      action: "project.snapshot.boundary",
      payload: {
        version: 1,
        command: { type: "project.snapshot.boundary", kind: "import_project" },
      },
    }],
  }).success, false);
});

test("新旧 operation 入口共用同一个有界 client id 字符集", () => {
  assert.equal(isValidAnnotationClientOperationId("op-550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isValidAnnotationClientOperationId("a:b_c.d-1"), true);
  assert.equal(isValidAnnotationClientOperationId(""), false);
  assert.equal(isValidAnnotationClientOperationId(`a${"b".repeat(128)}`), false);
  assert.equal(isValidAnnotationClientOperationId("op/path"), false);
});
