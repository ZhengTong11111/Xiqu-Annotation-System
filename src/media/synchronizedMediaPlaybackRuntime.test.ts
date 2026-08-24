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
    this.snapshot.currentTime = time;
  }
  async play() {
    this.playCount += 1;
    this.snapshot.paused = false;
    this.snapshot.ended = false;
  }
  pause() {
    this.pauseCount += 1;
    this.snapshot.paused = true;
  }
  setPlaybackRate(rate: number) { this.playbackRate = rate; }
  setVolume(volume: number) { this.volume = volume; }
  setMuted(muted: boolean) { this.muted = muted; }
  dispose() { this.disposeCount += 1; }
}

type PendingPreparation = {
  signal: AbortSignal;
  events: ExternalAudioPlaybackBackendEvents;
  resolve: (backend: FakeBackend) => void;
  reject: (error: Error) => void;
};

function createHarness() {
  const pending = new Map<string, PendingPreparation>();
  const prepareCounts = new Map<string, number>();
  const driftCallbacks: Array<() => void> = [];
  const stoppedDriftCallbacks = new Set<() => void>();
  const errors: string[] = [];
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
    onError: (message) => errors.push(message),
  });
  return {
    runtime,
    pending,
    prepareCounts,
    driftCallbacks,
    stoppedDriftCallbacks,
    errors,
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

  const selecting = harness.runtime.selectExternalSource(source("vocal", 1.5));
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

test("主媒体 ready 前后的同一选择只准备一次外部会话", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ ready: false, currentTime: 6 });
  const selectedSource = source("same-source");
  harness.runtime.attachMasterBackend(master);

  await harness.runtime.selectExternalSource(selectedSource);
  await harness.runtime.selectExternalSource(selectedSource);
  assert.equal(harness.prepareCounts.get("same-source") ?? 0, 0);

  master.snapshot.ready = true;
  harness.runtime.notifyMasterReady();
  const waitingForSamePreparation = harness.runtime.selectExternalSource(selectedSource);
  assert.equal(harness.prepareCounts.get("same-source"), 1);
  const external = new FakeBackend();
  harness.pending.get("same-source")?.resolve(external);
  await waitingForSamePreparation;

  await harness.runtime.selectExternalSource(selectedSource);
  assert.equal(harness.prepareCounts.get("same-source"), 1);
  assert.equal(external.disposeCount, 0);
});

test("A/B/C 快速选择只允许最后来源安装并发声", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 20, paused: false });
  harness.runtime.attachMasterBackend(master);

  const selectingA = harness.runtime.selectExternalSource(source("a"));
  const selectingB = harness.runtime.selectExternalSource(source("b"));
  const selectingC = harness.runtime.selectExternalSource(source("c"));
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
  const selecting = harness.runtime.selectExternalSource(source("vocal"));
  const external = new FakeBackend();
  const preparation = harness.pending.get("vocal");
  preparation?.resolve(external);
  await selecting;

  await harness.runtime.selectExternalSource(null);
  assert.equal(master.muted, false);
  assert.equal(external.disposeCount, 1);
  assert.equal(harness.runtime.getState().phase, "original");
  preparation?.events.onError("旧音轨迟到错误");
  preparation?.events.onBufferingChange?.(true);
  assert.equal(harness.runtime.getState().phase, "original");
  assert.deepEqual(harness.errors, []);
});

test("before-start 保持无声并在进入可播区后由漂移采样启动", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 1, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectExternalSource(source("delayed", 2));
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

test("连续中等漂移触发硬同步而小漂移保持不动", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 10, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectExternalSource(source("drift"));
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
});

test("缓冲暂停主视频，恢复时重同步；用户主动暂停后不自动恢复", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ currentTime: 12, paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectExternalSource(source("buffering"));
  const external = new FakeBackend({ currentTime: 12 });
  const preparation = harness.pending.get("buffering");
  preparation?.resolve(external);
  await selecting;

  preparation?.events.onBufferingChange?.(true);
  assert.equal(master.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "buffering_external");
  preparation?.events.onBufferingChange?.(false);
  await flushAsyncWork();
  assert.equal(master.snapshot.paused, false);
  assert.equal(harness.runtime.getState().phase, "playing_synced");

  preparation?.events.onBufferingChange?.(true);
  harness.runtime.pause();
  preparation?.events.onBufferingChange?.(false);
  await flushAsyncWork();
  assert.equal(master.snapshot.paused, true);
  assert.equal(harness.runtime.getState().phase, "ready_paused");
});

test("准备失败恢复原声并清理选择，不留下永久静音", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectExternalSource(source("broken"));
  harness.pending.get("broken")?.reject(new Error("音频服务不可用"));
  await selecting;

  assert.equal(master.muted, false);
  assert.equal(harness.runtime.getState().phase, "original");
  assert.deepEqual(harness.errors, ["音频服务不可用"]);
});

test("主来源卸载会取消准备、销毁主从 backend 并停止漂移", async () => {
  const harness = createHarness();
  const master = new FakeBackend({ paused: false });
  harness.runtime.attachMasterBackend(master);
  const selecting = harness.runtime.selectExternalSource(source("cleanup"));
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

function flushAsyncWork() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
