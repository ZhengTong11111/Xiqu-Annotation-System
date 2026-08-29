import assert from "node:assert/strict";
import test from "node:test";
import {
  MediaPlaybackCommandCancelledError,
  type MediaPlaybackBackend,
  type MediaPlaybackSnapshot,
} from "./mediaPlaybackController";
import type {
  ExternalAudioPlaybackBackendEvents,
  ExternalAudioPlaybackSource,
  PrepareExternalAudioPlaybackBackend,
} from "./externalAudioPlaybackBackendFactory";
import type { SynchronizedPlaybackDiagnostic } from "./synchronizedPlaybackDiagnostic";
import {
  createPlaybackClockProgressWaiter,
  type WaitForPlaybackClockProgress,
} from "./playbackClockProgress";
import { SynchronizedMediaPlaybackRuntime } from "./synchronizedMediaPlaybackRuntime";

class FakeBackend implements MediaPlaybackBackend {
  snapshot: MediaPlaybackSnapshot;
  seekTargets: number[] = [];
  playCount = 0;
  pauseCount = 0;
  disposeCount = 0;
  playbackRate = 1;
  volume = 0.5;
  muted = false;
  seekBlocker: Promise<void> | null = null;
  seekError: Error | null = null;
  recoverBlocker: Promise<void> | null = null;
  recoverCount = 0;
  playStateListener: ((playing: boolean) => void) | null = null;

  constructor(snapshot: Partial<MediaPlaybackSnapshot> = {}) {
    this.snapshot = {
      ready: true,
      currentTime: 0,
      duration: 120,
      paused: true,
      ended: false,
      ...snapshot,
    };
  }

  getSnapshot() { return { ...this.snapshot }; }
  async seek(time: number) {
    this.seekTargets.push(time);
    if (this.seekBlocker) await this.seekBlocker;
    if (this.seekError) throw this.seekError;
    this.snapshot.currentTime = time;
  }
  async play() {
    this.playCount += 1;
    this.snapshot.paused = false;
    this.snapshot.ended = false;
    this.playStateListener?.(true);
  }
  pause() {
    this.pauseCount += 1;
    this.snapshot.paused = true;
    this.playStateListener?.(false);
  }
  setPlaybackRate(rate: number) { this.playbackRate = rate; }
  setVolume(volume: number) { this.volume = volume; }
  setMuted(muted: boolean) { this.muted = muted; }
  async recoverAfterInterruption() {
    this.recoverCount += 1;
    if (this.recoverBlocker) await this.recoverBlocker;
  }
  dispose() { this.disposeCount += 1; }
}

type PendingPreparation = {
  signal: AbortSignal;
  events: ExternalAudioPlaybackBackendEvents;
  resolve: (backend: FakeBackend) => void;
  reject: (error: Error) => void;
};

function createHarness(options: {
  diagnosticThrows?: boolean;
  waitForMasterProgress?: WaitForPlaybackClockProgress;
} = {}) {
  const pending = new Map<string, PendingPreparation>();
  const prepareCounts = new Map<string, number>();
  const driftCallbacks: Array<() => void> = [];
  const stoppedDriftCallbacks = new Set<() => void>();
  const bufferingProbeCallbacks: Array<() => void> = [];
  const errors: string[] = [];
  const diagnostics: SynchronizedPlaybackDiagnostic[] = [];
  let nowMilliseconds = 0;
  const prepare: PrepareExternalAudioPlaybackBackend = (source, options) =>
    new Promise((resolve, reject) => {
      prepareCounts.set(source.trackId, (prepareCounts.get(source.trackId) ?? 0) + 1);
      const rejectCancelled = () => reject(
        new MediaPlaybackCommandCancelledError("测试来源已取消。"),
      );
      options.signal.addEventListener("abort", rejectCancelled, { once: true });
      pending.set(source.trackId, {
        signal: options.signal,
        events: options.events,
        resolve: (backend) => {
          options.signal.removeEventListener("abort", rejectCancelled);
          resolve({ backend, readySnapshot: backend.getSnapshot() });
        },
        reject: (error) => {
          options.signal.removeEventListener("abort", rejectCancelled);
          reject(error);
        },
      });
    });
  const runtime = new SynchronizedMediaPlaybackRuntime({
    vodContainerId: "audio-vod-host",
    prepareExternalBackend: prepare,
    scheduleDriftSample: (callback) => {
      driftCallbacks.push(callback);
      return () => stoppedDriftCallbacks.add(callback);
    },
    scheduleBufferingProbe: (callback) => {
      bufferingProbeCallbacks.push(callback);
      return () => {
        const index = bufferingProbeCallbacks.indexOf(callback);
        if (index >= 0) bufferingProbeCallbacks.splice(index, 1);
      };
    },
    // 既有 runtime 用例聚焦同步状态与命令合同；真实时钟等待由下方专项用例独立驱动。
    waitForMasterProgress: options.waitForMasterProgress ?? (async () => true),
    now: () => nowMilliseconds,
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
      if (options.diagnosticThrows) throw new Error("测试诊断消费者失败");
    },
    onError: (message) => errors.push(message),
  });
  return {
    runtime,
    pending,
    prepareCounts,
    driftCallbacks,
    stoppedDriftCallbacks,
    errors,
    diagnostics,
    runBufferingProbe: () => bufferingProbeCallbacks.shift()?.(),
    setNow: (value: number) => {
      nowMilliseconds = value;
    },
  };
}

