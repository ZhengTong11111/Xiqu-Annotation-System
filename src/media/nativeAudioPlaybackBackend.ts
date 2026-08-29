import {
  type MediaPlaybackBackend,
  type MediaPlaybackBackendEvents,
} from "./mediaPlaybackController";
import {
  NativeMediaPlaybackBackend,
  type NativeMediaElementPort,
} from "./nativeMediaPlaybackBackend";

export type NativeAudioElementPort = NativeMediaElementPort & {
  src: string;
  preload: string;
  load(): void;
  remove?(): void;
};

/**
 * HTMLAudioElement 的从音轨适配器。底层时间命令复用原生媒体 backend，本层只拥有事件和缓冲生命周期。
 */
export class NativeAudioPlaybackBackend implements MediaPlaybackBackend {
  private readonly commandBackend: NativeMediaPlaybackBackend;
  private disposed = false;
  private buffering = false;
  private commandedSeekCount = 0;
  private readonly listeners: Array<[string, EventListener]>;

  constructor(
    private readonly media: NativeAudioElementPort,
    private readonly events: MediaPlaybackBackendEvents,
  ) {
    this.commandBackend = new NativeMediaPlaybackBackend(media);
    const onReady: EventListener = () => {
      if (this.disposed) return;
      this.setBuffering(false);
      this.events.onReady(this.getSnapshot());
    };
    const onTimeUpdate: EventListener = () => {
      if (!this.disposed) this.events.onTimeUpdate(this.getSnapshot());
    };
    const onPlay: EventListener = () => {
      if (!this.disposed) this.events.onPlayStateChange(true);
    };
    const onPause: EventListener = () => {
      if (!this.disposed) this.events.onPlayStateChange(false);
    };
    const onWaiting: EventListener = () => {
      // 浏览器会在受控 currentTime 跳转时短暂发出 waiting；这属于同步命令的一部分，
      // 不能冒充网络断流并让组合运行时再次暂停、再次 seek。
      if (!this.disposed && this.commandedSeekCount === 0) this.setBuffering(true);
    };
    const onCanPlay: EventListener = () => {
      if (!this.disposed) this.setBuffering(false);
    };
    const onEnded: EventListener = () => {
      if (this.disposed) return;
      this.events.onPlayStateChange(false);
      this.events.onTimeUpdate(this.getSnapshot());
    };
    const onError: EventListener = () => {
      if (!this.disposed) this.events.onError("外部音频播放失败，请检查资源和权限。");
    };
    this.listeners = [
      ["loadedmetadata", onReady],
      ["canplay", onCanPlay],
      ["canplaythrough", onCanPlay],
      ["timeupdate", onTimeUpdate],
      ["seeked", onTimeUpdate],
      ["play", onPlay],
      ["pause", onPause],
      ["waiting", onWaiting],
      ["ended", onEnded],
      ["error", onError],
    ];
    for (const [type, listener] of this.listeners) media.addEventListener(type, listener);
  }

  getSnapshot() { return this.commandBackend.getSnapshot(); }
  async seek(time: number) {
    this.commandedSeekCount += 1;
    try {
      await this.commandBackend.seek(time);
    } finally {
      this.commandedSeekCount = Math.max(0, this.commandedSeekCount - 1);
    }
  }
  play() { return this.commandBackend.play(); }
  pause() { this.commandBackend.pause(); }
  setPlaybackRate(rate: number) { this.commandBackend.setPlaybackRate(rate); }
  setVolume(volume: number) { this.commandBackend.setVolume(volume); }
  setMuted(muted: boolean) { this.commandBackend.setMuted(muted); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [type, listener] of this.listeners) {
      this.media.removeEventListener(type, listener);
    }
    this.commandBackend.dispose();
    try {
      this.media.pause();
      this.media.src = "";
      this.media.load();
      this.media.remove?.();
    } catch {
      // 已损坏的媒体元素仍已移除监听并取消等待命令，清理不能反向抛到 React 卸载路径。
    }
  }

  private setBuffering(buffering: boolean) {
    if (this.buffering === buffering) return;
    this.buffering = buffering;
    this.events.onBufferingChange?.(buffering);
  }
}

/**
 * 分离预览可能属于另一个 document；从既有容器的 ownerDocument 创建 audio，
 * 才能保证生命周期、媒体策略和可观测时钟都属于正确窗口。
 */
export function createContainerNativeAudioPlaybackBackend(
  containerId: string,
  url: string,
  events: MediaPlaybackBackendEvents,
) {
  const container = typeof document === "undefined"
    ? null
    : document.getElementById(containerId);
  if (!container) return createNativeAudioPlaybackBackend(url, events);
  const media = container.ownerDocument.createElement("audio");
  media.hidden = true;
  media.setAttribute("aria-hidden", "true");
  container.appendChild(media);
  return createNativeAudioPlaybackBackend(
    url,
    events,
    () => media as NativeAudioElementPort,
  );
}

export function createNativeAudioPlaybackBackend(
  url: string,
  events: MediaPlaybackBackendEvents,
  createElement: () => NativeAudioElementPort = () => new Audio() as NativeAudioElementPort,
) {
  const media = createElement();
  media.preload = "auto";
  media.src = url;
  const backend = new NativeAudioPlaybackBackend(media, events);
  // listener 必须先安装再 load，缓存命中时同步/微任务 metadata 事件才不会丢失。
  media.load();
  return backend;
}
