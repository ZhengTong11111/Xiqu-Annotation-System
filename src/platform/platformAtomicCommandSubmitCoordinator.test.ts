import assert from "node:assert/strict";
import test from "node:test";
import type { CommitAnnotationCommandBatchResponse } from "@xiqu/shared";
import { PlatformApiError } from "../api/platformClient";
import type { AtomicCommandPlan } from "./platformAtomicCommandPlan";
import { createPlatformAtomicCommandSubmitCoordinator } from "./platformAtomicCommandSubmitCoordinator";

class FakeClock {
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();
  now = 0;

  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.now + delayMs, callback });
    return id;
  };

  clearTimer = (timerId: number) => {
    this.tasks.delete(timerId);
  };

  async advanceBy(delayMs: number) {
    const target = this.now + delayMs;
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
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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

function response(): CommitAnnotationCommandBatchResponse {
  return {
    committedRevision: 2,
    operationCursor: "cursor",
    operations: [{
      id: "row",
      annotationFileId: "file",
      actorUserId: "user",
      clientOperationId: "op-1",
      sequence: 1,
      baseRevision: 1,
      localRevision: 1,
      action: "annotation.items.content.update",
      payload: PLAN.request.operations[0].payload,
      status: "accepted",
      commitState: "committed",
      committedRevision: 2,
      committedAt: new Date().toISOString(),
      replayability: "domain_command",
      createdAt: new Date().toISOString(),
    }],
  };
}

test("coordinator 离线立即返回且同一会话只允许一个等待事务", async () => {
  const clock = new FakeClock();
  const pending = deferred<CommitAnnotationCommandBatchResponse>();
  const coordinator = createPlatformAtomicCommandSubmitCoordinator({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: () => pending.promise,
    applyCommitted: () => ({ status: "applied" }),
    onRetryableFailure: () => undefined,
  }, { online: false, sessionKey: "file-1" });

  assert.equal((await coordinator.submit(PLAN)).status, "failed");
  coordinator.updateConnection({ online: true, sessionKey: "file-1" });
  const first = coordinator.submit(PLAN);
  assert.equal((await coordinator.submit(PLAN)).status, "busy");
  await clock.advanceBy(0);
  pending.resolve(response());
  await flush();
  assert.equal((await first).status, "committed");
  coordinator.dispose();
});

test("可重试错误保留同一调用，最终冲突后才结束", async () => {
  const clock = new FakeClock();
  const retryableFailures: string[] = [];
  let attempts = 0;
  const coordinator = createPlatformAtomicCommandSubmitCoordinator({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("network");
      throw new PlatformApiError(409, "conflict", "revision", null);
    },
    applyCommitted: () => ({ status: "applied" }),
    onRetryableFailure: (failure) => retryableFailures.push(failure.status),
  }, { online: true, sessionKey: "file-1" });

  const result = coordinator.submit(PLAN);
  await clock.advanceBy(0);
  await clock.advanceBy(1_000);
  assert.deepEqual(retryableFailures, ["retryable"]);
  assert.equal((await result).status, "failed");
  assert.equal(attempts, 2);
  coordinator.dispose();
});

test("文件会话切换取消旧等待且迟到响应不能确认", async () => {
  const clock = new FakeClock();
  const pending = deferred<CommitAnnotationCommandBatchResponse>();
  let applied = 0;
  const coordinator = createPlatformAtomicCommandSubmitCoordinator({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    submit: () => pending.promise,
    applyCommitted: () => {
      applied += 1;
      return { status: "applied" };
    },
    onRetryableFailure: () => undefined,
  }, { online: true, sessionKey: "file-1" });

  const result = coordinator.submit(PLAN);
  await clock.advanceBy(0);
  coordinator.updateConnection({ online: true, sessionKey: "file-2" });
  assert.equal((await result).status, "cancelled");
  pending.resolve(response());
  await flush();
  assert.equal(applied, 0);
  coordinator.dispose();
});
