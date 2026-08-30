import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProcessingJobCommandMatch,
  createProcessingJobCommandFingerprint,
  createProcessingJobRetryClientRequestId,
  normalizeProcessingJobCancellationReason,
} from "../src/processingJobCommand.js";

test("任务取消原因规范化并保持明确长度边界", () => {
  assert.equal(normalizeProcessingJobCancellationReason(undefined), null);
  assert.equal(normalizeProcessingJobCancellationReason("  原因  "), "原因");
  assert.throws(() => normalizeProcessingJobCancellationReason("x".repeat(501)));
});

test("任务命令指纹绑定动作、目标和原因", () => {
  const base = {
    action: "cancel_request" as const,
    targetJobId: null,
    targetRequestId: "request-1",
    reason: null,
  };
  const fingerprint = createProcessingJobCommandFingerprint(base);
  assert.doesNotThrow(() => assertProcessingJobCommandMatch(fingerprint, fingerprint));
  assert.throws(
    () => assertProcessingJobCommandMatch(
      fingerprint,
      createProcessingJobCommandFingerprint({ ...base, reason: "changed" }),
    ),
  );
});

test("重试内部请求 UUID 对账号和命令稳定隔离", () => {
  const first = createProcessingJobRetryClientRequestId("user-1", "command-1");
  assert.equal(first, createProcessingJobRetryClientRequestId("user-1", "command-1"));
  assert.notEqual(first, createProcessingJobRetryClientRequestId("user-1", "command-2"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
