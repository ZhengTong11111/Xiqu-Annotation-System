import type {
  AliyunVodPlaybackSession,
  MediaAudioTrackPlaybackSession,
} from "@xiqu/shared";
import {
  AliyunVodPlaybackBackend,
  type AliyunVodMediaClock,
  type AliyunVodPlaybackBackendOptions,
} from "./aliyunVodPlaybackBackend";
import {
  MediaPlaybackCommandCancelledError,
  type MediaPlaybackBackend,
  type MediaPlaybackBackendEvents,
  type MediaPlaybackSnapshot,
} from "./mediaPlaybackController";
import { createNativeAudioPlaybackBackend } from "./nativeAudioPlaybackBackend";
import {
  RefreshingNativeAudioPlaybackBackend,
  type RefreshingNativeAudioPlaybackBackendOptions,
} from "./refreshingNativeAudioPlaybackBackend";

export type ExternalAudioPlaybackSource =
  | {
      type: "uploaded_audio";
      trackId: string;
      audioMediaResourceId: string;
      offsetSeconds: number;
      load: (signal?: AbortSignal) => Promise<{
        url: string;
        mimeType: string;
        duration: number | null;
      }>;
    }
  | {
      type: "aliyun_vod_audio";
      trackId: string;
      audioMediaResourceId: string;
      offsetSeconds: number;
      loadSession: (signal?: AbortSignal) => Promise<AliyunVodPlaybackSession>;
    }
  | {
      type: "aliyun_vod_rendition_audio";
      trackId: string;
      audioMediaResourceId: string;
      renditionJobId: string;
      offsetSeconds: number;
      loadSession: (
        signal?: AbortSignal,
      ) => Promise<Extract<
        MediaAudioTrackPlaybackSession,
        { sourceType: "aliyun_vod_rendition" }
      >>;
    };

export type ExternalAudioPlaybackBackendEvents = Omit<
  MediaPlaybackBackendEvents,
  "onReady"
>;

export type PreparedExternalAudioPlaybackBackend = {
  backend: MediaPlaybackBackend;
  readySnapshot: MediaPlaybackSnapshot;
};

export type PrepareExternalAudioPlaybackBackend = (
  source: ExternalAudioPlaybackSource,
  options: {
    signal: AbortSignal;
    vodContainerId: string;
    readVodMediaClock?: () => AliyunVodMediaClock | null;
    events: ExternalAudioPlaybackBackendEvents;
  },
) => Promise<PreparedExternalAudioPlaybackBackend>;

const EXTERNAL_AUDIO_READY_TIMEOUT_MS = 20_000;

type ExternalAudioBackendFactoryDependencies = {
  createNativeBackend?: (
    url: string,
    events: MediaPlaybackBackendEvents,
  ) => MediaPlaybackBackend;
  createVodBackend?: (options: AliyunVodPlaybackBackendOptions) => MediaPlaybackBackend;
  createRenditionNativeBackend?: (
    options: RefreshingNativeAudioPlaybackBackendOptions,
  ) => MediaPlaybackBackend;
  readyTimeoutMs?: number;
};

/**
 * 把延迟平台来源准备成统一音频 backend；URL、PlayAuth 和 DOM 细节到此为止，不进入组合状态机。
 */