const source = (
  trackId: string,
  offsetSeconds = 0,
): ExternalAudioPlaybackSource => ({
  type: "uploaded_audio",
  trackId,
  audioMediaResourceId: `media-${trackId}`,
  offsetSeconds,
  load: async () => ({ url: "unused", mimeType: "audio/mpeg", duration: 120 }),
});

const vodAudioSource = (
  trackId: string,
  offsetSeconds = 0,
): ExternalAudioPlaybackSource => ({
  type: "aliyun_vod_audio",
  trackId,
  audioMediaResourceId: `media-${trackId}`,
  offsetSeconds,
  // 组合运行时测试在 prepare 边界注入 fake backend，不会越界请求真实 VOD 会话。
  loadSession: async () => {
    throw new Error("组合运行时测试不应直接加载 VOD 会话。");
  },
});

const vodRenditionSource = (
  trackId: string,
  offsetSeconds = 0,
): ExternalAudioPlaybackSource => ({
  type: "aliyun_vod_rendition_audio",
  trackId,
  audioMediaResourceId: `media-${trackId}`,
  renditionJobId: `job-${trackId}`,
  offsetSeconds,
  // 组合运行时测试在 prepare 边界注入 fake backend，不会请求真实签名 URL。
  loadSession: async () => {
    throw new Error("组合运行时测试不应直接加载 VOD 转码会话。");
  },
});

const externalSelection = (value: ExternalAudioPlaybackSource) => ({
  type: "external" as const,
  source: value,
});

test("主时钟推进等待器不会把已接受播放误判为真实起播", async () => {
  const scheduledChecks: Array<() => void> = [];
  const snapshot: MediaPlaybackSnapshot = {
    ready: true,
    currentTime: 106.95,
    duration: 1_494,
    paused: false,
    ended: false,
  };
  const waiter = createPlaybackClockProgressWaiter((callback) => {
    scheduledChecks.push(callback);
    return () => undefined;
  });
  let settled = false;
  const waiting = waiter({
    baselineTime: snapshot.currentTime,
    readSnapshot: () => ({ ...snapshot }),
    isCurrent: () => true,
  }).then((result) => {
    settled = true;
    return result;
  });

  scheduledChecks.shift()?.();
  await flushAsyncWork();
  assert.equal(settled, false);

  snapshot.currentTime += 0.004;
  scheduledChecks.shift()?.();
  assert.equal(await waiting, true);
});

