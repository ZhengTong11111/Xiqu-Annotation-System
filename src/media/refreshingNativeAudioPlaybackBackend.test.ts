import assert from "node:assert/strict";
import test from "node:test";
import type { MediaAudioTrackPlaybackSession } from "@xiqu/shared";
import type {
  MediaPlaybackBackend,
  MediaPlaybackBackendEvents,
  MediaPlaybackSnapshot,
} from "./mediaPlaybackController";
import { RefreshingNativeAudioPlaybackBackend } from "./refreshingNativeAudioPlaybackBackend";

type RenditionSession = Extract<
  MediaAudioTrackPlaybackSession,
  { sourceType: "aliyun_vod_rendition" }
>;

class FakeNativeBackend implements MediaPlaybackBackend {
  snapshot: MediaPlaybackSnapshot = {
    ready: true,
    currentTime: 0,
    duration: 190,
    paused: true,
    ended: false,
  };
  disposed = false;
  seekTargets: number[] = [];
  playCount = 0;
  pauseCount = 0;
  playbackRates: number[] = [];
  volumes: number[] = [];
  mutedValues: boolean[] = [];

  getSnapshot() { return { ...this.snapshot }; }
  async seek(time: number) {
    this.seekTargets.push(time);
    this.snapshot.currentTime = time;
  }
  async play() {
    this.playCount += 1;
    this.snapshot.paused = false;
  }
  pause() {
    this.pauseCount += 1;
    this.snapshot.paused = true;
  }
  setPlaybackRate(rate: number) { this.playbackRates.push(rate); }
  setVolume(volume: number) { this.volumes.push(volume); }
  setMuted(muted: boolean) { this.mutedValues.push(muted); }
  dispose() { this.disposed = true; }
}

const createSession = (suffix: string, patch: Partial<RenditionSession> = {}): RenditionSession => ({
  version: 1,
  annotationFileId: "annotation-file",
  primaryMediaResourceId: "primary-media",
  trackId: "track-rendition",
  audioMediaResourceId: "audio-media",
  sourceType: "aliyun_vod_rendition",
  videoId: "vod-video",
  region: "cn-shanghai",
  jobId: "job-mp3",
  url: `https://vod.example.test/audio.mp3?token=${suffix}`,
  mimeType: "audio/mpeg",
  duration: 190,
  expiresAt: "2030-01-01T00:00:00.000Z",
  webPlayerLicense: { domain: "example.test", key: "public-license" },
  ...patch,
});

function createHarness(loadSession: (signal?: AbortSignal) => Promise<RenditionSession>) {
  const children: Array<{ url: string; backend: FakeNativeBackend; events: MediaPlaybackBackendEvents }> = [];
  const readyDurations: number[] = [];
  const timeUpdates: number[] = [];
  const playStates: boolean[] = [];
  const buffering: boolean[] = [];
  const errors: string[] = [];
  const scheduled: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  const backend = new RefreshingNativeAudioPlaybackBackend({
    containerId: "external-audio-host",
    initialSession: createSession("initial"),
    expectedVideoId: "vod-video",
    expectedRenditionJobId: "job-mp3",
    loadSession,
    events: {
      onReady: (snapshot) => readyDurations.push(snapshot.duration),
      onTimeUpdate: (snapshot) => timeUpdates.push(snapshot.currentTime),
      onPlayStateChange: (playing) => playStates.push(playing),
      onBufferingChange: (value) => buffering.push(value),
      onError: (message) => errors.push(message),
    },
    createNativeBackend: (url, events) => {
      const child = new FakeNativeBackend();
      children.push({ url, backend: child, events });
      queueMicrotask(() => events.onReady(child.getSnapshot()));
      return child;
    },
    now: () => Date.parse("2029-12-31T23:00:00.000Z"),
    scheduleRefresh: (callback, delay) => {
      const task = { callback, delay, cancelled: false };
      scheduled.push(task);
      return () => { task.cancelled = true; };
    },
  });
  return {
    backend,
    children,
    readyDurations,
    timeUpdates,
    playStates,
    buffering,
    errors,
    scheduled,
  };
}

