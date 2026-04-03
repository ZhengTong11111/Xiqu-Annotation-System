import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

const PREVIEW_SEEK_EPSILON = 1 / 90;

type VideoPlayerProps = {
  videoUrl: string;
  playbackRate: number;
  currentTime: number;
  previewTime: number | null;
  isPlaying: boolean;
  onLoadedMetadata: (duration: number) => void;
  onTimeUpdate: (currentTime: number) => void;
  onPlayStateChange: (playing: boolean) => void;
};

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  (
    {
      videoUrl,
      playbackRate,
      currentTime,
      previewTime,
      isPlaying,
      onLoadedMetadata,
      onTimeUpdate,
      onPlayStateChange,
    },
    ref,
  ) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const animationFrameRef = useRef<number | null>(null);
    const currentTimeRef = useRef(currentTime);
    const isPreviewingRef = useRef(false);
    const resumeAfterPreviewRef = useRef(false);
    const previewSeekFrameRef = useRef<number | null>(null);
    const pendingPreviewTimeRef = useRef<number | null>(null);
    const [showNativeControls, setShowNativeControls] = useState(false);

    useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement);

    useEffect(() => {
      currentTimeRef.current = currentTime;
    }, [currentTime]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video || previewTime !== null || isPreviewingRef.current) {
        return;
      }
      if (video.readyState < 1) {
        return;
      }
      if (Math.abs(video.currentTime - currentTime) < 0.05) {
        return;
      }
      if (!video.paused && !video.ended) {
        return;
      }
      try {
        video.currentTime = currentTime;
      } catch {
        // Ignore transient media seek errors until metadata is stable.
      }
    }, [currentTime, previewTime, videoUrl]);

    useEffect(() => {
      if (!videoRef.current) {
        return;
      }
      videoRef.current.volume = 0.5;
    }, []);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      stopFrameSync();
      if (previewSeekFrameRef.current !== null) {
        cancelAnimationFrame(previewSeekFrameRef.current);
        previewSeekFrameRef.current = null;
      }
      pendingPreviewTimeRef.current = null;
      isPreviewingRef.current = false;
      resumeAfterPreviewRef.current = false;
    }, [videoUrl]);

    useEffect(() => {
      return () => {
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current);
        }
        if (previewSeekFrameRef.current !== null) {
          cancelAnimationFrame(previewSeekFrameRef.current);
        }
      };
    }, []);

    function stopFrameSync() {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    }

    function startFrameSync() {
      stopFrameSync();

      const syncCurrentTime = () => {
        if (!videoRef.current) {
          animationFrameRef.current = null;
          return;
        }
        onTimeUpdate(videoRef.current.currentTime);
        if (!videoRef.current.paused && !videoRef.current.ended) {
          animationFrameRef.current = requestAnimationFrame(syncCurrentTime);
        } else {
          animationFrameRef.current = null;
        }
      };

      animationFrameRef.current = requestAnimationFrame(syncCurrentTime);
    }

    useEffect(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      if (previewTime === null) {
        if (!isPreviewingRef.current) {
          return;
        }
        pendingPreviewTimeRef.current = null;
        if (previewSeekFrameRef.current !== null) {
          cancelAnimationFrame(previewSeekFrameRef.current);
          previewSeekFrameRef.current = null;
        }
        isPreviewingRef.current = false;
        const resumePlayback = resumeAfterPreviewRef.current;
        resumeAfterPreviewRef.current = false;
        if (Math.abs(video.currentTime - currentTimeRef.current) > 0.001) {
          video.currentTime = currentTimeRef.current;
        }
        if (resumePlayback) {
          void video.play();
        }
        return;
      }

      if (!isPreviewingRef.current) {
        resumeAfterPreviewRef.current = !video.paused && !video.ended;
        if (resumeAfterPreviewRef.current) {
          video.pause();
        }
        isPreviewingRef.current = true;
      }

      pendingPreviewTimeRef.current = previewTime;
      if (previewSeekFrameRef.current !== null) {
        return;
      }
      previewSeekFrameRef.current = requestAnimationFrame(() => {
        previewSeekFrameRef.current = null;
        if (!videoRef.current || pendingPreviewTimeRef.current === null) {
          return;
        }
        const nextPreviewTime = pendingPreviewTimeRef.current;
        pendingPreviewTimeRef.current = null;
        if (Math.abs(videoRef.current.currentTime - nextPreviewTime) < PREVIEW_SEEK_EPSILON) {
          return;
        }
        videoRef.current.currentTime = nextPreviewTime;
      });
    }, [previewTime]);

    return (
      <section className="panel video-panel">
        <div className="panel-header">
          <h2>视频播放器</h2>
          <span>{previewTime === null ? (isPlaying ? "播放中" : "已暂停") : "边界预览中"}</span>
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
          <video
            ref={videoRef}
            className="video-element"
            controls={showNativeControls}
            src={videoUrl}
            preload="metadata"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              const safeTime = Math.max(0, Math.min(currentTimeRef.current, Number.isFinite(video.duration) ? video.duration : currentTimeRef.current));
              if (Math.abs(video.currentTime - safeTime) > 0.001) {
                try {
                  video.currentTime = safeTime;
                } catch {
                  // Ignore seek failures before the browser fully settles the media element.
                }
              }
              onLoadedMetadata(video.duration);
              onTimeUpdate(safeTime);
            }}
            onTimeUpdate={(event) => {
              if (!isPreviewingRef.current) {
                onTimeUpdate(event.currentTarget.currentTime);
              }
            }}
            onPlay={() => {
              onPlayStateChange(true);
              startFrameSync();
            }}
            onPause={() => {
              onPlayStateChange(false);
              stopFrameSync();
            }}
            onSeeking={(event) => {
              if (!isPreviewingRef.current) {
                onTimeUpdate(event.currentTarget.currentTime);
              }
            }}
            onSeeked={(event) => {
              if (!isPreviewingRef.current) {
                onTimeUpdate(event.currentTarget.currentTime);
              }
            }}
            onEnded={(event) => {
              onPlayStateChange(false);
              stopFrameSync();
              onTimeUpdate(event.currentTarget.currentTime);
            }}
            onRateChange={(event) => {
              if (!isPreviewingRef.current) {
                onTimeUpdate(event.currentTarget.currentTime);
              }
            }}
          />
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
