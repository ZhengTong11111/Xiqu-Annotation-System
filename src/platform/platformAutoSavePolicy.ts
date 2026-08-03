import type { ProjectSyncStatus } from "../state/projectDocumentState";

export const PLATFORM_AUTO_SAVE_IDLE_DELAY_MS = 3_000;
export const PLATFORM_AUTO_SAVE_RETRY_BASE_MS = 2_000;
export const PLATFORM_AUTO_SAVE_RETRY_MAX_MS = 60_000;

export type PlatformAutoSaveDecision =
  | { action: "disabled"; reason: "not-enabled" | "clean" | "suspended" }
  | { action: "blocked"; reason: "offline" | "conflict" | "non-retryable" }
  | { action: "waiting"; delayMs: number; reason: "idle" | "retry" | "in-flight" }
  | { action: "save-now" };

// 退避次数从第一次失败的 0 开始，采用确定性指数增长，便于测试并避免多个随机时钟难以复现。
export function getPlatformAutoSaveRetryDelay(attempt: number) {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(
    PLATFORM_AUTO_SAVE_RETRY_BASE_MS * (2 ** normalizedAttempt),
    PLATFORM_AUTO_SAVE_RETRY_MAX_MS,
  );
}

// 纯策略只根据当前事实决定是否保存；timer、请求和 React 生命周期由 hook 负责。
export function getPlatformAutoSaveDecision(input: {
  enabled: boolean;
  dirty: boolean;
  suspended: boolean;
  online: boolean;
  syncStatus: ProjectSyncStatus;
  inFlight: boolean;
  retryBlocked: boolean;
  idleDueAt: number | null;
  retryDueAt: number | null;
  now: number;
}): PlatformAutoSaveDecision {
  if (!input.enabled) return { action: "disabled", reason: "not-enabled" };
  if (!input.dirty) return { action: "disabled", reason: "clean" };
  if (input.suspended) return { action: "disabled", reason: "suspended" };
  if (!input.online || input.syncStatus === "offline") {
    return { action: "blocked", reason: "offline" };
  }
  if (input.syncStatus === "conflict") {
    return { action: "blocked", reason: "conflict" };
  }
  // error 只有在一次自动请求已经登记 retryDueAt 时才可继续；手动保存的确定错误不能被后台擅自重试。
  if (
    input.retryBlocked ||
    (input.syncStatus === "error" && input.retryDueAt === null)
  ) {
    return { action: "blocked", reason: "non-retryable" };
  }
  if (input.inFlight || input.syncStatus === "saving") {
    return { action: "waiting", delayMs: 0, reason: "in-flight" };
  }
  if (input.retryDueAt !== null && input.retryDueAt > input.now) {
    return {
      action: "waiting",
      delayMs: input.retryDueAt - input.now,
      reason: "retry",
    };
  }
  if (input.idleDueAt !== null && input.idleDueAt > input.now) {
    return {
      action: "waiting",
      delayMs: input.idleDueAt - input.now,
      reason: "idle",
    };
  }
  return { action: "save-now" };
}