test("暂停态 VOD 音轨静音预热一个真实时钟刻度后精确回位", async () => {
  const progressWaits: Array<{
    input: Parameters<WaitForPlaybackClockProgress>[0];
    resolve: (value: boolean) => void;
  }> = [];
  const harness = createHarness({
    waitForMasterProgress: (input) => new Promise((resolve) => {
      progressWaits.push({ input, resolve });
    }),
  });
  const master = new FakeBackend({ currentTime: 62, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(vodAudioSource("vod-prime")),
  );
  const external = new FakeBackend({ currentTime: 0, duration: 180 });
  harness.pending.get("vod-prime")?.resolve(external);
  await flushAsyncWork();

  assert.equal(external.playCount, 1);
  assert.equal(external.muted, true);
  assert.equal(progressWaits.length, 1);
  external.snapshot.currentTime = 62.02;
  const primeProgress = progressWaits.shift();
  primeProgress?.resolve(primeProgress.input.isCurrent());
  await selecting;

  assert.equal(external.snapshot.paused, true);
  assert.equal(external.muted, false);
  assert.deepEqual(external.seekTargets, [62, 62]);
  assert.equal(harness.runtime.getState().phase, "ready_paused");
});

test("JobId MP3 预热后与主视频并发起播且不追加冷启动 seek", async () => {
  const progressWaits: Array<{
    input: Parameters<WaitForPlaybackClockProgress>[0];
    resolve: (value: boolean) => void;
  }> = [];
  const harness = createHarness({
    waitForMasterProgress: (input) => new Promise((resolve) => {
      progressWaits.push({ input, resolve });
    }),
  });
  const master = new FakeBackend({ currentTime: 40, paused: true });
  harness.runtime.attachMasterBackend(master);
  master.playStateListener = (playing) =>
    harness.runtime.notifyMasterPlaybackState(playing);
  const selecting = harness.runtime.selectAudio(
    externalSelection(vodRenditionSource("rendition-prime")),
  );
  const external = new FakeBackend({ currentTime: 0, duration: 190 });
  harness.pending.get("rendition-prime")?.resolve(external);
  await flushAsyncWork();

  // 首次 play 只在静音预热中发生，视频尚未启动；时钟推进后音频会精确回到 40 秒。
  assert.equal(master.playCount, 0);
  assert.equal(external.playCount, 1);
  assert.equal(external.muted, true);
  external.snapshot.currentTime = 40.02;
  const primeProgress = progressWaits.shift();
  primeProgress?.resolve(primeProgress.input.isCurrent());
  await selecting;
  assert.deepEqual(external.seekTargets, [40, 40]);
  assert.equal(external.snapshot.paused, true);

  const playing = harness.runtime.play();
  await flushAsyncWork();
  assert.equal(master.playCount, 1);
  assert.equal(external.playCount, 2);
  assert.equal(external.muted, true);
  assert.equal(progressWaits.length, 2);

  master.snapshot.currentTime = 40.02;
  external.snapshot.currentTime = 40.02;
  for (const progress of progressWaits.splice(0)) {
    progress.resolve(progress.input.isCurrent());
  }
  await playing;

  // 并发起播复用预热后的 Range/解码状态，不在视频推进后再执行第三次 seek。
  assert.deepEqual(external.seekTargets, [40, 40]);
  assert.equal(external.muted, false);
  assert.equal(external.playbackRate, 1);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("播放中的 JobId MP3 随机 seek 会冻结视频并在目标预热后恢复", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: true });
  harness.runtime.attachMasterBackend(master);
  master.playStateListener = (playing) =>
    harness.runtime.notifyMasterPlaybackState(playing);
  const selecting = harness.runtime.selectAudio(
    externalSelection(vodRenditionSource("rendition-seek-prime")),
  );
  const external = new FakeBackend({ currentTime: 0, duration: 190 });
  harness.pending.get("rendition-seek-prime")?.resolve(external);
  await selecting;
  await harness.runtime.play();

  master.pauseCount = 0;
  master.playCount = 0;
  master.seekTargets = [];
  external.playCount = 0;
  external.seekTargets = [];
  await harness.runtime.seek(60);

  assert.deepEqual(master.seekTargets, [60]);
  assert.equal(master.pauseCount, 1);
  assert.equal(master.playCount, 1);
  assert.deepEqual(external.seekTargets, [60, 60]);
  assert.equal(external.playCount, 2);
  assert.equal(master.snapshot.paused, false);
  assert.equal(external.snapshot.paused, false);
  assert.equal(harness.runtime.getState().desiredPlayback, "playing");
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("JobId MP3 并发起播等待期间的后发暂停始终获胜", async () => {
  const progressWaits: Array<{
    input: Parameters<WaitForPlaybackClockProgress>[0];
    resolve: (value: boolean) => void;
  }> = [];
  const harness = createHarness({
    waitForMasterProgress: (input) => new Promise((resolve) => {
      progressWaits.push({ input, resolve });
    }),
  });
  const master = new FakeBackend({ currentTime: 25, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(vodRenditionSource("rendition-start-cancel")),
  );
  const external = new FakeBackend({ currentTime: 0, duration: 190 });
  harness.pending.get("rendition-start-cancel")?.resolve(external);
  await flushAsyncWork();
  external.snapshot.currentTime = 25.02;
  const primeProgress = progressWaits.shift();
  primeProgress?.resolve(primeProgress.input.isCurrent());
  await selecting;

  const playing = harness.runtime.play();
  await flushAsyncWork();
  assert.equal(progressWaits.length, 2);
  harness.runtime.pause();
  for (const progress of progressWaits.splice(0)) {
    progress.resolve(progress.input.isCurrent());
  }
  await playing;

  assert.equal(master.snapshot.paused, true);
  assert.equal(external.snapshot.paused, true);
  assert.equal(harness.runtime.getState().desiredPlayback, "paused");
  assert.equal(harness.runtime.getState().phase, "ready_paused");
});

test("主视频原生控件起播时复用已预热的 JobId MP3", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 18, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(vodRenditionSource("rendition-native-control")),
  );
  const external = new FakeBackend({ currentTime: 0, duration: 190 });
  harness.pending.get("rendition-native-control")?.resolve(external);
  await selecting;
  const primingSeekTargets = [...external.seekTargets];

  // 模拟 Aliplayer/原生 controls 已经直接启动主视频；runtime 只补启预热外轨，不重复 play 主播放器。
  master.snapshot.paused = false;
  assert.equal(harness.runtime.notifyMasterPlaybackState(true), true);
  await flushAsyncWork();

  assert.equal(master.playCount, 0);
  assert.equal(external.playCount, 2);
  assert.deepEqual(external.seekTargets, primingSeekTargets);
  assert.equal(external.muted, false);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("用户快速播放会等待现有 VOD 预热完成后再启动主从时钟", async () => {
  const progressWaits: Array<{
    input: Parameters<WaitForPlaybackClockProgress>[0];
    resolve: (value: boolean) => void;
  }> = [];
  const harness = createHarness({
    waitForMasterProgress: (input) => new Promise((resolve) => {
      progressWaits.push({ input, resolve });
    }),
  });
  const master = new FakeBackend({ currentTime: 90, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(vodAudioSource("vod-fast-play")),
  );
  const external = new FakeBackend({ currentTime: 0, duration: 180 });
  harness.pending.get("vod-fast-play")?.resolve(external);
  await flushAsyncWork();

  const playing = harness.runtime.play();
  await flushAsyncWork();
  assert.equal(master.playCount, 0);
  assert.equal(external.playCount, 1);

  external.snapshot.currentTime = 90.02;
  const primeProgress = progressWaits.shift();
  primeProgress?.resolve(primeProgress.input.isCurrent());
  await flushAsyncWork();
  assert.equal(master.playCount, 1);
  assert.equal(external.playCount, 1);

  master.snapshot.currentTime = 90.03;
  const masterProgress = progressWaits.shift();
  masterProgress?.resolve(masterProgress.input.isCurrent());
  await Promise.all([selecting, playing]);
  assert.equal(external.playCount, 2);
  assert.equal(external.snapshot.paused, false);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("原生上传音频不执行 VOD 冷启动预热", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 35, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(source("native-no-prime")),
  );
  const external = new FakeBackend({ currentTime: 0 });
  harness.pending.get("native-no-prime")?.resolve(external);
  await selecting;

  assert.equal(external.playCount, 0);
  assert.deepEqual(external.seekTargets, [35]);
});

test("随机 VOD 起播时从轨等待主时钟推进后才发声", async () => {
  let releaseProgress: () => void = () => {
    throw new Error("主时钟推进等待尚未建立。");
  };
  const harness = createHarness({
    waitForMasterProgress: (input) => new Promise((resolve) => {
      releaseProgress = () => resolve(input.isCurrent());
    }),
  });
  const master = new FakeBackend({ currentTime: 106.95, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(source("vod-random-start")),
  );
  const external = new FakeBackend({ currentTime: 106.95, duration: 180 });
  harness.pending.get("vod-random-start")?.resolve(external);
  await selecting;
  external.playCount = 0;
  external.pauseCount = 0;

  const playing = harness.runtime.play();
  await flushAsyncWork();
  assert.equal(master.snapshot.paused, false);
  assert.equal(external.playCount, 0);
  assert.equal(external.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "resyncing");

  master.snapshot.currentTime = 107.02;
  releaseProgress();
  await playing;
  assert.equal(external.playCount, 1);
  assert.equal(external.snapshot.paused, false);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("等待 VOD 起播期间暂停会取消旧从轨启动", async () => {
  let releaseProgress: () => void = () => {
    throw new Error("主时钟推进等待尚未建立。");
  };
  const harness = createHarness({
    waitForMasterProgress: (input) => new Promise((resolve) => {
      releaseProgress = () => resolve(input.isCurrent());
    }),
  });
  const master = new FakeBackend({ currentTime: 80, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(source("cancel-random-start")),
  );
  const external = new FakeBackend({ currentTime: 80 });
  harness.pending.get("cancel-random-start")?.resolve(external);
  await selecting;
  external.playCount = 0;

  const playing = harness.runtime.play();
  await flushAsyncWork();
  harness.runtime.pause();
  master.snapshot.currentTime = 80.1;
  releaseProgress();
  await playing;

  assert.equal(external.playCount, 0);
  assert.equal(external.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "ready_paused");
});

test("播放中随机 seek 会冻结从轨并等待新位置主时钟推进", async () => {
  const pendingProgress: Array<{
    input: Parameters<WaitForPlaybackClockProgress>[0];
    resolve: (value: boolean) => void;
  }> = [];
  const harness = createHarness({
    waitForMasterProgress: (input) => new Promise((resolve) => {
      pendingProgress.push({ input, resolve });
    }),
  });
  const master = new FakeBackend({ currentTime: 20, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("seek-gate")));
  const external = new FakeBackend({ currentTime: 20 });
  harness.pending.get("seek-gate")?.resolve(external);
  await selecting;

  const initialPlay = harness.runtime.play();
  await flushAsyncWork();
  master.snapshot.currentTime = 20.02;
  const initialProgress = pendingProgress.shift();
  initialProgress?.resolve(initialProgress.input.isCurrent());
  await initialPlay;
  assert.equal(external.playCount, 1);

  const seeking = harness.runtime.seek(60);
  await flushAsyncWork();
  assert.equal(external.snapshot.paused, true);
  assert.equal(external.playCount, 1);
  assert.equal(harness.runtime.getState().phase, "resyncing");

  master.snapshot.currentTime = 60.03;
  const seekProgress = pendingProgress.shift();
  seekProgress?.resolve(seekProgress.input.isCurrent());
  await seeking;
  assert.equal(external.playCount, 2);
  assert.equal(external.seekTargets[external.seekTargets.length - 1], 60.03);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("主视频播放中准备完成的新音轨也必须等待主时钟继续推进", async () => {
  let releaseProgress: () => void = () => {
    throw new Error("主时钟推进等待尚未建立。");
  };
  const harness = createHarness({
    waitForMasterProgress: (input) => new Promise((resolve) => {
      releaseProgress = () => resolve(input.isCurrent());
    }),
  });
  const master = new FakeBackend({ currentTime: 40, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(source("switch-while-playing")),
  );
  const external = new FakeBackend({ currentTime: 0 });
  harness.pending.get("switch-while-playing")?.resolve(external);
  await flushAsyncWork();

  assert.equal(external.playCount, 0);
  assert.equal(external.snapshot.paused, true);
  master.snapshot.currentTime = 40.02;
  releaseProgress();
  await selecting;
  assert.equal(external.playCount, 1);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("原声模式保持主 backend 为唯一快照和命令目标", async () => {
  const { runtime } = createHarness();
  const master = new FakeBackend({ currentTime: 3 });
  runtime.attachMasterBackend(master);

  runtime.setPlaybackRate(1.5);
  runtime.setVolume(0.75);
  runtime.setMuted(true);
  await runtime.seek(8);
  await runtime.play();
  runtime.pause();

  assert.equal(runtime.getSnapshot().currentTime, 8);
  assert.deepEqual(master.seekTargets, [8]);
  assert.equal(master.playCount, 1);
  assert.equal(master.playbackRate, 1.5);
  assert.equal(master.volume, 0.75);
  assert.equal(master.muted, true);
});

test("暂停和播放状态选择外部轨时按最新主时钟与偏移安装", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: true });
  harness.runtime.attachMasterBackend(master);
  harness.runtime.setPlaybackRate(1.25);
  harness.runtime.setVolume(0.6);

  const selecting = harness.runtime.selectAudio(externalSelection(source("vocal", 1.5)));
  assert.equal(master.muted, true);
  const external = new FakeBackend({ duration: 80 });
  harness.pending.get("vocal")?.resolve(external);
  await selecting;

  assert.deepEqual(external.seekTargets, [8.5]);
  assert.equal(external.playCount, 0);
  assert.equal(external.playbackRate, 1.25);
  assert.equal(external.volume, 0.6);
  assert.equal(harness.runtime.getState().phase, "ready_paused");

  await harness.runtime.play();
  assert.equal(master.playCount, 1);
  assert.equal(external.playCount, 1);
  assert.deepEqual(external.seekTargets, [8.5]);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("主媒体自带控件播放和暂停会同步更新外部音轨意图", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("native-controls")));
  const external = new FakeBackend({ duration: 80 });
  harness.pending.get("native-controls")?.resolve(external);
  await selecting;
  external.seekTargets = [];

  master.snapshot.paused = false;
  harness.runtime.notifyMasterPlaybackState(true);
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, []);
  assert.equal(external.snapshot.paused, false);
  assert.equal(harness.runtime.getState().phase, "playing_synced");

  master.snapshot.paused = true;
  harness.runtime.notifyMasterPlaybackState(false);
  assert.equal(external.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "ready_paused");
  assert.equal(harness.runtime.getState().desiredPlayback, "paused");
});

test("runtime 命令触发同步主媒体事件时保持幂等", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 6, paused: true });
  harness.runtime.attachMasterBackend(master);
  master.playStateListener = (playing) =>
    harness.runtime.notifyMasterPlaybackState(playing);
  const selecting = harness.runtime.selectAudio(externalSelection(source("command-events")));
  const external = new FakeBackend();
  harness.pending.get("command-events")?.resolve(external);
  await selecting;
  external.seekTargets = [];

  await harness.runtime.play();
  assert.deepEqual(external.seekTargets, []);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
  external.pauseCount = 0;
  harness.runtime.pause();
  assert.equal(harness.runtime.getState().phase, "ready_paused");
  assert.equal(external.pauseCount, 1);
  assert.deepEqual(harness.errors, []);
});

test("原生音频起播按最新主时钟精确定位，容差仅服务普通暂停恢复", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("resume-drift")));
  const external = new FakeBackend({ duration: 80 });
  harness.pending.get("resume-drift")?.resolve(external);
  await selecting;
  external.seekTargets = [];

  // 起播门禁之后按 1ms 精度建立原生时钟，8ms 不能继续沿用普通暂停恢复容差。
  external.snapshot.currentTime = 9.992;
  await harness.runtime.play();
  assert.deepEqual(external.seekTargets, [10]);
  harness.runtime.pause();

  // 原生音频可精确 Range seek，不能套用 Aliplayer 的 150ms 缓冲保留窗口。
  external.snapshot.currentTime = 9.92;
  await harness.runtime.play();
  assert.deepEqual(external.seekTargets, [10, 10]);
  harness.runtime.pause();

  // 明显漂移仍使用原来的硬对齐路径，不能以流畅为由牺牲科研试听精度。
  external.snapshot.currentTime = 9.8;
  await harness.runtime.play();
  assert.deepEqual(external.seekTargets, [10, 10, 10]);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("VOD JobId MP3 起播与硬同步后的冷停使用倍率追回，不形成重复 seek", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(vodRenditionSource("rendition-stabilization")),
  );
  const external = new FakeBackend({ duration: 190 });
  harness.pending.get("rendition-stabilization")?.resolve(external);
  await selecting;
  await harness.runtime.play();
  external.seekTargets = [];

  // 随机起播后的 220ms 冷停不再触发硬 seek，而是沿用既有最大 4% 倍率伺服。
  master.snapshot.currentTime = 10.2;
  external.snapshot.currentTime = 9.98;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, []);
  assert.equal(external.playbackRate, 1.04);

  // 稳定窗口结束后真正的大漂移仍会硬同步；该次 seek 又开启新窗口，防止解码冷停自激。
  harness.setNow(6_001);
  external.snapshot.currentTime = 9.6;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, [10.2]);

  harness.setNow(6_002);
  external.snapshot.currentTime = 9.98;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, [10.2]);
  assert.equal(external.playbackRate, 1.04);
});

