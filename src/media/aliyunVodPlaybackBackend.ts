import type {
  AliyunVodPlaybackSession,
  MediaAudioTrackPlaybackSession,
} from "@xiqu/shared";
import {
  loadAliplayerSdk,
  type AliplayerConstructor,
  type AliplayerInstance,
  type AliplayerOptions,
} from "./aliplayerSdk";
import {
  MediaPlaybackCommandCancelledError,
  normalizePlaybackSnapshot,
  normalizePlaybackTime,
  normalizePlaybackVolume,
  type MediaPlaybackBackend,
  type MediaPlaybackBackendEvents,
  type MediaPlaybackSnapshot,
} from "./mediaPlaybackController";
import { getVodSessionRefreshRetryDelay } from "./vodSessionRefreshPolicy";

const VOD_SEEK_EPSILON_SECONDS = 1 / 30;
const VOD_SEEK_TIMEOUT_MS = 12_000;
const VOD_READY_TIMEOUT_MS = 20_000;
const VOD_SESSION_REFRESH_AHEAD_MS = 60_000;
const VOD_MIN_SESSION_LIFETIME_MS = 5_000;

export type AliyunVodPlaybackBackendOptions = {
  containerId: string;
  expectedVideoId: string;
  expectedMediaKind?: "video" | "audio";
  expectedRenditionJobId?: string;
  loadSession: (signal?: AbortSignal) => Promise<AliyunVodRuntimePlaybackSession>;
  events: MediaPlaybackBackendEvents;
  loadFactory?: () => Promise<AliplayerConstructor>;
  now?: () => number;
  scheduleRefresh?: (callback: () => void, delayMs: number) => () => void;
};

export type AliyunVodRuntimePlaybackSession =
  | AliyunVodPlaybackSession
  | Extract<
      MediaAudioTrackPlaybackSession,
      { sourceType: "aliyun_vod_rendition" }
    >;

type PendingSeek = {
  target: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
};

/**
 * Aliplayer 到统一播放合同的唯一适配器。
 *
 * playauth 只保存在实例内存中；到期前以单飞方式重建播放器。每次重建都递增 generation，
 * 因而旧播放器的 ready/seeked/error 即使迟到，也不能修改新来源或完成新命令。
 */
export class AliyunVodPlaybackBackend implements MediaPlaybackBackend {
  private player: AliplayerInstance | null = null;
  private disposed = false;
  private generation = 0;
  private refreshPromise: Promise<void> | null = null;
  private cancelRefreshSchedule: (() => void) | null = null;
  private sessionRefreshAtMilliseconds: number | null = null;
  private backgroundRefreshFailedAttempts = 0;
  private playerRecoveryFailedAttempts = 0;
  private playerRecoveryActive = false;
  private playerRecoveryPromise: Promise<void> | null = null;
  private readonly sessionRequestAbortControllers = new Set<AbortController>();
  private pendingSeek: PendingSeek | null = null;
  private readyPromise: Promise<void>;
  private playbackRate = 1;
  private volume = 0.5;
  private muted = false;
  private lastPreparationError: Error | null = null;
  private snapshot: MediaPlaybackSnapshot = {
    ready: false,
    currentTime: 0,
    duration: 0,
    paused: true,
    ended: false,
  };

  private readonly loadFactory: () => Promise<AliplayerConstructor>;
  private readonly now: () => number;
  private readonly scheduleRefresh: (
    callback: () => void,
    delayMs: number,
  ) => () => void;

  constructor(private readonly options: AliyunVodPlaybackBackendOptions) {
    this.loadFactory = options.loadFactory ?? loadAliplayerSdk;
    this.now = options.now ?? Date.now;
    this.scheduleRefresh = options.scheduleRefresh ?? defaultScheduleRefresh;
    // 初次加载由组件状态消费，必须在构造时附加拒绝处理，避免“尚未点击播放”时出现未处理 Promise。
    this.readyPromise = this.rebuildPlayer({ preservePlayback: false }).catch(() => undefined);
  }

  getSnapshot() {
    return normalizePlaybackSnapshot(this.snapshot);
  }

