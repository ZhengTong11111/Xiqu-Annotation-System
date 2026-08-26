import {
  EMPTY_DRIFT_OBSERVATION,
  classifyExternalAudioDrift,
  mapMasterTimeToAudioTime,
  type DriftObservationState,
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

const DEFAULT_DRIFT_SAMPLE_INTERVAL_MS = 300;

export type SynchronizedMediaPlaybackRuntimeOptions = {
  vodContainerId: string;
  prepareExternalBackend?: PrepareExternalAudioPlaybackBackend;
  scheduleDriftSample?: (callback: () => void, delayMs: number) => () => void;
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
  private stopDriftSample: (() => void) | null = null;
  private driftSyncPromise: Promise<void> | null = null;
  private driftObservation: DriftObservationState = EMPTY_DRIFT_OBSERVATION;
  private externalTimelinePosition: ExternalTimelineObservation | null = null;
  private bufferingStartedAtMilliseconds: number | null = null;
  private state: SynchronizedPlaybackState = { ...INITIAL_SYNCHRONIZED_PLAYBACK_STATE };
  private commandGeneration = 0;
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

  constructor(private readonly options: SynchronizedMediaPlaybackRuntimeOptions) {
    this.prepareExternalBackend = options.prepareExternalBackend ??
      prepareExternalAudioPlaybackBackend;
    this.scheduleDriftSample = options.scheduleDriftSample ?? defaultScheduleDriftSample;
    this.now = options.now ?? getMonotonicNow;
  }

  getSnapshot() {
    return this.masterBackend?.getSnapshot() ?? {
      ready: false,
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
    };
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
      if (this.state.phase === "error_external") {
        this.masterBackend.pause();
        return false;
      }
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
        void this.resynchronizeExternal(generation, true).catch((error) => {
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

    // buffering 为同步 owner 主动暂停主视频，不能被误写成用户取消播放。
    if (this.state.phase === "buffering_external") return false;
    if (
      this.state.desiredPlayback === "paused" &&
      (this.state.phase === "original" ||
        this.state.phase === "ready_paused" ||
        this.state.phase === "error_external")
    ) return false;
    this.applyEvent({ type: "pause_requested" });
    this.externalBackend?.pause();
    this.stopDriftSampling();
    this.clearExternalTimelineObservation();
    if (masterSnapshot.ended) this.clearBufferingObservation();
    return false;
  }

  async selectAudio(selection: SynchronizedAudioSelection) {
    this.assertActive();
    if (selection.type === "original") {
      if (this.state.phase === "original" && !this.desiredSource) return;
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
    this.commandGeneration += 1;
    this.desiredSource = source;
    this.cancelExternalPreparation();
    this.disposeExternalBackend();
    this.stopDriftSampling();
    this.driftObservation = EMPTY_DRIFT_OBSERVATION;
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
    await master.seek(time);
    if (!this.isCurrentCommand(commandGeneration)) return;
    const generation = this.state.sourceGeneration;
    if (!this.externalBackend || !this.desiredSource) return;
    await this.resynchronizeExternal(generation, !master.getSnapshot().paused);
  }

  async play() {
    const master = this.requireMasterBackend();
    if (this.state.phase === "error_external") {
      throw new Error("当前监听音轨不可用，请重试或切回视频原声。");
    }
    const commandGeneration = ++this.commandGeneration;
    this.applyEvent({ type: "play_requested" });
    await master.play();
    if (!this.isCurrentCommand(commandGeneration)) {
      master.pause();
      return;
    }
    const generation = this.state.sourceGeneration;
    if (this.externalBackend && this.desiredSource) {
      await this.resynchronizeExternal(generation, true);
    }
    this.startDriftSampling();
  }

  pause() {
    if (this.disposed) return;
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
    this.externalBackend?.setPlaybackRate(rate);
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
      const alignment = await this.alignExternalToMaster(generation);
      if (!this.isCurrentSource(source, generation)) return;
      if (this.state.desiredPlayback === "playing") {
        if (alignment === "playable") await prepared.backend.play();
        this.applyEvent({ type: "external_started", generation });
        this.startDriftSampling();
      } else {
        prepared.backend.pause();
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

  private async alignExternalToMaster(generation: number): Promise<AlignmentResult> {
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
      this.driftObservation = EMPTY_DRIFT_OBSERVATION;
      this.externalTimelinePosition = mapped.status;
      return mapped.status;
    }
    await external.seek(mapped.audioTime);
    this.externalTimelinePosition = "playable";
    return "playable";
  }

  private async resynchronizeExternal(generation: number, resumePlayback: boolean) {
    if (generation !== this.state.sourceGeneration || !this.externalBackend) return false;
    const canEnterResync = this.state.phase === "starting" ||
      this.state.phase === "playing_synced";
    if (canEnterResync && !this.applyEvent({ type: "resync_required", generation })) {
      return false;
    }
    const alignment = await this.alignExternalToMaster(generation);
    if (generation !== this.state.sourceGeneration || !this.externalBackend) return false;
    // seek 等待期间用户可能主动暂停；这不是状态异常，也不能被迟到同步重新改为播放。
    if (canEnterResync && this.state.phase !== "resyncing") return false;
    if (canEnterResync && !this.applyEvent({ type: "resync_completed", generation })) {
      return false;
    }
    if (resumePlayback && this.state.desiredPlayback === "playing") {
      if (alignment === "playable") await this.externalBackend.play();
      if (!this.applyEvent({ type: "external_started", generation })) return false;
    }
    return true;
  }

  private handleExternalBuffering(generation: number, buffering: boolean) {
    if (generation !== this.state.sourceGeneration || !this.externalBackend) return;
    if (buffering) {
      const alreadyBuffering = this.state.phase === "buffering_external";
      if (!this.applyEvent({ type: "external_buffering", generation })) return;
      if (!alreadyBuffering) {
        this.bufferingStartedAtMilliseconds = this.readDiagnosticNow();
      }
      this.masterBackend?.pause();
      this.externalBackend.pause();
      this.stopDriftSampling();
      if (!alreadyBuffering) {
        this.emitDiagnostic({
          kind: "buffering",
          phase: "started",
          durationMilliseconds: null,
        });
      }
      return;
    }
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
      const alignment = await this.alignExternalToMaster(generation);
      if (generation !== this.state.sourceGeneration) return;
      // 用户可以在 seek 等待期间暂停；迟到恢复应静默结束，不能制造错误或恢复播放。
      if (this.state.phase !== "resyncing") return;
      if (!this.applyEvent({ type: "resync_completed", generation })) return;
      if (this.state.desiredPlayback === "playing") {
        await this.masterBackend?.play();
        if (alignment === "playable") await this.externalBackend?.play();
        this.applyEvent({ type: "external_started", generation });
        this.startDriftSampling();
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
    this.driftObservation = EMPTY_DRIFT_OBSERVATION;
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
      this.driftObservation = EMPTY_DRIFT_OBSERVATION;
      return;
    }
    if (mapped.status !== "playable") {
      // 主视频继续前进时只在首次跨入边界执行 pause，避免每 300 ms 重复写媒体元素。
      if (this.externalTimelinePosition !== mapped.status) {
        this.externalBackend.pause();
      }
      this.externalTimelinePosition = mapped.status;
      this.driftObservation = EMPTY_DRIFT_OBSERVATION;
      return;
    }
    this.externalTimelinePosition = "playable";
    const decision = classifyExternalAudioDrift({
      actualAudioTime: externalSnapshot.currentTime,
      expectedAudioTime: mapped.audioTime,
      previousObservation: this.driftObservation,
      forceHardResync: externalSnapshot.paused,
    });
    this.driftObservation = decision.nextObservation;
    if (decision.action !== "hard_resync") return;
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
    this.externalBackend = null;
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
    this.bufferingStartedAtMilliseconds = null;
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
    this.state = {
      ...INITIAL_SYNCHRONIZED_PLAYBACK_STATE,
      sourceGeneration: this.state.sourceGeneration + 1,
    };
    this.options.onStateChange?.(this.state);
  }

  /** 主来源替换和卸载共用同一资源释放边界，attach 只在新来源安装后广播一次重置状态。 */
  private releaseMediaSession(resetState: boolean) {
    const hasSession = Boolean(
      this.masterBackend ||
      this.desiredSource ||
      this.externalBackend ||
      this.prepareAbortController ||
      this.preparePromise,
    );
    if (!hasSession) return;
    this.commandGeneration += 1;
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

  private isCurrentCommand(generation: number) {
    return !this.disposed && generation === this.commandGeneration;
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

function getMonotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}
