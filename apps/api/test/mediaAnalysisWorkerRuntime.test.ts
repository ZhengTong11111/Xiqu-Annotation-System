import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateWorkerRetryDelay,
  MediaAnalysisWorkerRuntime,
} from "../src/mediaAnalysisWorkerRuntime.js";

test("worker 循环从短暂故障恢复并周期执行陈旧任务扫描", async () => {
  let recoverCalls = 0;
  let processCalls = 0;
  const warnings: Array<Record<string, unknown>> = [];
  const service = {
    recoverStaleJobs: async () => {
      recoverCalls += 1;
      if (recoverCalls === 1) throw new Error("测试数据库短暂不可用");
      return 0;
    },
    processNext: async () => {
      processCalls += 1;
      return false;
    },
  };
  const runtime = new MediaAnalysisWorkerRuntime(service, {
    pollIntervalMs: 2,
    staleRecoveryIntervalMs: 5,
    retryInitialMs: 1,
    retryMaxMs: 2,
    logger: { warn: (facts) => warnings.push(facts) },
  });

  const running = runtime.start();
  await waitUntil(() => recoverCalls >= 3 && processCalls > 0);
  await runtime.stop();
  await running;

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.errorCode, "worker_loop_iteration_failed");
  assert.ok(processCalls > 0, "恢复成功后必须继续领取任务");
});

test("worker stop 会立即中止长退避且保持幂等", async () => {
  let recoverCalls = 0;
  const service = {
    recoverStaleJobs: async () => {
      recoverCalls += 1;
      throw new Error("测试持续故障");
    },
    processNext: async () => false,
  };
  const runtime = new MediaAnalysisWorkerRuntime(service, {
    retryInitialMs: 60_000,
    retryMaxMs: 60_000,
  });

  const running = runtime.start();
  await waitUntil(() => recoverCalls === 1);
  await Promise.race([
    Promise.all([runtime.stop(), runtime.stop(), running]),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("worker stop 未中止退避等待")),
      250,
    )),
  ]);
});

test("worker 退避按指数增长并受最大值限制", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 20].map((attempt) => calculateWorkerRetryDelay(attempt, 10, 80)),
    [10, 20, 40, 80, 80],
  );
});

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待测试状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
