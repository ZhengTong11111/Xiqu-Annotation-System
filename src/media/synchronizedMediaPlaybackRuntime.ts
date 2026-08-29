import {
  classifyExternalAudioDrift,
  isExternalAudioWithinSyncTolerance,
  mapMasterTimeToAudioTime,
  SYNCHRONIZED_AUDIO_DRIFT_POLICY,
} from "./synchronizedPlaybackPolicy";
import {
  INITIAL_SYNCHRONIZED_PLAYBACK_STATE,
  reduceSynchronizedPlaybackState,
  type SynchronizedPlaybackEvent,
  type SynchronizedPlaybackState,
} from "./synchronizedPlaybackState";
import {
  MediaPlaybackCommandCancelledError,
  normalizePlaybackVolume,
  type MediaPlaybackBackend,
} from "./mediaPlaybackController";
import {
  createPlaybackClockProgressWaiter,
  type WaitForPlaybackClockProgress,
} from "./playbackClockProgress";
import {
  normalizeBufferingDurationMilliseconds,
  normalizeDiagnosticDriftMilliseconds,
  type SynchronizedPlaybackDiagnostic,
} from "./synchronizedPlaybackDiagnostic";
import {
  prepareExternalAudioPlaybackBackend,
  type ExternalAudioPlaybackBackendEvents,
  type ExternalAudioPlaybackSource,
  type PrepareExternalAudioPlaybackBackend,
} from "./externalAudioPlaybackBackendFactory";
import type { AliyunVodMediaClock } from "./aliyunVodPlaybackBackend";

const DEFAULT_DRIFT_SAMPLE_INTERVAL_MS = 100;
const BUFFERING_STALL_CONFIRMATION_MS = 120;
const BUFFERING_CLOCK_PROGRESS_SECONDS = 0.001;
const PRECISE_NATIVE_START_EPSILON_SECONDS = 0.001;
const NATIVE_RENDITION_STABILIZATION_MS = 6_000;
const NATIVE_RENDITION_STABILIZATION_HARD_RESYNC_SECONDS = 0.5;

type PendingBufferingProbe = {
  baselineTime: number;
  cancel: () => void;
};

export type SynchronizedMediaPlaybackRuntimeOptions = {
  vodContainerId: string;
  readVodMediaClock?: () => AliyunVodMediaClock | null;
  prepareExternalBackend?: PrepareExternalAudioPlaybackBackend;
  scheduleDriftSample?: (callback: () => void, delayMs: number) => () => void;
  scheduleBufferingProbe?: (callback: () => void, delayMs: number) => () => void;
  waitForMasterProgress?: WaitForPlaybackClockProgress;
  now?: () => number;
  onStateChange?: (state: SynchronizedPlaybackState) => void;
  onDiagnostic?: (diagnostic: SynchronizedPlaybackDiagnostic) => void;
  onError?: (message: string) => void;
};

export type SynchronizedAudioSelection =
  | { type: "original" }
  | { type: "external"; source: ExternalAudioPlaybackSource }
  | { type: "unavailable"; trackId: string; errorCode: string }
  | { type: "blocked"; errorCode: string };

export const ORIGINAL_AUDIO_SELECTION: SynchronizedAudioSelection =
  Object.freeze({ type: "original" });

type AlignmentResult = "playable" | "before_start" | "after_end";
type ExternalTimelineObservation = AlignmentResult | "invalid_time";
type ExternalAlignmentMode =
  | "always_seek"
  | "skip_seek_within_tolerance"
  | "precise_native_start"
  | "preserve_buffered_start";
type PendingExternalStart = {
  commandGeneration: number;
  sourceGeneration: number;
  promise: Promise<boolean>;
};
type PrimedRenditionStartResult = "not_applicable" | "completed" | "cancelled";

/**
 * 组合播放运行时让视频始终担任主时钟，并集中拥有唯一一条替换音频及其异步生命周期。
 * App 继续只调用 MediaPlaybackBackend；音轨选择、漂移和缓冲不会扩散到时间轴或协作层。
 */
export class SynchronizedMediaPlaybackRuntime implements MediaPlaybackBackend {
  private masterBackend: MediaPlaybackBackend | null = null;
  private externalBackend: MediaPlaybackBackend | null = null;
  private desiredSource: ExternalAudioPlaybackSource | null = null;
  private prepareAbortController: AbortController | null = null;
  private preparePromise: Promise<void> | null = null;
  private interruptionRecoveryPromise: Promise<void> | null = null;
  private interruptionRecoveryGeneration = 0;
  private stopDriftSample: (() => void) | null = null;
  private driftSyncPromise: Promise<void> | null = null;
  private pendingExternalStart: PendingExternalStart | null = null;
  private externalPrimePromise: Promise<void> | null = null;
  private externalPriming = false;
  private externalPrimeGeneration = 0;
  private primedExternalPosition: {
    sourceGeneration: number;
    audioTime: number;
  } | null = null;
  private externalPlaybackRateMultiplier = 1;
  private nativeRenditionStabilizationUntilMilliseconds = 0;
  private externalTimelinePosition: ExternalTimelineObservation | null = null;
  private bufferingStartedAtMilliseconds: number | null = null;
  private pendingMasterBufferingProbe: PendingBufferingProbe | null = null;
  private pendingExternalBufferingProbe: PendingBufferingProbe | null = null;
  private state: SynchronizedPlaybackState = { ...INITIAL_SYNCHRONIZED_PLAYBACK_STATE };
  private commandGeneration = 0;
  private internalMasterPauseCommandGeneration: number | null = null;
  private playbackRate = 1;
  private volume = 0.5;
  private userMuted = false;
  private disposed = false;

  private readonly prepareExternalBackend: PrepareExternalAudioPlaybackBackend;
  private readonly scheduleDriftSample: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  private readonly now: () => number;
  private readonly waitForMasterProgress: WaitForPlaybackClockProgress;
  private readonly scheduleBufferingProbe: (
    callback: () => void,
    delayMs: number,
  ) => () => void;

  constructor(private readonly options: SynchronizedMediaPlaybackRuntimeOptions) {
    this.prepareExternalBackend = options.prepareExternalBackend ??
      prepareExternalAudioPlaybackBackend;
    this.scheduleDriftSample = options.scheduleDriftSample ?? defaultScheduleDriftSample;
    this.waitForMasterProgress = options.waitForMasterProgress ??
      createPlaybackClockProgressWaiter();
    this.scheduleBufferingProbe = options.scheduleBufferingProbe ??
      defaultScheduleBufferingProbe;
    this.now = options.now ?? getMonotonicNow;
  }

  getSnapshot() {
    const masterSnapshot = this.masterBackend?.getSnapshot();
    if (!masterSnapshot) return {
      ready: false,
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
    };
    if (
      masterSnapshot.paused &&
      this.internalMasterPauseCommandGeneration === this.commandGeneration &&
      this.state.desiredPlayback === "playing"
    ) {
      // JobId MP3 目标预热期间，主媒体在物理层暂停，但组合播放器仍处于一次播放中 seek。
      // 对外保持逻辑 playing，避免 VideoPlayer 的暂停态 currentTime effect 用旧时间覆盖目标 seek。
      return { ...masterSnapshot, paused: false };
    }
    return masterSnapshot;
  }

  getState() {
    return this.state;
  }

