import type { PlatformOperationCatchUpResult } from "./platformOperationCatchUp";

export const PLATFORM_CATCH_UP_INTERVAL_MS = 5_000;
export const PLATFORM_CATCH_UP_RETRY_MS = 2_000;

export type PlatformOperationCatchUpFacts = {
  enabled: boolean;
  blocked: boolean;
  online: boolean;
  sessionKey: string;
  knownRevision: number;
  cursor: string;
};

type RuntimeDependencies = {
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
  check: (facts: PlatformOperationCatchUpFacts) => Promise<PlatformOperationCatchUpResult>;
  apply: (
    result: PlatformOperationCatchUpResult,
    facts: PlatformOperationCatchUpFacts,
  ) => Promise<void> | void;
  onError: (error: unknown) => void;
};

export type PlatformOperationCatchUpRuntime = {
  update: (facts: PlatformOperationCatchUpFacts) => void;
  requestCheck: () => void;
  dispose: () => void;
};

// 运行时独占 timer 与 single-flight；React 重渲染只更新事实，不能制造并行轮询或跨文件迟到写入。
export function createPlatformOperationCatchUpRuntime(
  dependencies: RuntimeDependencies,
): PlatformOperationCatchUpRuntime {
  let facts: PlatformOperationCatchUpFacts | null = null;
  let timerId: number | null = null;
  let inFlight = false;
  let disposed = false;
  let generation = 0;
  let wakeRequested = false;

  // timer 只能由协调器持有一个，facts 变化时先清旧计划再重新求值。
  function clearTimer() {
    if (timerId === null) return;
    dependencies.clearTimer(timerId);
    timerId = null;
  }

  function isEligible(value: PlatformOperationCatchUpFacts | null) {
    return Boolean(value?.enabled && value.online && !value.blocked);
  }

  // 一次请求连同结果应用都属于同一个 flight；快照降级尚未结束时不能启动第二次检查。
  function runCheck() {
    if (disposed || inFlight || !isEligible(facts) || !facts) return;
    clearTimer();
    // 多个 WebSocket revision 通知合并成一个 flight；flight 期间的新通知会再次把该标志置回 true。
    wakeRequested = false;
    const requestFacts = facts;
    const requestGeneration = generation;
    let failed = false;
    inFlight = true;
    void Promise.resolve()
      .then(() => dependencies.check(requestFacts))
      .then(async (result) => {
        if (
          disposed ||
          generation !== requestGeneration ||
          !factsMatch(facts, requestFacts) ||
          !isEligible(facts)
        ) return;
        await dependencies.apply(result, requestFacts);
      })
      .catch((error: unknown) => {
        failed = true;
        if (!disposed && generation === requestGeneration) dependencies.onError(error);
      })
      .finally(() => {
        inFlight = false;
        if (disposed) return;
        // 文件/基线在请求中变化时立即检查新会话；普通失败使用短退避，成功则回到稳定轮询周期。
        schedule(
          generation !== requestGeneration || wakeRequested
            ? 0
            : failed
              ? PLATFORM_CATCH_UP_RETRY_MS
              : PLATFORM_CATCH_UP_INTERVAL_MS,
        );
      });
  }

  // blocked/offline 状态不保留隐藏 timer；恢复后 update 会立即触发检查。
  function schedule(delayMs: number) {
    clearTimer();
    if (!isEligible(facts) || disposed) return;
    timerId = dependencies.setTimer(() => {
      timerId = null;
      runCheck();
    }, delayMs);
  }

  return {
    update(nextFacts) {
      if (disposed) return;
      const sessionChanged = Boolean(facts && facts.sessionKey !== nextFacts.sessionKey);
      const identityChanged = !facts ||
        facts.sessionKey !== nextFacts.sessionKey ||
        facts.knownRevision !== nextFacts.knownRevision ||
        facts.cursor !== nextFacts.cursor;
      const becameEligible = !isEligible(facts) && isEligible(nextFacts);
      const becameIneligible = isEligible(facts) && !isEligible(nextFacts);
      facts = nextFacts;
      if (sessionChanged) wakeRequested = false;
      if (identityChanged || becameIneligible) generation += 1;
      clearTimer();
      if (!isEligible(nextFacts)) return;
      if ((identityChanged || becameEligible) && !inFlight) {
        runCheck();
        return;
      }
      if (!inFlight) schedule(PLATFORM_CATCH_UP_INTERVAL_MS);
    },

    // revision 通知只唤醒现有 HTTP 检查；blocked/offline 时保留一次待处理唤醒，不能直接应用消息内容。
    requestCheck() {
      if (disposed) return;
      wakeRequested = true;
      if (isEligible(facts) && !inFlight) schedule(0);
    },

    // dispose 使在途 Promise 结果失效；网络请求可自然结束，但不能再应用或重建 timer。
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      wakeRequested = false;
      clearTimer();
    },
  };
}

// 迟到结果只有在完整会话身份与续读位置都未变化时才可应用。
function factsMatch(
  current: PlatformOperationCatchUpFacts | null,
  request: PlatformOperationCatchUpFacts,
): boolean {
  return Boolean(
    current &&
    current.sessionKey === request.sessionKey &&
    current.knownRevision === request.knownRevision &&
    current.cursor === request.cursor,
  );
}
