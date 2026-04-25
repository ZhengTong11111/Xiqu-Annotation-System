import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, RefObject } from "react";
import type { ProjectSyncStatus } from "../state/projectDocumentState";
import type { BuiltinTrackId } from "../types";

type TopMenuBarProps = {
  isPlaying: boolean;
  playbackRate: number;
  loopPlaybackEnabled: boolean;
  hasLoopPlaybackRange: boolean;
  canUndo: boolean;
  canRedo: boolean;
  syncStatus: ProjectSyncStatus;
  localRevision: number;
  savedRevision: number;
  pendingOperationCount: number;
  activeBuiltinTrackIds: BuiltinTrackId[];
  videoFileInputRef: RefObject<HTMLInputElement>;
  srtFileInputRef: RefObject<HTMLInputElement>;
  projectFileInputRef: RefObject<HTMLInputElement>;
  mergeProjectFileInputRef: RefObject<HTMLInputElement>;
  onVideoFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSrtFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onProjectFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onMergeProjectFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSaveProject: () => void;
  onExportTrack: (kind: "character" | "singing" | "hand" | "body") => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddAction: (trackId: "hand-action" | "body-action") => void;
  onTogglePlay: () => void;
  onStep: (delta: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onToggleLoopPlayback: () => void;
  onClearLoopPlaybackRange: () => void;
};

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5];
const menuOrder = ["文件", "编辑", "播放", "视图", "帮助"] as const;

