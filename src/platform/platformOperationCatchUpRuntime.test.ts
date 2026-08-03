import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlatformOperationCatchUpRuntime,
  PLATFORM_CATCH_UP_INTERVAL_MS,
  PLATFORM_CATCH_UP_RETRY_MS,
  type PlatformOperationCatchUpFacts,
} from "./platformOperationCatchUpRuntime";

// 可控时钟逐个执行到期任务，使轮询、退避和 dispose 测试无需等待真实时间。
class FakeClock {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.now + delayMs, callback });
    return id;
  };

  clearTimer = (id: number) => {
    this.tasks.delete(id);
  };

  pendingCount() {
    return this.tasks.size;
  }

  async advanceBy(durationMs: number) {
    const target = this.now + durationMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].dueAt;
      next[1].callback();
      await flushPromises();
    }
    this.now = target;
    await flushPromises();
  }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const FACTS: PlatformOperationCatchUpFacts = {
  enabled: true,
  blocked: false,
  online: true,
  sessionKey: "file-1",
  knownRevision: 1,
  cursor: "cursor-1",
};

// harness 统一收集检查、应用和异常，确保测试关注协调行为而不是 React 生命周期。
function createHarness(check: () => Promise<{ status: "up_to_date"; revision: number; cursor: string }>) {
  const clock = new FakeClock();
  let checks = 0;
  const applied: string[] = [];
  const errors: unknown[] = [];
  const runtime = createPlatformOperationCatchUpRuntime({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    check: async () => {
      checks += 1;
      return check();
    },
    apply: async (result) => {
      applied.push(result.status);
    },
    onError: (error) => errors.push(error),
  });
  return { clock, runtime, applied, errors, getChecks: () => checks };
}

test("clean 会话立即检查并按固定周期保持 single-flight", async () => {
  const pending = deferred<{ status: "up_to_date"; revision: number; cursor: string }>();
  const harness = createHarness(() => pending.promise);
  harness.runtime.update(FACTS);
  await flushPromises();
  assert.equal(harness.getChecks(), 1);
  harness.runtime.update(FACTS);
  await harness.clock.advanceBy(PLATFORM_CATCH_UP_INTERVAL_MS * 2);
  assert.equal(harness.getChecks(), 1);
  pending.resolve({ status: "up_to_date", revision: 1, cursor: "cursor-1" });
  await flushPromises();
  assert.deepEqual(harness.applied, ["up_to_date"]);
  assert.equal(harness.clock.pendingCount(), 1);
  await harness.clock.advanceBy(PLATFORM_CATCH_UP_INTERVAL_MS);
  assert.equal(harness.getChecks(), 2);
  harness.runtime.dispose();
});

test("blocked 与 offline 不轮询，恢复 eligible 后立即检查", async () => {
  const harness = createHarness(async () => ({
    status: "up_to_date",
    revision: 1,
    cursor: "cursor-1",
  }));
  harness.runtime.update({ ...FACTS, blocked: true });
  harness.runtime.update({ ...FACTS, online: false });
  await harness.clock.advanceBy(30_000);
  assert.equal(harness.getChecks(), 0);
  harness.runtime.update(FACTS);
  await flushPromises();
  assert.equal(harness.getChecks(), 1);
  harness.runtime.dispose();
});

test("文件切换和 dispose 丢弃迟到结果", async () => {
  const first = deferred<{ status: "up_to_date"; revision: number; cursor: string }>();
  const harness = createHarness(() => first.promise);
  harness.runtime.update(FACTS);
  await flushPromises();
  harness.runtime.update({
    ...FACTS,
    sessionKey: "file-2",
    knownRevision: 0,
    cursor: "cursor-file-2",
  });
  first.resolve({ status: "up_to_date", revision: 1, cursor: "cursor-1" });
  await flushPromises();
  assert.deepEqual(harness.applied, []);
  await harness.clock.advanceBy(0);
  assert.equal(harness.getChecks(), 2);
  harness.runtime.dispose();
  assert.equal(harness.clock.pendingCount(), 0);
});

test("网络异常报告一次并使用短退避重试", async () => {
  let shouldFail = true;
  const harness = createHarness(async () => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error("temporary network");
    }
    return { status: "up_to_date", revision: 1, cursor: "cursor-1" };
  });
  harness.runtime.update(FACTS);
  await flushPromises();
  assert.equal(harness.errors.length, 1);
  await harness.clock.advanceBy(PLATFORM_CATCH_UP_RETRY_MS - 1);
  assert.equal(harness.getChecks(), 1);
  await harness.clock.advanceBy(1);
  assert.equal(harness.getChecks(), 2);
  harness.runtime.dispose();
});

test("显式唤醒在 idle 时立即检查，并把 flight 期间多次通知合并成一次后续检查", async () => {
  const first = deferred<{ status: "up_to_date"; revision: number; cursor: string }>();
  let useFirst = true;
  const harness = createHarness(async () => {
    if (useFirst) {
      useFirst = false;
      return first.promise;
    }
    return { status: "up_to_date", revision: 1, cursor: "cursor-1" };
  });
  harness.runtime.update(FACTS);
  await flushPromises();
  harness.runtime.requestCheck();
  harness.runtime.requestCheck();
  assert.equal(harness.getChecks(), 1);
  first.resolve({ status: "up_to_date", revision: 1, cursor: "cursor-1" });
  await flushPromises();
  await harness.clock.advanceBy(0);
  assert.equal(harness.getChecks(), 2);
  harness.runtime.dispose();
});

test("blocked 时保留一次通知唤醒，恢复 clean 后立即执行", async () => {
  const harness = createHarness(async () => ({
    status: "up_to_date",
    revision: 1,
    cursor: "cursor-1",
  }));
  harness.runtime.update({ ...FACTS, blocked: true });
  harness.runtime.requestCheck();
  await harness.clock.advanceBy(10_000);
  assert.equal(harness.getChecks(), 0);
  harness.runtime.update(FACTS);
  await flushPromises();
  assert.equal(harness.getChecks(), 1);
  harness.runtime.dispose();
});
