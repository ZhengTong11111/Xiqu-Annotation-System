import assert from "node:assert/strict";
import test from "node:test";
import type { AliyunVodPlaybackSession } from "@xiqu/shared";
import {
  createExternalAudioPlaybackBackendPreparer,
  type ExternalAudioPlaybackBackendEvents,
} from "./externalAudioPlaybackBackendFactory";
import type { AliyunVodPlaybackBackendOptions } from "./aliyunVodPlaybackBackend";
import {
  MediaPlaybackCommandCancelledError,
  type MediaPlaybackBackend,
  type MediaPlaybackBackendEvents,
} from "./mediaPlaybackController";

class ReadyBackend implements MediaPlaybackBackend {
  disposed = false;
  getSnapshot() {
    return { ready: true, currentTime: 0, duration: 90, paused: true, ended: false };
  }
  async seek() {}
  async play() {}
  pause() {}
  setPlaybackRate() {}
  setVolume() {}
  setMuted() {}
  dispose() { this.disposed = true; }
}

const noopEvents = (errors: string[] = []): ExternalAudioPlaybackBackendEvents => ({
  onTimeUpdate: () => undefined,
  onPlayStateChange: () => undefined,
  onBufferingChange: () => undefined,
  onError: (message) => errors.push(message),
});

test("uploaded 工厂先取得临时 URL，再等待 backend ready", async () => {
  let receivedUrl = "";
  let receivedSignal: AbortSignal | undefined;
  const backend = new ReadyBackend();
  const prepare = createExternalAudioPlaybackBackendPreparer({
    createNativeBackend: (url, events) => {
      receivedUrl = url;
      queueMicrotask(() => events.onReady(backend.getSnapshot()));
      return backend;
    },
  });
  const prepared = await prepare({
    type: "uploaded_audio",
    trackId: "track-uploaded",
    audioMediaResourceId: "media-uploaded",
    offsetSeconds: 0,
    load: async (signal) => {
      receivedSignal = signal;
      return { url: "/api/files/audio/content", mimeType: "audio/mpeg", duration: 90 };
    },
  }, {
    signal: new AbortController().signal,
    vodContainerId: "unused",
    events: noopEvents(),
  });

  assert.equal(receivedUrl, "/api/files/audio/content");
  assert.equal(receivedSignal?.aborted, false);
  assert.equal(prepared.backend, backend);
  assert.equal(prepared.readySnapshot.duration, 90);
});

test("VOD 工厂复用首份会话作为 expected identity 和首次 PlayAuth", async () => {
  let sessionRequests = 0;
  const capturedVodOptions: AliyunVodPlaybackBackendOptions[] = [];
  const backend = new ReadyBackend();
  const prepare = createExternalAudioPlaybackBackendPreparer({
    createVodBackend: (options) => {
      capturedVodOptions.push(options);
      queueMicrotask(() => options.events.onReady(backend.getSnapshot()));
      return backend;
    },
  });
  const createSession = (suffix: string): AliyunVodPlaybackSession => ({
    sourceType: "aliyun_vod",
    mediaKind: "audio",
    videoId: "vod-audio",
    region: "cn-shanghai",
    playAuth: `auth-${suffix}`,
    expiresAt: "2030-01-01T00:00:00.000Z",
    webPlayerLicense: { domain: "example.test", key: "public-license" },
  });
  await prepare({
    type: "aliyun_vod_audio",
    trackId: "track-vod",
    audioMediaResourceId: "media-vod",
    offsetSeconds: 0,
    loadSession: async () => createSession(String(++sessionRequests)),
  }, {
    signal: new AbortController().signal,
    vodContainerId: "vod-audio-host",
    events: noopEvents(),
  });

  const vodOptions = capturedVodOptions[0];
  assert.ok(vodOptions);
  assert.equal(vodOptions.expectedMediaKind, "audio");
  assert.equal(vodOptions.expectedVideoId, "vod-audio");
  assert.equal((await vodOptions.loadSession()).playAuth, "auth-1");
  assert.equal(sessionRequests, 1);
  assert.equal((await vodOptions.loadSession()).playAuth, "auth-2");
  assert.equal(sessionRequests, 2);
});

test("调用方取消会中止会话请求并返回可识别取消错误", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const prepare = createExternalAudioPlaybackBackendPreparer();
  const preparing = prepare({
    type: "uploaded_audio",
    trackId: "track-cancel",
    audioMediaResourceId: "media-cancel",
    offsetSeconds: 0,
    load: (signal) => {
      requestSignal = signal;
      return new Promise((_, reject) => signal?.addEventListener(
        "abort",
        () => reject(new Error("fetch aborted")),
        { once: true },
      ));
    },
  }, {
    signal: controller.signal,
    vodContainerId: "unused",
    events: noopEvents(),
  });
  controller.abort();

  await assert.rejects(
    preparing,
    (error: unknown) => error instanceof MediaPlaybackCommandCancelledError,
  );
  assert.equal(requestSignal?.aborted, true);
});

test("准备超时覆盖会话请求阶段并主动 abort", async () => {
  let requestSignal: AbortSignal | undefined;
  const prepare = createExternalAudioPlaybackBackendPreparer({ readyTimeoutMs: 5 });
  const preparing = prepare({
    type: "uploaded_audio",
    trackId: "track-timeout",
    audioMediaResourceId: "media-timeout",
    offsetSeconds: 0,
    load: (signal) => {
      requestSignal = signal;
      return new Promise((_, reject) => signal?.addEventListener(
        "abort",
        () => reject(new Error("fetch aborted")),
        { once: true },
      ));
    },
  }, {
    signal: new AbortController().signal,
    vodContainerId: "unused",
    events: noopEvents(),
  });

  await assert.rejects(preparing, /等待替换音轨准备超时/);
  assert.equal(requestSignal?.aborted, true);
});

test("ready 后错误转发给组合 owner，ready 前错误拒绝并销毁 backend", async () => {
  const forwardedErrors: string[] = [];
  const readyBackend = new ReadyBackend();
  const capturedReadyEvents: MediaPlaybackBackendEvents[] = [];
  const prepareReady = createExternalAudioPlaybackBackendPreparer({
    createNativeBackend: (_url, events) => {
      capturedReadyEvents.push(events);
      queueMicrotask(() => events.onReady(readyBackend.getSnapshot()));
      return readyBackend;
    },
  });
  await prepareReady(uploadedSource("ready"), {
    signal: new AbortController().signal,
    vodContainerId: "unused",
    events: noopEvents(forwardedErrors),
  });
  capturedReadyEvents[0]?.onError("播放中错误");
  assert.deepEqual(forwardedErrors, ["播放中错误"]);

  const failedBackend = new ReadyBackend();
  const prepareFailure = createExternalAudioPlaybackBackendPreparer({
    createNativeBackend: (_url, events) => {
      queueMicrotask(() => events.onError("准备失败"));
      return failedBackend;
    },
  });
  await assert.rejects(prepareFailure(uploadedSource("failed"), {
    signal: new AbortController().signal,
    vodContainerId: "unused",
    events: noopEvents(),
  }), /准备失败/);
  assert.equal(failedBackend.disposed, true);
});

function uploadedSource(trackId: string) {
  return {
    type: "uploaded_audio" as const,
    trackId,
    audioMediaResourceId: `media-${trackId}`,
    offsetSeconds: 0,
    load: async () => ({ url: "/audio", mimeType: "audio/mpeg", duration: 90 }),
  };
}
