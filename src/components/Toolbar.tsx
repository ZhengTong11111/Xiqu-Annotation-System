import type { ChangeEvent } from "react";
import type { BuiltinTrackId } from "../types";

type ToolbarProps = {
  isPlaying: boolean;
  playbackRate: number;
  canUndo: boolean;
  canRedo: boolean;
  activeBuiltinTrackIds: BuiltinTrackId[];
  onTogglePlay: () => void;
  onStep: (delta: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onVideoFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSrtFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onProjectFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSaveProject: () => void;
  onExportTrack: (kind: "character" | "singing" | "hand" | "body") => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddAction: (trackId: "hand-action" | "body-action") => void;
};

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5];

export function Toolbar({
  isPlaying,
  playbackRate,
  canUndo,
  canRedo,
  activeBuiltinTrackIds,
  onTogglePlay,
  onStep,
  onPlaybackRateChange,
  onVideoFileChange,
  onSrtFileChange,
  onProjectFileChange,
  onSaveProject,
  onExportTrack,
  onUndo,
  onRedo,
  onAddAction,
}: ToolbarProps) {
  const hasHandTrack = activeBuiltinTrackIds.includes("hand-action");
  const hasBodyTrack = activeBuiltinTrackIds.includes("body-action");

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <label className="file-button">
          导入视频
          <input type="file" accept="video/*" onChange={onVideoFileChange} />
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
        <button onClick={() => onExportTrack("hand")}>导出手部动作</button>
        <button onClick={() => onExportTrack("body")}>导出肢体动作</button>
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
        <button onClick={() => onAddAction("hand-action")} disabled={!hasHandTrack}>
          新增手部动作
        </button>
        <button onClick={() => onAddAction("body-action")} disabled={!hasBodyTrack}>
          新增肢体动作
        </button>
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
