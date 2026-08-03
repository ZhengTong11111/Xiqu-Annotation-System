import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationMutationLeaseGrant } from "@xiqu/shared";
import { createPlatformMutationLeaseRuntime } from "./platformMutationLeaseRuntime";

function grant(token: string, expiresAtMs: number): AnnotationMutationLeaseGrant {
  return {
    annotationFileId: "file-one",
    holder: { id: "user-one", accountName: "admin", displayName: "管理员" },
    purpose: "track_structure",
    baseRevision: 3,
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    token,
  };
}

test("结构租约 acquire single-flight、定时续期并在提交后只清本地状态", async () => {
  let now = 1_000;
  let acquireCount = 0;
  let renewCount = 0;
  let releaseCount = 0;
  const timers = new Map<number, () => void>();
  const states: string[] = [];
  const runtime = createPlatformMutationLeaseRuntime({
    baseRevision: 3,
    now: () => now,
    setTimer: (callback) => {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    acquire: async () => {
      acquireCount += 1;
      return grant("xiqu_lease_one", 61_000);
    },
    renew: async () => {
      renewCount += 1;
      return grant("xiqu_lease_one", 101_000);
    },
    release: async () => {
      releaseCount += 1;
    },
    onStateChange: (state) => states.push(state.status),
    onLeaseLost: () => assert.fail("租约不应丢失"),
  });
  const [first, second] = await Promise.all([
    runtime.acquire("track_structure"),
    runtime.acquire("track_structure"),
  ]);
  assert.equal(first, second);
  assert.equal(acquireCount, 1);
  assert.deepEqual(states.slice(0, 2), ["acquiring", "active"]);
  const renewTimer = [...timers.values()][0];
  assert.ok(renewTimer);
  now = 41_000;
  renewTimer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renewCount, 1);
  runtime.markCommitted();
  assert.equal(runtime.getToken(), undefined);
  assert.equal(releaseCount, 0);
});

test("显式取消与 dispose 使用 best-effort release，迟到 acquire 不污染关闭会话", async () => {
  let resolveAcquire!: (value: AnnotationMutationLeaseGrant) => void;
  const released: string[] = [];
  const runtime = createPlatformMutationLeaseRuntime({
    baseRevision: 3,
    now: () => 1_000,
    setTimer: () => 1,
    clearTimer: () => undefined,
    acquire: () => new Promise((resolve) => {
      resolveAcquire = resolve;
    }),
    renew: async (token) => grant(token, 61_000),
    release: async (token) => {
      released.push(token);
    },
    onStateChange: () => undefined,
    onLeaseLost: () => undefined,
  });
  const pending = runtime.acquire("track_structure");
  runtime.dispose();
  resolveAcquire(grant("xiqu_lease_late", 61_000));
  await assert.rejects(pending, /会话已经切换/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(released, ["xiqu_lease_late"]);
});

test("显式 release 清除本地 token 并把同一个凭据交还服务端", async () => {
  const released: string[] = [];
  const runtime = createPlatformMutationLeaseRuntime({
    baseRevision: 3,
    now: () => 1_000,
    setTimer: () => 1,
    clearTimer: () => undefined,
    acquire: async () => grant("xiqu_lease_cancel", 61_000),
    renew: async (token) => grant(token, 101_000),
    release: async (token) => {
      released.push(token);
    },
    onStateChange: () => undefined,
    onLeaseLost: () => undefined,
  });
  await runtime.acquire("track_structure");
  await runtime.release();
  assert.equal(runtime.getToken(), undefined);
  assert.deepEqual(released, ["xiqu_lease_cancel"]);
});

test("续期短暂失败保留有效 token，接近过期时才上报租约丢失", async () => {
  let now = 1_000;
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  let lostCount = 0;
  const runtime = createPlatformMutationLeaseRuntime({
    baseRevision: 3,
    now: () => now,
    setTimer: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    acquire: async () => grant("xiqu_lease_retry", 30_000),
    renew: async () => {
      throw new Error("network");
    },
    release: async () => undefined,
    onStateChange: () => undefined,
    onLeaseLost: () => {
      lostCount += 1;
    },
  });
  await runtime.acquire("track_structure");
  const firstTimer = [...timers.values()][0];
  assert.ok(firstTimer);
  now = 10_000;
  firstTimer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtime.getToken(), "xiqu_lease_retry");
  const retryTimer = [...timers.values()][0];
  assert.ok(retryTimer);
  now = 29_500;
  retryTimer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtime.getToken(), undefined);
  assert.equal(lostCount, 1);
});