  /** 主媒体 backend 由 VideoPlayer 创建，但从挂载起由组合运行时统一销毁。 */
  attachMasterBackend(backend: MediaPlaybackBackend) {
    this.assertActive();
    this.releaseMediaSession(false);
    this.masterBackend = backend;
    backend.setPlaybackRate(this.playbackRate);
    backend.setVolume(this.volume);
    backend.setMuted(this.userMuted);
    this.resetStateForMaster();
  }

  /** source effect cleanup 只移除自己安装的 backend，避免旧 cleanup 销毁后来的主媒体。 */
  detachMasterBackend(expected?: MediaPlaybackBackend) {
    if (expected && this.masterBackend !== expected) return;
    this.releaseMediaSession(true);
  }

  /** 主媒体 metadata/Aliplayer ready 后才开始消费外部选择，避免在无权威时钟时提前 seek。 */
  notifyMasterReady() {
    if (
      !this.masterBackend?.getSnapshot().ready ||
      !this.desiredSource ||
      this.state.phase !== "preparing_external"
    ) return;
    if (this.externalBackend || this.preparePromise) return;
    const generation = this.state.sourceGeneration;
    void this.startPreparation(this.desiredSource, generation);
  }

  /**
   * 原生 controls 与 Aliplayer controls 会绕过 App 命令直接改变主媒体。
   * 这里把浏览器事实重新收口到组合 runtime，但 buffering 主动暂停仍保留原播放意图。
   */
  notifyMasterPlaybackState(playing: boolean): boolean {
    if (this.disposed || !this.masterBackend) return false;
    const masterSnapshot = this.masterBackend.getSnapshot();
    if (playing) {
      // 同步屏障恢复播放后，后端的 playing 事实同时结束本次内部暂停抑制。
      this.internalMasterPauseCommandGeneration = null;
      if (this.state.phase === "error_external") {
        this.masterBackend.pause();
        return false;
      }
      // 只有直接操作媒体控件时，playing 事件才会先于 runtime 播放意图到达。
      // 将它登记为新命令，可使刚被用户暂停的旧起播等待彻底失效。
      if (this.state.desiredPlayback === "paused") this.commandGeneration += 1;
      if (this.state.phase === "original") {
        this.applyEvent({ type: "play_requested" });
        return true;
      }
      if (!this.externalBackend || !this.desiredSource) {
        this.applyEvent({ type: "play_requested" });
        return true;
      }
      if (this.state.phase === "ready_paused") {
        if (!this.applyEvent({ type: "play_requested" })) return false;
        const generation = this.state.sourceGeneration;
        const commandGeneration = this.commandGeneration;
        void this.startExternalAfterPrime(
          generation,
          commandGeneration,
          "preserve_buffered_start",
        ).catch((error) => {
          if (!(error instanceof MediaPlaybackCommandCancelledError)) {
            this.handleExternalFailure(
              generation,
              error instanceof Error ? error.message : "替换音轨重新同步失败。",
            );
          }
        });
        return true;
      }
      if (this.state.phase === "playing_synced") this.startDriftSampling();
      return true;
    }

    if (
      this.internalMasterPauseCommandGeneration === this.commandGeneration &&
      this.state.desiredPlayback === "playing"
    ) {
      // 随机 seek 为预热 JobId MP3 暂停主视频，不等于用户点击暂停。这里继续向 React 回报“逻辑播放中”，
      // 否则暂停态的 currentTime 同步 effect 会用旧时间追加 seek，反向覆盖用户刚选择的新目标。
      return true;
    }

    // buffering 为同步 owner 主动暂停主视频，不能被误写成用户取消播放。
    if (
      this.state.phase === "buffering_master" ||
      this.state.phase === "buffering_external"
    ) return false;
    if (
      this.state.desiredPlayback === "paused" &&
      (this.state.phase === "original" ||
        this.state.phase === "ready_paused" ||
        this.state.phase === "error_external")
    ) return false;
    // runtime.pause() 会先写入 paused 意图再触发媒体 pause 事件，因此这里只会递增原生控件命令。
    this.commandGeneration += 1;
    this.applyEvent({ type: "pause_requested" });
    this.externalBackend?.pause();
    this.stopDriftSampling();
    this.clearExternalTimelineObservation();
    if (masterSnapshot.ended) this.clearBufferingObservation();
    return false;
  }

  /**
   * 主 VOD 的 waiting/canplay 必须进入组合 owner：主时钟停住时从轨不能继续跑，
   * 恢复后仍先等待主时钟真实推进，避免一次 CDN 缺片演变成连续硬 seek。
   */
  notifyMasterBufferingState(buffering: boolean) {
    const master = this.masterBackend;
    const external = this.externalBackend;
    const source = this.desiredSource;
    if (!master || !external || !source || this.disposed) return;
    const generation = this.state.sourceGeneration;

    if (buffering) {
      if (
        this.state.desiredPlayback !== "playing" ||
        this.state.phase === "buffering_external"
      ) return;
      if (this.pendingMasterBufferingProbe || this.state.phase === "buffering_master") return;
      const probe: PendingBufferingProbe = {
        baselineTime: master.getSnapshot().currentTime,
        cancel: () => undefined,
      };
      probe.cancel = this.scheduleBufferingProbe(() => {
        if (this.pendingMasterBufferingProbe !== probe) return;
        this.pendingMasterBufferingProbe = null;
        if (
          this.disposed ||
          this.masterBackend !== master ||
          this.externalBackend !== external ||
          !this.isCurrentSource(source, generation) ||
          this.state.desiredPlayback !== "playing" ||
          hasPlaybackClockProgressed(master.getSnapshot().currentTime, probe.baselineTime)
        ) return;
        if (!this.applyEvent({ type: "master_buffering", generation })) return;
        // 旧起播等待会在下一次轮询发现 phase 变化；先释放单飞槽，允许 canplay 立即建立新等待。
        this.pendingExternalStart = null;
        external.pause();
        this.stopDriftSampling();
      }, BUFFERING_STALL_CONFIRMATION_MS);
      this.pendingMasterBufferingProbe = probe;
      return;
    }

    this.cancelMasterBufferingProbe();
    if (this.state.phase !== "buffering_master") return;
    if (!this.applyEvent({ type: "master_recovered", generation })) return;
    const commandGeneration = this.commandGeneration;
    void this.startExternalAfterMasterProgress(
      generation,
      commandGeneration,
      master.getSnapshot().currentTime,
      "preserve_buffered_start",
    ).catch((error) => {
      if (!(error instanceof MediaPlaybackCommandCancelledError)) {
        this.handleExternalFailure(
          generation,
          error instanceof Error ? error.message : "主媒体缓冲后重新同步失败。",
        );
      }
    });
  }

  /** online/pageshow/visible 共用这一单飞入口，恢复完成前用户的新命令和切轨始终优先。 */
  recoverAfterInterruption() {
    if (this.disposed || !this.masterBackend) return Promise.resolve();
    if (this.interruptionRecoveryPromise) return this.interruptionRecoveryPromise;
    const recoveryGeneration = this.interruptionRecoveryGeneration;
    const recovery = this.performInterruptionRecovery(recoveryGeneration).finally(() => {
      if (this.interruptionRecoveryPromise === recovery) {
        this.interruptionRecoveryPromise = null;
      }
    });
    this.interruptionRecoveryPromise = recovery;
    return recovery;
  }

