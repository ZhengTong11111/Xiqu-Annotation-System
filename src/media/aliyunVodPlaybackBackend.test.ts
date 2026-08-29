import assert from "node:assert/strict";
import test from "node:test";
import type { AliyunVodPlaybackSession } from "@xiqu/shared";
import {
  type AliplayerConstructor,
  type AliplayerEventHandler,
  type AliplayerInstance,
  type AliplayerOptions,
} from "./aliplayerSdk";
import { AliyunVodPlaybackBackend } from "./aliyunVodPlaybackBackend";

class FakeAliplayer implements AliplayerInstance {
  static instances: FakeAliplayer[] = [];
  currentTime = 0;
  duration = 90;
  paused = true;
  ended = false;
  speed = 1;
  volume = 0.5;
  muted = false;
  disposed = false;
  private handlers = new Map<string, Set<AliplayerEventHandler>>();

  constructor(
    readonly options: AliplayerOptions,
    ready?: (player: AliplayerInstance) => void,
  ) {
    FakeAliplayer.instances.push(this);
    queueMicrotask(() => ready?.(this));
  }

  on(event: string, handler: AliplayerEventHandler) {
    const handlers = this.handlers.get(event) ?? new Set<AliplayerEventHandler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }
  play() { this.paused = false; this.emit("play"); }
  pause() { this.paused = true; this.emit("pause"); }
  seek(time: number) { this.currentTime = time; this.emit("seeked"); }
  getCurrentTime() { return this.currentTime; }
  getDuration() { return this.duration; }
  getStatus() { return this.paused ? "pause" : "playing"; }
  setSpeed(rate: number) { this.speed = rate; }
  setVolume(volume: number) { this.volume = volume; }
  mute() { this.muted = true; }
  unMute() { this.muted = false; }
  dispose() { this.disposed = true; }
  emit(event: string) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler();
  }
}

function createSession(
  playAuth: string,
  mediaKind: AliyunVodPlaybackSession["mediaKind"] = "video",
): AliyunVodPlaybackSession {
  return {
    sourceType: "aliyun_vod",
    mediaKind,
    videoId: "vod-1",
    region: "cn-shanghai",
    playAuth,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    webPlayerLicense: {
      domain: "example.test",
      key: "test-web-license-key",
    },
  };
}

type ScheduledRefreshTask = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

/** 测试只接管会话续签调度，不替换播放器 ready/seek 的真实微任务与超时合同。 */
function createRefreshScheduler() {
  const tasks: ScheduledRefreshTask[] = [];
  return {
    scheduleRefresh(callback: () => void, delayMs: number) {
      const task = { callback, delayMs, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    pendingDelays() {
      return tasks.filter((task) => !task.cancelled).map((task) => task.delayMs);
    },
    async runNext() {
      const index = tasks.findIndex((task) => !task.cancelled);
      assert.notEqual(index, -1, "预期存在待执行的 VOD 续签任务");
      const [task] = tasks.splice(index, 1);
      task?.callback();
      await flushAsyncTasks();
    },
  };
}

function createSessionAt(
  playAuth: string,
  nowMilliseconds: number,
  lifetimeMilliseconds = 120_000,
) {
  return {
    ...createSession(playAuth),
    expiresAt: new Date(nowMilliseconds + lifetimeMilliseconds).toISOString(),
  };
}

test("VOD 后端映射 ready、seek、play、pause 和倍率", async () => {
  FakeAliplayer.instances = [];
  const readyDurations: number[] = [];
  const playing: boolean[] = [];
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player",
    expectedVideoId: "vod-1",
    loadSession: async () => createSession("auth-1"),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: (snapshot) => readyDurations.push(snapshot.duration),
      onTimeUpdate: () => undefined,
      onPlayStateChange: (value) => playing.push(value),
      onError: () => undefined,
    },
  });

  backend.setPlaybackRate(1.5);
  backend.setVolume(0.75);
  backend.setMuted(true);
  await backend.seek(12);
  await backend.play();
  backend.pause();

  const player = FakeAliplayer.instances[0];
  assert.deepEqual(readyDurations, [90]);
  assert.equal(backend.getSnapshot().currentTime, 12);
  assert.equal(player?.speed, 1.5);
  assert.equal(player?.volume, 0.75);
  assert.equal(player?.muted, true);
  assert.deepEqual(player?.options.license, {
    domain: "example.test",
    key: "test-web-license-key",
  });
  assert.deepEqual(playing, [true, false]);
  backend.dispose();
  assert.equal(player?.disposed, true);
});

test("VOD 快照在 timeupdate 之间仍读取实时主时钟", async () => {
  FakeAliplayer.instances = [];
  const liveClock = { currentTime: 0, duration: 91 };
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-live-clock",
    expectedVideoId: "vod-1",
    loadSession: async () => createSession("auth-live-clock"),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    readMediaClock: () => ({ ...liveClock }),
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });
  await backend.play();
  const player = FakeAliplayer.instances[0];
  assert.ok(player);

  // 不发 timeupdate，模拟两次供应商事件之间组合运行时主动采样主时钟。
  player.currentTime = 8;
  liveClock.currentTime = 12.345;
  assert.equal(backend.getSnapshot().currentTime, 12.345);
  assert.equal(backend.getSnapshot().duration, 91);
  backend.dispose();
});