export function TopMenuBar({
  isPlaying,
  playbackRate,
  loopPlaybackEnabled,
  hasLoopPlaybackRange,
  canUndo,
  canRedo,
  syncStatus,
  localRevision,
  savedRevision,
  pendingOperationCount,
  activeBuiltinTrackIds,
  videoFileInputRef,
  srtFileInputRef,
  projectFileInputRef,
  mergeProjectFileInputRef,
  onVideoFileChange,
  onSrtFileChange,
  onProjectFileChange,
  onMergeProjectFileChange,
  onSaveProject,
  onExportTrack,
  onUndo,
  onRedo,
  onAddAction,
  onTogglePlay,
  onStep,
  onPlaybackRateChange,
  onToggleLoopPlayback,
  onClearLoopPlaybackRange,
}: TopMenuBarProps) {
  const [openMenu, setOpenMenu] = useState<(typeof menuOrder)[number] | null>(null);
  const menuBarRef = useRef<HTMLElement>(null);
  const hasHandTrack = activeBuiltinTrackIds.includes("hand-action");
  const hasBodyTrack = activeBuiltinTrackIds.includes("body-action");
  const syncStatusLabel = getSyncStatusLabel(
    syncStatus,
    localRevision,
    savedRevision,
    pendingOperationCount,
  );

  useEffect(() => {
    if (!openMenu) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuBarRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenu]);

  function triggerFileInput(ref: RefObject<HTMLInputElement>) {
    ref.current?.click();
    setOpenMenu(null);
  }

  function handleAction(action: () => void) {
    action();
    setOpenMenu(null);
  }

  return (
    <header className="top-menu-bar" ref={menuBarRef}>
      <div className="top-menu-brand">
        <span className="top-menu-brand-dot" />
        <div className="top-menu-brand-copy">
          <strong>戏曲多轨标注工作台</strong>
          <span>Desktop Web Workspace</span>
        </div>
      </div>
      <nav className="top-menu-items" aria-label="应用菜单">
        {menuOrder.map((item) => (
          <div
            key={item}
            className="top-menu-item"
            onMouseEnter={() => {
              if (openMenu) {
                setOpenMenu(item);
              }
            }}
          >
            <button
              type="button"
              className={`top-menu-button ${openMenu === item ? "active" : ""}`}
              onClick={() => setOpenMenu((current) => (current === item ? null : item))}
            >
              {item}
            </button>
            {openMenu === item ? (
              <div className="top-menu-dropdown" role="menu" aria-label={item}>
                {item === "文件" ? (
                  <>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => triggerFileInput(videoFileInputRef)}>
                      导入视频
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => triggerFileInput(srtFileInputRef)}>
                      导入句级 SRT
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => triggerFileInput(projectFileInputRef)}>
                      导入项目
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => triggerFileInput(mergeProjectFileInputRef)}>
                      导入并整合标注
                    </button>
                    <div className="top-menu-divider" />
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onSaveProject)}>
                      保存项目
                    </button>
                    <div className="top-menu-divider" />
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(() => onExportTrack("character"))}>
                      导出逐字 SRT
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(() => onExportTrack("singing"))}>
                      导出唱腔 SRT
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(() => onExportTrack("hand"))}>
                      导出手部动作 SRT
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(() => onExportTrack("body"))}>
                      导出肢体动作 SRT
                    </button>
                  </>
                ) : null}
                {item === "编辑" ? (
                  <>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onUndo)} disabled={!canUndo}>
                      撤销
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onRedo)} disabled={!canRedo}>
                      重做
                    </button>
                    <div className="top-menu-divider" />
                    <button
                      type="button"
                      className="top-menu-dropdown-item"
                      onClick={() => handleAction(() => onAddAction("hand-action"))}
                      disabled={!hasHandTrack}
                    >
                      新增手部动作
                    </button>
                    <button
                      type="button"
                      className="top-menu-dropdown-item"
                      onClick={() => handleAction(() => onAddAction("body-action"))}
                      disabled={!hasBodyTrack}
                    >
                      新增肢体动作
                    </button>
                  </>
                ) : null}
                {item === "播放" ? (
                  <>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onTogglePlay)}>
                      {isPlaying ? "暂停" : "播放"}
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(() => onStep(-0.1))}>
                      后退 0.1s
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(() => onStep(0.1))}>
                      前进 0.1s
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(() => onStep(-0.04))}>
                      后退 1 帧
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(() => onStep(0.04))}>
                      前进 1 帧
                    </button>
                    <div className="top-menu-divider" />
                    <div className="top-menu-label">播放速度</div>
                    {playbackRates.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        className={`top-menu-dropdown-item ${playbackRate === rate ? "active-option" : ""}`}
                        onClick={() => handleAction(() => onPlaybackRateChange(rate))}
                      >
                        {playbackRate === rate ? `✓ ${rate}x` : `${rate}x`}
                      </button>
                    ))}
                    <div className="top-menu-divider" />
                    <button
                      type="button"
                      className={`top-menu-dropdown-item ${
                        hasLoopPlaybackRange && loopPlaybackEnabled ? "active-option" : ""
                      }`}
                      onClick={() => handleAction(onToggleLoopPlayback)}
                      disabled={!hasLoopPlaybackRange}
                    >
                      {hasLoopPlaybackRange && loopPlaybackEnabled ? "✓ 循环播放选区" : "循环播放选区"}
                    </button>
                    <button
                      type="button"
                      className="top-menu-dropdown-item"
                      onClick={() => handleAction(onClearLoopPlaybackRange)}
                      disabled={!hasLoopPlaybackRange}
                    >
                      清除循环选区
                    </button>
                  </>
                ) : null}
                {item === "视图" ? (
                  <div className="top-menu-note">时间轴缩放、轨道显隐与布局操作保留在工作区内完成。</div>
                ) : null}
                {item === "帮助" ? (
                  <div className="top-menu-note">空格播放/暂停，Command/Ctrl + S 保存项目，Command/Ctrl + 拖拽可创建块。</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </nav>
      <div className={`top-menu-status sync-status sync-status-${syncStatus}`}>
        {syncStatusLabel}
      </div>
      <input ref={videoFileInputRef} type="file" accept="video/*" onChange={onVideoFileChange} />
      <input ref={srtFileInputRef} type="file" accept=".srt" onChange={onSrtFileChange} />
      <input ref={projectFileInputRef} type="file" accept=".json" onChange={onProjectFileChange} />
      <input ref={mergeProjectFileInputRef} type="file" accept=".json" onChange={onMergeProjectFileChange} />
    </header>
  );
}

function getSyncStatusLabel(
  status: ProjectSyncStatus,
  localRevision: number,
  savedRevision: number,
  pendingOperationCount: number,
) {
  if (status === "saved") {
    return `已保存 · r${savedRevision}`;
  }
  if (status === "saving") {
    return `保存中 · r${localRevision}`;
  }
  if (status === "offline") {
    return `离线待同步 · ${pendingOperationCount} 项`;
  }
  if (status === "conflict") {
    return "存在远端冲突";
  }
  if (status === "error") {
    return "同步失败";
  }
  return `本地更改 · ${pendingOperationCount} 项`;
}
