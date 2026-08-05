import type { AliyunVodPlaybackSession } from "@xiqu/shared";
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
  type MediaPlaybackBackend,
  type MediaPlaybackBackendEvents,
  type MediaPlaybackSnapshot,
} from "./mediaPlaybackController";

const VOD_SEEK_EPSILON_SECONDS = 1 / 30;
const VOD_SEEK_TIMEOUT_MS = 12_000;
const VOD_READY_TIMEOUT_MS = 20_000;
const VOD_SESSION_REFRESH_AHEAD_MS = 60_000;
const VOD_MIN_SESSION_LIFETIME_MS = 5_000;

export type AliyunVodPlaybackBackendOptions = {
  containerId: string;
  expectedVideoId: string;
  loadSession: () => Promise<AliyunVodPlaybackSession>;
  events: MediaPlaybackBackendEvents;
  loadFactory?: () => Promise<AliplayerConstructor>;
  now?: () => number;
};

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
  private refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pendingSeek: PendingSeek | null = null;
  private readyPromise: Promise<void>;
  private playbackRate = 1;
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

  constructor(private readonly options: AliyunVodPlaybackBackendOptions) {
    this.loadFactory = options.loadFactory ?? loadAliplayerSdk;
    this.now = options.now ?? Date.now;
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

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearRefreshTimer();
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

  private async rebuildPlayer({ preservePlayback }: { preservePlayback: boolean }) {
    const previous = this.getSnapshot();
    const resumePlayback = preservePlayback && !previous.paused && !previous.ended;
    const requestGeneration = this.generation;
    this.lastPreparationError = null;

    let factory: AliplayerConstructor;
    let session: AliyunVodPlaybackSession;
    try {
      // SDK 与播放会话并行加载；若二者同时失败，优先展示服务端已经收敛的业务错误。
      const [factoryResult, sessionResult] = await Promise.allSettled([
        this.loadFactory(),
        this.options.loadSession(),
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
        this.options.events.onError(message);
      }
      throw this.lastPreparationError ?? new Error("无法准备阿里云 VOD 播放会话。");
    }
    if (this.disposed || requestGeneration !== this.generation) return;

    // 新凭据成功到手后才切断旧实例，避免定时刷新期间因短暂网络延迟提前黑屏。
    const generation = ++this.generation;
    this.clearRefreshTimer();
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

      const playerOptions: AliplayerOptions = {
        id: this.options.containerId,
        vid: session.videoId,
        playauth: session.playAuth,
        width: "100%",
        height: "100%",
        autoplay: false,
        preload: true,
        isLive: false,
        controlBarVisibility: "hover",
        useH5Prism: true,
        // Web Aliplayer 2.29.1+ 强制校验 domain/key；二者来自受控服务配置，不由项目 JSON 提供。
        license: session.webPlayerLicense,
      };
      try {
        const player = new factory(playerOptions, (readyPlayer) => {
          if (!this.isCurrent(generation)) return finish("resolve");
          this.player = readyPlayer;
          this.bindPlayerEvents(readyPlayer, generation);
          readyPlayer.setSpeed(this.playbackRate);
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
    player.on("error", () => {
      if (!this.isCurrentPlayer(player, generation)) return;
      this.rejectPendingSeek(new Error("阿里云媒体播放失败。"));
      this.options.events.onError("阿里云媒体播放失败，正在尝试刷新播放凭据。");
      void this.refreshSession().catch(() => {
        if (!this.disposed) this.options.events.onError("阿里云媒体播放失败，请重试。");
      });
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

  private scheduleSessionRefresh(session: AliyunVodPlaybackSession) {
    const expiresAt = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAt)) return;
    const delay = Math.max(
      VOD_MIN_SESSION_LIFETIME_MS,
      expiresAt - this.now() - VOD_SESSION_REFRESH_AHEAD_MS,
    );
    this.refreshTimer = globalThis.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSession().catch(() => undefined);
    }, delay);
  }

  private validateSession(session: AliyunVodPlaybackSession) {
    if (
      session.sourceType !== "aliyun_vod" ||
      session.mediaKind !== "video" ||
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

  private clearRefreshTimer() {
    if (this.refreshTimer === null) return;
    globalThis.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
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
