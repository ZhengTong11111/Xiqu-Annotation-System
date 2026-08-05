import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformSaveOutcome } from "../utils/platformOperations";
import {
  createPlatformAutoSaveRuntime,
  type PlatformAutoSaveFacts,
} from "./platformAutoSaveRuntime";

// 确定性时钟只运行到指定时间内的任务，使 idle 与退避测试无需等待真实秒数。
class FakeClock {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { dueAt: this.now + delayMs, callback });
    return id;
  };

  clearTimer = (timerId: number) => {
    this.tasks.delete(timerId);
  };

  pendingCount() {
    return this.tasks.size;
  }

  // 逐个执行到期任务并清空 Promise 链，保证请求结果安排的新 timer 可在断言前落地。
  async advanceBy(durationMs: number) {
    const target = this.now + durationMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.dueAt;
      task.callback();
      await flushPromises();
    }
    this.now = target;
    await flushPromises();
  }
}

// 运行时请求使用多层 then/finally；有限轮微任务刷新足以让所有同步 outcome 完成。
async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

// deferred 用于模拟保存期间继续编辑和卸载后的迟到响应。
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const DIRTY_FACTS: PlatformAutoSaveFacts = {
  enabled: true,
  dirty: true,
  suspended: false,
  localRevision: 1,
  syncStatus: "dirty",
  online: true,
};

// 测试夹具统一注入 fake clock，并暴露保存次数、异常和可替换保存实现。
function createHarness(save: () => Promise<PlatformSaveOutcome>) {
  const clock = new FakeClock();
  const unexpectedErrors: unknown[] = [];
  let saveCount = 0;
  const runtime = createPlatformAutoSaveRuntime({
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save: () => {
      saveCount += 1;
      return save();
    },
    onUnexpectedError: (error) => unexpectedErrors.push(error),
  });
  return { clock, runtime, unexpectedErrors, getSaveCount: () => saveCount };
}

// dirty 会话只建立一个 idle timer，到点后也只启动一个保存请求。
test("自动保存运行时在空闲窗口后单次保存", async () => {
  const harness = createHarness(async () => ({ status: "saved" }));
  harness.runtime.update(DIRTY_FACTS);
  assert.equal(harness.clock.pendingCount(), 1);
  await harness.clock.advanceBy(2_999);
  assert.equal(harness.getSaveCount(), 0);
  await harness.clock.advanceBy(1);
  assert.equal(harness.getSaveCount(), 1);
  assert.equal(harness.clock.pendingCount(), 1);
  harness.runtime.dispose();
});

// 保存过程中产生的新 revision 不能并发提交，首请求结束后才重新进入 idle。
test("保存期间继续编辑仍保持 single-flight", async () => {
  const firstSave = createDeferred<PlatformSaveOutcome>();
  const harness = createHarness(() => firstSave.promise);
  harness.runtime.update(DIRTY_FACTS);
  await harness.clock.advanceBy(3_000);
  assert.equal(harness.getSaveCount(), 1);

  harness.runtime.update({ ...DIRTY_FACTS, localRevision: 2, syncStatus: "saving" });
  assert.equal(harness.clock.pendingCount(), 0);
  assert.equal(harness.getSaveCount(), 1);

  firstSave.resolve({ status: "saved" });
  await flushPromises();
  // 服务器 Promise 完成不等于 React 文档状态已提交；saving facts 下运行时必须继续等待。
  assert.equal(harness.clock.pendingCount(), 0);
  harness.runtime.update({ ...DIRTY_FACTS, localRevision: 2 });
  assert.equal(harness.clock.pendingCount(), 1);
  await harness.clock.advanceBy(3_000);
  assert.equal(harness.getSaveCount(), 2);
  harness.runtime.dispose();
});

// 可重试错误必须按 2 秒、4 秒增长，且每次失败后仍只有一个 timer。
test("可重试错误使用有界指数退避", async () => {
  const outcomes: PlatformSaveOutcome[] = [
    { status: "error", retryable: true, message: "temporary-1" },
    { status: "error", retryable: true, message: "temporary-2" },
    { status: "saved" },
  ];
  const harness = createHarness(async () => outcomes.shift() ?? { status: "saved" });
  harness.runtime.update(DIRTY_FACTS);
  await harness.clock.advanceBy(3_000);
  assert.equal(harness.getSaveCount(), 1);
  assert.equal(harness.clock.pendingCount(), 1);
  await harness.clock.advanceBy(1_999);
  assert.equal(harness.getSaveCount(), 1);
  await harness.clock.advanceBy(1);
  assert.equal(harness.getSaveCount(), 2);
  await harness.clock.advanceBy(3_999);
  assert.equal(harness.getSaveCount(), 2);
  await harness.clock.advanceBy(1);
  assert.equal(harness.getSaveCount(), 3);
  harness.runtime.dispose();
});

