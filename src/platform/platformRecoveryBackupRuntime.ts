import type { PlatformSaveOutcome } from "../utils/platformOperations";

export const PLATFORM_RECOVERY_BACKUP_THRESHOLDS = [3, 5, 10] as const;
export type PlatformRecoveryBackupThreshold =
  typeof PLATFORM_RECOVERY_BACKUP_THRESHOLDS[number];

export type PlatformRecoveryBackupPreferences = {
  enabled: boolean;
  failureThreshold: PlatformRecoveryBackupThreshold;
};

export const DEFAULT_PLATFORM_RECOVERY_BACKUP_PREFERENCES: PlatformRecoveryBackupPreferences = {
  enabled: true,
  failureThreshold: 3,
};

export type PlatformRecoveryBackupState =
  | { status: "idle"; failureCount: 0 }
  | { status: "counting"; failureCount: number }
  | { status: "pending"; failureCount: number }
  | { status: "creating"; failureCount: number }
  | { status: "created"; failureCount: number; fileName: string }
  | { status: "error"; failureCount: number; message: string };

export type PlatformRecoveryBackupRequest<TPayload> = {
  clientBackupId: string;
  sourceRevision: number;
  failureCount: number;
  payload: TPayload;
};

type RuntimeContext = PlatformRecoveryBackupPreferences & { online: boolean };

export type PlatformRecoveryBackupRuntime<TPayload> = {
  update: (context: RuntimeContext) => void;
  recordSaveOutcome: (
    outcome: PlatformSaveOutcome,
    buildRequest: (
      clientBackupId: string,
      failureCount: number,
    ) => PlatformRecoveryBackupRequest<TPayload>,
  ) => Promise<void>;
  dispose: () => void;
};

export function createPlatformRecoveryBackupRuntime<TPayload>(dependencies: {
  createId: () => string;
  createBackup: (
    request: PlatformRecoveryBackupRequest<TPayload>,
  ) => Promise<{ fileName: string }>;
  shouldDeferError?: (error: unknown) => boolean;
  onStateChange: (state: PlatformRecoveryBackupState) => void;
}): PlatformRecoveryBackupRuntime<TPayload> {
  let context: RuntimeContext = {
    ...DEFAULT_PLATFORM_RECOVERY_BACKUP_PREFERENCES,
    online: true,
  };
  let failureCount = 0;
  let clientBackupId: string | null = null;
  let pendingRequest: PlatformRecoveryBackupRequest<TPayload> | null = null;
  let requestAttempted = false;
  let inFlight = false;
  let created = false;
  let disposed = false;

  function resetEpisode() {
    failureCount = 0;
    clientBackupId = null;
    pendingRequest = null;
    requestAttempted = false;
    inFlight = false;
    created = false;
    dependencies.onStateChange({ status: "idle", failureCount: 0 });
  }

  async function attemptPendingBackup() {
    if (
      disposed ||
      !context.enabled ||
      !context.online ||
      inFlight ||
      created ||
      !pendingRequest
    ) return;
    inFlight = true;
    const request = pendingRequest;
    // 首次网络请求后幂等键与 payload 必须永久绑定；响应未知时也只能原样重放。
    requestAttempted = true;
    dependencies.onStateChange({ status: "creating", failureCount });
    try {
      const result = await dependencies.createBackup(request);
      if (disposed || request !== pendingRequest) return;
      created = true;
      pendingRequest = null;
      dependencies.onStateChange({
        status: "created",
        failureCount,
        fileName: result.fileName,
      });
    } catch (error) {
      if (disposed || request !== pendingRequest) return;
      if (!context.online || dependencies.shouldDeferError?.(error)) {
        dependencies.onStateChange({ status: "pending", failureCount });
      } else {
        dependencies.onStateChange({
          status: "error",
          failureCount,
          message: error instanceof Error ? error.message : "服务器恢复备份创建失败。",
        });
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    update(nextContext) {
      if (disposed) return;
      const wasOnline = context.online;
      context = nextContext;
      if (!context.enabled) {
        resetEpisode();
        return;
      }
      // 断网期间只保留冻结请求；浏览器恢复在线时尝试一次，不建立高频重试定时器。
      if (!wasOnline && context.online && pendingRequest && !created) {
        void attemptPendingBackup();
      }
    },

    async recordSaveOutcome(outcome, buildRequest) {
      if (disposed || !context.enabled) return;
      if (outcome.status === "saved") {
        resetEpisode();
        return;
      }
      if (outcome.status === "skipped" || outcome.status === "rebased") return;

      failureCount += 1;
      if (created) return;
      if (failureCount < context.failureThreshold) {
        dependencies.onStateChange({ status: "counting", failureCount });
        return;
      }

      clientBackupId ??= dependencies.createId();
      // 尚未发出网络请求时（通常是离线）可刷新冻结内容；一旦请求发出，后续重试必须保持逐字段一致。
      if (!pendingRequest || !requestAttempted) {
        pendingRequest = buildRequest(clientBackupId, failureCount);
      }
      if (!context.online || outcome.status === "offline") {
        dependencies.onStateChange({ status: "pending", failureCount });
        return;
      }
      await attemptPendingBackup();
    },

    dispose() {
      disposed = true;
      pendingRequest = null;
    },
  };
}
