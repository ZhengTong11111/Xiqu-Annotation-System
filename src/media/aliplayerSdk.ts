const ALIPLAYER_VERSION = "2.38.3";
const ALIPLAYER_SCRIPT_URL = `https://g.alicdn.com/apsara-media-box/imp-web-player/${ALIPLAYER_VERSION}/aliplayer-min.js`;
const ALIPLAYER_STYLE_URL = `https://g.alicdn.com/apsara-media-box/imp-web-player/${ALIPLAYER_VERSION}/skins/default/aliplayer-min.css`;
const ALIPLAYER_LOAD_TIMEOUT_MS = 15_000;
const ALIPLAYER_SCRIPT_MARKER = "xiqu-aliplayer-sdk";
const ALIPLAYER_STYLE_MARKER = "xiqu-aliplayer-style";

export type AliplayerEventHandler = (event?: unknown) => void;

export interface AliplayerInstance {
  on(event: string, handler: AliplayerEventHandler): void;
  off?(event: string, handler: AliplayerEventHandler): void;
  play(): void;
  pause(): void;
  seek(time: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getStatus?(): string;
  setSpeed(rate: number): void;
  dispose(): void;
}

export type AliplayerOptions = {
  id: string;
  vid: string;
  playauth: string;
  width: string;
  height: string;
  autoplay: boolean;
  preload: boolean;
  isLive: boolean;
  controlBarVisibility: "hover";
  useH5Prism: boolean;
};

export type AliplayerConstructor = new (
  options: AliplayerOptions,
  ready?: (player: AliplayerInstance) => void,
) => AliplayerInstance;

declare global {
  interface Window {
    Aliplayer?: AliplayerConstructor;
  }
}

let loaderPromise: Promise<AliplayerConstructor> | null = null;

/**
 * 以固定官方 URL 单例加载 Aliplayer，杜绝用户输入脚本地址和并发重复注入。
 *
 * 失败的 script 会移除并清空 Promise，下一次显式重试可以重新加载；成功样式保留供后续实例复用。
 */
export function loadAliplayerSdk() {
  if (window.Aliplayer) return Promise.resolve(window.Aliplayer);
  if (loaderPromise) return loaderPromise;
  loaderPromise = new Promise<AliplayerConstructor>((resolve, reject) => {
    ensureAliplayerStyle(document);
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-xiqu-loader="${ALIPLAYER_SCRIPT_MARKER}"]`,
    );
    const script = existing ?? document.createElement("script");
    let settled = false;
    const finish = (result: "resolve" | "reject") => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
      if (result === "resolve" && window.Aliplayer) {
        resolve(window.Aliplayer);
        return;
      }
      script.remove();
      loaderPromise = null;
      reject(new Error("阿里云播放器组件加载失败。"));
    };
    const handleLoad = () => {
      script.dataset.xiquLoaded = "true";
      finish(window.Aliplayer ? "resolve" : "reject");
    };
    const handleError = () => finish("reject");
    const timeout = window.setTimeout(() => finish("reject"), ALIPLAYER_LOAD_TIMEOUT_MS);
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    if (!existing) {
      script.src = ALIPLAYER_SCRIPT_URL;
      script.async = true;
      script.dataset.xiquLoader = ALIPLAYER_SCRIPT_MARKER;
      document.head.appendChild(script);
    } else if (script.dataset.xiquLoaded === "true") {
      // 页面若残留已加载但没有正确注册全局的脚本，不能等待一个不会再次发生的 load 事件。
      finish("reject");
    }
  });
  return loaderPromise;
}

// 样式与脚本独立去重；样式加载失败由播放器 ready/error 状态统一呈现。
function ensureAliplayerStyle(target: Document) {
  if (target.querySelector(`link[data-xiqu-loader="${ALIPLAYER_STYLE_MARKER}"]`)) return;
  const link = target.createElement("link");
  link.rel = "stylesheet";
  link.href = ALIPLAYER_STYLE_URL;
  link.dataset.xiquLoader = ALIPLAYER_STYLE_MARKER;
  target.head.appendChild(link);
}

// 测试只重置本模块 Promise；真实页面中的成功全局由官方 SDK 自己持有。
export function resetAliplayerLoaderForTests() {
  loaderPromise = null;
}