// 409 自动协调只更新本地/远端基线，重建后的命令尚未提交；运行时必须再次触发保存完成闭环。
test("并发协调重基线后继续提交重建命令", async () => {
  const outcomes: PlatformSaveOutcome[] = [
    { status: "rebased", message: "已重放到最新版本" },
    { status: "saved" },
  ];
  const harness = createHarness(async () => outcomes.shift() ?? { status: "saved" });
  harness.runtime.update(DIRTY_FACTS);
  await harness.clock.advanceBy(3_000);
  assert.equal(harness.getSaveCount(), 2);
  assert.equal(harness.clock.pendingCount(), 1);
  harness.runtime.dispose();
});

// offline 不建立请求；恢复在线后 dirty 会话无需再等待完整 idle 窗口。
test("离线恢复后立即重新保存", async () => {
  const harness = createHarness(async () => ({ status: "saved" }));
  harness.runtime.update({ ...DIRTY_FACTS, online: false, syncStatus: "offline" });
  assert.equal(harness.clock.pendingCount(), 0);
  harness.runtime.update(DIRTY_FACTS);
  await flushPromises();
  assert.equal(harness.getSaveCount(), 1);
  harness.runtime.dispose();
});

// conflict 和确定错误必须 fail closed，后续编辑不能在后台擅自解除阻断。
test("冲突与不可重试错误阻断后续自动保存", async () => {
  const conflictHarness = createHarness(async () => ({
    status: "conflict",
    retryable: false,
    message: "conflict",
  }));
  conflictHarness.runtime.update(DIRTY_FACTS);
  await conflictHarness.clock.advanceBy(3_000);
  conflictHarness.runtime.update({ ...DIRTY_FACTS, localRevision: 2, syncStatus: "conflict" });
  await conflictHarness.clock.advanceBy(30_000);
  assert.equal(conflictHarness.getSaveCount(), 1);
  assert.equal(conflictHarness.clock.pendingCount(), 0);
  conflictHarness.runtime.dispose();

  const errorHarness = createHarness(async () => ({
    status: "error",
    retryable: false,
    message: "forbidden",
  }));
  errorHarness.runtime.update(DIRTY_FACTS);
  await errorHarness.clock.advanceBy(3_000);
  errorHarness.runtime.update({ ...DIRTY_FACTS, localRevision: 2, syncStatus: "error" });
  await errorHarness.clock.advanceBy(30_000);
  assert.equal(errorHarness.getSaveCount(), 1);
  errorHarness.runtime.dispose();
});

// suspend 必须取消可见 timer；解除后 dirty 会话继续沿原 idle 截止时间求值。
test("待确认整合暂停并安全恢复自动保存", async () => {
  const harness = createHarness(async () => ({ status: "saved" }));
  harness.runtime.update(DIRTY_FACTS);
  harness.runtime.update({ ...DIRTY_FACTS, suspended: true });
  assert.equal(harness.clock.pendingCount(), 0);
  await harness.clock.advanceBy(5_000);
  harness.runtime.update(DIRTY_FACTS);
  await flushPromises();
  assert.equal(harness.getSaveCount(), 1);
  harness.runtime.dispose();
});

// 合同外同步 throw 与 rejected Promise 都必须报告、释放锁并停止自动重试。
test("保存合同外异常被统一阻断且不遗留请求锁", async () => {
  for (const save of [
    () => {
      throw new Error("sync throw");
    },
    () => Promise.reject(new Error("async reject")),
  ]) {
    const harness = createHarness(save);
    harness.runtime.update(DIRTY_FACTS);
    await harness.clock.advanceBy(3_000);
    harness.runtime.update({ ...DIRTY_FACTS, localRevision: 2, syncStatus: "error" });
    await harness.clock.advanceBy(30_000);
    assert.equal(harness.getSaveCount(), 1);
    assert.equal(harness.unexpectedErrors.length, 1);
    assert.equal(harness.clock.pendingCount(), 0);
    harness.runtime.dispose();
  }
});

// 卸载后的迟到响应不得重新建 timer，也不得把异常回调到已销毁编辑器。
test("dispose 后忽略迟到保存结果", async () => {
  const deferred = createDeferred<PlatformSaveOutcome>();
  const harness = createHarness(() => deferred.promise);
  harness.runtime.update(DIRTY_FACTS);
  await harness.clock.advanceBy(3_000);
  harness.runtime.dispose();
  deferred.reject(new Error("late failure"));
  await flushPromises();
  assert.equal(harness.clock.pendingCount(), 0);
  assert.deepEqual(harness.unexpectedErrors, []);
});