  private async performInterruptionRecovery(recoveryGeneration: number) {
    const master = this.masterBackend;
    if (!master) return;
    // 命令版本必须在任何网络等待前冻结；恢复期间发生的 pause/play/seek 都应让旧后处理直接失效。
    const commandGeneration = this.commandGeneration;
    await master.recoverAfterInterruption?.();
    if (
      !this.isCurrentInterruptionRecovery(recoveryGeneration) ||
      !this.isCurrentCommand(commandGeneration) ||
      this.masterBackend !== master
    ) {
      return;
    }

    const external = this.externalBackend;
    const source = this.desiredSource;
    const sourceGeneration = this.state.sourceGeneration;
    if (!external || !source) return;
    await external.recoverAfterInterruption?.();
    if (
      !this.isCurrentInterruptionRecovery(recoveryGeneration) ||
      !this.isCurrentCommand(commandGeneration) ||
      !this.isCurrentSource(source, sourceGeneration) ||
      this.externalBackend !== external ||
      this.state.phase === "buffering_external"
    ) {
      return;
    }

    const shouldPlay = this.state.desiredPlayback === "playing" &&
      !master.getSnapshot().ended;
    const baselineTime = master.getSnapshot().currentTime;
    if (shouldPlay && master.getSnapshot().paused) {
      await master.play();
      if (!this.isCurrentCommand(commandGeneration) || this.state.desiredPlayback !== "playing") {
        master.pause();
        return;
      }
    }
    if (!this.isCurrentCommand(commandGeneration)) return;
    if (shouldPlay) {
      await this.startExternalAfterMasterProgress(
        sourceGeneration,
        commandGeneration,
        baselineTime,
      );
    } else {
      await this.resynchronizeExternal(sourceGeneration, false);
    }
  }

  async selectAudio(selection: SynchronizedAudioSelection) {
    this.assertActive();
    if (selection.type === "original") {
      if (this.state.phase === "original" && !this.desiredSource) return;
      this.invalidateInterruptionRecovery();
      this.commandGeneration += 1;
      this.activateOriginal();
      return;
    }
    if (selection.type === "unavailable") {
      if (
        this.state.phase === "error_external" &&
        this.state.selectedTrackId === selection.trackId &&
        this.state.errorCode === selection.errorCode
      ) return;
      this.invalidateInterruptionRecovery();
      this.commandGeneration += 1;
      this.enterUnavailableSelection(selection.trackId, selection.errorCode);
      return;
    }
    if (selection.type === "blocked") {
      if (
        this.state.phase === "error_external" &&
        this.state.selectedTrackId === null &&
        this.state.errorCode === selection.errorCode
      ) return;
      this.invalidateInterruptionRecovery();
      this.commandGeneration += 1;
      this.enterBlockedSelection(selection.errorCode);
      return;
    }
    const source = selection.source;
    // React effect 与主媒体 ready 可能先后表达同一选择；幂等复用可避免重复申请会话和短暂恢复原声。
    if (source === this.desiredSource && this.state.phase !== "error_external") {
      if (this.externalBackend) return;
      if (this.preparePromise) return this.preparePromise;
      if (!this.masterBackend?.getSnapshot().ready) return;
      return this.startPreparation(source, this.state.sourceGeneration);
    }
    this.invalidateInterruptionRecovery();
    this.commandGeneration += 1;
    this.desiredSource = source;
    this.cancelExternalPreparation();
    this.disposeExternalBackend();
    this.stopDriftSampling();
    this.setExternalPlaybackRateMultiplier(1);
    const desiredPlayback = this.getSnapshot().paused ? "paused" : "playing";
    if (!this.applyEvent({
      type: "select_external",
      trackId: source.trackId,
      desiredPlayback,
    })) return;
    // 新外部声音尚未 ready 时先关闭主声音，允许短暂无声但绝不允许原声与替换音轨重叠。
    this.masterBackend?.setMuted(true);
    if (!this.masterBackend?.getSnapshot().ready) return;

    const generation = this.state.sourceGeneration;
    await this.startPreparation(source, generation);
  }

  async seek(time: number) {
    const master = this.requireMasterBackend();
    const commandGeneration = ++this.commandGeneration;
    const shouldResume = this.state.desiredPlayback === "playing" &&
      !master.getSnapshot().ended;
    const shouldPrimeRenditionBeforeResume = shouldResume &&
      this.desiredSource?.type === "aliyun_vod_rendition_audio";
    if (this.externalBackend && this.desiredSource) {
      // seek 期间先冻结从轨，避免 VOD 拉取新分片时音频仍沿旧时钟独自前进。
      this.invalidateExternalPrime();
      this.externalBackend.pause();
      this.stopDriftSampling();
    }
    // Aliplayer 在播放态 seek 是既有可靠路径；不能为了外轨预热先暂停再 seek，否则供应商播放器可能留在旧位置。
    await master.seek(time);
    if (!this.isCurrentCommand(commandGeneration)) return;
    const generation = this.state.sourceGeneration;
    if (!this.externalBackend || !this.desiredSource) return;
    if (!shouldResume) {
      await this.resynchronizeExternal(generation, false);
      await this.primePausedExternal(generation);
      return;
    }
    if (shouldPrimeRenditionBeforeResume) {
      // 主视频已经抵达新目标后才进入媒体级冻结；不提交 pause_requested，用户的播放意图保持不变。
      this.pauseMasterForSynchronization(master, commandGeneration);
      await this.alignExternalToMaster(generation);
      if (!this.isCurrentCommand(commandGeneration)) return;
      await this.primePausedExternal(generation);
      if (!this.isCurrentCommand(commandGeneration)) return;
      const startResult = await this.startPrimedRenditionWithMaster(
        generation,
        commandGeneration,
      );
      if (startResult !== "not_applicable") return;
    }
    const baselineTime = master.getSnapshot().currentTime;
    if (master.getSnapshot().paused) await master.play();
    if (!this.isCurrentCommand(commandGeneration)) return;
    await this.startExternalAfterMasterProgress(
      generation,
      commandGeneration,
      baselineTime,
    );
  }

  async play() {
    // 暂停/seek 阶段已经启动的静音预热必须先完成，避免用户快速点击播放时冷启动重新泄漏到听觉路径。
    const pendingPrime = this.externalPrimePromise;
    if (pendingPrime) await pendingPrime;
    const master = this.requireMasterBackend();
    if (this.state.phase === "error_external") {
      throw new Error("当前监听音轨不可用，请重试或切回视频原声。");
    }
    const commandGeneration = ++this.commandGeneration;
    const baselineTime = master.getSnapshot().currentTime;
    this.applyEvent({ type: "play_requested" });
    const primedStartResult = await this.startPrimedRenditionWithMaster(
      this.state.sourceGeneration,
      commandGeneration,
    );
    if (primedStartResult !== "not_applicable") return;
    await master.play();
    if (!this.isCurrentCommand(commandGeneration)) {
      master.pause();
      return;
    }
    const generation = this.state.sourceGeneration;
    if (this.externalBackend && this.desiredSource) {
      await this.startExternalAfterMasterProgress(
        generation,
        commandGeneration,
        baselineTime,
        "preserve_buffered_start",
      );
    }
  }