export function createExternalAudioPlaybackBackendPreparer(
  dependencies: ExternalAudioBackendFactoryDependencies = {},
): PrepareExternalAudioPlaybackBackend {
  const createNativeBackend = dependencies.createNativeBackend ??
    createNativeAudioPlaybackBackend;
  const createVodBackend = dependencies.createVodBackend ??
    ((options) => new AliyunVodPlaybackBackend(options));
  const createRenditionNativeBackend = dependencies.createRenditionNativeBackend ??
    ((options) => new RefreshingNativeAudioPlaybackBackend(options));
  const readyTimeoutMs = dependencies.readyTimeoutMs ?? EXTERNAL_AUDIO_READY_TIMEOUT_MS;

  return async (source, options) => {
    if (options.signal.aborted) throw createCancelledError();
    let backend: MediaPlaybackBackend | null = null;
    let ready = false;
    let timedOut = false;
    let resolveReady: ((snapshot: MediaPlaybackSnapshot) => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    const preparationAbortController = new AbortController();
    const readyPromise = new Promise<MediaPlaybackSnapshot>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // 会话请求仍在等待时 abort 可能先拒绝 ready；观察者只防止未处理 rejection，最终错误仍由下方 await 返回。
    void readyPromise.catch(() => undefined);
    const timeout = globalThis.setTimeout(() => {
      timedOut = true;
      preparationAbortController.abort();
    }, readyTimeoutMs);
    const forwardCallerAbort = () => preparationAbortController.abort();
    const handlePreparationAbort = () => {
      rejectReady?.(createCancelledError());
      backend?.dispose();
      backend = null;
    };
    options.signal.addEventListener("abort", forwardCallerAbort, { once: true });
    preparationAbortController.signal.addEventListener(
      "abort",
      handlePreparationAbort,
      { once: true },
    );

    // ready 前的 error 负责拒绝工厂，ready 后的 error 才交给组合 owner 做回退。
    const events: MediaPlaybackBackendEvents = {
      onReady: (snapshot) => {
        if (preparationAbortController.signal.aborted) return;
        ready = true;
        resolveReady?.(snapshot);
      },
      onTimeUpdate: options.events.onTimeUpdate,
      onPlayStateChange: options.events.onPlayStateChange,
      onBufferingChange: options.events.onBufferingChange,
      onError: (message) => {
        if (!ready) rejectReady?.(new Error(message));
        else options.events.onError(message);
      },
    };

    try {
      if (source.type === "uploaded_audio") {
        const loaded = await source.load(preparationAbortController.signal);
        if (preparationAbortController.signal.aborted) throw createCancelledError();
        backend = createNativeBackend(loaded.url, events);
      } else if (source.type === "aliyun_vod_rendition_audio") {
        const initialSession = await source.loadSession(preparationAbortController.signal);
        if (preparationAbortController.signal.aborted) throw createCancelledError();
        // 指定 JobId 后，服务端返回的是可直接 Range 播放的 HTTPS MP3；使用原生 audio
        // 可避开隐藏 Aliplayer 在随机 seek 后的解码冷启动，同时仍由专用 backend 负责短期 URL 续签。
        backend = createRenditionNativeBackend({
          containerId: options.vodContainerId,
          initialSession,
          expectedVideoId: initialSession.videoId,
          expectedRenditionJobId: source.renditionJobId,
          loadSession: source.loadSession,
          // 只有测试/宿主显式注入时才覆盖默认工厂；产品路径必须从隐藏容器的 ownerDocument 创建 audio。
          ...(dependencies.createNativeBackend
            ? { createNativeBackend: dependencies.createNativeBackend }
            : {}),
          events,
        });
      } else {
        // 首份会话既提供受服务端校验的媒资身份，也会被播放器首次加载复用，不能额外请求第二份 PlayAuth。
        let initialSession: AliyunVodPlaybackSession | null =
          await source.loadSession(preparationAbortController.signal);
        if (preparationAbortController.signal.aborted) throw createCancelledError();
        backend = createVodBackend({
          containerId: options.vodContainerId,
          expectedVideoId: initialSession.videoId,
          expectedMediaKind: "audio",
          loadSession: async (signal) => {
            if (initialSession) {
              const session = initialSession;
              initialSession = null;
              return session;
            }
            // 首次准备结束后，续签请求改由 VOD backend 自己的生命周期 signal 管理。
            // 这样切换文件或销毁音轨时可以中止正在进行的 HTTP 请求，而不只是忽略迟到响应。
            return source.loadSession(signal);
          },
          readMediaClock: options.readVodMediaClock,
          events,
        });
      }
      const readySnapshot = await readyPromise;
      if (preparationAbortController.signal.aborted) throw createCancelledError();
      return { backend, readySnapshot };
    } catch (error) {
      backend?.dispose();
      if (options.signal.aborted) throw createCancelledError();
      if (timedOut) throw new Error("等待替换音轨准备超时。");
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      options.signal.removeEventListener("abort", forwardCallerAbort);
      preparationAbortController.signal.removeEventListener(
        "abort",
        handlePreparationAbort,
      );
      resolveReady = null;
      rejectReady = null;
    }
  };
}

export const prepareExternalAudioPlaybackBackend =
  createExternalAudioPlaybackBackendPreparer();

function createCancelledError() {
  return new MediaPlaybackCommandCancelledError("替换音轨准备已被后续选择取消。");
}