test("vid + PlayAuth 音轨起播保留 150ms 内的 Aliplayer 解码缓冲", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: true });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(vodAudioSource("vod-buffer-preserve")),
  );
  const external = new FakeBackend({ duration: 80 });
  harness.pending.get("vod-buffer-preserve")?.resolve(external);
  await selecting;
  external.seekTargets = [];
  external.snapshot.currentTime = 9.92;

  await harness.runtime.play();

  assert.deepEqual(external.seekTargets, []);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("主媒体 ready 前后的同一选择只准备一次外部会话", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ ready: false, currentTime: 6 });
  const selectedSource = source("same-source");
  harness.runtime.attachMasterBackend(master);

  await harness.runtime.selectAudio(externalSelection(selectedSource));
  await harness.runtime.selectAudio(externalSelection(selectedSource));
  assert.equal(harness.prepareCounts.get("same-source") ?? 0, 0);

  master.snapshot.ready = true;
  harness.runtime.notifyMasterReady();
  const waitingForSamePreparation = harness.runtime.selectAudio(externalSelection(selectedSource));
  assert.equal(harness.prepareCounts.get("same-source"), 1);
  const external = new FakeBackend();
  harness.pending.get("same-source")?.resolve(external);
  await waitingForSamePreparation;

  await harness.runtime.selectAudio(externalSelection(selectedSource));
  assert.equal(harness.prepareCounts.get("same-source"), 1);
  assert.equal(external.disposeCount, 0);
});

