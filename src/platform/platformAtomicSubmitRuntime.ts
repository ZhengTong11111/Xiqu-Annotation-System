import type { CommitAnnotationCommandBatchResponse } from "@xiqu/shared";
import type { AtomicCommandPlan } from "./platformAtomicCommandPlan";
import {
  classifyAtomicSubmitError,
  getAtomicSubmitRetryDelay,
  validateAtomicSubmitResponse,
  type AtomicSubmitErrorClassification,
} from "./platformAtomicSubmitPolicy";

export const MAX_ATOMIC_SUBMIT_RETRY_ATTEMPTS = 5;

export type PlatformAtomicSubmitFacts = {
  enabled: boolean;
  online: boolean;
  sessionKey: string;
  plan: AtomicCommandPlan | null;
};

export type AtomicCommitApplyResult =
  | { status: "applied" }
  | { status: "rejected"; reason: string };

type RuntimeDependencies = {
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timerId: number) => void;
  submit: (plan: AtomicCommandPlan) => Promise<CommitAnnotationCommandBatchResponse>;
  onCommitted: (
    plan: AtomicCommandPlan,
    response: CommitAnnotationCommandBatchResponse,
  ) => AtomicCommitApplyResult | Promise<AtomicCommitApplyResult>;
  onFailure: (failure: AtomicSubmitErrorClassification) => void;
  onProtocolError: (reason: string) => void;
};

export type PlatformAtomicSubmitRuntime = {
  update: (facts: PlatformAtomicSubmitFacts) => void;
  requestSubmit: () => void;
  dispose: () => void;
};

// runtime 只冻结并发送 planner 产出的批次；它不读取 React state，也不自行拼接下一批 ProjectData。
export function createPlatformAtomicSubmitRuntime(
  dependencies: RuntimeDependencies,
): PlatformAtomicSubmitRuntime {
  let facts: PlatformAtomicSubmitFacts | null = null;
  let timerId: number | null = null;
  let inFlight = false;
  let disposed = false;
  let generation = 0;
  let retryAttempt = 0;
  let retryPlan: AtomicCommandPlan | null = null;
  let completedPlanKey: string | null = null;
  let blockedPlanKey: string | null = null;

  function clearTimer() {
    if (timerId === null) return;
    dependencies.clearTimer(timerId);
    timerId = null;
  }

  function getPlanKey(plan: AtomicCommandPlan) {
    // token 本身不能进入日志/状态 key；只区分是否已取得租约，允许无 token 失败后由有 token 计划解除阻断。
    const leaseState = plan.request.mutationLeaseToken ? "leased" : "unleased";
    return `${plan.request.baseRevision}:${leaseState}:${plan.operationIds.join(",")}`;
  }

  function isEligible(value: PlatformAtomicSubmitFacts | null) {
    return Boolean(
      value?.enabled &&
      value.online &&
      value.plan &&
      getPlanKey(value.plan) !== completedPlanKey &&
      getPlanKey(value.plan) !== blockedPlanKey,
    );
  }

  function scheduleRetry(plan: AtomicCommandPlan) {
    clearTimer();
    retryPlan = plan;
    const delay = getAtomicSubmitRetryDelay(retryAttempt);
    retryAttempt += 1;
    timerId = dependencies.setTimer(() => {
      timerId = null;
      run(plan);
    }, delay);
  }

  function run(candidate?: AtomicCommandPlan) {
    if (disposed || inFlight || !isEligible(facts) || !facts?.plan) return;
    const plan = candidate ?? facts.plan;
    const requestSessionKey = facts.sessionKey;
    const requestGeneration = generation;
    clearTimer();
    inFlight = true;
    void Promise.resolve()
      .then(() => dependencies.submit(plan))
      .then(async (response) => {
        if (disposed || requestGeneration !== generation || facts?.sessionKey !== requestSessionKey) return;
        const validation = validateAtomicSubmitResponse(plan, response);
        if (validation.status === "invalid") {
          retryPlan = null;
          blockedPlanKey = getPlanKey(plan);
          dependencies.onProtocolError(validation.reason);
          return;
        }
        const applyResult = await dependencies.onCommitted(plan, response);
        if (disposed || requestGeneration !== generation || facts?.sessionKey !== requestSessionKey) return;
        if (applyResult.status === "rejected") {
          retryPlan = null;
          blockedPlanKey = getPlanKey(plan);
          dependencies.onProtocolError(`document_state_rejected:${applyResult.reason}`);
          return;
        }
        completedPlanKey = getPlanKey(plan);
        blockedPlanKey = null;
        retryAttempt = 0;
        retryPlan = null;
      })
      .catch((error: unknown) => {
        if (disposed || requestGeneration !== generation || facts?.sessionKey !== requestSessionKey) return;
        const failure = classifyAtomicSubmitError(error, facts.online);
        dependencies.onFailure(failure);
        if (failure.retryable && retryAttempt < MAX_ATOMIC_SUBMIT_RETRY_ATTEMPTS) {
          scheduleRetry(plan);
        } else {
          retryPlan = null;
          blockedPlanKey = getPlanKey(plan);
        }
      })
      .finally(() => {
        inFlight = false;
        // 文件或 planner 在请求期间切换后，旧响应失效；新会话不应等待额外用户动作才开始提交。
        if (!disposed && isEligible(facts) && timerId === null) {
          timerId = dependencies.setTimer(() => {
            timerId = null;
            run();
          }, 0);
        }
      });
  }

  return {
    update(nextFacts) {
      if (disposed) return;
      const previousFacts = facts;
      const sessionChanged = Boolean(previousFacts && previousFacts.sessionKey !== nextFacts.sessionKey);
      const planChanged = previousFacts?.plan && nextFacts.plan
        ? getPlanKey(previousFacts.plan) !== getPlanKey(nextFacts.plan)
        : previousFacts?.plan !== nextFacts.plan;
      const cameOnline = Boolean(previousFacts && !previousFacts.online && nextFacts.online);
      facts = nextFacts;

      if (sessionChanged) {
        generation += 1;
        completedPlanKey = null;
        blockedPlanKey = null;
        retryPlan = null;
        retryAttempt = 0;
        clearTimer();
      } else if (planChanged && !inFlight) {
        retryPlan = null;
        retryAttempt = 0;
        blockedPlanKey = null;
        clearTimer();
      }
      if (!nextFacts.enabled || !nextFacts.online || !nextFacts.plan) {
        clearTimer();
        return;
      }
      if (cameOnline) {
        retryAttempt = 0;
        retryPlan = null;
        clearTimer();
        run();
      } else if (!inFlight && timerId === null && isEligible(nextFacts)) {
        timerId = dependencies.setTimer(() => {
          timerId = null;
          run();
        }, 0);
      }
    },

    requestSubmit() {
      if (disposed) return;
      blockedPlanKey = null;
      retryAttempt = 0;
      clearTimer();
      run(retryPlan ?? facts?.plan ?? undefined);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      retryPlan = null;
      clearTimer();
    },
  };
}