test("VOD 会话刷新单飞并恢复时间与播放状态", async () => {
  FakeAliplayer.instances = [];
  let sessionCount = 0;
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-refresh",
    expectedVideoId: "vod-1",
    loadSession: async () => createSession(`auth-${++sessionCount}`),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });
  await backend.seek(8);
  await backend.play();
  backend.setPlaybackRate(1.25);
  backend.setVolume(0.3);
  backend.setMuted(true);

  await Promise.all([backend.refreshSession(), backend.refreshSession()]);

  assert.equal(sessionCount, 2);
  assert.equal(FakeAliplayer.instances.length, 2);
  assert.equal(backend.getSnapshot().currentTime, 8);
  assert.equal(backend.getSnapshot().paused, false);
  assert.equal(FakeAliplayer.instances[1]?.speed, 1.25);
  assert.equal(FakeAliplayer.instances[1]?.volume, 0.3);
  assert.equal(FakeAliplayer.instances[1]?.muted, true);
  backend.dispose();
});

test("VOD 后端销毁会中止仍在进行的会话刷新请求", async () => {
  FakeAliplayer.instances = [];
  let sessionCount = 0;
  let refreshSignal: AbortSignal | undefined;
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-refresh-abort",
    expectedVideoId: "vod-1",
    loadSession: async (signal) => {
      sessionCount += 1;
      if (sessionCount === 1) return createSession("auth-initial");
      refreshSignal = signal;
      return new Promise((_, reject) => signal?.addEventListener(
        "abort",
        () => reject(new Error("request aborted")),
        { once: true },
      ));
    },
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });
  await backend.play();

  const refreshing = backend.refreshSession();
  await Promise.resolve();
  assert.equal(refreshSignal?.aborted, false);
  backend.dispose();

  assert.equal(refreshSignal?.aborted, true);
  await assert.rejects(refreshing, /无法准备阿里云 VOD 播放会话/u);
});

test("VOD 后端可显式接收音频媒资并拒绝媒体类型漂移", async () => {
  FakeAliplayer.instances = [];
  const audioBackend = new AliyunVodPlaybackBackend({
    containerId: "audio-player",
    expectedVideoId: "vod-1",
    expectedMediaKind: "audio",
    loadSession: async () => createSession("audio-auth", "audio"),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });
  await audioBackend.play();
  assert.equal(FakeAliplayer.instances.length, 1);
  audioBackend.dispose();

  const mismatchedBackend = new AliyunVodPlaybackBackend({
    containerId: "audio-player-mismatch",
    expectedVideoId: "vod-1",
    expectedMediaKind: "audio",
    loadSession: async () => createSession("video-auth", "video"),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });
  await assert.rejects(mismatchedBackend.play(), /播放会话与当前媒体不匹配/);
  assert.equal(FakeAliplayer.instances.length, 1);
  mismatchedBackend.dispose();
});

test("VOD 刷新失败后保留旧实例并允许继续执行播放命令", async () => {
  FakeAliplayer.instances = [];
  let sessionCount = 0;
  const errors: string[] = [];
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-refresh-failure",
    expectedVideoId: "vod-1",
    loadSession: async () => {
      sessionCount += 1;
      if (sessionCount > 1) throw new Error("供应商临时不可用");
      return createSession("auth-initial");
    },
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: (message) => errors.push(message),
    },
  });
  await backend.play();
  const originalPlayer = FakeAliplayer.instances[0];

  await assert.rejects(backend.refreshSession(), /供应商临时不可用/);
  await backend.play();

  assert.equal(FakeAliplayer.instances.length, 1);
  assert.equal(originalPlayer?.disposed, false);
  assert.equal(errors.length, 0);
  backend.dispose();
});

test("VOD 后台续签失败保留旧实例并按退避恢复", async () => {
  FakeAliplayer.instances = [];
  const scheduler = createRefreshScheduler();
  const errors: string[] = [];
  let nowMilliseconds = 0;
  let sessionCount = 0;
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-background-retry",
    expectedVideoId: "vod-1",
    now: () => nowMilliseconds,
    scheduleRefresh: scheduler.scheduleRefresh,
    loadSession: async () => {
      sessionCount += 1;
      if (sessionCount === 2) throw new Error("测试网络暂不可用");
      return createSessionAt(`auth-${sessionCount}`, nowMilliseconds);
    },
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: (message) => errors.push(message),
    },
  });
  await backend.play();
  const originalPlayer = FakeAliplayer.instances[0];
  assert.deepEqual(scheduler.pendingDelays(), [60_000]);

  nowMilliseconds = 60_000;
  await scheduler.runNext();
  assert.equal(originalPlayer?.disposed, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(scheduler.pendingDelays(), [5_000]);

  // 页面重新在线时立即消费失败状态，并取消尚未到点的旧 retry。
  await backend.recoverAfterInterruption();
  assert.equal(sessionCount, 3);
  assert.equal(FakeAliplayer.instances.length, 2);
  assert.equal(originalPlayer?.disposed, true);
  assert.deepEqual(scheduler.pendingDelays(), [60_000]);
  backend.dispose();
  assert.deepEqual(scheduler.pendingDelays(), []);
});

