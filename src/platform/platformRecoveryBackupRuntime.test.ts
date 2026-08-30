import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlatformRecoveryBackupRuntime,
  type PlatformRecoveryBackupState,
} from "./platformRecoveryBackupRuntime";

type Payload = { marker: string };

test("连续三次失败只创建一次恢复备份，成功保存后开启新周期", async () => {
  const states: PlatformRecoveryBackupState[] = [];
  const requests: Array<{ clientBackupId: string; failureCount: number; payload: Payload }> = [];
  let idIndex = 0;
  const runtime = createPlatformRecoveryBackupRuntime<Payload>({
    createId: () => `00000000-0000-8000-8000-${String(++idIndex).padStart(12, "0")}`,
    createBackup: async (request) => {
      requests.push(request);
      return { fileName: `backup-${requests.length}.json` };
    },
    onStateChange: (state) => states.push(state),
  });
  runtime.update({ enabled: true, failureThreshold: 3, online: true });

  const error = { status: "error", retryable: true, message: "failed" } as const;
  for (let index = 1; index <= 4; index += 1) {
    await runtime.recordSaveOutcome(error, (clientBackupId, failureCount) => ({
      clientBackupId,
      sourceRevision: 8,
      failureCount,
      payload: { marker: `attempt-${index}` },
    }));
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.failureCount, 3);
  assert.deepEqual(requests[0]?.payload, { marker: "attempt-3" });
  assert.equal(states[states.length - 1]?.status, "created");

  await runtime.recordSaveOutcome({ status: "saved" }, () => {
    throw new Error("成功保存不应创建备份请求");
  });
  for (let index = 0; index < 3; index += 1) {
    await runtime.recordSaveOutcome(error, (clientBackupId, failureCount) => ({
      clientBackupId,
      sourceRevision: 9,
      failureCount,
      payload: { marker: "new-episode" },
    }));
  }
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.clientBackupId, requests[1]?.clientBackupId);
});

test("离线达到阈值时冻结最新内容，恢复在线后补建", async () => {
  const requests: Array<{ payload: Payload }> = [];
  const states: PlatformRecoveryBackupState[] = [];
  const runtime = createPlatformRecoveryBackupRuntime<Payload>({
    createId: () => "00000000-0000-8000-8000-000000000001",
    createBackup: async (request) => {
      requests.push({ payload: request.payload });
      return { fileName: "offline-backup.json" };
    },
    onStateChange: (state) => states.push(state),
  });
  runtime.update({ enabled: true, failureThreshold: 3, online: false });
  for (let index = 1; index <= 4; index += 1) {
    await runtime.recordSaveOutcome(
      { status: "offline", retryable: true, message: "offline" },
      (clientBackupId, failureCount) => ({
        clientBackupId,
        sourceRevision: 5,
        failureCount,
        payload: { marker: `offline-${index}` },
      }),
    );
  }
  assert.equal(requests.length, 0);
  assert.equal(states[states.length - 1]?.status, "pending");

  runtime.update({ enabled: true, failureThreshold: 3, online: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.payload, { marker: "offline-4" });
  assert.equal(states[states.length - 1]?.status, "created");
});

test("skipped 与 rebased 不计数，关闭设置会清理失败周期", async () => {
  const states: PlatformRecoveryBackupState[] = [];
  let createCount = 0;
  const runtime = createPlatformRecoveryBackupRuntime<Payload>({
    createId: () => "00000000-0000-8000-8000-000000000001",
    createBackup: async () => {
      createCount += 1;
      return { fileName: "unused.json" };
    },
    onStateChange: (state) => states.push(state),
  });
  runtime.update({ enabled: true, failureThreshold: 3, online: true });
  await runtime.recordSaveOutcome({ status: "skipped", reason: "busy" }, () => {
    throw new Error("skipped 不应读取 payload");
  });
  await runtime.recordSaveOutcome({ status: "rebased", message: "retry" }, () => {
    throw new Error("rebased 不应读取 payload");
  });
  await runtime.recordSaveOutcome(
    { status: "conflict", retryable: false, message: "conflict" },
    (clientBackupId, failureCount) => ({
      clientBackupId,
      sourceRevision: 1,
      failureCount,
      payload: { marker: "one" },
    }),
  );
  assert.equal(states[states.length - 1]?.failureCount, 1);

  runtime.update({ enabled: false, failureThreshold: 3, online: true });
  assert.deepEqual(states[states.length - 1], { status: "idle", failureCount: 0 });
  assert.equal(createCount, 0);
});

test("维护门禁失败保持待创建状态，不丢失冻结请求", async () => {
  const states: PlatformRecoveryBackupState[] = [];
  const runtime = createPlatformRecoveryBackupRuntime<Payload>({
    createId: () => "00000000-0000-8000-8000-000000000001",
    createBackup: async () => {
      throw new Error("maintenance");
    },
    shouldDeferError: (error) => error instanceof Error && error.message === "maintenance",
    onStateChange: (state) => states.push(state),
  });
  runtime.update({ enabled: true, failureThreshold: 3, online: true });
  for (let index = 0; index < 3; index += 1) {
    await runtime.recordSaveOutcome(
      { status: "error", retryable: false, message: "maintenance" },
      (clientBackupId, failureCount) => ({
        clientBackupId,
        sourceRevision: 2,
        failureCount,
        payload: { marker: "maintenance" },
      }),
    );
  }
  assert.equal(states[states.length - 1]?.status, "pending");
});

test("首次网络请求发出后不再替换同一幂等键的 payload", async () => {
  let releaseRequest: () => void = () => {
    throw new Error("备份请求尚未开始。");
  };
  const requests: Array<{ failureCount: number; payload: Payload }> = [];
  const runtime = createPlatformRecoveryBackupRuntime<Payload>({
    createId: () => "00000000-0000-8000-8000-000000000001",
    createBackup: async (request) => {
      requests.push({ failureCount: request.failureCount, payload: request.payload });
      await new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      return { fileName: "stable.json" };
    },
    onStateChange: () => undefined,
  });
  runtime.update({ enabled: true, failureThreshold: 3, online: true });
  const failure = { status: "error", retryable: true, message: "failed" } as const;
  await runtime.recordSaveOutcome(failure, (clientBackupId, failureCount) => ({
    clientBackupId,
    sourceRevision: 1,
    failureCount,
    payload: { marker: "one" },
  }));
  await runtime.recordSaveOutcome(failure, (clientBackupId, failureCount) => ({
    clientBackupId,
    sourceRevision: 1,
    failureCount,
    payload: { marker: "two" },
  }));
  const third = runtime.recordSaveOutcome(failure, (clientBackupId, failureCount) => ({
    clientBackupId,
    sourceRevision: 1,
    failureCount,
    payload: { marker: "frozen" },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await runtime.recordSaveOutcome(failure, (clientBackupId, failureCount) => ({
    clientBackupId,
    sourceRevision: 1,
    failureCount,
    payload: { marker: "must-not-replace" },
  }));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { failureCount: 3, payload: { marker: "frozen" } });
  releaseRequest();
  await third;
});
