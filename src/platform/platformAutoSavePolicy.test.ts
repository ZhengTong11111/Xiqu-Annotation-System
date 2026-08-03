import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlatformAutoSaveDecision,
  getPlatformAutoSaveRetryDelay,
  PLATFORM_AUTO_SAVE_RETRY_MAX_MS,
} from "./platformAutoSavePolicy";

const BASE_INPUT = {
  enabled: true,
  dirty: true,
  suspended: false,
  online: true,
  syncStatus: "dirty" as const,
  inFlight: false,
  retryBlocked: false,
  idleDueAt: null,
  retryDueAt: null,
  now: 10_000,
};

// 禁用、clean 与待确认整合都不能产生服务器保存任务。
test("自动保存策略在不适用会话中保持禁用", () => {
  assert.deepEqual(getPlatformAutoSaveDecision({ ...BASE_INPUT, enabled: false }), {
    action: "disabled",
    reason: "not-enabled",
  });
  assert.deepEqual(getPlatformAutoSaveDecision({ ...BASE_INPUT, dirty: false }), {
    action: "disabled",
    reason: "clean",
  });
  assert.deepEqual(getPlatformAutoSaveDecision({ ...BASE_INPUT, suspended: true }), {
    action: "disabled",
    reason: "suspended",
  });
});

// idle 与 retry 共享一个明确 dueAt 模型，到点后才返回唯一 save-now 命令。
test("自动保存策略区分空闲等待、退避等待与到点保存", () => {
  assert.deepEqual(getPlatformAutoSaveDecision({
    ...BASE_INPUT,
    idleDueAt: 12_500,
  }), { action: "waiting", delayMs: 2_500, reason: "idle" });
  assert.deepEqual(getPlatformAutoSaveDecision({
    ...BASE_INPUT,
    retryDueAt: 12_000,
  }), { action: "waiting", delayMs: 2_000, reason: "retry" });
  assert.deepEqual(getPlatformAutoSaveDecision({
    ...BASE_INPUT,
    idleDueAt: 9_999,
  }), { action: "save-now" });
});

// 离线、冲突、确定不可重试错误和进行中请求都必须阻止重入。
test("自动保存策略阻断离线、冲突、不可重试错误与并发请求", () => {
  assert.deepEqual(getPlatformAutoSaveDecision({ ...BASE_INPUT, online: false }), {
    action: "blocked",
    reason: "offline",
  });
  assert.deepEqual(getPlatformAutoSaveDecision({ ...BASE_INPUT, syncStatus: "conflict" }), {
    action: "blocked",
    reason: "conflict",
  });
  assert.deepEqual(getPlatformAutoSaveDecision({ ...BASE_INPUT, retryBlocked: true }), {
    action: "blocked",
    reason: "non-retryable",
  });
  assert.deepEqual(getPlatformAutoSaveDecision({ ...BASE_INPUT, syncStatus: "error" }), {
    action: "blocked",
    reason: "non-retryable",
  });
  assert.deepEqual(getPlatformAutoSaveDecision({
    ...BASE_INPUT,
    syncStatus: "error",
    retryDueAt: 12_000,
  }), { action: "waiting", delayMs: 2_000, reason: "retry" });
  assert.deepEqual(getPlatformAutoSaveDecision({ ...BASE_INPUT, inFlight: true }), {
    action: "waiting",
    delayMs: 0,
    reason: "in-flight",
  });
});

// 指数退避必须有上限，长时间故障不会溢出或形成超长不确定 timer。
test("自动保存退避按指数增长并封顶", () => {
  assert.equal(getPlatformAutoSaveRetryDelay(0), 2_000);
  assert.equal(getPlatformAutoSaveRetryDelay(1), 4_000);
  assert.equal(getPlatformAutoSaveRetryDelay(5), PLATFORM_AUTO_SAVE_RETRY_MAX_MS);
  assert.equal(getPlatformAutoSaveRetryDelay(100), PLATFORM_AUTO_SAVE_RETRY_MAX_MS);
  assert.equal(getPlatformAutoSaveRetryDelay(-2), 2_000);
});
