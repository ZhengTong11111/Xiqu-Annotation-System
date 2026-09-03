import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_HISTORY_FUTURE_ROLLOUT,
  decideFutureSnapshotStorage,
  MAX_ANNOTATION_HISTORY_FUTURE_REPLAY_OPERATIONS,
} from "../src/annotationHistoryFutureSnapshotPolicy.js";

const HASH = "a".repeat(64);

function proof(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    payloadHash: HASH,
    recipe: {
      version: 1 as const,
      hashVersion: "canonical-json-sha256-v1" as const,
      checkpointSnapshotId: "checkpoint-1",
      checkpointRevision: 1,
      operationRevisionStart: 2,
      operationRevisionEnd: 2,
      operationSequenceStart: 1,
      operationSequenceEnd: 1,
      operationCount: 1,
      targetPayloadHash: HASH,
      estimatedBytes: 180,
      ...overrides,
    },
  };
}

function decide(overrides: Record<string, unknown> = {}) {
  return decideFutureSnapshotStorage({
    rollout: ANNOTATION_HISTORY_FUTURE_ROLLOUT,
    reason: "save",
    isCheckpoint: false,
    targetRevision: 2,
    checkpointRevision: 1,
    proof: proof(),
    ...overrides,
  });
}

// 未到明确 rollout 边界时，旧历史和旧 release 一律继续使用完整 inline。
test("rollout 未开启时回退 inline", () => {
  assert.deepEqual(decide({ rollout: "disabled" }), {
    storageMode: "inline",
    payloadRequired: true,
    recipe: null,
    fallbackReason: "rollout_disabled",
  });
});

// 特殊保护快照和周期检查点必须提供恢复起点，不能因为有 recipe 就省略正文。
test("特殊 reason 和检查点回退 inline", () => {
  assert.equal(decide({ reason: "before_snapshot_restore" }).fallbackReason, "non_save_reason");
  assert.equal(decide({ isCheckpoint: true }).fallbackReason, "checkpoint_required");
});

// 证明缺失、失败和形状漂移都不应制造半可恢复记录。
test("证明缺失或失败回退 inline", () => {
  assert.equal(decide({ proof: null }).fallbackReason, "proof_missing");
  assert.equal(decide({ proof: { ok: false, code: "operation_apply_failed" } }).fallbackReason, "proof_failed");
  assert.equal(decide({ proof: proof({ targetPayloadHash: "b".repeat(64) }) }).fallbackReason, "proof_shape_invalid");
});

// recipe 的目标 revision、checkpoint revision 和 hash 必须与事务上下文完全相等。
test("recipe 身份或 hash 不一致回退 inline", () => {
  assert.equal(decide({ targetRevision: 3 }).fallbackReason, "proof_shape_invalid");
  assert.equal(decide({ checkpointRevision: 0 }).fallbackReason, "proof_shape_invalid");
  assert.equal(
    decide({ proof: proof({ hashVersion: "other-hash-version" }) }).fallbackReason,
    "proof_shape_invalid",
  );
  assert.equal(decide({ proof: { ...proof(), payloadHash: "b".repeat(64) } }).fallbackReason, "proof_shape_invalid");
});

// 超过恢复预算时宁可写完整快照，不能让线上恢复请求承担无界重放。
test("超过 operation 预算回退 inline", () => {
  assert.equal(
    decide({
      proof: proof({
        operationCount: MAX_ANNOTATION_HISTORY_FUTURE_REPLAY_OPERATIONS + 1,
        operationSequenceEnd: MAX_ANNOTATION_HISTORY_FUTURE_REPLAY_OPERATIONS + 1,
      }),
    }).fallbackReason,
    "replay_budget_exceeded",
  );
});

// 只有完整证明成功时才允许省略 payload，并且原 recipe 不能被策略层改写。
test("精确证明成功时选择 reconstructible", () => {
  const result = decide();
  assert.equal(result.storageMode, "reconstructible");
  assert.equal(result.payloadRequired, false);
  assert.deepEqual(result.recipe, proof().recipe);
  assert.equal(result.fallbackReason, null);
});