  pause() {
    if (this.disposed) return;
    this.internalMasterPauseCommandGeneration = null;
    this.commandGeneration += 1;
    // 先提交意图再暂停媒体，原生 pause 事件同步重入时只能读到最新 paused 状态。
    this.applyEvent({ type: "pause_requested" });
    this.masterBackend?.pause();
    this.externalBackend?.pause();
    this.stopDriftSampling();
    this.clearBufferingObservation();
    this.clearExternalTimelineObservation();
  }

  setPlaybackRate(rate: number) {
    this.assertActive();
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("播放倍率必须是正数。");
    this.playbackRate = rate;
    this.masterBackend?.setPlaybackRate(rate);
    this.externalBackend?.setPlaybackRate(
      rate * this.externalPlaybackRateMultiplier,
    );
  }

  setVolume(volume: number) {
    this.assertActive();
    this.volume = normalizePlaybackVolume(volume);
    this.masterBackend?.setVolume(this.volume);
    this.externalBackend?.setVolume(this.volume);
  }

  setMuted(muted: boolean) {
    this.assertActive();
    this.userMuted = muted;
    this.applyOutputRouting();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateInterruptionRecovery();
    this.commandGeneration += 1;
    this.cancelExternalPreparation();
    this.disposeExternalBackend();
    this.stopDriftSampling();
    this.masterBackend?.dispose();
    this.masterBackend = null;
    this.applyEvent({ type: "dispose" });
  }

  private async prepareDesiredSource(
    source: ExternalAudioPlaybackSource,
    generation: number,
  ) {
    const abortController = new AbortController();
    this.prepareAbortController = abortController;
    const events = this.createExternalEvents(generation);
    try {
      const prepared = await this.prepareExternalBackend(source, {
        signal: abortController.signal,
        vodContainerId: this.options.vodContainerId,
        readVodMediaClock: this.options.readVodMediaClock,
        events,
      });
      if (!this.isCurrentSource(source, generation) || abortController.signal.aborted) {
        prepared.backend.dispose();
        return;
      }
      this.externalBackend = prepared.backend;
      prepared.backend.setPlaybackRate(this.playbackRate);
      prepared.backend.setVolume(this.volume);
      prepared.backend.setMuted(this.userMuted);
      if (!this.applyEvent({ type: "external_ready", generation })) return;
      if (this.state.desiredPlayback === "playing") {
        // 主视频可能正在随机 VOD seek 后等待分片；不能因外部音频先 ready 就让它抢跑。
        const commandGeneration = this.commandGeneration;
        await this.startExternalAfterMasterProgress(
          generation,
          commandGeneration,
          this.requireMasterBackend().getSnapshot().currentTime,
        );
      } else {
        await this.alignExternalToMaster(generation);
        if (!this.isCurrentSource(source, generation)) return;
        prepared.backend.pause();
        await this.primePausedExternal(
          generation,
        );
      }
    } catch (error) {
      if (
        abortController.signal.aborted ||
        error instanceof MediaPlaybackCommandCancelledError ||
        !this.isCurrentSource(source, generation)
      ) return;
      this.handleExternalFailure(
        generation,
        error instanceof Error ? error.message : "替换音轨准备失败。",
      );
    } finally {
      if (this.prepareAbortController === abortController) {
        this.prepareAbortController = null;
      }
    }
  }

  private startPreparation(
    source: ExternalAudioPlaybackSource,
    generation: number,
  ) {
    const preparation = this.prepareDesiredSource(source, generation);
    let tracked: Promise<void>;
    tracked = preparation.finally(() => {
      if (this.preparePromise === tracked) this.preparePromise = null;
    });
    this.preparePromise = tracked;
    return tracked;
  }

  private createExternalEvents(
    generation: number,
  ): ExternalAudioPlaybackBackendEvents {
    return {
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onBufferingChange: (buffering) => this.handleExternalBuffering(
        generation,
        buffering,
      ),
      onError: (message) => this.handleExternalFailure(generation, message),
    };
  }

  private async alignExternalToMaster(
    generation: number,
    mode: ExternalAlignmentMode = "always_seek",
  ): Promise<AlignmentResult> {
    const master = this.requireMasterBackend();
    const external = this.externalBackend;
    const source = this.desiredSource;
    if (!external || !source || generation !== this.state.sourceGeneration) {
      throw new MediaPlaybackCommandCancelledError("替换音轨已经变化。");
    }
    const externalDuration = external.getSnapshot().duration;
    const mapped = mapMasterTimeToAudioTime({
      masterTime: master.getSnapshot().currentTime,
      offsetSeconds: source.offsetSeconds,
      audioDuration: externalDuration > 0 ? externalDuration : null,
    });
    if (mapped.status === "invalid_time") {
      throw new Error("替换音轨时间映射无效。");
    }
    if (mapped.status !== "playable") {
      external.pause();
      this.setExternalPlaybackRateMultiplier(1);
      this.externalTimelinePosition = mapped.status;
      return mapped.status;
    }
    if (
      shouldPreserveExternalBuffer(
        resolveAlignmentModeForSource(mode, source),
        external.getSnapshot().currentTime,
        mapped.audioTime,
      )
    ) {
      // 随机 VOD 起播时主时钟只前进一个轮询窗口；为几十毫秒再次 seek 会清空刚准备好的 MP3 分片。
      // 150ms 内保留缓冲并交给速率伺服平滑追回，稳定播放后仍按 10ms 目标持续校正。
      this.setExternalPlaybackRateMultiplier(1);
      this.externalTimelinePosition = "playable";
      return "playable";
    }
    await external.seek(mapped.audioTime);
    this.externalTimelinePosition = "playable";
    return "playable";
  }

  private async resynchronizeExternal(
    generation: number,
    resumePlayback: boolean,
    alignmentMode: ExternalAlignmentMode = "always_seek",
  ) {
    if (generation !== this.state.sourceGeneration || !this.externalBackend) return false;
    const ownsResyncState = this.state.phase === "starting" ||
      this.state.phase === "resyncing" ||
      this.state.phase === "playing_synced";
    if (
      this.state.phase !== "resyncing" &&
      ownsResyncState &&
      !this.applyEvent({ type: "resync_required", generation })
    ) {
      return false;
    }
    const alignment = await this.alignExternalToMaster(generation, alignmentMode);
    if (generation !== this.state.sourceGeneration || !this.externalBackend) return false;
    // seek 等待期间用户可能主动暂停；这不是状态异常，也不能被迟到同步重新改为播放。
    if (ownsResyncState && this.state.phase !== "resyncing") return false;
    if (ownsResyncState && !this.applyEvent({ type: "resync_completed", generation })) {
      return false;
    }
    if (resumePlayback && this.state.desiredPlayback === "playing") {
      if (alignment === "playable") await this.externalBackend.play();
      if (!this.applyEvent({ type: "external_started", generation })) return false;
    }
    return true;
  }

