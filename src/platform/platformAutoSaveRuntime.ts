import type { ProjectSyncStatus } from "../state/projectDocumentState";
import type { PlatformSaveOutcome } from "../utils/platformOperations";
import {
  getPlatformAutoSaveDecision,
  getPlatformAutoSaveRetryDelay,
  PLATFORM_AUTO_SAVE_IDLE_DELAY_MS,
} from "./platformAutoSavePolicy";

// 运行时 facts 只描述当前会话状态，不携带项目内容、权限对象或服务器客户端。
export type PlatformAutoSaveFacts = {
  enabled: boolean;
  dirty: boolean;
  suspended: boolean;
  localRevision: number;
  syncStatus: ProjectSyncStatus;
  online: boolean;
};

export type PlatformAutoSaveRuntimeDependencies = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
  save: () => Promise<PlatformSaveOutcome>;
  onUnexpectedError: (error: unknown) => void;
};

export type PlatformAutoSaveRuntime = {
  update: (facts: PlatformAutoSaveFacts) => void;
  dispose: () => void;
};

// 自动保存运行时集中维护 timer、single-flight 和退避状态；React hook 只负责提供最新 facts 与依赖。
export function createPlatformAutoSaveRuntime(
  dependencies: PlatformAutoSaveRuntimeDependencies,
): PlatformAutoSaveRuntime {
  let facts: PlatformAutoSaveFacts | null = null;
  let timerId: number | null = null;
  let inFlight = false;
  let disposed = false;
  let idleDueAt: number | null = null;
  let retryDueAt: number | null = null;
  let retryAttempt = 0;
  let retryBlocked = false;

  // 任意一次重新决策前先清旧 timer，确保同一会话最多只有一个等待任务。
  function clearScheduledTimer() {
    if (timerId === null) return;
    dependencies.clearTimer(timerId);
    timerId = null;
  }

  // 清洁或禁用会话没有可继承的退避；下次重新启用应从新的 idle 窗口开始。
  function resetSchedulingState() {
    idleDueAt = null;
    retryDueAt = null;
    retryAttempt = 0;
    retryBlocked = false;
  }

  // 正常 outcome 只改变调度状态；服务器 revision、dirty baseline 与 operation 确认仍由唯一保存事务负责。
  function applySaveOutcome(outcome: PlatformSaveOutcome) {
    if (outcome.status === "offline") {
      retryDueAt = null;
      return;
    }
    if (outcome.status === "error" && outcome.retryable) {
      retryDueAt = dependencies.now() + getPlatformAutoSaveRetryDelay(retryAttempt);
      retryAttempt += 1;
      return;
    }
    if (
      outcome.status === "conflict" ||
      (outcome.status === "error" && !outcome.retryable)
    ) {
      retryBlocked = true;
      return;
    }

    retryAttempt = 0;
    // 保存期间出现的新编辑由最新 facts 表示；先排 idle，随后 clean update 会立即清除它。
    if (facts?.dirty) {
      idleDueAt = dependencies.now() + PLATFORM_AUTO_SAVE_IDLE_DELAY_MS;
    }
  }

  // 每次 facts、timer 或请求结果变化都从同一策略重新求值，避免分散分支产生并行保存。
  function evaluate() {
    if (disposed || !facts) return;
    clearScheduledTimer();

    if (!facts.enabled || !facts.dirty) {
      resetSchedulingState();
    } else if (idleDueAt === null && retryDueAt === null) {
      idleDueAt = dependencies.now() + PLATFORM_AUTO_SAVE_IDLE_DELAY_MS;
    }

    const decision = getPlatformAutoSaveDecision({
      ...facts,
      inFlight,
      retryBlocked,
      idleDueAt,
      retryDueAt,
      now: dependencies.now(),
    });
    if (decision.action === "disabled" || decision.action === "blocked") return;
    if (decision.action === "waiting") {
      // 在途请求会自行在 finally 重新求值，不为 delay=0 再建立忙轮询 timer。
      if (decision.reason === "in-flight") return;
      timerId = dependencies.setTimer(() => {
        timerId = null;
        evaluate();
      }, Math.max(0, decision.delayMs));
      return;
    }

    // Promise.resolve().then 同时捕获同步 throw 与异步 reject，异常不能遗留永久 in-flight 锁。
    inFlight = true;
    idleDueAt = null;
    retryDueAt = null;
    void Promise.resolve()
      .then(() => dependencies.save())
      .then((outcome) => {
        if (!disposed) applySaveOutcome(outcome);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        retryBlocked = true;
        idleDueAt = null;
        retryDueAt = null;
        dependencies.onUnexpectedError(error);
      })
      .finally(() => {
        inFlight = false;
        if (!disposed) evaluate();
      });
  }

  return {
    // update 处理新编辑和恢复在线两个事件，再统一交给策略决定立即保存或等待。
    update(nextFacts) {
      if (disposed) return;
      const previousFacts = facts;
      facts = nextFacts;
      const now = dependencies.now();

      if (previousFacts && previousFacts.localRevision !== nextFacts.localRevision) {
        const nextDueAt = now + PLATFORM_AUTO_SAVE_IDLE_DELAY_MS;
        // retryable error 保留可重试证据，只把长退避缩回一次空闲窗口。
        if (nextFacts.syncStatus === "error" && retryDueAt !== null) {
          retryDueAt = nextDueAt;
          idleDueAt = null;
        } else {
          idleDueAt = nextDueAt;
          retryDueAt = null;
        }
        retryAttempt = 0;
      }

      const cameOnline = Boolean(previousFacts && nextFacts.online && !previousFacts.online);
      if (cameOnline && nextFacts.dirty && nextFacts.syncStatus !== "conflict") {
        idleDueAt = now;
        retryDueAt = null;
        retryAttempt = 0;
      }
      evaluate();
    },

    // 卸载后只清 timer；在途网络请求自然完成，但其结果不能重新安排当前会话。
    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduledTimer();
    },
  };
}
