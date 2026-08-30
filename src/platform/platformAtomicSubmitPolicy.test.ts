import assert from "node:assert/strict";
import test from "node:test";
import type { CommitAnnotationCommandBatchResponse } from "@xiqu/shared";
import { PlatformApiError } from "../api/platformClient";
import type { AtomicCommandPlan } from "./platformAtomicCommandPlan";
import {
  classifyAtomicSubmitError,
  isMutationLeaseSubmitFailure,
  requiresLegacySnapshotMigration,
  shouldReleaseMutationLeaseAfterAtomicFailure,
  validateAtomicSubmitResponse,
} from "./platformAtomicSubmitPolicy";

const PLAN = {
  request: {
    baseRevision: 4,
    operations: [{
      clientOperationId: "op-1",
      localRevision: 2,
      action: "annotation.items.content.update",
      payload: { version: 1, command: { type: "annotation.items.content.update", items: [] } },
    }],
  },
  operationIds: ["op-1"],
  serverBaseProject: {} as AtomicCommandPlan["serverBaseProject"],
  acknowledgedProject: {} as AtomicCommandPlan["acknowledgedProject"],
  acknowledgedTrackSnapEnabled: {},
  remainingCount: 0,
  expectedSavedLocalRevision: 1,
  acknowledgedLocalRevision: 2,
  requiredLeasePurpose: null,
} as AtomicCommandPlan;

function response(overrides: Partial<CommitAnnotationCommandBatchResponse> = {}): CommitAnnotationCommandBatchResponse {
  return {
    committedRevision: 5,
    operationCursor: "cursor-5",
    operations: [{
      id: "row-1",
      annotationFileId: "file-1",
      actorUserId: "user-1",
      clientOperationId: "op-1",
      sequence: 1,
      baseRevision: 4,
      localRevision: 2,
      action: "annotation.items.content.update",
      payload: PLAN.request.operations[0].payload,
      status: "accepted",
      commitState: "committed",
      committedRevision: 5,
      committedAt: new Date().toISOString(),
      replayability: "domain_command",
      createdAt: new Date().toISOString(),
    }],
    ...overrides,
  };
}

test("严格确认 revision、operation 身份与提交事实", () => {
  assert.deepEqual(validateAtomicSubmitResponse(PLAN, response()), {
    status: "valid",
    committedRevision: 5,
  });
  assert.equal(validateAtomicSubmitResponse(PLAN, response({ committedRevision: 6 })).status, "invalid");
  const wrongOrder = response();
  wrongOrder.operations[0].clientOperationId = "op-other";
  assert.equal(validateAtomicSubmitResponse(PLAN, wrongOrder).status, "invalid");
  const uncommitted = response();
  uncommitted.operations[0].commitState = "accepted";
  assert.equal(validateAtomicSubmitResponse(PLAN, uncommitted).status, "invalid");
});

test("网络、冲突和确定错误使用原子提交专用分类", () => {
  assert.equal(classifyAtomicSubmitError(new TypeError("fetch"), true).status, "retryable");
  assert.equal(classifyAtomicSubmitError(new Error("offline"), false).status, "offline");
  const conflict = new PlatformApiError(409, "conflict", "revision", {
    code: "annotation_command_batch_revision_conflict",
  });
  const revisionConflict = classifyAtomicSubmitError(conflict, true);
  assert.deepEqual(revisionConflict, {
    status: "conflict",
    retryable: false,
    code: "annotation_command_batch_revision_conflict",
    message: "revision",
  });
  const expiredLease = new PlatformApiError(409, "conflict", "lease expired", {
    code: "annotation_mutation_lease_expired",
  });
  assert.deepEqual(classifyAtomicSubmitError(expiredLease, true), {
    status: "error",
    retryable: false,
    code: "annotation_mutation_lease_expired",
    message: "lease expired",
  });
  const legacyPayload = classifyAtomicSubmitError(new PlatformApiError(
    409,
    "conflict",
    "payload migration required",
    { code: "annotation_payload_invalid" },
  ), true);
  assert.deepEqual(legacyPayload, {
    status: "error",
    retryable: false,
    code: "annotation_payload_invalid",
    message: "payload migration required",
  });
  assert.equal(requiresLegacySnapshotMigration(legacyPayload), true);
  assert.equal(requiresLegacySnapshotMigration(revisionConflict), false);
  assert.equal(requiresLegacySnapshotMigration(classifyAtomicSubmitError(expiredLease, true)), false);
  assert.equal(isMutationLeaseSubmitFailure(classifyAtomicSubmitError(expiredLease, true)), true);
  assert.equal(isMutationLeaseSubmitFailure(revisionConflict), false);
  assert.equal(shouldReleaseMutationLeaseAfterAtomicFailure(
    classifyAtomicSubmitError(expiredLease, true),
  ), true);
  assert.equal(shouldReleaseMutationLeaseAfterAtomicFailure(revisionConflict), true);
  assert.equal(shouldReleaseMutationLeaseAfterAtomicFailure(legacyPayload), false);
  assert.equal(classifyAtomicSubmitError(new PlatformApiError(503, "internal_error", "busy", null), true).retryable, true);
  assert.deepEqual(
    classifyAtomicSubmitError(new PlatformApiError(503, "maintenance_mode", "维护中", null), true),
    {
      status: "error",
      retryable: false,
      code: "maintenance_mode",
      message: "服务器正在维护，当前修改暂时无法自动保存到服务器；本地恢复草稿将继续保留。",
    },
  );
  assert.equal(classifyAtomicSubmitError(new PlatformApiError(403, "forbidden", "no", null), true).retryable, false);
});