  /**
   * 所有起播路径共用这一单飞门禁：先冻结从轨，确认 VOD 主时钟真实推进，再按最新主时间对齐并发声。
   * 固定等待几百毫秒无法覆盖不同网络和 CDN 缓冲；以 currentTime 前进作为事实才能同时兼容 HTTP IP 与 HTTPS。
   */
  private startExternalAfterMasterProgress(
    generation: number,
    commandGeneration: number,
    baselineTime: number,
    alignmentMode: ExternalAlignmentMode = "always_seek",
  ) {
    const existing = this.pendingExternalStart;
    if (
      existing?.commandGeneration === commandGeneration &&
      existing.sourceGeneration === generation
    ) {
      return existing.promise;
    }

    const master = this.masterBackend;
    const external = this.externalBackend;
    const source = this.desiredSource;
    if (
      !master ||
      !external ||
      !source ||
      !this.isCurrentCommand(commandGeneration) ||
      !this.isCurrentSource(source, generation)
    ) {
      return Promise.resolve(false);
    }

    external.pause();
    this.stopDriftSampling();
    if (
      this.state.phase !== "resyncing" &&
      !this.applyEvent({ type: "resync_required", generation })
    ) {
      return Promise.resolve(false);
    }

    const pending: PendingExternalStart = {
      commandGeneration,
      sourceGeneration: generation,
      promise: Promise.resolve(false),
    };
    pending.promise = this.waitForMasterProgress({
      baselineTime,
      readSnapshot: () => master.getSnapshot(),
      isCurrent: () =>
        this.masterBackend === master &&
        this.externalBackend === external &&
        this.isCurrentCommand(commandGeneration) &&
        this.isCurrentSource(source, generation) &&
        this.state.desiredPlayback === "playing" &&
        isExternalStartPhase(this.state.phase),
      })
      .then(async (progressed) => {
        if (!progressed) return false;
        const resolvedAlignmentMode = resolveAlignmentModeForSource(
          alignmentMode,
          source,
        );
        const completed = await this.resynchronizeExternal(
          generation,
          true,
          alignmentMode,
        );
        // 以真正完成 seek/play 的时刻开始计时，慢网络不能提前耗尽稳定窗口。
        if (completed && resolvedAlignmentMode === "precise_native_start") {
          this.beginNativeRenditionStabilization(source);
        }
        if (completed) this.startDriftSampling();
        return completed;
      })
      .finally(() => {
        if (this.pendingExternalStart === pending) {
          this.pendingExternalStart = null;
        }
      });
    this.pendingExternalStart = pending;
    return pending.promise;
  }

  /**
   * 原生播放器控件可能在暂停态 VOD 音频预热尚未结束时直接启动主视频。
   * 这里等待同一预热单飞，再从届时的主时钟建立起播门禁；旧播放命令不会在等待后复活。
   */
  private async startExternalAfterPrime(
    generation: number,
    commandGeneration: number,
    alignmentMode: ExternalAlignmentMode,
  ) {
    const pendingPrime = this.externalPrimePromise;
    if (pendingPrime) await pendingPrime;
    const master = this.masterBackend;
    const source = this.desiredSource;
    if (
      !master ||
      !source ||
      !this.isCurrentCommand(commandGeneration) ||
      !this.isCurrentSource(source, generation) ||
      this.state.desiredPlayback !== "playing"
    ) return false;
    const primedStartResult = await this.startPrimedRenditionWithMaster(
      generation,
      commandGeneration,
      true,
    );
    if (primedStartResult !== "not_applicable") {
      return primedStartResult === "completed";
    }
    return this.startExternalAfterMasterProgress(
      generation,
      commandGeneration,
      master.getSnapshot().currentTime,
      alignmentMode,
    );
  }

  /**
   * 已预热的 JobId MP3 与视频在同一阶段发出 play，并等待两个媒体时钟都真实推进后再放出声音。
   * 这里不替代通用起播门禁：只有来源、代次、暂停状态和预热位置全部匹配时才接管，否则由旧路径处理。
   */
  private async startPrimedRenditionWithMaster(
    generation: number,
    commandGeneration: number,
    masterAlreadyPlaying = false,
  ): Promise<PrimedRenditionStartResult> {
    const master = this.masterBackend;
    const external = this.externalBackend;
    const source = this.desiredSource;
    const primedPosition = this.primedExternalPosition;
    if (
      !master ||
      !external ||
      source?.type !== "aliyun_vod_rendition_audio" ||
      !primedPosition ||
      primedPosition.sourceGeneration !== generation ||
      !this.isCurrentCommand(commandGeneration) ||
      !this.isCurrentSource(source, generation)
    ) return "not_applicable";
    const masterSnapshot = master.getSnapshot();
    if (
      (masterAlreadyPlaying && (masterSnapshot.paused || masterSnapshot.ended)) ||
      (!masterAlreadyPlaying && !masterSnapshot.paused)
    ) return "not_applicable";

    const mapped = mapMasterTimeToAudioTime({
      masterTime: masterSnapshot.currentTime,
      offsetSeconds: source.offsetSeconds,
      audioDuration: external.getSnapshot().duration || null,
    });
    if (
      mapped.status !== "playable" ||
      Math.abs(primedPosition.audioTime - mapped.audioTime) >
        SYNCHRONIZED_AUDIO_DRIFT_POLICY.toleranceSeconds
    ) return "not_applicable";

    const masterBaselineTime = masterSnapshot.currentTime;
    const externalBaselineTime = external.getSnapshot().currentTime;
    external.setMuted(true);
    this.stopDriftSampling();

    const isCurrentStart = () =>
      this.masterBackend === master &&
      this.externalBackend === external &&
      this.isCurrentCommand(commandGeneration) &&
      this.isCurrentSource(source, generation) &&
      this.state.desiredPlayback === "playing" &&
      isExternalStartPhase(this.state.phase);

    try {
      // 命令式播放在同一微任务启动主从后端；原生控件已经启动主视频时只补启外轨，不能重复 play 主播放器。
      await Promise.all(masterAlreadyPlaying
        ? [external.play()]
        : [master.play(), external.play()]);
      if (this.internalMasterPauseCommandGeneration === commandGeneration) {
        this.internalMasterPauseCommandGeneration = null;
      }
      // 后发命令已经接管媒体时，旧任务必须保持惰性，不能反向暂停新命令正在启动的后端。
      if (!isCurrentStart()) return "cancelled";
      const [masterProgressed, externalProgressed] = await Promise.all([
        this.waitForMasterProgress({
          baselineTime: masterBaselineTime,
          readSnapshot: () => master.getSnapshot(),
          isCurrent: isCurrentStart,
        }),
        this.waitForMasterProgress({
          baselineTime: externalBaselineTime,
          readSnapshot: () => external.getSnapshot(),
          isCurrent: isCurrentStart,
        }),
      ]);
      if (!isCurrentStart()) return "cancelled";
      if (!masterProgressed || !externalProgressed) {
        this.handleExternalFailure(generation, "主视频与替换音轨未能完成同步起播。");
        return "cancelled";
      }
      if (!this.applyEvent({ type: "external_started", generation })) {
        this.handleExternalFailure(generation, "替换音轨同步状态异常，无法完成起播。");
        return "cancelled";
      }

      // 首个真实时钟样本立即参与 10ms 漂移策略，不再额外等待一个 100ms 采样周期。
      this.beginNativeRenditionStabilization(source);
      await this.sampleDrift();
      if (!isCurrentStart()) return "cancelled";
      external.setMuted(this.userMuted);
      this.startDriftSampling();
      return "completed";
    } catch (error) {
      if (!isCurrentStart()) return "cancelled";
      this.handleExternalFailure(
        generation,
        error instanceof Error ? error.message : "替换音轨同步起播失败。",
      );
      return "cancelled";
    }
  }

