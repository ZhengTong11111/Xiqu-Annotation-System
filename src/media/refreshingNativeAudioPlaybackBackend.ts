import type { MediaAudioTrackPlaybackSession } from "@xiqu/shared";
import {
  MediaPlaybackCommandCancelledError,
  normalizePlaybackVolume,
  type MediaPlaybackBackend,
  type MediaPlaybackBackendEvents,
  type MediaPlaybackSnapshot,
} from "./mediaPlaybackController";
import { createContainerNativeAudioPlaybackBackend } from "./nativeAudioPlaybackBackend";
import { getVodSessionRefreshRetryDelay } from "./vodSessionRefreshPolicy";

type RenditionPlaybackSession = Extract<
  MediaAudioTrackPlaybackSession,
  { sourceType: "aliyun_vod_rendition" }
>;

type NativeBackendFactory = (
  url: string,
  events: MediaPlaybackBackendEvents,
) => MediaPlaybackBackend;

type ChildSlot = {
  backend: MediaPlaybackBackend | null;
  active: boolean;
  ready: boolean;
};

type ChildPreparationEvents = {
  onReady?: () => void;
  onError?: (message: string) => void;
};

export type RefreshingNativeAudioPlaybackBackendOptions = {
  containerId: string;
  initialSession: RenditionPlaybackSession;
  expectedVideoId: string;
  expectedRenditionJobId: string;
  loadSession: (signal?: AbortSignal) => Promise<RenditionPlaybackSession>;
  events: MediaPlaybackBackendEvents;
  createNativeBackend?: NativeBackendFactory;
  now?: () => number;
  scheduleRefresh?: (callback: () => void, delayMs: number) => () => void;
  readyTimeoutMs?: number;
};

const SESSION_REFRESH_AHEAD_MS = 60_000;
const MIN_SESSION_LIFETIME_MS = 5_000;
const CANDIDATE_READY_TIMEOUT_MS = 20_000;

/**
 * 指定 JobId 的 VOD MP3 已经是可 Range 播放的 HTTPS 音频，不再套用隐藏 Aliplayer。
 * 本适配器只在内存中持有短期 URL，并在旧元素仍可用时静音准备新元素，再原子接管播放状态。
 */
export class RefreshingNativeAudioPlaybackBackend implements MediaPlaybackBackend {
  private activeSlot: ChildSlot;
  private candidateSlot: ChildSlot | null = null;
  private disposed = false;
  private refreshPromise: Promise<void> | null = null;
  private cancelCandidatePreparation: ((error: Error) => void) | null = null;
  private cancelRefreshSchedule: (() => void) | null = null;
  private refreshDueAtMilliseconds: number | null = null;
  private backgroundFailedAttempts = 0;
  private recoveryFailedAttempts = 0;
  private recoveryActive = false;
  private recoveryPromise: Promise<void> | null = null;
  private readonly sessionRequestControllers = new Set<AbortController>();
  private playbackRate = 1;
  private volume = 0.5;
  private muted = false;
  private lastRefreshError: Error | null = null;

  private readonly createNativeBackend: NativeBackendFactory;
  private readonly now: () => number;
  private readonly scheduleRefresh: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  private readonly readyTimeoutMs: number;

  constructor(private readonly options: RefreshingNativeAudioPlaybackBackendOptions) {
    this.createNativeBackend = options.createNativeBackend ??
      ((url, events) => createContainerNativeAudioPlaybackBackend(
        options.containerId,
        url,
        events,
      ));
    this.now = options.now ?? Date.now;
    this.scheduleRefresh = options.scheduleRefresh ?? defaultScheduleRefresh;
    this.readyTimeoutMs = options.readyTimeoutMs ?? CANDIDATE_READY_TIMEOUT_MS;
    this.validateSession(options.initialSession);
    this.activeSlot = this.createActiveSlot(options.initialSession.url);
    this.scheduleSessionRefresh(options.initialSession);
  }

  getSnapshot() {
    return this.activeSlot.backend?.getSnapshot() ?? emptySnapshot();
  }

  async seek(time: number) {
    this.assertActive();
    await this.activeSlot.backend?.seek(time);
  }

  async play() {
    this.assertActive();
    await this.activeSlot.backend?.play();
  }

  pause() {
    if (!this.disposed) this.activeSlot.backend?.pause();
  }

  setPlaybackRate(rate: number) {
    this.assertActive();
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("播放倍率必须是正数。");
    this.playbackRate = rate;
    this.activeSlot.backend?.setPlaybackRate(rate);
  }

  setVolume(volume: number) {
    this.assertActive();
    this.volume = normalizePlaybackVolume(volume);
    this.activeSlot.backend?.setVolume(this.volume);
  }

  setMuted(muted: boolean) {
    this.assertActive();
    this.muted = muted;
    this.activeSlot.backend?.setMuted(muted);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRefreshSchedule();
    for (const controller of this.sessionRequestControllers) controller.abort();
    this.sessionRequestControllers.clear();
    this.cancelCandidatePreparation?.(
      new MediaPlaybackCommandCancelledError("VOD 音频转码已切换。"),
    );
    this.cancelCandidatePreparation = null;
    this.deactivateAndDispose(this.candidateSlot);
    this.candidateSlot = null;
    this.deactivateAndDispose(this.activeSlot);
  }