  async seek(time: number) {
    this.assertActive();
    await this.readyPromise;
    this.assertActive();
    const target = normalizePlaybackTime(time);
    return this.seekReadyPlayer(target);
  }

  private async seekReadyPlayer(target: number) {
    const player = this.requirePlayer();
    if (Math.abs(this.readCurrentTime(player) - target) <= VOD_SEEK_EPSILON_SECONDS) {
      this.updateSnapshot({ currentTime: target, ended: false });
      return;
    }

    this.rejectPendingSeek(new MediaPlaybackCommandCancelledError("新的时间跳转已替代旧操作。"));
    await new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        if (this.pendingSeek?.resolve !== resolve) return;
        this.pendingSeek = null;
        reject(new Error("等待阿里云媒体跳转超时。"));
      }, VOD_SEEK_TIMEOUT_MS);
      this.pendingSeek = { target, resolve, reject, timeout };
      try {
        player.seek(target);
      } catch {
        this.rejectPendingSeek(new Error("阿里云媒体拒绝时间跳转。"));
      }
    });
  }

  async play() {
    this.assertActive();
    await this.readyPromise;
    this.assertActive();
    this.requirePlayer().play();
    this.setPlaying(true);
  }

  pause() {
    if (this.disposed || !this.player) return;
    this.player.pause();
    this.setPlaying(false);
  }

  setPlaybackRate(rate: number) {
    this.assertActive();
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("播放倍率必须是正数。");
    this.playbackRate = rate;
    if (this.player) this.player.setSpeed(rate);
  }

  setVolume(volume: number) {
    this.assertActive();
    this.volume = normalizePlaybackVolume(volume);
    if (this.player) this.player.setVolume(this.volume);
  }

  setMuted(muted: boolean) {
    this.assertActive();
    this.muted = muted;
    if (!this.player) return;
    if (muted) this.player.mute(true);
    else this.player.unMute(true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.playerRecoveryActive = false;
    this.clearRefreshSchedule();
    // 切换文件或音轨时真正终止仍在等待的会话请求，不能只依赖 generation 忽略迟到结果。
    for (const controller of this.sessionRequestAbortControllers) controller.abort();
    this.sessionRequestAbortControllers.clear();
    this.rejectPendingSeek(new MediaPlaybackCommandCancelledError("阿里云媒体已切换。"));
    this.disposePlayer();
  }

  /**
   * 会话刷新保留当前时间、倍率和播放状态，但不会复用旧 playauth。
   * 同一时刻只运行一个刷新；失败后保留明确错误，等待用户重试或下一次命令。
   */
  async refreshSession() {
    this.assertActive();
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = this.rebuildPlayer({ preservePlayback: true })
      .finally(() => {
        this.refreshPromise = null;
      });
    this.refreshPromise = refresh;
    // 刷新失败时旧实例仍在；命令等待刷新收束即可，不能让 readyPromise 永久保持 rejected。
    this.readyPromise = refresh.catch(() => undefined);
    return refresh;
  }

  /** 页面从断网、后台或系统休眠恢复时，只在凭据需要更新时唤醒同一刷新单飞。 */
  async recoverAfterInterruption() {
    this.assertActive();
    if (this.playerRecoveryActive) {
      this.clearRefreshSchedule();
      await this.runPlayerRecoveryAttempt();
      return;
    }
    const refreshDue = this.sessionRefreshAtMilliseconds !== null &&
      this.now() >= this.sessionRefreshAtMilliseconds;
    if (!refreshDue && !this.lastPreparationError) return;
    this.clearRefreshSchedule();
    try {
      await this.refreshSession();
    } catch (error) {
      if (!this.player) throw error;
      this.scheduleBackgroundRefreshRetry();
    }
  }

  private async rebuildPlayer({ preservePlayback }: { preservePlayback: boolean }) {
    const previous = this.getSnapshot();
    const resumePlayback = preservePlayback && !previous.paused && !previous.ended;
    const requestGeneration = this.generation;
    this.lastPreparationError = null;

    let factory: AliplayerConstructor;
    let session: AliyunVodRuntimePlaybackSession;
    const sessionRequestController = new AbortController();
    this.sessionRequestAbortControllers.add(sessionRequestController);
    try {
      // SDK 与播放会话并行加载；若二者同时失败，优先展示服务端已经收敛的业务错误。
      const [factoryResult, sessionResult] = await Promise.allSettled([
        this.loadFactory(),
        this.options.loadSession(sessionRequestController.signal),
      ]);
      if (sessionResult.status === "rejected") throw sessionResult.reason;
      if (factoryResult.status === "rejected") {
        throw new Error("无法加载阿里云 VOD 播放器，请检查网络后重试。");
      }
      factory = factoryResult.value;
      session = sessionResult.value;
      this.validateSession(session);
    } catch (error) {
      if (!this.disposed && requestGeneration === this.generation) {
        // 播放会话错误已由平台 API 收敛；SDK 加载错误在上方替换为固定文案，避免泄露底层细节。
        const message = error instanceof Error
          ? error.message
          : "无法准备阿里云 VOD 播放会话。";
        this.lastPreparationError = new Error(message);
        // 后台续签失败时旧实例仍可播放；只有初次准备或已无实例才进入致命错误通道。
        if (!preservePlayback || !this.player) this.options.events.onError(message);
      }
      throw this.lastPreparationError ?? new Error("无法准备阿里云 VOD 播放会话。");
    } finally {
      this.sessionRequestAbortControllers.delete(sessionRequestController);
    }
    if (this.disposed || requestGeneration !== this.generation) return;

    // 新凭据成功到手后才切断旧实例，避免定时刷新期间因短暂网络延迟提前黑屏。
    const generation = ++this.generation;
    this.clearRefreshSchedule();
    this.rejectPendingSeek(new MediaPlaybackCommandCancelledError("阿里云媒体会话正在刷新。"));
    this.disposePlayer();
    this.updateSnapshot({ ready: false, paused: true, ended: false });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (result: "resolve" | "reject") => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        if (result === "resolve") resolve();
        else reject(new Error("阿里云媒体准备失败。"));
      };
      const timeout = globalThis.setTimeout(() => {
        if (!this.isCurrent(generation)) return finish("resolve");
        this.options.events.onError("等待阿里云媒体准备超时，请重试。");
        // ready 超时后立即淘汰实例，防止迟到 ready 在错误界面后重新复活。
        this.generation += 1;
        this.disposePlayer();
        finish("reject");
      }, VOD_READY_TIMEOUT_MS);

      const commonPlayerOptions = {
        id: this.options.containerId,
        width: "100%",
        height: "100%",
        autoplay: false,
        preload: true,
        isLive: false,
        controlBarVisibility: "hover" as const,
        useH5Prism: true,
        // Web Aliplayer 2.29.1+ 强制校验 domain/key；二者来自受控服务配置，不由项目 JSON 提供。
        license: session.webPlayerLicense,
      };
      // 指定 JobId 的 VOD 音频使用本次 no-store 会话的 HTTPS 地址；普通 VOD 仍使用 vid + PlayAuth。
      const playerOptions: AliplayerOptions =
        session.sourceType === "aliyun_vod_rendition"
          ? {
              ...commonPlayerOptions,
              source: session.url,
              mediaType: "audio",
              format: "mp3",
            }
          : {
              ...commonPlayerOptions,
              vid: session.videoId,
              playauth: session.playAuth,
            };
      try {
        const player = new factory(playerOptions, (readyPlayer) => {
          if (!this.isCurrent(generation)) return finish("resolve");
          this.player = readyPlayer;
          this.bindPlayerEvents(readyPlayer, generation);
          readyPlayer.setSpeed(this.playbackRate);
          readyPlayer.setVolume(this.volume);
          if (this.muted) readyPlayer.mute(true);
          else readyPlayer.unMute(true);
          this.readPlayerSnapshot(readyPlayer, { ready: true });
          this.options.events.onReady(this.getSnapshot());
          finish("resolve");
        });
        this.player = player;
      } catch {
        if (this.isCurrent(generation)) {
          this.options.events.onError("阿里云播放器初始化失败，请重试。");
        }
        finish("reject");
      }
    });
    if (!this.isCurrent(generation)) return;

    this.lastPreparationError = null;
    this.scheduleSessionRefresh(session);
    if (preservePlayback && previous.currentTime > 0) {
      await this.seekReadyPlayer(previous.currentTime);
    }
    if (resumePlayback) this.requirePlayer().play();
  }

  // 官方播放器事件只在当前 generation 下生效；事件载荷不进入业务状态或日志。
  private bindPlayerEvents(player: AliplayerInstance, generation: number) {
    player.on("play", () => {
      if (!this.isCurrentPlayer(player, generation)) return;
      this.readPlayerSnapshot(player);
      this.setPlaying(true);
    });
    player.on("pause", () => {
      if (!this.isCurrentPlayer(player, generation)) return;
      this.readPlayerSnapshot(player);
      this.setPlaying(false);
    });
    player.on("timeupdate", () => {
      if (!this.isCurrentPlayer(player, generation)) return;
      this.readPlayerSnapshot(player);
      this.finishSeekIfReached();
      this.options.events.onTimeUpdate(this.getSnapshot());
    });
    player.on("seeked", () => {
      if (!this.isCurrentPlayer(player, generation)) return;
      this.readPlayerSnapshot(player);
      this.finishSeekIfReached(true);
      this.options.events.onTimeUpdate(this.getSnapshot());
    });
    player.on("ended", () => {
      if (!this.isCurrentPlayer(player, generation)) return;
      this.readPlayerSnapshot(player, { paused: true, ended: true });
      this.options.events.onPlayStateChange(false);
      this.options.events.onTimeUpdate(this.getSnapshot());
    });
    player.on("waiting", () => {
      if (this.isCurrentPlayer(player, generation)) this.options.events.onBufferingChange?.(true);
    });
    player.on("canplay", () => {
      if (this.isCurrentPlayer(player, generation)) this.options.events.onBufferingChange?.(false);
    });
    player.on("error", () => {
      if (!this.isCurrentPlayer(player, generation)) return;
      this.rejectPendingSeek(new Error("阿里云媒体播放失败。"));
      this.startPlayerErrorRecovery();
    });
  }

  private readPlayerSnapshot(player: AliplayerInstance, patch: Partial<MediaPlaybackSnapshot> = {}) {
    this.updateSnapshot({
      currentTime: this.readCurrentTime(player),
      duration: player.getDuration(),
      ...patch,
    });
  }

  private readCurrentTime(player: AliplayerInstance) {
    return normalizePlaybackTime(player.getCurrentTime());
  }

  private finishSeekIfReached(force = false) {
    const pending = this.pendingSeek;
    if (!pending) return;
    if (!force && Math.abs(this.snapshot.currentTime - pending.target) > VOD_SEEK_EPSILON_SECONDS) return;
    this.pendingSeek = null;
    globalThis.clearTimeout(pending.timeout);
    this.updateSnapshot({ currentTime: pending.target, ended: false });
    pending.resolve();
  }

  private rejectPendingSeek(error: Error) {
    const pending = this.pendingSeek;
    if (!pending) return;
    this.pendingSeek = null;
    globalThis.clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private scheduleSessionRefresh(session: AliyunVodRuntimePlaybackSession) {
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    this.backgroundRefreshFailedAttempts = 0;
    const delay = Math.max(
      VOD_MIN_SESSION_LIFETIME_MS,
      expiresAt - this.now() - VOD_SESSION_REFRESH_AHEAD_MS,
    );
    this.sessionRefreshAtMilliseconds = this.now() + delay;
    this.scheduleRefreshTask(() => {
      void this.runBackgroundSessionRefresh();
    }, delay);
  }

  private async runBackgroundSessionRefresh() {
    try {
      await this.refreshSession();
    } catch {
      if (!this.disposed && this.player && !this.playerRecoveryActive) {
        this.scheduleBackgroundRefreshRetry();
      }
    }
  }

  private scheduleBackgroundRefreshRetry() {
    this.backgroundRefreshFailedAttempts += 1;
    const delay = getVodSessionRefreshRetryDelay(
      "background",
      this.backgroundRefreshFailedAttempts,
    );
    if (delay === null) return;
    this.sessionRefreshAtMilliseconds = this.now();
    this.scheduleRefreshTask(() => {
      void this.runBackgroundSessionRefresh();
    }, delay);
  }

  private startPlayerErrorRecovery() {
    if (this.playerRecoveryActive || this.disposed) return;
    this.playerRecoveryActive = true;
    this.playerRecoveryFailedAttempts = 0;
    this.clearRefreshSchedule();
    this.options.events.onBufferingChange?.(true);
    void this.runPlayerRecoveryAttempt();
  }

  private runPlayerRecoveryAttempt() {
    if (this.playerRecoveryPromise) return this.playerRecoveryPromise;
    let attempt: Promise<void>;
    attempt = this.refreshSession()
      .then(() => {
        if (this.disposed || !this.playerRecoveryActive) return;
        this.playerRecoveryActive = false;
        this.playerRecoveryFailedAttempts = 0;
        this.options.events.onBufferingChange?.(false);
      })
      .catch(() => {
        if (this.disposed || !this.playerRecoveryActive) return;
        this.playerRecoveryFailedAttempts += 1;
        const delay = getVodSessionRefreshRetryDelay(
          "player_recovery",
          this.playerRecoveryFailedAttempts,
        );
        if (delay === null) {
          this.playerRecoveryActive = false;
          this.options.events.onError("阿里云媒体播放失败，请重试。");
          return;
        }
        this.scheduleRefreshTask(() => {
          void this.runPlayerRecoveryAttempt();
        }, delay);
      })
      .finally(() => {
        if (this.playerRecoveryPromise === attempt) this.playerRecoveryPromise = null;
      });
    this.playerRecoveryPromise = attempt;
    return attempt;
  }

  private validateSession(session: AliyunVodRuntimePlaybackSession) {
    if (session.sourceType === "aliyun_vod_rendition") {
      if (
        !this.options.expectedRenditionJobId ||
        session.jobId !== this.options.expectedRenditionJobId ||
        session.videoId !== this.options.expectedVideoId ||
        session.mimeType !== "audio/mpeg" ||
        !isSecureHttpsUrl(session.url) ||
        !session.expiresAt ||
        !session.webPlayerLicense?.domain ||
        !session.webPlayerLicense?.key ||
        !Number.isFinite(Date.parse(session.expiresAt)) ||
        Date.parse(session.expiresAt) <= this.now()
      ) {
        throw new Error("VOD 音频转码会话与当前音轨不匹配。");
      }
      return;
    }
    if (
      session.sourceType !== "aliyun_vod" ||
      session.mediaKind !== (this.options.expectedMediaKind ?? "video") ||
      session.videoId !== this.options.expectedVideoId ||
      !session.playAuth ||
      !session.expiresAt ||
      !session.webPlayerLicense?.domain ||
      !session.webPlayerLicense?.key ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= this.now()
    ) {
      throw new Error("VOD 播放会话与当前媒体不匹配。");
    }
  }

  private updateSnapshot(patch: Partial<MediaPlaybackSnapshot>) {
    this.snapshot = normalizePlaybackSnapshot({ ...this.snapshot, ...patch });
  }

  // SDK 事件可能同步或异步到达；幂等更新保证快速连续按键立即读到最新暂停状态且只回报一次。
  private setPlaying(playing: boolean) {
    const changed = this.snapshot.paused === playing || (playing && this.snapshot.ended);
    this.updateSnapshot({ paused: !playing, ...(playing ? { ended: false } : {}) });
    if (changed) this.options.events.onPlayStateChange(playing);
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

  private disposePlayer() {
    const player = this.player;
    this.player = null;
    if (!player) return;
    try {
      player.pause();
    } catch {
      // 已损坏的供应商实例仍需继续 dispose，不能让清理流程中断。
    }
    try {
      player.dispose();
    } catch {
      // dispose 本身失败也不能阻止 generation 失效和其余本地状态清理。
    }
  }

  private requirePlayer() {
    if (!this.player) {
      throw this.lastPreparationError ?? new Error("阿里云媒体尚未准备完成。");
    }
    return this.player;
  }

  private isCurrent(generation: number) {
    return !this.disposed && generation === this.generation;
  }

  private isCurrentPlayer(player: AliplayerInstance, generation: number) {
    return this.isCurrent(generation) && this.player === player;
  }

  private assertActive() {
    if (this.disposed) throw new Error("阿里云媒体已不可用。");
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
