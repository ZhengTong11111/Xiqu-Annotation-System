import assert from "node:assert/strict";
import test from "node:test";
import type {
  AliyunVodPlaybackSession,
  MediaAudioTrackPlaybackSession,
} from "@xiqu/shared";
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

function createRenditionSession(
  suffix: string,
): Extract<
  MediaAudioTrackPlaybackSession,
  { sourceType: "aliyun_vod_rendition" }
> {
  return {
    version: 1,
    annotationFileId: "annotation-1",
    primaryMediaResourceId: "vod-resource",
    trackId: "track-rendition",
    audioMediaResourceId: "vod-resource",
    sourceType: "aliyun_vod_rendition",
    videoId: "vod-1",
    region: "cn-shanghai",
    jobId: "job-audio",
    url: `https://vod.example.test/audio.mp3?session=${suffix}`,
    mimeType: "audio/mpeg",
    duration: 90,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    webPlayerLicense: {
      domain: "example.test",
      key: "test-web-license-key",
    },
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

test("VOD 音频转码后端锁定 JobId 并在刷新时更换短时 source", async () => {
  FakeAliplayer.instances = [];
  let sessionCount = 0;
  const backend = new AliyunVodPlaybackBackend({
    containerId: "rendition-player",
    expectedVideoId: "vod-1",
    expectedRenditionJobId: "job-audio",
    loadSession: async () => createRenditionSession(String(++sessionCount)),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });

  await backend.seek(12);
  const first = FakeAliplayer.instances[0];
  assert.equal(first?.options.source?.includes("session=1"), true);
  assert.equal(first?.options.mediaType, "audio");
  assert.equal(first?.options.format, "mp3");
  await backend.refreshSession();
  const second = FakeAliplayer.instances[1];
  assert.equal(second?.options.source?.includes("session=2"), true);
  assert.equal(backend.getSnapshot().currentTime, 12);
  backend.dispose();

  const mismatch = new AliyunVodPlaybackBackend({
    containerId: "rendition-mismatch",
    expectedVideoId: "vod-1",
    expectedRenditionJobId: "different-job",
    loadSession: async () => createRenditionSession("mismatch"),
    loadFactory: async () => FakeAliplayer as unknown as AliplayerConstructor,
    events: {
      onReady: () => undefined,
      onTimeUpdate: () => undefined,
      onPlayStateChange: () => undefined,
      onError: () => undefined,
    },
  });
  await assert.rejects(mismatch.play(), /音频转码会话与当前音轨不匹配/);
  mismatch.dispose();
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
  assert.equal(errors.length, 1);
  backend.dispose();
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