  /** 页面恢复时仅在临时地址接近到期或上次续签失败时重建，正常播放不会重复请求会话。 */
  async recoverAfterInterruption() {
    this.assertActive();
    if (this.recoveryActive) {
      this.clearRefreshSchedule();
      await this.runRecoveryAttempt();
      return;
    }
    const refreshDue = this.refreshDueAtMilliseconds !== null &&
      this.now() >= this.refreshDueAtMilliseconds;
    if (!refreshDue && !this.lastRefreshError) return;
    this.clearRefreshSchedule();
    try {
      await this.refreshSession();
    } catch (error) {
      if (this.disposed) throw error;
      this.scheduleBackgroundRetry();
    }
  }

  /**
   * 续签先准备候选 audio；候选完成 metadata、seek 和静音起播后才替换旧元素。
   * 网络或供应商失败不会提前切断仍可用的旧音频。
   */
  async refreshSession() {
    this.assertActive();
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = this.rebuildFromFreshSession().finally(() => {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    });
    this.refreshPromise = refresh;
    return refresh;
  }

  private createActiveSlot(url: string) {
    const slot: ChildSlot = { backend: null, active: true, ready: false };
    slot.backend = this.createNativeBackend(url, this.createChildEvents(slot));
    return slot;
  }

  private createChildEvents(
    slot: ChildSlot,
    preparationEvents: ChildPreparationEvents = {},
  ): MediaPlaybackBackendEvents {
    return {
      onReady: (snapshot) => {
        slot.ready = true;
        preparationEvents.onReady?.();
        if (slot.active && !this.disposed) this.options.events.onReady(snapshot);
      },
      onTimeUpdate: (snapshot) => {
        if (slot.active && !this.disposed) this.options.events.onTimeUpdate(snapshot);
      },
      onPlayStateChange: (playing) => {
        if (slot.active && !this.disposed) this.options.events.onPlayStateChange(playing);
      },
      onBufferingChange: (buffering) => {
        if (slot.active && !this.disposed) {
          this.options.events.onBufferingChange?.(buffering);
        }
      },
      onError: (message) => {
        // 候选接管前的错误只负责终止准备；接管后的同一事件通道必须继续触发播放恢复。
        if (!slot.ready && preparationEvents.onError) {
          preparationEvents.onError(message);
          return;
        }
        if (!slot.active || this.disposed) return;
        if (!slot.ready) {
          this.options.events.onError(message);
          return;
        }
        this.startPlaybackRecovery();
      },
    };
  }

  private async rebuildFromFreshSession() {
    const oldSlot = this.activeSlot;
    const requestController = new AbortController();
    this.sessionRequestControllers.add(requestController);
    let session: RenditionPlaybackSession;
    try {
      session = await this.options.loadSession(requestController.signal);
      this.validateSession(session);
    } catch (error) {
      if (this.disposed || requestController.signal.aborted) {
        throw new MediaPlaybackCommandCancelledError("VOD 音频转码会话已切换。");
      }
      const message = error instanceof Error ? error.message : "无法续签 VOD 音频转码会话。";
      this.lastRefreshError = new Error(message);
      throw this.lastRefreshError;
    } finally {
      this.sessionRequestControllers.delete(requestController);
    }
    this.assertActive();

    const candidate = await this.prepareCandidate(session.url);
    if (this.disposed || this.activeSlot !== oldSlot) {
      this.deactivateAndDispose(candidate);
      throw new MediaPlaybackCommandCancelledError("更新的 VOD 音频会话已过期。");
    }

    try {
      const oldSnapshot = oldSlot.backend?.getSnapshot() ?? emptySnapshot();
      candidate.backend?.setPlaybackRate(this.playbackRate);
      candidate.backend?.setVolume(this.volume);
      // 候选在接管前保持静音，避免旧、新元素短暂双声。
      candidate.backend?.setMuted(true);
      await candidate.backend?.seek(oldSnapshot.currentTime);
      if (!oldSnapshot.paused && !oldSnapshot.ended) await candidate.backend?.play();
      this.assertActive();
      if (this.activeSlot !== oldSlot) {
        throw new MediaPlaybackCommandCancelledError("VOD 音频已由更新会话接管。");
      }

      oldSlot.active = false;
      candidate.active = true;
      this.activeSlot = candidate;
      this.candidateSlot = null;
      oldSlot.backend?.pause();
      oldSlot.backend?.dispose();
      candidate.backend?.setMuted(this.muted);
      this.lastRefreshError = null;
      this.scheduleSessionRefresh(session);
      this.options.events.onTimeUpdate(candidate.backend?.getSnapshot() ?? emptySnapshot());
    } catch (error) {
      if (candidate !== this.activeSlot) this.deactivateAndDispose(candidate);
      if (this.candidateSlot === candidate) this.candidateSlot = null;
      throw error;
    }
  }

