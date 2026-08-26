import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AliyunVodPlaybackBackend } from "../media/aliyunVodPlaybackBackend";
import {
  LatestMediaPlaybackCommand,
  MediaPlaybackCommandCancelledError,
  createSafeMediaPlaybackController,
  type MediaPlaybackBackend,
  type MediaPlaybackController,
  type MediaPlaybackSource,
} from "../media/mediaPlaybackController";
import { NativeMediaPlaybackBackend } from "../media/nativeMediaPlaybackBackend";
import {
  ORIGINAL_AUDIO_SELECTION,
  SynchronizedMediaPlaybackRuntime,
  type SynchronizedAudioSelection,
} from "../media/synchronizedMediaPlaybackRuntime";
import type { SynchronizedPlaybackDiagnostic } from "../media/synchronizedPlaybackDiagnostic";
import type { SynchronizedPlaybackState } from "../media/synchronizedPlaybackState";

const PREVIEW_SEEK_EPSILON = 1 / 90;

type VideoPlayerProps = {
  source: MediaPlaybackSource;
  audioSelection?: SynchronizedAudioSelection;
  playbackRate: number;
  currentTime: number;
  previewTime: number | null;
  isPlaying: boolean;
  isDetached?: boolean;
  onToggleDetached?: () => void;
  onLoadedMetadata: (duration: number) => void;
  onTimeUpdate: (currentTime: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  onAudioPlaybackStateChange?: (state: SynchronizedPlaybackState) => void;
  onAudioPlaybackDiagnostic?: (diagnostic: SynchronizedPlaybackDiagnostic) => void;
  onAudioPlaybackError?: (message: string) => void;
};

type PlaybackViewState =
  | { status: "loading"; message: string }
  | { status: "ready"; message: null }
  | { status: "error"; message: string };

export const VideoPlayer = forwardRef<MediaPlaybackController, VideoPlayerProps>(
  (
    {
      source,
      audioSelection = ORIGINAL_AUDIO_SELECTION,
      playbackRate,
      currentTime,
      previewTime,
      isPlaying,
      isDetached = false,
      onToggleDetached,
      onLoadedMetadata,
      onTimeUpdate,
      onPlayStateChange,
      onAudioPlaybackStateChange,
      onAudioPlaybackDiagnostic,
      onAudioPlaybackError,
    },
    ref,
  ) => {
    const nativeVideoRef = useRef<HTMLVideoElement>(null);
    const synchronizedRuntimeRef = useRef<SynchronizedMediaPlaybackRuntime | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const previewSeekFrameRef = useRef<number | null>(null);
    const pendingPreviewTimeRef = useRef<number | null>(null);
    const currentTimeRef = useRef(currentTime);
    const audioSelectionRef = useRef(audioSelection);
    const isPreviewingRef = useRef(false);
    const resumeAfterPreviewRef = useRef(false);
    const callbacksRef = useRef({
      onLoadedMetadata,
      onTimeUpdate,
      onPlayStateChange,
      onAudioPlaybackStateChange,
      onAudioPlaybackDiagnostic,
      onAudioPlaybackError,
    });
    const commandRef = useRef<LatestMediaPlaybackCommand | null>(null);
    const controllerRef = useRef<MediaPlaybackController | null>(null);
    const [showNativeControls, setShowNativeControls] = useState(false);
    const [retryGeneration, setRetryGeneration] = useState(0);
    const [viewState, setViewState] = useState<PlaybackViewState>(() => getInitialViewState(source));
    const reactId = useId();
    const vodContainerId = useRef(`xiqu-vod-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`);
    const audioVodContainerId = useRef(
      `xiqu-audio-vod-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    );

    if (!synchronizedRuntimeRef.current) {
      synchronizedRuntimeRef.current = new SynchronizedMediaPlaybackRuntime({
        vodContainerId: audioVodContainerId.current,
        onStateChange: (state) => callbacksRef.current.onAudioPlaybackStateChange?.(state),
        onDiagnostic: (diagnostic) =>
          callbacksRef.current.onAudioPlaybackDiagnostic?.(diagnostic),
        onError: (message) => callbacksRef.current.onAudioPlaybackError?.(message),
      });
    }

    // 控制器对象在组件生命周期内保持稳定，后端则可随媒体来源安全替换。
    if (!commandRef.current) {
      commandRef.current = new LatestMediaPlaybackCommand(
        () => synchronizedRuntimeRef.current,
      );
    }
    if (!controllerRef.current) {
      controllerRef.current = createSafeMediaPlaybackController(
        commandRef.current,
        (message) => setViewState({ status: "error", message }),
      );
    }
    useImperativeHandle(ref, () => controllerRef.current as MediaPlaybackController, []);

    currentTimeRef.current = currentTime;
    audioSelectionRef.current = audioSelection;
    callbacksRef.current = {
      onLoadedMetadata,
      onTimeUpdate,
      onPlayStateChange,
      onAudioPlaybackStateChange,
      onAudioPlaybackDiagnostic,
      onAudioPlaybackError,
    };

    function stopFrameSync() {
      if (animationFrameRef.current === null) return;
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    // 原生 video 与 Aliplayer 都通过 backend snapshot 驱动同一高频播放头同步。
    function startFrameSync() {
      stopFrameSync();
      const syncCurrentTime = () => {
        const snapshot = commandRef.current?.getSnapshot();
        if (!snapshot) {
          animationFrameRef.current = null;
          return;
        }
        if (!isPreviewingRef.current) callbacksRef.current.onTimeUpdate(snapshot.currentTime);
        if (!snapshot.paused && !snapshot.ended) {
          animationFrameRef.current = requestAnimationFrame(syncCurrentTime);
        } else {
          animationFrameRef.current = null;
        }
      };
      animationFrameRef.current = requestAnimationFrame(syncCurrentTime);
    }

    // 取消属于正常的快速切换；真正的意外错误才需要进入外部音轨提示区。
    function reportExternalAudioSelectionError(error: unknown) {
      if (error instanceof MediaPlaybackCommandCancelledError) return;
      callbacksRef.current.onAudioPlaybackError?.(
        error instanceof Error ? error.message : "替换音轨切换失败。",
      );
    }

    // 主媒体控件和自然结束都可能绕过 App 命令；统一回写 runtime 才能保持替换音轨播放意图一致。
    function handleMasterPlaybackStateChange(playing: boolean) {
      const effectivePlaying = synchronizedRuntimeRef.current
        ?.notifyMasterPlaybackState(playing) ?? playing;
      callbacksRef.current.onPlayStateChange(effectivePlaying);
      if (effectivePlaying) startFrameSync();
      else stopFrameSync();
    }

    useLayoutEffect(() => {
      const command = commandRef.current as LatestMediaPlaybackCommand;
      const synchronizedRuntime = synchronizedRuntimeRef.current as SynchronizedMediaPlaybackRuntime;
      command.invalidate();
      synchronizedRuntime.detachMasterBackend();
      stopFrameSync();
      cancelPreviewFrame(previewSeekFrameRef);
      pendingPreviewTimeRef.current = null;
      isPreviewingRef.current = false;
      resumeAfterPreviewRef.current = false;
      setViewState(getInitialViewState(source));

      // 所有来源共用同一清理函数；Strict Effects、来源切换和 unavailable 卸载都不会留下帧或 backend。
      let installedMasterBackend: MediaPlaybackBackend | null = null;
      const cleanup = () => {
        command.invalidate();
        if (installedMasterBackend) {
          synchronizedRuntime.detachMasterBackend(installedMasterBackend);
          installedMasterBackend = null;
        }
        stopFrameSync();
        cancelPreviewFrame(previewSeekFrameRef);
      };
      if (source.type === "unavailable") return cleanup;

      const events = {
        onReady: (snapshot: ReturnType<MediaPlaybackBackend["getSnapshot"]>) => {
          setViewState({ status: "ready", message: null });
          callbacksRef.current.onLoadedMetadata(snapshot.duration);
          const initialTime = Math.min(currentTimeRef.current, snapshot.duration || currentTimeRef.current);
          if (Math.abs(snapshot.currentTime - initialTime) > 0.001) {
            void command.seek(initialTime).finally(() => {
              synchronizedRuntime.notifyMasterReady();
            });
          } else synchronizedRuntime.notifyMasterReady();
        },
        onTimeUpdate: (snapshot: ReturnType<MediaPlaybackBackend["getSnapshot"]>) => {
          if (!isPreviewingRef.current) callbacksRef.current.onTimeUpdate(snapshot.currentTime);
        },
        onPlayStateChange: (playing: boolean) => {
          handleMasterPlaybackStateChange(playing);
        },
        onError: (message: string) => setViewState({ status: "error", message }),
      };

      if (source.type === "native") {
        const media = nativeVideoRef.current;
        if (!media) {
          setViewState({ status: "error", message: "原生媒体元素初始化失败。" });
          return;
        }
        const backend = new NativeMediaPlaybackBackend(media);
        backend.setPlaybackRate(playbackRate);
        synchronizedRuntime.attachMasterBackend(backend);
        installedMasterBackend = backend;
      } else {
        const backend = new AliyunVodPlaybackBackend({
          containerId: vodContainerId.current,
          expectedVideoId: source.expectedVideoId,
          loadSession: source.loadSession,
          events,
        });
        backend.setPlaybackRate(playbackRate);
        synchronizedRuntime.attachMasterBackend(backend);
        installedMasterBackend = backend;
      }

      // 主视频重新挂载时恢复当前选择意图；backend 未 ready 时 runtime 仅静音并等待，不会提前创建从播放器。
      void synchronizedRuntime.selectAudio(audioSelectionRef.current).catch(
        reportExternalAudioSelectionError,
      );

      return cleanup;
    }, [source, retryGeneration]);

    // 外部来源只交给组合 runtime；主媒体尚未 ready 时 runtime 会保存意图，并由 ready 事件统一启动。
    useEffect(() => {
      const runtime = synchronizedRuntimeRef.current;
      if (!runtime) return;
      void runtime.selectAudio(audioSelection).catch(
        reportExternalAudioSelectionError,
      );
    }, [audioSelection]);

    // 倍率变化只经过统一控制器，不再由 App 直接写 HTMLVideoElement。
    useEffect(() => {
      controllerRef.current?.setPlaybackRate(playbackRate);
    }, [playbackRate]);

    // 外部时间变化仅在暂停状态同步媒体；播放中的时间回报不能反向制造 seek。
    useEffect(() => {
      if (previewTime !== null || isPreviewingRef.current) return;
      const controller = controllerRef.current;
      const snapshot = controller?.getSnapshot();
      if (!controller || !snapshot?.ready || (!snapshot.paused && !snapshot.ended)) return;
      if (Math.abs(snapshot.currentTime - currentTime) < 0.05) return;
      void controller.seek(currentTime);
    }, [currentTime, previewTime, source]);

    // 边界预览暂停真实播放、合并同一帧内的移动，并在结束时恢复正式播放头和原播放状态。
    useEffect(() => {
      const controller = controllerRef.current;
      if (!controller) return;
      if (previewTime === null) {
        if (!isPreviewingRef.current) return;
        pendingPreviewTimeRef.current = null;
        cancelPreviewFrame(previewSeekFrameRef);
        isPreviewingRef.current = false;
        // 外部播放命令可能在预览结束前到达；当前 backend 已在播放时也必须维持该最新意图。
        const resumePlayback = resumeAfterPreviewRef.current || !controller.getSnapshot().paused;
        resumeAfterPreviewRef.current = false;
        void controller.seek(currentTimeRef.current, { playAfterSeek: resumePlayback });
        return;
      }

      if (!isPreviewingRef.current) {
        const snapshot = controller.getSnapshot();
        resumeAfterPreviewRef.current = !snapshot.paused && !snapshot.ended;
        if (resumeAfterPreviewRef.current) controller.pause();
        isPreviewingRef.current = true;
      }
      pendingPreviewTimeRef.current = previewTime;
      if (previewSeekFrameRef.current !== null) return;
      previewSeekFrameRef.current = requestAnimationFrame(() => {
        previewSeekFrameRef.current = null;
        const nextPreviewTime = pendingPreviewTimeRef.current;
        pendingPreviewTimeRef.current = null;
        if (nextPreviewTime === null) return;
        const snapshot = controller.getSnapshot();
        if (Math.abs(snapshot.currentTime - nextPreviewTime) < PREVIEW_SEEK_EPSILON) return;
        void controller.seek(nextPreviewTime);
      });
    }, [previewTime]);

    const unavailable = source.type === "unavailable";
    const showStatus = unavailable || viewState.status !== "ready";

    return (
      <section className="panel video-panel">
        <div className="panel-header">
          <h2>视频播放器</h2>
          <div className="panel-header-actions">
            <span>{previewTime === null ? (isPlaying ? "播放中" : "已暂停") : "边界预览中"}</span>
            {onToggleDetached ? (
              <button
                type="button"
                className="panel-window-button"
                title={isDetached ? "收回工作台" : "弹出独立窗口"}
                aria-label={isDetached ? "收回工作台" : "弹出独立窗口"}
                onClick={onToggleDetached}
              >
                {isDetached ? "↩" : "↗"}
              </button>
            ) : null}
          </div>
        </div>
        <div
          className="video-surface"
          onPointerEnter={() => setShowNativeControls(true)}
          onPointerLeave={() => setShowNativeControls(false)}
          onFocus={() => setShowNativeControls(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setShowNativeControls(false);
            }
          }}
        >
          {source.type === "native" ? (
            <video
              key={`${source.url}:${retryGeneration}`}
              ref={nativeVideoRef}
              className="video-element"
              controls={showNativeControls}
              src={source.url}
              preload="metadata"
              onLoadedMetadata={() => {
                const runtime = synchronizedRuntimeRef.current;
                const snapshot = runtime?.getSnapshot();
                if (!runtime || !snapshot) return;
                setViewState({ status: "ready", message: null });
                callbacksRef.current.onLoadedMetadata(snapshot.duration);
                const safeTime = Math.min(currentTimeRef.current, snapshot.duration || currentTimeRef.current);
                if (Math.abs(snapshot.currentTime - safeTime) > 0.001) {
                  void commandRef.current?.seek(safeTime).finally(() => {
                    runtime.notifyMasterReady();
                  });
                } else runtime.notifyMasterReady();
              }}
              onTimeUpdate={() => {
                const snapshot = synchronizedRuntimeRef.current?.getSnapshot();
                if (snapshot && !isPreviewingRef.current) {
                  callbacksRef.current.onTimeUpdate(snapshot.currentTime);
                }
              }}
              onPlay={() => {
                handleMasterPlaybackStateChange(true);
              }}
              onPause={() => {
                handleMasterPlaybackStateChange(false);
              }}
              onSeeking={() => {
                const snapshot = synchronizedRuntimeRef.current?.getSnapshot();
                if (snapshot && !isPreviewingRef.current) {
                  callbacksRef.current.onTimeUpdate(snapshot.currentTime);
                }
              }}
              onSeeked={() => {
                const snapshot = synchronizedRuntimeRef.current?.getSnapshot();
                if (snapshot && !isPreviewingRef.current) {
                  callbacksRef.current.onTimeUpdate(snapshot.currentTime);
                }
              }}
              onEnded={() => {
                const snapshot = synchronizedRuntimeRef.current?.getSnapshot();
                handleMasterPlaybackStateChange(false);
                if (snapshot) callbacksRef.current.onTimeUpdate(snapshot.currentTime);
              }}
              onError={() => setViewState({
                status: "error",
                message: "无法读取当前本地或服务器媒体，请检查文件与访问权限。",
              })}
            />
          ) : null}
          {source.type === "aliyun_vod" ? (
            <div id={vodContainerId.current} className="video-element vod-player-element" />
          ) : null}
          <div
            id={audioVodContainerId.current}
            className="external-audio-vod-host"
            aria-hidden="true"
            ref={(element) => {
              // 第三方播放器会注入可聚焦控件；inert 保证隐藏音轨不会进入键盘导航。
              if (element) element.inert = true;
            }}
          />
          {showStatus ? (
            <div className="video-unavailable-state video-playback-status" role="status">
              <strong>{viewState.status === "loading" ? "正在准备媒体" : "媒体暂不可播放"}</strong>
              <span>{unavailable ? source.message : viewState.message}</span>
              {!unavailable && viewState.status === "error" ? (
                <button type="button" className="secondary-button" onClick={() => setRetryGeneration((value) => value + 1)}>
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="video-meta">
          <span>当前时间 {currentTime.toFixed(3)}s</span>
          <span>{previewTime === null ? "预览帧 -" : `预览帧 ${previewTime.toFixed(3)}s`}</span>
          <span>倍率 {playbackRate}x</span>
        </div>
      </section>
    );
  },
);

VideoPlayer.displayName = "VideoPlayer";

// 不可用来源不进入“加载中”，其原因由上游资源绑定状态直接给出。
function getInitialViewState(source: MediaPlaybackSource): PlaybackViewState {
  if (source.type === "unavailable") return { status: "error", message: source.message };
  return {
    status: "loading",
    message: source.type === "aliyun_vod" ? "正在获取临时播放凭据。" : "正在读取媒体元数据。",
  };
}

function cancelPreviewFrame(frameRef: { current: number | null }) {
  if (frameRef.current === null) return;
  cancelAnimationFrame(frameRef.current);
  frameRef.current = null;
}
