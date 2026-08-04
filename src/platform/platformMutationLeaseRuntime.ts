import type {
  AnnotationMutationLeaseGrant,
  AnnotationMutationPurpose,
} from "@xiqu/shared";

const RENEW_HEADROOM_MS = 20_000;
const RENEW_RETRY_MS = 5_000;

export type PlatformMutationLeaseViewState =
  | { status: "idle" }
  | { status: "acquiring" }
  | {
      status: "active";
      purpose: AnnotationMutationPurpose;
      expiresAt: string;
    }
  | { status: "error"; message: string };

export type PlatformMutationLeaseRuntime = {
  acquire: (purpose: AnnotationMutationPurpose) => Promise<string>;
  getToken: () => string | undefined;
  markCommitted: () => void;
  updateBaseRevision: (baseRevision: number) => void;
  release: () => Promise<void>;
  dispose: () => void;
};

type PlatformMutationLeaseRuntimeDependencies = {
  baseRevision: number;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
  acquire: (purpose: AnnotationMutationPurpose, baseRevision: number) => Promise<AnnotationMutationLeaseGrant>;
  renew: (token: string) => Promise<AnnotationMutationLeaseGrant>;
  release: (token: string) => Promise<void>;
  onStateChange: (state: PlatformMutationLeaseViewState) => void;
  onLeaseLost: (error: unknown) => void;
};

// runtime 是文件会话级内存对象：token 不进入 React 可持久化状态，timer 与网络 single-flight 也不散落进 App。
export function createPlatformMutationLeaseRuntime(
  dependencies: PlatformMutationLeaseRuntimeDependencies,
): PlatformMutationLeaseRuntime {
  let lease: AnnotationMutationLeaseGrant | null = null;
  let acquirePromise: Promise<string> | null = null;
  let renewPromise: Promise<void> | null = null;
  let timerId: number | null = null;
  let disposed = false;
  let generation = 0;
  let baseRevision = dependencies.baseRevision;

  function clearTimer() {
    if (timerId === null) return;
    dependencies.clearTimer(timerId);
    timerId = null;
  }

  function clearLocalLease(nextState: PlatformMutationLeaseViewState = { status: "idle" }) {
    clearTimer();
    lease = null;
    acquirePromise = null;
    renewPromise = null;
    if (!disposed) dependencies.onStateChange(nextState);
  }

  function scheduleRenewal() {
    clearTimer();
    if (!lease || disposed) return;
    const expiresAt = Date.parse(lease.expiresAt);
    const delay = Math.max(0, expiresAt - dependencies.now() - RENEW_HEADROOM_MS);
    timerId = dependencies.setTimer(() => {
      timerId = null;
      void renewLease();
    }, delay);
  }

  function scheduleExpiryLoss(token: string, expiresAt: string) {
    clearTimer();
    const delay = Math.max(0, Date.parse(expiresAt) - dependencies.now());
    timerId = dependencies.setTimer(() => {
      timerId = null;
      if (disposed || lease?.token !== token) return;
      const error = new Error("结构编辑租约已达到最长持有时间，请重新取得编辑锁。");
      clearLocalLease({ status: "error", message: error.message });
      dependencies.onLeaseLost(error);
    }, delay);
  }

  async function renewLease() {
    if (!lease || disposed || renewPromise) return renewPromise ?? Promise.resolve();
    const requestGeneration = generation;
    const token = lease.token;
    const previousExpiresAt = Date.parse(lease.expiresAt);
    renewPromise = dependencies.renew(token)
      .then((renewed) => {
        if (disposed || requestGeneration !== generation || lease?.token !== token) return;
        lease = renewed;
        dependencies.onStateChange({
          status: "active",
          purpose: renewed.purpose,
          expiresAt: renewed.expiresAt,
        });
        const renewedExpiresAt = Date.parse(renewed.expiresAt);
        if (renewedExpiresAt <= previousExpiresAt) {
          // 服务端的绝对持有上限会返回相同 expiresAt；此时不能按 0ms 忙循环续期。
          scheduleExpiryLoss(token, renewed.expiresAt);
        } else {
          scheduleRenewal();
        }
      })
      .catch((error: unknown) => {
        if (disposed || requestGeneration !== generation || lease?.token !== token) return;
        const remainingMs = Date.parse(lease.expiresAt) - dependencies.now();
        if (remainingMs > 1_000) {
          // 短暂网络失败保留尚有效 token 并快速重试；不能提前降级为无锁写入。
          timerId = dependencies.setTimer(() => {
            timerId = null;
            void renewLease();
          }, Math.min(RENEW_RETRY_MS, remainingMs - 1_000));
          dependencies.onStateChange({ status: "error", message: toErrorMessage(error) });
          return;
        }
        clearLocalLease({ status: "error", message: toErrorMessage(error) });
        dependencies.onLeaseLost(error);
      })
      .finally(() => {
        if (requestGeneration === generation) renewPromise = null;
      });
    return renewPromise;
  }

  return {
    async acquire(purpose) {
      if (disposed) throw new Error("结构编辑租约运行时已经关闭。");
      if (lease) return lease.token;
      if (acquirePromise) return acquirePromise;
      const requestGeneration = generation;
      dependencies.onStateChange({ status: "acquiring" });
      acquirePromise = dependencies.acquire(purpose, baseRevision)
        .then((grant) => {
          if (disposed || requestGeneration !== generation) {
            void dependencies.release(grant.token).catch(() => undefined);
            throw new Error("结构编辑会话已经切换。");
          }
          lease = grant;
          dependencies.onStateChange({
            status: "active",
            purpose: grant.purpose,
            expiresAt: grant.expiresAt,
          });
          scheduleRenewal();
          return grant.token;
        })
        .catch((error: unknown) => {
          if (!disposed && requestGeneration === generation && !lease) {
            dependencies.onStateChange({ status: "error", message: toErrorMessage(error) });
          }
          throw error;
        })
        .finally(() => {
          if (requestGeneration === generation) acquirePromise = null;
        });
      return acquirePromise;
    },

    getToken() {
      return lease?.token;
    },

    // save 成功时服务端已在同一事务删除租约；客户端只清内存，不再发送会产生误导审计的 DELETE。
    markCommitted() {
      generation += 1;
      clearLocalLease();
    },

    // 原子批次提交会同步推进服务器 revision；下一批申请租约必须立即使用新基线，不能等待 React effect。
    updateBaseRevision(nextBaseRevision) {
      if (disposed || nextBaseRevision === baseRevision) return;
      const previousLease = lease;
      baseRevision = nextBaseRevision;
      generation += 1;
      clearLocalLease();
      // 外部 revision 推进时旧 token 已不再适用于新基线；若服务器尚未消费则做 best-effort 释放。
      if (previousLease) void dependencies.release(previousLease.token).catch(() => undefined);
    },

    async release() {
      const current = lease;
      generation += 1;
      clearLocalLease();
      if (current) await dependencies.release(current.token);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearTimer();
      const token = lease?.token;
      lease = null;
      if (token) void dependencies.release(token).catch(() => undefined);
    },
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "结构编辑租约请求失败。";
}