  /**
   * VOD 播放器和 JobId MP3 的第一次 play 都可能在 ready 后经历解码冷启动。暂停态先静音推进一个真实时钟刻度，
   * 随后暂停并精确回到目标位置，可把这段一次性延迟移到用户起播之前；普通上传音频保持现有轻量路径。
   */
  private primePausedExternal(generation: number) {
    const external = this.externalBackend;
    const source = this.desiredSource;
    const master = this.masterBackend;
    if (
      !external ||
      !source ||
      !master ||
      !supportsPausedExternalPrime(source) ||
      generation !== this.state.sourceGeneration
    ) return Promise.resolve();

    const mapped = mapMasterTimeToAudioTime({
      masterTime: master.getSnapshot().currentTime,
      offsetSeconds: source.offsetSeconds,
      audioDuration: external.getSnapshot().duration || null,
    });
    if (mapped.status !== "playable") return Promise.resolve();
    if (
      this.primedExternalPosition?.sourceGeneration === generation &&
      Math.abs(this.primedExternalPosition.audioTime - mapped.audioTime) <=
        SYNCHRONIZED_AUDIO_DRIFT_POLICY.toleranceSeconds
    ) return Promise.resolve();
    if (this.externalPrimePromise) return this.externalPrimePromise;

    const primeGeneration = this.externalPrimeGeneration;
    const targetAudioTime = mapped.audioTime;
    let tracked: Promise<void>;
    const prime = (async () => {
      this.externalPriming = true;
      external.setMuted(true);
      const baselineTime = external.getSnapshot().currentTime;
      await external.play();
      const progressed = await this.waitForMasterProgress({
        baselineTime,
        readSnapshot: () => external.getSnapshot(),
        isCurrent: () =>
          this.externalBackend === external &&
          this.isCurrentSource(source, generation) &&
          this.externalPrimeGeneration === primeGeneration,
      });
      if (!progressed || this.externalPrimeGeneration !== primeGeneration) return;

      // 回位必须仍属于同一来源和预热代次；随机 seek 或切轨后的旧任务不能覆盖新位置。
      external.pause();
      await external.seek(targetAudioTime);
      if (
        this.externalBackend === external &&
        this.isCurrentSource(source, generation) &&
        this.externalPrimeGeneration === primeGeneration
      ) {
        this.primedExternalPosition = { sourceGeneration: generation, audioTime: targetAudioTime };
      }
    })().finally(() => {
      if (this.externalPrimePromise !== tracked) return;
      this.externalPrimePromise = null;
      this.externalPriming = false;
      if (
        this.externalBackend === external &&
        this.isCurrentSource(source, generation) &&
        this.externalPrimeGeneration === primeGeneration
      ) {
        external.pause();
        external.setMuted(this.userMuted);
      }
    });
    tracked = prime;
    this.externalPrimePromise = tracked;
    return tracked;
  }

  /** seek、切轨和销毁只递增预热代次；正在轮询的旧任务会在下一拍自行退出。 */
  private invalidateExternalPrime() {
    this.externalPrimeGeneration += 1;
    this.primedExternalPosition = null;
  }

  private handleExternalBuffering(generation: number, buffering: boolean) {
    if (generation !== this.state.sourceGeneration || !this.externalBackend) return;
    if (this.externalPriming) return;
    // 主视频等待期间从轨由组合 owner 主动暂停；此时从轨的迟到 waiting/canplay 不得抢占恢复流程。
    if (this.state.phase === "buffering_master") return;
    if (buffering) {
      if (this.pendingExternalBufferingProbe || this.state.phase === "buffering_external") return;
      const external = this.externalBackend;
      const source = this.desiredSource;
      if (!source) return;
      const probe: PendingBufferingProbe = {
        baselineTime: external.getSnapshot().currentTime,
        cancel: () => undefined,
      };
      probe.cancel = this.scheduleBufferingProbe(() => {
        if (this.pendingExternalBufferingProbe !== probe) return;
        this.pendingExternalBufferingProbe = null;
        if (
          this.disposed ||
          this.externalBackend !== external ||
          !this.isCurrentSource(source, generation) ||
          this.state.desiredPlayback !== "playing" ||
          hasPlaybackClockProgressed(external.getSnapshot().currentTime, probe.baselineTime)
        ) return;
        if (!this.applyEvent({ type: "external_buffering", generation })) return;
        this.bufferingStartedAtMilliseconds = this.readDiagnosticNow();
        this.masterBackend?.pause();
        external.pause();
        this.stopDriftSampling();
        this.emitDiagnostic({
          kind: "buffering",
          phase: "started",
          durationMilliseconds: null,
        });
      }, BUFFERING_STALL_CONFIRMATION_MS);
      this.pendingExternalBufferingProbe = probe;
      return;
    }
    this.cancelExternalBufferingProbe();
    if (this.state.phase !== "buffering_external") return;
    const durationMilliseconds = this.consumeBufferingDuration();
    if (!this.applyEvent({ type: "external_recovered", generation })) return;
    this.emitDiagnostic({
      kind: "buffering",
      phase: "recovery_started",
      durationMilliseconds,
    });
    void this.recoverFromBuffering(generation, durationMilliseconds);
  }

  private async recoverFromBuffering(
    generation: number,
    durationMilliseconds: number,
  ) {
    try {
      if (this.state.desiredPlayback === "playing") {
        const master = this.requireMasterBackend();
        const commandGeneration = this.commandGeneration;
        const baselineTime = master.getSnapshot().currentTime;
        await master.play();
        if (!this.isCurrentCommand(commandGeneration)) return;
        await this.startExternalAfterMasterProgress(
          generation,
          commandGeneration,
          baselineTime,
        );
      } else {
        await this.resynchronizeExternal(generation, false);
      }
      if (generation === this.state.sourceGeneration) {
        this.emitDiagnostic({
          kind: "buffering",
          phase: "recovered",
          durationMilliseconds,
        });
      }
    } catch (error) {
      if (error instanceof MediaPlaybackCommandCancelledError) return;
      if (generation === this.state.sourceGeneration) {
        this.emitDiagnostic({
          kind: "buffering",
          phase: "failed",
          durationMilliseconds,
        });
      }
      this.handleExternalFailure(
        generation,
        error instanceof Error ? error.message : "替换音轨缓冲恢复失败。",
      );
    }
  }

  private startDriftSampling() {
    if (
      this.stopDriftSample ||
      !this.externalBackend ||
      !this.desiredSource ||
      this.state.desiredPlayback !== "playing"
    ) return;
    this.stopDriftSample = this.scheduleDriftSample(() => {
      void this.sampleDrift();
    }, DEFAULT_DRIFT_SAMPLE_INTERVAL_MS);
  }

  private stopDriftSampling() {
    this.stopDriftSample?.();
    this.stopDriftSample = null;
    this.driftSyncPromise = null;
    this.setExternalPlaybackRateMultiplier(1);
  }