test("A/B/C 快速选择只允许最后来源安装并发声", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 20, paused: false });
  harness.runtime.attachMasterBackend(master);

  const selectingA = harness.runtime.selectAudio(externalSelection(source("a")));
  const selectingB = harness.runtime.selectAudio(externalSelection(source("b")));
  const selectingC = harness.runtime.selectAudio(externalSelection(source("c")));
  const backendA = new FakeBackend();
  const backendB = new FakeBackend();
  const backendC = new FakeBackend();
  harness.pending.get("a")?.resolve(backendA);
  harness.pending.get("b")?.resolve(backendB);
  harness.pending.get("c")?.resolve(backendC);
  await Promise.all([selectingA, selectingB, selectingC]);

  assert.equal(backendA.playCount, 0);
  assert.equal(backendB.playCount, 0);
  assert.equal(backendC.playCount, 1);
  assert.equal(harness.runtime.getState().selectedTrackId, "c");
});

test("切回原声先恢复主输出且旧外部事件不能复活", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 5, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("vocal")));
  const external = new FakeBackend();
  const preparation = harness.pending.get("vocal");
  preparation?.resolve(external);
  await selecting;

  await harness.runtime.selectAudio({ type: "original" });
  assert.equal(master.muted, false);
  assert.equal(external.disposeCount, 1);
  assert.equal(harness.runtime.getState().phase, "original");
  preparation?.events.onError("旧音轨迟到错误");
  preparation?.events.onBufferingChange?.(true);
  assert.equal(harness.runtime.getState().phase, "original");
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.diagnostics, []);
});

