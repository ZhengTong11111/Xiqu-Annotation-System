import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import { buildProjectAnnotationContentCommand } from "../utils/annotationContentCommand";
import {
  buildAnnotationClientSyncFailureReport,
  getSyncFailurePlannerFailure,
} from "./platformSyncFailureDiagnostic";

test("同步失败报告保留命令目标、UUID 和 before/after，但脱敏 URL 与凭据", () => {
  const next = structuredClone(mockProject);
  next.characterAnnotations[0].char = "调试内容 https://example.invalid/token/abcdefghijklmnopqrstuvwxyz123456";
  const envelope = buildProjectAnnotationContentCommand(mockProject, next, [{
    entityType: "character",
    entityId: next.characterAnnotations[0].id,
    field: "char",
  }]);
  if (!envelope) throw new Error("测试命令生成失败。");
  const report = buildAnnotationClientSyncFailureReport({
    clientRuntimeId: "runtime-test",
    errorMessage: "本地命令链无法安全提交（local_chain_mismatch）",
    syncState: {
      status: "error",
      localRevision: 1,
      savedRevision: 0,
      remoteRevision: 68,
      pendingOperationCount: 1,
      lastChangedAt: null,
      lastSavedAt: null,
      lastSyncAttemptAt: null,
      errorMessage: null,
    },
    appRemoteRevision: 68,
    observedRemoteRevision: 68,
    hasUnsavedChanges: true,
    saveInFlight: false,
    online: true,
    mismatchFields: ["characterAnnotations"],
    mismatchDetails: [{
      path: "/characterAnnotations/0/char",
      savedValue: "原字",
      replayedValue: "命令值",
      currentValue: "当前文字",
    }],
    pendingOperations: [{
      id: "op-test",
      type: envelope.command.type,
      action: "edit",
      localRevision: 1,
      baseRevision: 0,
      createdAt: Date.parse("2026-08-06T00:00:00.000Z"),
      syncState: "pending",
      commandEnvelope: envelope,
      summary: { hasProjectChange: true, hasTrackSnapChange: false },
    }],
  });
  assert.equal(report.category, "atomic_plan");
  assert.equal(report.reason, "local_chain_mismatch");
  assert.equal(report.errorMessage, "本地命令链无法安全提交（local_chain_mismatch）");
  assert.deepEqual(report.mismatchFields, ["characterAnnotations"]);
  assert.deepEqual(report.mismatchDetails, [{
    path: "/characterAnnotations/0/char",
    savedValue: "原字",
    replayedValue: "命令值",
    currentValue: "当前文字",
  }]);
  assert.match(report.pendingOperations[0].targets[0], /character/);
  assert.equal(report.pendingOperations[0].operationId, "op-test");
  assert.match(report.pendingOperations[0].targets[0], new RegExp(next.characterAnnotations[0].id));
  const payload = report.pendingOperations[0].commandPayload as typeof envelope;
  assert.equal(payload.command.items[0].before, envelope.command.items[0].before);
  assert.equal(payload.command.items[0].after, "调试内容 [REDACTED_URL]");
});

test("租约错误码进入结构编辑锁分类并保留可诊断消息", () => {
  const report = buildAnnotationClientSyncFailureReport({
    clientRuntimeId: "runtime-lease-test",
    errorMessage: "当前文件正在进行结构性变更（annotation_mutation_lease_required）",
    syncState: {
      status: "error",
      localRevision: 2,
      savedRevision: 1,
      remoteRevision: 79,
      pendingOperationCount: 1,
      lastChangedAt: null,
      lastSavedAt: null,
      lastSyncAttemptAt: null,
      errorMessage: null,
    },
    appRemoteRevision: 79,
    observedRemoteRevision: 79,
    hasUnsavedChanges: true,
    saveInFlight: false,
    online: true,
    pendingOperations: [],
  });
  assert.equal(report.category, "mutation_lease");
  assert.equal(report.reason, "annotation_mutation_lease_required");
  assert.match(report.errorMessage, /结构性变更/);
});

test("命令前置条件失败保留 operation 位置与有界子命令问题", () => {
  const plannerFailure = getSyncFailurePlannerFailure({
    operationId: "op-precondition",
    operationIndex: 0,
    issues: {
      status: "blocked",
      childIndex: 1,
      issues: [{ code: "before_mismatch", targetKey: "character:char-1" }],
      mediaUrl: "https://example.invalid/private-audio.mp3",
    },
  });
  const report = buildAnnotationClientSyncFailureReport({
    clientRuntimeId: "runtime-precondition-test",
    errorMessage: "本地命令链无法安全提交（command_precondition_failed）",
    syncState: {
      status: "error",
      localRevision: 9,
      savedRevision: 8,
      remoteRevision: 80,
      pendingOperationCount: 1,
      lastChangedAt: null,
      lastSavedAt: null,
      lastSyncAttemptAt: null,
      errorMessage: null,
    },
    appRemoteRevision: 80,
    observedRemoteRevision: 80,
    hasUnsavedChanges: true,
    saveInFlight: false,
    online: true,
    pendingOperations: [],
    plannerFailure,
  });

  assert.deepEqual(report.plannerFailure, {
    operationId: "op-precondition",
    operationIndex: 0,
    issues: {
      status: "blocked",
      childIndex: 1,
      issues: [{ code: "before_mismatch", targetKey: "character:char-1" }],
      mediaUrl: "[REDACTED]",
    },
  });
});