test("VOD 播放器错误以单飞方式刷新并从 buffering 恢复", async () => {
  FakeAliplayer.instances = [];
  const scheduler = createRefreshScheduler();
  const buffering: boolean[] = [];
  const errors: string[] = [];
  let sessionCount = 0;
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-error-recovery",
    expectedVideoId: "vod-1",
    scheduleRefresh: scheduler.scheduleRefresh,
    loadSession: async () => createSession(`auth-${++sessionCount}`),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onBufferingChange: (value) => buffering.push(value),
      onError: (message) => errors.push(message),
    },
  });
  await backend.play();
  const originalPlayer = FakeAliplayer.instances[0];
  originalPlayer?.emit("error");
  originalPlayer?.emit("error");
  await flushAsyncTasks();

  assert.equal(sessionCount, 2);
  assert.equal(FakeAliplayer.instances.length, 2);
  assert.deepEqual(buffering, [true, false]);
  assert.deepEqual(errors, []);
  backend.dispose();
});

test("VOD 播放器错误耗尽有限恢复预算后只上报一次致命错误", async () => {
  FakeAliplayer.instances = [];
  const scheduler = createRefreshScheduler();
  const buffering: boolean[] = [];
  const errors: string[] = [];
  let sessionCount = 0;
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-error-budget",
    expectedVideoId: "vod-1",
    scheduleRefresh: scheduler.scheduleRefresh,
    loadSession: async () => {
      sessionCount += 1;
      if (sessionCount > 1) throw new Error("测试持续故障");
      return createSession("auth-initial");
    },
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onBufferingChange: (value) => buffering.push(value),
      onError: (message) => errors.push(message),
    },
  });
  await backend.play();
  FakeAliplayer.instances[0]?.emit("error");
  await flushAsyncTasks();
  assert.deepEqual(scheduler.pendingDelays(), [1_000]);

  for (const expectedNextDelay of [3_000, 10_000, 30_000]) {
    await scheduler.runNext();
    assert.deepEqual(scheduler.pendingDelays(), [expectedNextDelay]);
  }
  await scheduler.runNext();

  assert.equal(sessionCount, 6);
  assert.deepEqual(buffering, [true]);
  assert.deepEqual(errors, ["阿里云媒体播放失败，请重试。"]);
  assert.deepEqual(scheduler.pendingDelays(), []);
  backend.dispose();
});

test("VOD 后端销毁会取消播放器错误留下的延迟恢复", async () => {
  FakeAliplayer.instances = [];
  const scheduler = createRefreshScheduler();
  let sessionCount = 0;
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-error-dispose",
    expectedVideoId: "vod-1",
    scheduleRefresh: scheduler.scheduleRefresh,
    loadSession: async () => {
      sessionCount += 1;
      if (sessionCount > 1) throw new Error("测试网络故障");
      return createSession("auth-initial");
    },
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });
  await backend.play();
  FakeAliplayer.instances[0]?.emit("error");
  await flushAsyncTasks();
  assert.deepEqual(scheduler.pendingDelays(), [1_000]);

  backend.dispose();
  assert.deepEqual(scheduler.pendingDelays(), []);
  assert.equal(FakeAliplayer.instances[0]?.disposed, true);
});

test("VOD 后端拒绝与当前资源不匹配的短时会话", async () => {
  const errors: string[] = [];
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-invalid",
    expectedVideoId: "vod-expected",
    loadSession: async () => createSession("auth-invalid"),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: (message) => errors.push(message),
    },
  });
  await assert.rejects(backend.play(), /播放会话与当前媒体不匹配/);
  assert.equal(errors.length, 1);
  backend.dispose();
});

test("VOD 后端在构造播放器前拒绝缺少 Web License 的会话", async () => {
  FakeAliplayer.instances = [];
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-license-missing",
    expectedVideoId: "vod-1",
    loadSession: async () => ({
      ...createSession("auth-without-license"),
      webPlayerLicense: undefined,
    } as unknown as AliyunVodPlaybackSession),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });

  await assert.rejects(backend.play(), /播放会话/);
  assert.equal(FakeAliplayer.instances.length, 0);
  backend.dispose();
});

test("VOD 后端不向界面暴露播放器 SDK 加载错误细节", async () => {
  const errors: string[] = [];
  const backend = new AliyunVodPlaybackBackend({
    containerId: "player-sdk-failure",
    expectedVideoId: "vod-1",
    loadSession: async () => createSession("auth-sdk-failure"),
    loadFactory: async () => {
      throw new Error("https://cdn.example.test/player.js?private-detail=1");
    },
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: (message) => errors.push(message),
    },
  });

  await assert.rejects(
    backend.play(),
    /无法加载阿里云 VOD 播放器，请检查网络后重试/,
  );
  assert.deepEqual(errors, ["无法加载阿里云 VOD 播放器，请检查网络后重试\u3002"]);
  backend.dispose();
});

async function flushAsyncTasks() {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}
