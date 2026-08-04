import type { CommitAnnotationCommandBatchResponse } from "@xiqu/shared";
import type { AtomicCommandPlan } from "./platformAtomicCommandPlan";
import {
  createPlatformAtomicSubmitRuntime,
  type AtomicCommitApplyResult,
} from "./platformAtomicSubmitRuntime";
import {
  classifyAtomicSubmitError,
  type AtomicSubmitErrorClassification,
} from "./platformAtomicSubmitPolicy";

export type PlatformAtomicCommandSubmitResult =
  | { status: "committed"; response: CommitAnnotationCommandBatchResponse }
  | { status: "failed"; failure: AtomicSubmitErrorClassification }
  | { status: "protocol_error"; reason: string }
  | { status: "busy" }
  | { status: "cancelled" };

type ConnectionFacts = {
  online: boolean;
  sessionKey: string;
};

type Dependencies = {
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
  submit: (plan: AtomicCommandPlan) => Promise<CommitAnnotationCommandBatchResponse>;
  applyCommitted: (
    plan: AtomicCommandPlan,
    response: CommitAnnotationCommandBatchResponse,
  ) => AtomicCommitApplyResult;
  onRetryableFailure: (failure: AtomicSubmitErrorClassification) => void;
};

export type PlatformAtomicCommandSubmitCoordinator = {
  updateConnection: (facts: ConnectionFacts) => void;
  submit: (plan: AtomicCommandPlan) => Promise<PlatformAtomicCommandSubmitResult>;
  dispose: () => void;
};

// coordinator 把底层 retry runtime 包装成一次可等待的保存事务；同一时刻只允许一个 frozen plan。
export function createPlatformAtomicCommandSubmitCoordinator(
  dependencies: Dependencies,
  initialFacts: ConnectionFacts,
): PlatformAtomicCommandSubmitCoordinator {
  let facts = initialFacts;
  let activePlan: AtomicCommandPlan | null = null;
  let completion: ((result: PlatformAtomicCommandSubmitResult) => void) | null = null;
  let disposed = false;

  function finish(result: PlatformAtomicCommandSubmitResult) {
    const resolve = completion;
    completion = null;
    activePlan = null;
    runtime.update({ enabled: false, online: facts.online, sessionKey: facts.sessionKey, plan: null });
    resolve?.(result);
  }

  const runtime = createPlatformAtomicSubmitRuntime({
    setTimer: dependencies.setTimer,
    clearTimer: dependencies.clearTimer,
    submit: dependencies.submit,
    onCommitted: (plan, response) => {
      const applied = dependencies.applyCommitted(plan, response);
      if (applied.status === "applied") finish({ status: "committed", response });
      return applied;
    },
    onFailure: (failure, willRetry) => {
      if (willRetry) {
        dependencies.onRetryableFailure(failure);
        return;
      }
      finish({ status: "failed", failure });
    },
    onProtocolError: (reason) => finish({ status: "protocol_error", reason }),
  });

  return {
    updateConnection(nextFacts) {
      if (disposed) return;
      const sessionChanged = nextFacts.sessionKey !== facts.sessionKey;
      facts = nextFacts;
      if (sessionChanged && completion) {
        // 账号或文件切换必须先结束旧调用；迟到响应由底层 generation 丢弃。
        finish({ status: "cancelled" });
        return;
      }
      if (activePlan) {
        runtime.update({ enabled: true, ...facts, plan: activePlan });
      }
    },

    submit(plan) {
      if (disposed) return Promise.resolve({ status: "cancelled" });
      if (completion) return Promise.resolve({ status: "busy" });
      if (!facts.online) {
        return Promise.resolve({
          status: "failed",
          failure: classifyAtomicSubmitError(new TypeError("offline"), false),
        });
      }
      activePlan = plan;
      const result = new Promise<PlatformAtomicCommandSubmitResult>((resolve) => {
        completion = resolve;
      });
      runtime.update({ enabled: true, ...facts, plan });
      runtime.requestSubmit();
      return result;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      runtime.dispose();
      if (completion) finish({ status: "cancelled" });
    },
  };
}
