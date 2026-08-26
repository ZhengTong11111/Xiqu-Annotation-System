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

function createHarness(options: { diagnosticThrows?: boolean } = {}) {
  const pending = new Map<string, PendingPreparation>();
  const prepareCounts = new Map<string, number>();
  const driftCallbacks: Array<() => void> = [];
  const stoppedDriftCallbacks = new Set<() => void>();
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

const externalSelection = (value: ExternalAudioPlaybackSource) => ({
  type: "external" as const,
  source: value,
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
  assert.deepEqual(external.seekTargets, [10]);
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
  assert.deepEqual(external.seekTargets, [6]);
  assert.equal(harness.runtime.getState().phase, "playing_synced");
  external.pauseCount = 0;
  harness.runtime.pause();
  assert.equal(harness.runtime.getState().phase, "ready_paused");
  assert.equal(external.pauseCount, 1);
  assert.deepEqual(harness.errors, []);
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

test("连续中等漂移触发硬同步而小漂移保持不动", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectAudio(externalSelection(source("drift")));
  const external = new FakeBackend({ currentTime: 10 });
  harness.pending.get("drift")?.resolve(external);
  await selecting;
  external.seekTargets = [];

  external.snapshot.currentTime = 9.97;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, []);

  external.snapshot.currentTime = 9.9;
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, []);
  harness.driftCallbacks[harness.driftCallbacks.length - 1]?.();
  await flushAsyncWork();
  assert.deepEqual(external.seekTargets, [10]);
  assert.deepEqual(harness.diagnostics, [
    {
      kind: "drift_resync",
      phase: "started",
      reason: "confirmed_medium_drift",
      driftMilliseconds: -100,
    },
    {
      kind: "drift_resync",
      phase: "succeeded",
      reason: "confirmed_medium_drift",
      driftMilliseconds: -100,
    },
  ]);
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
  assert.equal(harness.runtime.getState().phase, "buffering_external");
  assert.equal(master.snapshot.paused, true);
  assert.deepEqual(harness.errors, []);
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
