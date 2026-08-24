import {
  MediaPlaybackCommandCancelledError,
  normalizePlaybackSnapshot,
  normalizePlaybackTime,
  normalizePlaybackVolume,
  type MediaPlaybackBackend,
} from "./mediaPlaybackController";

const NATIVE_SEEK_EPSILON_SECONDS = 1 / 1_000;
const NATIVE_SEEK_TIMEOUT_MS = 10_000;

export type NativeMediaElementPort = {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};

/**
 * HTMLMediaElement 的窄适配器。
 *
 * React 仍负责渲染原生 video 和转发普通事件；该类只提供 App 所需的命令/快照合同，
 * 并确保每个等待中的 seek 在成功、错误、超时或 dispose 时都有确定结局。
 */
export class NativeMediaPlaybackBackend implements MediaPlaybackBackend {
  private disposed = false;
  private pendingSeekRejectors = new Set<(error: Error) => void>();

  constructor(private readonly media: NativeMediaElementPort) {}

  getSnapshot() {
    return normalizePlaybackSnapshot({
      ready: !this.disposed && this.media.readyState >= 1,
      currentTime: this.media.currentTime,
      duration: this.media.duration,
      paused: this.media.paused,
      ended: this.media.ended,
    });
  }

  async seek(time: number) {
    this.assertActive();
    const normalizedTarget = normalizePlaybackTime(time);
    const target = Number.isFinite(this.media.duration) && this.media.duration > 0
      ? Math.min(normalizedTarget, this.media.duration)
      : normalizedTarget;
    if (
      this.media.readyState >= 1 &&
      Math.abs(this.media.currentTime - target) <= NATIVE_SEEK_EPSILON_SECONDS
    ) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        globalThis.clearTimeout(timeout);
        this.media.removeEventListener("seeked", handleSeeked);
        this.media.removeEventListener("error", handleError);
        this.media.removeEventListener("emptied", handleError);
        this.pendingSeekRejectors.delete(rejectPending);
      };
      const settle = (result: "resolve" | "reject", error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result === "resolve") resolve();
        else reject(error ?? new Error("原生媒体跳转失败。"));
      };
      const handleSeeked: EventListener = () => settle("resolve");
      const handleError: EventListener = () => settle(
        "reject",
        new Error("原生媒体无法完成时间跳转。"),
      );
      const rejectPending = (error: Error) => settle("reject", error);
      const timeout = globalThis.setTimeout(() => settle(
        "reject",
        new Error("等待原生媒体跳转超时。"),
      ), NATIVE_SEEK_TIMEOUT_MS);
      this.pendingSeekRejectors.add(rejectPending);
      this.media.addEventListener("seeked", handleSeeked);
      this.media.addEventListener("error", handleError);
      this.media.addEventListener("emptied", handleError);
      try {
        this.media.currentTime = target;
      } catch {
        settle("reject", new Error("原生媒体拒绝时间跳转。"));
      }
    });
  }

  async play() {
    this.assertActive();
    await this.media.play();
  }

  pause() {
    if (!this.disposed) this.media.pause();
  }

  setPlaybackRate(rate: number) {
    this.assertActive();
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("播放倍率必须是正数。");
    }
    this.media.playbackRate = rate;
  }

  setVolume(volume: number) {
    this.assertActive();
    this.media.volume = normalizePlaybackVolume(volume);
  }

  setMuted(muted: boolean) {
    this.assertActive();
    this.media.muted = muted;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = new MediaPlaybackCommandCancelledError("原生媒体已切换。");
    for (const reject of [...this.pendingSeekRejectors]) reject(error);
    this.pendingSeekRejectors.clear();
  }

  private assertActive() {
    if (this.disposed) throw new Error("原生媒体已不可用。");
  }
}
