import assert from "node:assert/strict";
import test from "node:test";
import type { CommitAnnotationCommandBatchResponse } from "@xiqu/shared";
import { PlatformApiError } from "../api/platformClient";
import type { AtomicCommandPlan } from "./platformAtomicCommandPlan";
import { createPlatformAtomicSubmitRuntime } from "./platformAtomicSubmitRuntime";

class FakeClock {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();
  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.now + delayMs, callback });
    return id;
  };
  clearTimer = (id: number) => { this.tasks.delete(id); };
  async advanceBy(ms: number) {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].dueAt;
      next[1].callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
  count() { return this.tasks.size; }
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const PLAN = {
  request: { baseRevision: 1, operations: [{
    clientOperationId: "op-1",
    localRevision: 1,
    action: "annotation.items.content.update",
    payload: { version: 1, command: { type: "annotation.items.content.update", items: [] } },
  }] },
  operationIds: ["op-1"],
  serverBaseProject: {} as AtomicCommandPlan["serverBaseProject"],
  acknowledgedProject: {} as AtomicCommandPlan["acknowledgedProject"],
  acknowledgedTrackSnapEnabled: {},
  remainingCount: 0,
  expectedSavedLocalRevision: 0,
  acknowledgedLocalRevision: 1,
  requiredLeasePurpose: null,
} as AtomicCommandPlan;

function createResponse(): CommitAnnotationCommandBatchResponse {
  return {
    committedRevision: 2,
    operationCursor: "cursor",
    operations: [{
      id: "row", annotationFileId: "file", actorUserId: "user", clientOperationId: "op-1",
      sequence: 1, baseRevision: 1, localRevision: 1, action: "annotation.items.content.update",
      payload: PLAN.request.operations[0].payload, status: "accepted", commitState: "committed",
      committedRevision: 2, committedAt: new Date().toISOString(), replayability: "domain_command",
      createdAt: new Date().toISOString(),
    }],
  };
}

test("同一批保持 single-flight，成功后不重复提交", async () => {
  const clock = new FakeClock();
  const pending = deferred<CommitAnnotationCommandBatchResponse>();
  let submissions = 0;
  let commits = 0;
  const runtime = createPlatformAtomicSubmitRuntime({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: () => { submissions += 1; return pending.promise; },
    onCommitted: () => { commits += 1; return { status: "applied" }; },
    onFailure: () => undefined,
    onProtocolError: () => undefined,
  });
  runtime.update({ enabled: true, online: true, sessionKey: "file-1", plan: PLAN });
  await clock.advanceBy(0);
  runtime.requestSubmit();
  assert.equal(submissions, 1);
  pending.resolve(createResponse());
  await flush();
  assert.equal(commits, 1);
  await clock.advanceBy(10_000);
  assert.equal(submissions, 1);
  runtime.dispose();
});

test("retryable 失败复用同一 plan，409 停止自动重试", async () => {
  const clock = new FakeClock();
  const seenPlans: AtomicCommandPlan[] = [];
  const failures: Array<{ status: string; willRetry: boolean }> = [];
  let call = 0;
  const runtime = createPlatformAtomicSubmitRuntime({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: async (plan) => {
      seenPlans.push(plan);
      call += 1;
      if (call === 1) throw new TypeError("network");
      throw new PlatformApiError(409, "conflict", "revision", null);
    },
    onCommitted: () => ({ status: "applied" }),
    onFailure: (failure, willRetry) => failures.push({ status: failure.status, willRetry }),
    onProtocolError: () => undefined,
  });
  runtime.update({ enabled: true, online: true, sessionKey: "file-1", plan: PLAN });
  await clock.advanceBy(0);
  await clock.advanceBy(1_000);
  assert.deepEqual(failures, [
    { status: "retryable", willRetry: true },
    { status: "conflict", willRetry: false },
  ]);
  assert.equal(seenPlans[0], seenPlans[1]);
  await clock.advanceBy(60_000);
  assert.equal(seenPlans.length, 2);
  runtime.dispose();
});