  private prepareCandidate(url: string) {
    return new Promise<ChildSlot>((resolve, reject) => {
      const slot: ChildSlot = { backend: null, active: false, ready: false };
      this.candidateSlot = slot;
      let settled = false;
      const settle = (result: "resolve" | "reject", error?: Error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        if (this.cancelCandidatePreparation === cancelPreparation) {
          this.cancelCandidatePreparation = null;
        }
        if (result === "resolve") resolve(slot);
        else {
          this.deactivateAndDispose(slot);
          if (this.candidateSlot === slot) this.candidateSlot = null;
          reject(error ?? new Error("VOD 音频转码准备失败。"));
        }
      };
      // 候选与初始元素共用事件转发器；否则候选接管后会丢失 timeupdate、buffering 和恢复事件。
      const events = this.createChildEvents(slot, {
        onReady: () => settle("resolve"),
        onError: (message) => settle("reject", new Error(message)),
      });
      const timeout = globalThis.setTimeout(() => {
        settle("reject", new Error("等待 VOD 音频转码准备超时。"));
      }, this.readyTimeoutMs);
      const cancelPreparation = (error: Error) => settle("reject", error);
      this.cancelCandidatePreparation = cancelPreparation;
      try {
        slot.backend = this.createNativeBackend(url, events);
      } catch {
        settle("reject", new Error("VOD 音频转码播放器初始化失败。"));
      }
    });
  }

  private validateSession(session: RenditionPlaybackSession) {
    if (
      session.sourceType !== "aliyun_vod_rendition" ||
      session.videoId !== this.options.expectedVideoId ||
      session.jobId !== this.options.expectedRenditionJobId ||
      session.mimeType !== "audio/mpeg" ||
      !isSecureHttpsUrl(session.url) ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= this.now()
    ) {
      throw new Error("VOD 音频转码会话与当前音轨不匹配。");
    }
  }

  private scheduleSessionRefresh(session: RenditionPlaybackSession) {
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    this.backgroundFailedAttempts = 0;
    const delay = Math.max(
      MIN_SESSION_LIFETIME_MS,
      expiresAt - this.now() - SESSION_REFRESH_AHEAD_MS,
    );
    this.refreshDueAtMilliseconds = this.now() + delay;
    this.scheduleRefreshTask(() => void this.runBackgroundRefresh(), delay);
  }

  private async runBackgroundRefresh() {
    try {
      await this.refreshSession();
    } catch {
      if (!this.disposed && this.activeSlot.backend && !this.recoveryActive) {
        this.scheduleBackgroundRetry();
      }
    }
  }

  private scheduleBackgroundRetry() {
    this.backgroundFailedAttempts += 1;
    const delay = getVodSessionRefreshRetryDelay("background", this.backgroundFailedAttempts);
    if (delay === null) return;
    this.refreshDueAtMilliseconds = this.now();
    this.scheduleRefreshTask(() => void this.runBackgroundRefresh(), delay);
  }

  private startPlaybackRecovery() {
    if (this.recoveryActive || this.disposed) return;
    this.recoveryActive = true;
    this.recoveryFailedAttempts = 0;
    this.clearRefreshSchedule();
    this.options.events.onBufferingChange?.(true);
    void this.runRecoveryAttempt();
  }

  private runRecoveryAttempt() {
    if (this.recoveryPromise) return this.recoveryPromise;
    let attempt: Promise<void>;
    attempt = this.refreshSession()
      .then(() => {
        if (this.disposed || !this.recoveryActive) return;
        this.recoveryActive = false;
        this.recoveryFailedAttempts = 0;
        this.options.events.onBufferingChange?.(false);
      })
      .catch(() => {
        if (this.disposed || !this.recoveryActive) return;
        this.recoveryFailedAttempts += 1;
        const delay = getVodSessionRefreshRetryDelay(
          "player_recovery",
          this.recoveryFailedAttempts,
        );
        if (delay === null) {
          this.recoveryActive = false;
          this.options.events.onError("VOD 音频转码播放失败，请重试。");
          return;
        }
        this.scheduleRefreshTask(() => void this.runRecoveryAttempt(), delay);
      })
      .finally(() => {
        if (this.recoveryPromise === attempt) this.recoveryPromise = null;
      });
    this.recoveryPromise = attempt;
    return attempt;
  }

  private scheduleRefreshTask(callback: () => void, delayMs: number) {
    this.clearRefreshSchedule();
    this.cancelRefreshSchedule = this.scheduleRefresh(() => {
      this.cancelRefreshSchedule = null;
      callback();
    }, delayMs);
  }

  private clearRefreshSchedule() {
    this.cancelRefreshSchedule?.();
    this.cancelRefreshSchedule = null;
  }

  private deactivateAndDispose(slot: ChildSlot | null) {
    if (!slot) return;
    slot.active = false;
    slot.backend?.pause();
    slot.backend?.dispose();
  }

  private assertActive() {
    if (this.disposed) throw new Error("VOD 音频转码已不可用。");
  }
}

function defaultScheduleRefresh(callback: () => void, delayMs: number) {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function isSecureHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function emptySnapshot(): MediaPlaybackSnapshot {
  return { ready: false, currentTime: 0, duration: 0, paused: true, ended: false };
}