  private async sampleDrift() {
    if (this.driftSyncPromise || !this.externalBackend || !this.desiredSource) return;
    const masterSnapshot = this.masterBackend?.getSnapshot();
    if (!masterSnapshot || masterSnapshot.paused || masterSnapshot.ended) return;
    const externalSnapshot = this.externalBackend.getSnapshot();
    const mapped = mapMasterTimeToAudioTime({
      masterTime: masterSnapshot.currentTime,
      offsetSeconds: this.desiredSource.offsetSeconds,
      audioDuration: externalSnapshot.duration > 0 ? externalSnapshot.duration : null,
    });
    if (mapped.status === "invalid_time") {
      if (this.externalTimelinePosition !== "invalid_time") {
        this.externalBackend.pause();
      }
      this.externalTimelinePosition = "invalid_time";
      this.setExternalPlaybackRateMultiplier(1);
      return;
    }
    if (mapped.status !== "playable") {
      // 主视频继续前进时只在首次跨入边界执行 pause，避免每 300 ms 重复写媒体元素。
      if (this.externalTimelinePosition !== mapped.status) {
        this.externalBackend.pause();
      }
      this.externalTimelinePosition = mapped.status;
      this.setExternalPlaybackRateMultiplier(1);
      return;
    }
    this.externalTimelinePosition = "playable";
    const decision = classifyExternalAudioDrift({
      actualAudioTime: externalSnapshot.currentTime,
      expectedAudioTime: mapped.audioTime,
      forceHardResync: externalSnapshot.paused,
      hardResyncSeconds: this.getCurrentHardResyncThreshold(),
    });
    if (decision.action === "within_tolerance") {
      this.setExternalPlaybackRateMultiplier(1);
      return;
    }
    if (decision.action === "adjust_rate") {
      this.setExternalPlaybackRateMultiplier(decision.playbackRateMultiplier);
      return;
    }
    if (decision.action !== "hard_resync") return;
    this.setExternalPlaybackRateMultiplier(1);
    const driftMilliseconds = normalizeDiagnosticDriftMilliseconds(
      decision.driftSeconds,
    );
    // classify 已证明 drift 为有限值；这里保留 fail-closed 防线，避免诊断异常反向影响播放。
    if (driftMilliseconds === null) return;
    const generation = this.state.sourceGeneration;
    const diagnosticFacts = {
      reason: decision.reason,
      driftMilliseconds,
    } as const;
    const synchronization = this.resynchronizeExternal(generation, true)
      .then((completed) => {
        if (
          !completed ||
          generation !== this.state.sourceGeneration ||
          !this.desiredSource
        ) return;
        // 以硬同步真正完成的时刻重新开启稳定窗口，避免 seek 自身的等待吞掉恢复预算。
        this.beginNativeRenditionStabilization(this.desiredSource);
        this.emitDiagnostic({
          kind: "drift_resync",
          phase: "succeeded",
          ...diagnosticFacts,
        });
      })
      .catch((error) => {
        if (!(error instanceof MediaPlaybackCommandCancelledError)) {
          if (generation === this.state.sourceGeneration && this.desiredSource) {
            this.emitDiagnostic({
              kind: "drift_resync",
              phase: "failed",
              ...diagnosticFacts,
            });
          }
          this.handleExternalFailure(
            generation,
            error instanceof Error ? error.message : "替换音轨重新同步失败。",
          );
        }
      })
      .finally(() => {
        if (this.driftSyncPromise === synchronization) this.driftSyncPromise = null;
      });
    this.driftSyncPromise = synchronization;
    // 先占住 single-flight，再通知旁路观察者；诊断 callback 不能重入并启动第二次同步。
    this.emitDiagnostic({
      kind: "drift_resync",
      phase: "started",
      ...diagnosticFacts,
    });
    await synchronization;
  }

  private handleExternalFailure(generation: number, message: string) {
    if (generation !== this.state.sourceGeneration || !this.desiredSource) return;
    this.applyEvent({
      type: "external_failed",
      generation,
      errorCode: "external_audio_failed",
    });
    this.options.onError?.(message || "替换音轨播放失败。");
    // 科研试听不能静默换回原声；失败后暂停并保持主轨静音，等待用户重试或显式切回。
    this.masterBackend?.pause();
    this.masterBackend?.setMuted(true);
    this.stopDriftSampling();
    this.disposeExternalBackend();
  }

  /** 中等漂移只调节从音轨；视频主时钟和用户选择的基础倍率始终保持不变。 */
  private setExternalPlaybackRateMultiplier(multiplier: number) {
    if (!Number.isFinite(multiplier) || multiplier <= 0) return;
    if (Math.abs(multiplier - this.externalPlaybackRateMultiplier) < 1e-6) return;
    this.externalPlaybackRateMultiplier = multiplier;
    this.externalBackend?.setPlaybackRate(this.playbackRate * multiplier);
  }

  /**
   * JobId MP3 与视频使用两个浏览器媒体时钟。随机起播或一次硬 seek 后，audio 解码器可能落后约数百毫秒；
   * 若立刻沿用 150ms 门槛，会由“seek -> 冷停 -> 再 seek”形成可听卡顿。窗口内仍以 10ms 为目标，
   * 只是把不超过 500ms 的启动滞后交给最大 4% 的既有倍率伺服平滑追回。
   */
  private beginNativeRenditionStabilization(
    source: ExternalAudioPlaybackSource | null,
  ) {
    if (source?.type !== "aliyun_vod_rendition_audio") return;
    this.nativeRenditionStabilizationUntilMilliseconds =
      this.now() + NATIVE_RENDITION_STABILIZATION_MS;
  }

  private getCurrentHardResyncThreshold() {
    return this.desiredSource?.type === "aliyun_vod_rendition_audio" &&
        this.now() < this.nativeRenditionStabilizationUntilMilliseconds
      ? NATIVE_RENDITION_STABILIZATION_HARD_RESYNC_SECONDS
      : SYNCHRONIZED_AUDIO_DRIFT_POLICY.hardResyncSeconds;
  }

  private enterUnavailableSelection(trackId: string, errorCode: string) {
    this.desiredSource = null;
    this.cancelExternalPreparation();
    this.stopDriftSampling();
    this.disposeExternalBackend();
    this.masterBackend?.pause();
    this.masterBackend?.setMuted(true);
    this.applyEvent({ type: "select_unavailable", trackId, errorCode });
  }

  private enterBlockedSelection(errorCode: string) {
    this.desiredSource = null;
    this.cancelExternalPreparation();
    this.stopDriftSampling();
    this.disposeExternalBackend();
    this.masterBackend?.pause();
    this.masterBackend?.setMuted(true);
    this.applyEvent({ type: "suspend_selection", errorCode });
  }

  private activateOriginal(desiredPlayback?: boolean) {
    const master = this.masterBackend;
    const shouldPlay = desiredPlayback ?? Boolean(master && !master.getSnapshot().paused);
    this.desiredSource = null;
    this.cancelExternalPreparation();
    this.stopDriftSampling();
    // 恢复主输出必须先于销毁从轨，切回原声不会产生额外无声窗口。
    master?.setVolume(this.volume);
    master?.setMuted(this.userMuted);
    this.disposeExternalBackend();
    this.applyEvent({
      type: "select_original",
      desiredPlayback: shouldPlay ? "playing" : "paused",
    });
    if (shouldPlay && master?.getSnapshot().paused) {
      void master.play().catch(() => {
        this.options.onError?.("恢复视频原声播放失败。");
      });
    }
  }

  private applyOutputRouting() {
    // 只要不在原声态，主媒体就必须保持静音；选项加载失败没有 trackId，也不能意外放出原声。
    if (this.state.phase !== "original") {
      this.masterBackend?.setMuted(true);
      this.externalBackend?.setMuted(this.userMuted);
      return;
    }
    this.masterBackend?.setMuted(this.userMuted);
  }

  private cancelExternalPreparation() {
    this.prepareAbortController?.abort();
    this.prepareAbortController = null;
    this.preparePromise = null;
  }