test("VOD MP3 转码使用原生音频，并在续签时静音准备后原子接管", async () => {
  let requests = 0;
  const harness = createHarness(async () => createSession(`refresh-${++requests}`));
  await Promise.resolve();
  assert.equal(harness.children.length, 1);
  assert.match(harness.children[0]?.url ?? "", /token=initial/u);
  assert.deepEqual(harness.readyDurations, [190]);

  const first = harness.children[0]!.backend;
  first.snapshot.currentTime = 47.125;
  first.snapshot.paused = false;
  harness.backend.setPlaybackRate(1.25);
  harness.backend.setVolume(0.7);
  harness.backend.setMuted(false);
  await harness.backend.refreshSession();

  assert.equal(requests, 1);
  assert.equal(harness.children.length, 2);
  assert.match(harness.children[1]?.url ?? "", /token=refresh-1/u);
  const second = harness.children[1]!.backend;
  assert.deepEqual(second.seekTargets, [47.125]);
  assert.equal(second.playCount, 1);
  assert.deepEqual(second.playbackRates, [1.25]);
  assert.deepEqual(second.volumes, [0.7]);
  assert.deepEqual(second.mutedValues, [true, false]);
  assert.equal(first.disposed, true);
  assert.equal(harness.backend.getSnapshot().currentTime, 47.125);
  // 候选 metadata 只服务内部接管，不能让外层误判为第二次来源 ready。
  assert.deepEqual(harness.readyDurations, [190]);
  assert.deepEqual(harness.timeUpdates, [47.125]);

  // 候选成为活动元素后仍必须向组合运行时上报媒体事件，不能停留在“仅准备 metadata”的事件闭包。
  second.snapshot.currentTime = 48;
  harness.children[1]!.events.onTimeUpdate(second.getSnapshot());
  harness.children[1]!.events.onPlayStateChange(true);
  harness.children[1]!.events.onBufferingChange?.(true);
  assert.deepEqual(harness.timeUpdates, [47.125, 48]);
  assert.deepEqual(harness.playStates, [true]);
  assert.deepEqual(harness.buffering, [true]);
});

test("续签身份漂移时保留旧音频且不接纳临时 URL", async () => {
  const harness = createHarness(async () => createSession("mismatch", { jobId: "other-job" }));
  await Promise.resolve();
  const first = harness.children[0]!.backend;
  first.snapshot.currentTime = 31;

  await assert.rejects(harness.backend.refreshSession(), /与当前音轨不匹配/u);
  assert.equal(harness.children.length, 1);
  assert.equal(first.disposed, false);
  assert.equal(harness.backend.getSnapshot().currentTime, 31);
});

test("销毁会中止续签请求并让迟到会话失效", async () => {
  let refreshSignal: AbortSignal | undefined;
  const harness = createHarness((signal) => {
    refreshSignal = signal;
    return new Promise((_, reject) => signal?.addEventListener(
      "abort",
      () => reject(new Error("aborted")),
      { once: true },
    ));
  });
  await Promise.resolve();
  const refreshing = harness.backend.refreshSession();
  await Promise.resolve();
  assert.equal(refreshSignal?.aborted, false);
  harness.backend.dispose();

  assert.equal(refreshSignal?.aborted, true);
  await assert.rejects(refreshing, /已切换/u);
  assert.equal(harness.children[0]?.backend.disposed, true);
  assert.equal(harness.scheduled.every((task) => task.cancelled), true);
});

test("候选音频等待 metadata 时销毁会立即结束准备，不等待超时", async () => {
  const children: FakeNativeBackend[] = [];
  let createCount = 0;
  const backend = new RefreshingNativeAudioPlaybackBackend({
    containerId: "external-audio-host",
    initialSession: createSession("initial"),
    expectedVideoId: "vod-video",
    expectedRenditionJobId: "job-mp3",
    loadSession: async () => createSession("refresh"),
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
    createNativeBackend: (_url, events) => {
      const child = new FakeNativeBackend();
      children.push(child);
      createCount += 1;
      // 初始元素正常 ready，候选故意保持 metadata pending，验证 dispose 的主动取消合同。
      if (createCount === 1) queueMicrotask(() => events.onReady(child.getSnapshot()));
      return child;
    },
    now: () => Date.parse("2029-12-31T23:00:00.000Z"),
    scheduleRefresh: () => () => undefined,
    readyTimeoutMs: 60_000,
  });
  await Promise.resolve();
  const refreshing = backend.refreshSession();
  await Promise.resolve();
  assert.equal(children.length, 2);

  backend.dispose();

  await assert.rejects(refreshing, /已切换/u);
  assert.equal(children.every((child) => child.disposed), true);
});
