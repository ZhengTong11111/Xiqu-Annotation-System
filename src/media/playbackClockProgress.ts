import type { MediaPlaybackSnapshot } from "./mediaPlaybackController";

const PLAYBACK_CLOCK_POLL_INTERVAL_MS = 20;
const MINIMUM_PLAYBACK_CLOCK_PROGRESS_SECONDS = 0.001;

export type PlaybackClockProgressWaitInput = {
  baselineTime: number;
  readSnapshot: () => MediaPlaybackSnapshot;
  isCurrent: () => boolean;
};

export type PlaybackClockProgressScheduler = (
  callback: () => void,
  delayMilliseconds: number,
) => () => void;

export type WaitForPlaybackClockProgress = (
  input: PlaybackClockProgressWaitInput,
) => Promise<boolean>;

/**
 * 等待媒体时钟真实向前推进，而不是把 play() Promise 或 playing 事件误当成已经起播。
 *
 * VOD 在随机 seek 或首次解码后可能先接受播放请求，再花一段时间拉取、解码目标分片。等待不设固定超时，
 * 慢网络恢复后仍可自然放行；调用方通过 isCurrent 让 seek、切轨和暂停及时取消旧等待。
 */
export function createPlaybackClockProgressWaiter(
  schedule: PlaybackClockProgressScheduler = schedulePlaybackClockProgressCheck,
): WaitForPlaybackClockProgress {
  return ({ baselineTime, readSnapshot, isCurrent }) =>
    new Promise((resolve) => {
      let cancelScheduledCheck: (() => void) | null = null;
      let settled = false;

      const finish = (progressed: boolean) => {
        if (settled) return;
        settled = true;
        cancelScheduledCheck?.();
        cancelScheduledCheck = null;
        resolve(progressed);
      };

      const inspect = () => {
        cancelScheduledCheck = null;
        if (!isCurrent()) {
          finish(false);
          return;
        }

        const snapshot = readSnapshot();
        if (snapshot.ended) {
          finish(false);
          return;
        }
        if (
          Number.isFinite(snapshot.currentTime) &&
          snapshot.currentTime - baselineTime >=
            MINIMUM_PLAYBACK_CLOCK_PROGRESS_SECONDS
        ) {
          finish(true);
          return;
        }

        // 使用一次性定时器串联检查，确保任意时刻只有一个等待回调，不形成并行轮询。
        cancelScheduledCheck = schedule(inspect, PLAYBACK_CLOCK_POLL_INTERVAL_MS);
      };

      inspect();
    });
}

function schedulePlaybackClockProgressCheck(
  callback: () => void,
  delayMilliseconds: number,
) {
  const timer = globalThis.setTimeout(callback, delayMilliseconds);
  return () => globalThis.clearTimeout(timer);
}