test("before-start 保持无声并在进入可播区后由漂移采样启动", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 1, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("delayed", 2)));
  const external = new FakeBackend({ duration: 20 });
  harness.pending.get("delayed")?.resolve(external);
  await selecting;
  assert.equal(external.playCount, 0);
  assert.equal(master.muted, true);

  master.snapshot.currentTime = 4;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.equal(external.seekTargets[external.seekTargets.length - 1], 2);
  assert.equal(external.playCount, 1);
});

test("外部音轨结束边界只暂停一次，主时钟返回可播区后恢复", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 5, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("short-audio")));
  const external = new FakeBackend({ currentTime: 5, duration: 10 });
  harness.pending.get("short-audio")?.resolve(external);
  await selecting;
  external.pauseCount = 0;
  external.seekTargets = [];

  master.snapshot.currentTime = 12;
  const driftCallback = harness.driftCallbacks[harness.driftCallbacks.length - 1];
  driftCallback?.();
  driftCallback?.();
  await flushAsyncWork();
  assert.equal(external.pauseCount, 1);

  master.snapshot.currentTime = 4;
  driftCallback?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, [4]);
  assert.equal(external.snapshot.paused, false);
});

test("中等漂移只平滑调速而小漂移恢复用户基础倍率", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("drift")));
  const external = new FakeBackend({ currentTime: 10 });
  harness.pending.get("drift")?.resolve(external);
  await selecting;
  external.seekTargets = [];

  external.snapshot.currentTime = 9.992;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, []);

  external.snapshot.currentTime = 9.9;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, []);
  assert.equal(external.playbackRate, 1.04);

  external.snapshot.currentTime = 10.005;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.equal(external.playbackRate, 1);
  assert.deepEqual(external.seekTargets, []);
  assert.deepEqual(harness.diagnostics, []);
});

test("缓冲暂停主视频，恢复时重同步；用户主动暂停后不自动恢复", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 12, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("buffering")));
  const external = new FakeBackend({ currentTime: 12 });
  const preparation = harness.pending.get("buffering");
  preparation?.resolve(external);
  await selecting;

  harness.setNow(100);
  preparation?.events.onBufferingChange?.(true);
  preparation?.events.onBufferingChange?.(true);
  harness.runBufferingProbe();
  harness.runtime.notifyMasterPlaybackState(false);
  assert.equal(master.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "buffering_external");
  assert.equal(harness.runtime.getState().desiredPlayback, "playing");
  harness.setNow(1_350);
  preparation?.events.onBufferingChange?.(false);
  await flushAsyncWork();
  assert.equal(master.snapshot.paused, false);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
  assert.deepEqual(harness.diagnostics, [
    { kind: "buffering", phase: "started", durationMilliseconds: null },
    { kind: "buffering", phase: "recovery_started", durationMilliseconds: 1_250 },
    { kind: "buffering", phase: "recovered", durationMilliseconds: 1_250 },
  ]);

  preparation?.events.onBufferingChange?.(true);
  harness.runtime.pause();
  preparation?.events.onBufferingChange?.(false);
  await flushAsyncWork();
  assert.equal(master.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "ready_paused");
  assert.equal(
    harness.diagnostics.filter(({ kind, phase }) =>
      kind === "buffering" && phase === "recovery_started").length,
    1,
  );
});

