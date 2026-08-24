import type { AliyunVodPlaybackSession } from "@xiqu/shared";

export type MediaPlaybackSnapshot = {
  ready: boolean;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
};

export type MediaPlaybackSeekOptions = {
  playAfterSeek?: boolean;
};

export interface MediaPlaybackBackend {
  getSnapshot(): MediaPlaybackSnapshot;
  seek(time: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  setPlaybackRate(rate: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export type MediaPlaybackBackendEvents = {
  onReady: (snapshot: MediaPlaybackSnapshot) => void;
  onTimeUpdate: (snapshot: MediaPlaybackSnapshot) => void;
  onPlayStateChange: (playing: boolean) => void;
  onBufferingChange?: (buffering: boolean) => void;
  onError: (message: string) => void;
};

export interface MediaPlaybackController {
  getSnapshot(): MediaPlaybackSnapshot;
  seek(time: number, options?: MediaPlaybackSeekOptions): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  setPlaybackRate(rate: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
}

export type MediaPlaybackSource =
  | { type: "native"; url: string }
  | {
      type: "aliyun_vod";
      resourceId: string;
      expectedVideoId: string;
      loadSession: () => Promise<AliyunVodPlaybackSession>;
    }
  | { type: "unavailable"; message: string };

export const EMPTY_PLAYBACK_SNAPSHOT: MediaPlaybackSnapshot = {
  ready: false,
  currentTime: 0,
  duration: 0,
  paused: true,
  ended: false,
};

// 来源切换、快速预览和后发 seek 替换前一命令都属于正常控制流，不应进入用户错误状态。
export class MediaPlaybackCommandCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaPlaybackCommandCancelledError";
  }
}

/**
 * 串行化 App 发出的播放命令，并让后发命令使旧异步 seek 失效。
 *
 * 慢网络下旧 seeked 可能晚于 pause 或第二次 seek 到达；generation 是控制层唯一顺序事实，
 * 因此旧命令即使完成也不能再触发 play。
 */
export class LatestMediaPlaybackCommand {
  private generation = 0;

  constructor(private readonly getBackend: () => MediaPlaybackBackend | null) {}

  getSnapshot() {
    return this.getBackend()?.getSnapshot() ?? EMPTY_PLAYBACK_SNAPSHOT;
  }

  async seek(time: number, options: MediaPlaybackSeekOptions = {}) {
    const backend = this.getBackend();
    if (!backend) return;
    const generation = ++this.generation;
    await backend.seek(time);
    if (generation !== this.generation || backend !== this.getBackend()) return;
    if (options.playAfterSeek) await backend.play();
  }

  async play() {
    const backend = this.getBackend();
    if (!backend) return;
    const generation = ++this.generation;
    await backend.play();
    // 浏览器的 play Promise 可能在后发 pause 之后才完成；后发命令必须最终占优。
    if (generation !== this.generation || backend !== this.getBackend()) backend.pause();
  }

  pause() {
    this.generation += 1;
    this.getBackend()?.pause();
  }

  setPlaybackRate(rate: number) {
    this.getBackend()?.setPlaybackRate(rate);
  }

  setVolume(volume: number) {
    this.getBackend()?.setVolume(volume);
  }

  setMuted(muted: boolean) {
    this.getBackend()?.setMuted(muted);
  }

  // 来源切换会让所有旧异步命令失效，随后由 owner dispose 对应 backend。
  invalidate() {
    this.generation += 1;
  }
}

/**
 * 播放器 UI 使用这一层吞并命令异常，并将稳定中文错误交给界面。
 * App 可以安全地 fire-and-forget；供应商原始错误和临时凭据不会穿透到控制台或未处理 Promise。
 */
export function createSafeMediaPlaybackController(
  command: LatestMediaPlaybackCommand,
  onError: (message: string) => void,
): MediaPlaybackController {
  const report = (error: unknown) => {
    if (error instanceof MediaPlaybackCommandCancelledError) return;
    onError(error instanceof Error ? error.message : "媒体播放操作失败。");
  };
  return {
    getSnapshot: () => command.getSnapshot(),
    seek: async (time, options) => {
      try {
        await command.seek(time, options);
      } catch (error) {
        report(error);
      }
    },
    play: async () => {
      try {
        await command.play();
      } catch (error) {
        report(error);
      }
    },
    pause: () => command.pause(),
    setPlaybackRate: (rate) => {
      try {
        command.setPlaybackRate(rate);
      } catch (error) {
        report(error);
      }
    },
    setVolume: (volume) => {
      try {
        command.setVolume(volume);
      } catch (error) {
        report(error);
      }
    },
    setMuted: (muted) => {
      try {
        command.setMuted(muted);
      } catch (error) {
        report(error);
      }
    },
  };
}

export function normalizePlaybackVolume(value: number) {
  if (!Number.isFinite(value)) throw new Error("播放音量必须是有限数。");
  return Math.min(1, Math.max(0, value));
}

// 所有 backend 都通过同一数值边界，避免 NaN/Infinity 污染时间轴状态。
export function normalizePlaybackTime(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function normalizePlaybackSnapshot(
  snapshot: MediaPlaybackSnapshot,
): MediaPlaybackSnapshot {
  return {
    ready: snapshot.ready,
    currentTime: normalizePlaybackTime(snapshot.currentTime),
    duration: normalizePlaybackTime(snapshot.duration),
    paused: snapshot.paused,
    ended: snapshot.ended,
  };
}
