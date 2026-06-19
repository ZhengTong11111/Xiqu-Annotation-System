import type { ChangeEvent, RefObject } from "react";

type ToolbarProps = {
  isPlaying: boolean;
  playbackRate: number;
  canUndo: boolean;
  canRedo: boolean;
  onTogglePlay: () => void;
  onStep: (delta: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  videoFileInputRef?: RefObject<HTMLInputElement>;
  onVideoFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSrtFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onProjectFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSaveProject: () => void;
  onExportTrack: (kind: "character" | "singing") => void;
  onUndo: () => void;
  onRedo: () => void;
};

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5];

export function Toolbar({
  isPlaying,
  playbackRate,
  canUndo,
  canRedo,
  onTogglePlay,
  onStep,
  onPlaybackRateChange,
  videoFileInputRef,
  onVideoFileChange,
  onSrtFileChange,
  onProjectFileChange,
  onSaveProject,
  onExportTrack,
  onUndo,
  onRedo,
}: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <label className="file-button">
          导入视频
          <input ref={videoFileInputRef} type="file" accept="video/*" onChange={onVideoFileChange} />
        </label>
        <label className="file-button">
          导入句级 SRT
          <input type="file" accept=".srt" onChange={onSrtFileChange} />
        </label>
        <label className="file-button">
          导入项目
          <input type="file" accept=".json" onChange={onProjectFileChange} />
        </label>
        <button onClick={onSaveProject} title="保存项目 (Command/Ctrl + S)">
          保存项目
        </button>
        <button onClick={() => onExportTrack("character")}>导出逐字 SRT</button>
        <button onClick={() => onExportTrack("singing")}>导出唱腔 SRT</button>
      </div>

      <div className="toolbar-group">
        <button onClick={onTogglePlay}>{isPlaying ? "暂停" : "播放"}</button>
        <button onClick={() => onStep(-0.1)}>-0.1s</button>
        <button onClick={() => onStep(0.1)}>+0.1s</button>
        <button onClick={() => onStep(-0.04)}>-1 帧</button>
        <button onClick={() => onStep(0.04)}>+1 帧</button>
        <select
          value={playbackRate}
          onChange={(event) => onPlaybackRateChange(Number(event.target.value))}
        >
          {playbackRates.map((rate) => (
            <option key={rate} value={rate}>
              {rate}x
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar-group">
        <button onClick={onUndo} disabled={!canUndo}>
          撤销
        </button>
        <button onClick={onRedo} disabled={!canRedo}>
          重做
        </button>
      </div>
    </header>
  );
}
