export type AnnotationRemoteActivityRateLimiter = {
  accept: (nowMs: number) => boolean;
};

type RateLimiterOptions = {
  ratePerSecond?: number;
  burst?: number;
};

// 连接级令牌桶允许短促拖动，同时持续限制客户端业务帧，避免高频输入挤占协作广播。
export function createAnnotationRemoteActivityRateLimiter(
  options: RateLimiterOptions = {},
): AnnotationRemoteActivityRateLimiter {
  const ratePerSecond = options.ratePerSecond ?? 8;
  const burst = options.burst ?? 4;
  let tokens = burst;
  let lastRefillMs: number | null = null;
  return {
    accept(nowMs) {
      if (!Number.isFinite(nowMs)) return false;
      if (lastRefillMs === null) lastRefillMs = nowMs;
      const elapsedMs = Math.max(0, nowMs - lastRefillMs);
      tokens = Math.min(burst, tokens + elapsedMs * ratePerSecond / 1_000);
      lastRefillMs = nowMs;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
