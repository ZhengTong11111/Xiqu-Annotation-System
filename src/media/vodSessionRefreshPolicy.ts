export type VodSessionRefreshRetryMode = "background" | "player_recovery";

const BACKGROUND_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
const PLAYER_RECOVERY_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;

/**
 * 后台续签允许按最后一级持续退避；仍可用的旧实例不应因临时断网被主动销毁。
 * 播放器已经报错时预算有限，耗尽后必须交给既有可操作错误界面。
 */
export function getVodSessionRefreshRetryDelay(
  mode: VodSessionRefreshRetryMode,
  failedAttemptCount: number,
) {
  if (!Number.isInteger(failedAttemptCount) || failedAttemptCount < 1) return null;
  const delays = mode === "background"
    ? BACKGROUND_RETRY_DELAYS_MS
    : PLAYER_RECOVERY_RETRY_DELAYS_MS;
  const index = failedAttemptCount - 1;
  if (mode === "player_recovery" && index >= delays.length) return null;
  return delays[Math.min(index, delays.length - 1)] ?? null;
}