  private disposeExternalBackend() {
    const backend = this.externalBackend;
    this.invalidateExternalPrime();
    this.externalBackend = null;
    this.externalPrimePromise = null;
    this.externalPriming = false;
    this.primedExternalPosition = null;
    this.nativeRenditionStabilizationUntilMilliseconds = 0;
    this.clearBufferingObservation();
    this.clearExternalTimelineObservation();
    backend?.pause();
    backend?.dispose();
  }

  private consumeBufferingDuration() {
    const startedAt = this.bufferingStartedAtMilliseconds;
    this.bufferingStartedAtMilliseconds = null;
    const duration = startedAt === null
      ? null
      : normalizeBufferingDurationMilliseconds(
          (this.readDiagnosticNow() ?? startedAt) - startedAt,
        );
    // 单调时钟失效时使用零作为有限诊断事实；播放恢复本身不依赖这个旁路测量。
    return duration ?? 0;
  }

  private clearBufferingObservation() {
    this.cancelMasterBufferingProbe();
    this.cancelExternalBufferingProbe();
    this.bufferingStartedAtMilliseconds = null;
  }

  private cancelMasterBufferingProbe() {
    this.pendingMasterBufferingProbe?.cancel();
    this.pendingMasterBufferingProbe = null;
  }

  private cancelExternalBufferingProbe() {
    this.pendingExternalBufferingProbe?.cancel();
    this.pendingExternalBufferingProbe = null;
  }

  private clearExternalTimelineObservation() {
    this.externalTimelinePosition = null;
  }

  private readDiagnosticNow() {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  private emitDiagnostic(diagnostic: SynchronizedPlaybackDiagnostic) {
    try {
      this.options.onDiagnostic?.(diagnostic);
    } catch {
      // 诊断消费者是旁路观察者；UI 或测试 callback 失败不能中断媒体播放状态机。
    }
  }

  private applyEvent(event: SynchronizedPlaybackEvent) {
    const transition = reduceSynchronizedPlaybackState(this.state, event);
    if (transition.status === "stale_event") return false;
    if (transition.status === "invalid_transition") {
      this.options.onError?.("替换音轨同步状态异常，已保留当前安全状态。");
      return false;
    }
    this.state = transition.state;
    this.options.onStateChange?.(this.state);
    return true;
  }

  private resetStateForMaster() {
    this.internalMasterPauseCommandGeneration = null;
    this.state = {
      ...INITIAL_SYNCHRONIZED_PLAYBACK_STATE,
      sourceGeneration: this.state.sourceGeneration + 1,
    };
    this.options.onStateChange?.(this.state);
  }

  /** 主来源替换和卸载共用同一资源释放边界，attach 只在新来源安装后广播一次重置状态。 */
  private releaseMediaSession(resetState: boolean) {
    // 旧页面恢复任务不能阻塞新媒体会话；其异步结果仍靠 generation 和 backend 身份双重隔离。
    this.invalidateInterruptionRecovery();
    const hasSession = Boolean(
      this.masterBackend ||
      this.desiredSource ||
      this.externalBackend ||
      this.prepareAbortController ||
      this.preparePromise,
    );
    if (!hasSession) return;
    this.commandGeneration += 1;
    this.internalMasterPauseCommandGeneration = null;
    this.desiredSource = null;
    this.cancelExternalPreparation();
    this.disposeExternalBackend();
    this.stopDriftSampling();
    const master = this.masterBackend;
    this.masterBackend = null;
    master?.dispose();
    if (resetState && !this.disposed) this.resetStateForMaster();
  }

  private isCurrentSource(source: ExternalAudioPlaybackSource, generation: number) {
    return !this.disposed &&
      this.desiredSource === source &&
      this.state.sourceGeneration === generation;
  }

  /** 暂停主时钟但保留播放意图；只允许同一 command generation 的 pause 事件被识别为内部动作。 */
  private pauseMasterForSynchronization(
    master: MediaPlaybackBackend,
    commandGeneration: number,
  ) {
    if (master.getSnapshot().paused) return;
    this.internalMasterPauseCommandGeneration = commandGeneration;
    master.pause();
  }

  private isCurrentCommand(generation: number) {
    return !this.disposed && generation === this.commandGeneration;
  }

  private invalidateInterruptionRecovery() {
    this.interruptionRecoveryGeneration += 1;
    this.interruptionRecoveryPromise = null;
  }

  private isCurrentInterruptionRecovery(generation: number) {
    return !this.disposed && generation === this.interruptionRecoveryGeneration;
  }

  private requireMasterBackend() {
    this.assertActive();
    if (!this.masterBackend) throw new Error("主媒体尚未准备完成。");
    return this.masterBackend;
  }

  private assertActive() {
    if (this.disposed) throw new Error("组合播放器已经销毁。");
  }
}

function defaultScheduleDriftSample(callback: () => void, delayMs: number) {
  const timer = globalThis.setInterval(callback, delayMs);
  return () => globalThis.clearInterval(timer);
}

function defaultScheduleBufferingProbe(callback: () => void, delayMs: number) {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function hasPlaybackClockProgressed(currentTime: number, baselineTime: number) {
  return Number.isFinite(currentTime) &&
    Number.isFinite(baselineTime) &&
    currentTime - baselineTime >= BUFFERING_CLOCK_PROGRESS_SECONDS;
}

function shouldPreserveExternalBuffer(
  mode: ExternalAlignmentMode,
  actualAudioTime: number,
  expectedAudioTime: number,
) {
  if (mode === "always_seek") return false;
  if (mode === "skip_seek_within_tolerance") {
    return isExternalAudioWithinSyncTolerance({
      actualAudioTime,
      expectedAudioTime,
    });
  }
  if (mode === "precise_native_start") {
    return Number.isFinite(actualAudioTime) &&
      Number.isFinite(expectedAudioTime) &&
      Math.abs(actualAudioTime - expectedAudioTime) <=
        PRECISE_NATIVE_START_EPSILON_SECONDS;
  }
  if (
    !Number.isFinite(actualAudioTime) ||
    !Number.isFinite(expectedAudioTime)
  ) {
    return false;
  }
  return Math.abs(actualAudioTime - expectedAudioTime) <=
    SYNCHRONIZED_AUDIO_DRIFT_POLICY.hardResyncSeconds;
}

/**
 * 150ms 起播免 seek 只服务 vid + PlayAuth 的隐藏 Aliplayer；原生音频能够精确 Range seek，
 * 若沿用该窗口会先制造可听偏差，再被 10ms 漂移策略硬同步成周期卡顿。
 */
function resolveAlignmentModeForSource(
  mode: ExternalAlignmentMode,
  source: ExternalAudioPlaybackSource,
): ExternalAlignmentMode {
  return mode === "preserve_buffered_start" && source.type !== "aliyun_vod_audio"
    ? "precise_native_start"
    : mode;
}

/** 只预热两类远端 VOD 音频；上传音频无需为了冷启动额外执行一次静音播放。 */
function supportsPausedExternalPrime(source: ExternalAudioPlaybackSource) {
  return source.type === "aliyun_vod_audio" ||
    source.type === "aliyun_vod_rendition_audio";
}

function isExternalStartPhase(phase: SynchronizedPlaybackState["phase"]) {
  return phase === "starting" ||
    phase === "resyncing" ||
    phase === "playing_synced";
}

function getMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