test("文件切换与 dispose 丢弃迟到响应，协议损坏不确认", async () => {
  const clock = new FakeClock();
  const pending = deferred<CommitAnnotationCommandBatchResponse>();
  const protocols: string[] = [];
  let commits = 0;
  const runtime = createPlatformAtomicSubmitRuntime({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: () => pending.promise,
    onCommitted: () => { commits += 1; return { status: "applied" }; },
    onFailure: () => undefined,
    onProtocolError: (reason) => protocols.push(reason),
  });
  runtime.update({ enabled: true, online: true, sessionKey: "file-1", plan: PLAN });
  await clock.advanceBy(0);
  runtime.update({ enabled: false, online: true, sessionKey: "file-2", plan: null });
  const malformed = createResponse();
  malformed.committedRevision = 9;
  pending.resolve(malformed);
  await flush();
  assert.equal(commits, 0);
  assert.deepEqual(protocols, []);
  runtime.dispose();
  assert.equal(clock.count(), 0);
});

test("当前会话协议错误会阻断同一批确认", async () => {
  const clock = new FakeClock();
  const protocols: string[] = [];
  const runtime = createPlatformAtomicSubmitRuntime({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: async () => ({ ...createResponse(), committedRevision: 9 }),
    onCommitted: () => ({ status: "applied" }),
    onFailure: () => undefined,
    onProtocolError: (reason) => protocols.push(reason),
  });
  runtime.update({ enabled: true, online: true, sessionKey: "file-1", plan: PLAN });
  await clock.advanceBy(0);
  assert.deepEqual(protocols, ["invalid_revision"]);
  await clock.advanceBy(60_000);
  assert.deepEqual(protocols, ["invalid_revision"]);
  runtime.dispose();
});

test("请求期间离线会保留同批，恢复在线后立即重试", async () => {
  const clock = new FakeClock();
  const first = deferred<CommitAnnotationCommandBatchResponse>();
  let submissions = 0;
  const runtime = createPlatformAtomicSubmitRuntime({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: async () => {
      submissions += 1;
      if (submissions === 1) return first.promise;
      return createResponse();
    },
    onCommitted: () => ({ status: "applied" }),
    onFailure: () => undefined,
    onProtocolError: () => undefined,
  });
  runtime.update({ enabled: true, online: true, sessionKey: "file-1", plan: PLAN });
  await clock.advanceBy(0);
  runtime.update({ enabled: true, online: false, sessionKey: "file-1", plan: PLAN });
  first.reject(new TypeError("offline"));
  await flush();
  await clock.advanceBy(30_000);
  assert.equal(submissions, 1);
  runtime.update({ enabled: true, online: true, sessionKey: "file-1", plan: PLAN });
  await flush();
  assert.equal(submissions, 2);
  runtime.dispose();
});

test("取得结构租约后同一 operation 批次可解除旧计划阻断", async () => {
  const clock = new FakeClock();
  let submissions = 0;
  const runtime = createPlatformAtomicSubmitRuntime({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: async () => {
      submissions += 1;
      if (submissions === 1) throw new PlatformApiError(409, "conflict", "lease", null);
      return createResponse();
    },
    onCommitted: () => ({ status: "applied" }),
    onFailure: () => undefined,
    onProtocolError: () => undefined,
  });
  runtime.update({ enabled: true, online: true, sessionKey: "file-1", plan: PLAN });
  await clock.advanceBy(0);
  const leasedPlan: AtomicCommandPlan = {
    ...PLAN,
    request: { ...PLAN.request, mutationLeaseToken: "lease-token" },
  };
  runtime.update({ enabled: true, online: true, sessionKey: "file-1", plan: leasedPlan });
  await clock.advanceBy(0);
  assert.equal(submissions, 2);
  runtime.dispose();
});
