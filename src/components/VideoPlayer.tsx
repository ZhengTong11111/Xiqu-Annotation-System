import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

type VideoPlayerProps = {
  videoUrl: string;
  playbackRate: number;
  currentTime: number;
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
      isPlaying,
      onLoadedMetadata,
      onTimeUpdate,
      onPlayStateChange,
    },
    ref,
  ) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const animationFrameRef = useRef<number | null>(null);

    useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement, []);

    useEffect(() => {
      return () => {
        if (animationFrameRef.current !== null) {
          cancelAnimationFrame(animationFrameRef.current);
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

    return (
      <section className="panel video-panel">
        <div className="panel-header">
          <h2>视频播放器</h2>
          <span>{isPlaying ? "播放中" : "已暂停"}</span>
        </div>
        <video
          ref={videoRef}
          className="video-element"
          controls
          src={videoUrl}
          preload="metadata"
          onLoadedMetadata={(event) => onLoadedMetadata(event.currentTarget.duration)}
          onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
          onPlay={() => {
            onPlayStateChange(true);
            startFrameSync();
          }}
          onPause={() => {
            onPlayStateChange(false);
            stopFrameSync();
          }}
          onSeeking={(event) => onTimeUpdate(event.currentTarget.currentTime)}
          onSeeked={(event) => onTimeUpdate(event.currentTarget.currentTime)}
          onEnded={(event) => {
            onPlayStateChange(false);
            stopFrameSync();
            onTimeUpdate(event.currentTarget.currentTime);
          }}
          onRateChange={(event) => onTimeUpdate(event.currentTarget.currentTime)}
        />
        <div className="video-meta">
          <span>当前时间 {currentTime.toFixed(3)}s</span>
          <span>倍率 {playbackRate}x</span>
        </div>
      </section>
    );
  },
);

VideoPlayer.displayName = "VideoPlayer";
