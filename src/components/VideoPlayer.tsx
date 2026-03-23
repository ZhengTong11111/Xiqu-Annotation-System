import { forwardRef } from "react";

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
    return (
      <section className="panel video-panel">
        <div className="panel-header">
          <h2>视频播放器</h2>
          <span>{isPlaying ? "播放中" : "已暂停"}</span>
        </div>
        <video
          ref={ref}
          className="video-element"
          controls
          src={videoUrl}
          preload="metadata"
          onLoadedMetadata={(event) => onLoadedMetadata(event.currentTarget.duration)}
          onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
          onPlay={() => onPlayStateChange(true)}
          onPause={() => onPlayStateChange(false)}
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