test("主 VOD 缓冲会冻结从轨并在主时钟恢复后重新放行", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 14, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(source("master-buffering")),
  );
  const external = new FakeBackend({ currentTime: 14 });
  harness.pending.get("master-buffering")?.resolve(external);
  await selecting;
  assert.equal(external.playCount, 1);

  harness.runtime.notifyMasterBufferingState(true);
  harness.runBufferingProbe();
  assert.equal(external.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "buffering_master");
  assert.equal(harness.runtime.getState().desiredPlayback, "playing");

  master.snapshot.currentTime = 14.03;
  harness.runtime.notifyMasterBufferingState(false);
  await flushAsyncWork();
  assert.equal(external.playCount, 2);
  assert.equal(external.snapshot.paused, false);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
});

test("主视频自然结束会停止外部音轨与漂移采样", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 20, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("master-ended")));
  const external = new FakeBackend({ currentTime: 20 });
  harness.pending.get("master-ended")?.resolve(external);
  await selecting;
  const driftCallback = harness.driftCallbacks[harness.driftCallbacks.length - 1];

  master.snapshot.paused = true;
  master.snapshot.ended = true;
  harness.runtime.notifyMasterPlaybackState(false);

  assert.equal(external.snapshot.paused, true);
  assert.equal(harness.runtime.getState().desiredPlayback, "paused");
  assert.equal(harness.runtime.getState().phase, "ready_paused");
  assert.ok(driftCallback && harness.stoppedDriftCallbacks.has(driftCallback));
});

test("硬同步在途保持单飞且用户暂停不会被迟到 seek 恢复", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("single-flight")));
  const external = new FakeBackend({ currentTime: 10 });
  harness.pending.get("single-flight")?.resolve(external);
  await selecting;
  external.seekTargets = [];

  const seekGate = createDeferred();
  external.seekBlocker = seekGate.promise;
  external.snapshot.currentTime = 9.7;
  const driftCallback = harness.driftCallbacks[harness.driftCallbacks.length - 1];
  driftCallback?.();
  await flushAsyncWork();
  driftCallback?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, [10]);
  assert.equal(harness.diagnostics.length, 1);

  harness.runtime.pause();
  seekGate.resolve();
  await flushAsyncWork();
  assert.equal(master.snapshot.paused, true);
  assert.equal(external.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "ready_paused");
  assert.equal(harness.diagnostics.length, 1);
  assert.deepEqual(harness.errors, []);
});

test("诊断消费者抛错不会中断缓冲安全暂停", async () => {
  const harness = createHarness({ diagnosticThrows: true });
  const master = new FakeBackend({ paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("observer")));
  const external = new FakeBackend();
  const preparation = harness.pending.get("observer");
  preparation?.resolve(external);
  await selecting;

  preparation?.events.onBufferingChange?.(true);
  harness.runBufferingProbe();
  assert.equal(harness.runtime.getState().phase, "buffering_external");
  assert.equal(master.snapshot.paused, true);
  assert.deepEqual(harness.errors, []);
});

test("VOD 短暂 waiting 期间时钟仍推进时不暂停主从媒体", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 30, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(
    externalSelection(source("transient-waiting")),
  );
  const external = new FakeBackend({ currentTime: 30 });
  const preparation = harness.pending.get("transient-waiting");
  preparation?.resolve(external);
  await selecting;

  preparation?.events.onBufferingChange?.(true);
  external.snapshot.currentTime = 30.02;
  harness.runBufferingProbe();

  assert.equal(master.snapshot.paused, false);
  assert.equal(external.snapshot.paused, false);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
  assert.deepEqual(harness.diagnostics, []);
});

test("漂移同步失败记录有限事实并进入既有安全错误态", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("drift-failure")));
  const external = new FakeBackend({ currentTime: 10 });
  harness.pending.get("drift-failure")?.resolve(external);
  await selecting;
  external.seekTargets = [];

  external.snapshot.currentTime = 9.7;
  external.seekError = new Error("包含供应商细节的测试错误");
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();

  assert.deepEqual(harness.diagnostics, [
    {
      kind: "drift_resync",
      phase: "started",
      reason: "large_drift",
      driftMilliseconds: -300,
    },
    {
      kind: "drift_resync",
      phase: "failed",
      reason: "large_drift",
      driftMilliseconds: -300,
    },
  ]);
  assert.equal(harness.runtime.getState().phase, "error_external");
  assert.equal(master.snapshot.paused, true);
  assert.deepEqual(harness.errors, ["包含供应商细节的测试错误"]);
});

test("准备失败暂停且保持所选音轨，只有显式重试或切回原声才能恢复", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ paused: false });
  harness.runtime.attachMasterBackend(master);
  const brokenSource = source("broken");
  const selecting = harness.runtime.selectAudio(externalSelection(brokenSource));
  harness.pending.get("broken")?.reject(new Error("音频服务不可用"));
  await selecting;

  assert.equal(master.muted, true);
  assert.equal(master.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "error_external");
  assert.equal(harness.runtime.getState().selectedTrackId, "broken");
  assert.deepEqual(harness.errors, ["音频服务不可用"]);
  await assert.rejects(() => harness.runtime.play(), /当前监听音轨不可用/u);

  // 错误态直接操作主视频 controls 仍会被安全暂停，调用方可据返回值保持 UI 为暂停。
  master.snapshot.paused = false;
  assert.equal(harness.runtime.notifyMasterPlaybackState(true), false);
  assert.equal(master.snapshot.paused, true);

  const retrying = harness.runtime.selectAudio(externalSelection(brokenSource));
  assert.equal(harness.prepareCounts.get("broken"), 2);
  const recovered = new FakeBackend();
  harness.pending.get("broken")?.resolve(recovered);
  await retrying;
  assert.equal(harness.runtime.getState().phase, "ready_paused");

  await harness.runtime.selectAudio({ type: "original" });
  assert.equal(master.muted, false);
  assert.equal(harness.runtime.getState().phase, "original");
});

test("权威选项判定不可用时直接暂停静音并保留目标身份", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ paused: false });
  harness.runtime.attachMasterBackend(master);

  await harness.runtime.selectAudio({
    type: "unavailable",
    trackId: "revoked-track",
    errorCode: "permission_denied",
  });

  assert.equal(master.snapshot.paused, true);
  assert.equal(master.muted, true);
  assert.equal(harness.runtime.getState().selectedTrackId, "revoked-track");
  assert.equal(harness.runtime.getState().errorCode, "permission_denied");
  assert.equal(harness.prepareCounts.size, 0);
});

test("选项加载暂挂不会伪造音轨身份或启动外部请求", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ paused: false });
  harness.runtime.attachMasterBackend(master);

  await harness.runtime.selectAudio({ type: "blocked", errorCode: "options_loading" });

  assert.equal(master.snapshot.paused, true);
  assert.equal(master.muted, true);
  assert.equal(harness.runtime.getState().selectedTrackId, null);
  assert.equal(harness.runtime.getState().errorCode, "options_loading");
  assert.equal(harness.prepareCounts.size, 0);

  // 加载失败没有 trackId，但后续音量控件也不能绕过安全静音并意外放出视频原声。
  harness.runtime.setMuted(false);
  assert.equal(master.muted, true);
});

test("主来源卸载会取消准备、销毁主从 backend 并停止漂移", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("cleanup")));
  const external = new FakeBackend();
  harness.pending.get("cleanup")?.resolve(external);
  await selecting;
  const driftCallback = harness.driftCallbacks[harness.driftCallbacks.length - 1];

  harness.runtime.detachMasterBackend(master);
  assert.equal(master.disposeCount, 1);
  assert.equal(external.disposeCount, 1);
  assert.ok(driftCallback && harness.stoppedDriftCallbacks.has(driftCallback));
  assert.equal(harness.runtime.getSnapshot().ready, false);
});

test("页面恢复保持单飞并在完成后按主时钟对齐主从音频", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 18, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("recovery", 2)));
  const external = new FakeBackend({ currentTime: 4, duration: 80, paused: true });
  harness.pending.get("recovery")?.resolve(external);
  await selecting;
  external.seekTargets = [];
  external.pause();

  const first = harness.runtime.recoverAfterInterruption();
  const second = harness.runtime.recoverAfterInterruption();
  assert.equal(first, second);
  await first;

  assert.equal(master.recoverCount, 1);
  assert.equal(external.recoverCount, 1);
  assert.deepEqual(external.seekTargets, [16]);
  assert.equal(external.snapshot.paused, false);
});

test("页面恢复等待期间用户暂停，迟到恢复不得重新播放", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 12, paused: false });
  const recoveryGate = createDeferred();
  master.recoverBlocker = recoveryGate.promise;
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("pause-during-recovery")));
  const external = new FakeBackend({ currentTime: 12, paused: false });
  harness.pending.get("pause-during-recovery")?.resolve(external);
  await selecting;
  external.seekTargets = [];

  const recovering = harness.runtime.recoverAfterInterruption();
  harness.runtime.pause();
  recoveryGate.resolve();
  await recovering;

  assert.equal(master.snapshot.paused, true);
  assert.equal(external.snapshot.paused, true);
  assert.equal(external.playCount, 1);
  assert.deepEqual(external.seekTargets, []);
});

test("旧来源恢复在切轨后失效，且不会阻塞新来源独立恢复", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 20, paused: false });
  harness.runtime.attachMasterBackend(master);
  const firstSelection = harness.runtime.selectAudio(externalSelection(source("old-recovery")));
  const oldExternal = new FakeBackend({ currentTime: 20, paused: false });
  const oldRecoveryGate = createDeferred();
  oldExternal.recoverBlocker = oldRecoveryGate.promise;
  harness.pending.get("old-recovery")?.resolve(oldExternal);
  await firstSelection;

  const oldRecovery = harness.runtime.recoverAfterInterruption();
  const nextSelection = harness.runtime.selectAudio(externalSelection(source("new-recovery")));
  const newExternal = new FakeBackend({ currentTime: 20, paused: false });
  harness.pending.get("new-recovery")?.resolve(newExternal);
  await nextSelection;
  const newRecovery = harness.runtime.recoverAfterInterruption();
  await newRecovery;
  oldRecoveryGate.resolve();
  await oldRecovery;

  assert.equal(oldExternal.disposeCount, 1);
  assert.equal(newExternal.recoverCount, 1);
  assert.equal(newExternal.disposeCount, 0);
  assert.equal(harness.runtime.getState().selectedTrackId, "new-recovery");
});

function flushAsyncWork() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createDeferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
