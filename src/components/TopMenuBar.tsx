import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, RefObject } from "react";
import type { ProjectSyncStatus } from "../state/projectDocumentState";
import type { PlatformCollaborationStatus } from "../platform/platformCollaborationRuntime";
import type { AnnotationPresenceMember } from "@xiqu/shared";
import { CollaborationPresenceMenu } from "./CollaborationPresenceMenu";
import { CommandPalette } from "./CommandPalette";
import type { CommandSearchEntry } from "./CommandPalette";

export type TopMenuPlatformNavigation = {
  label: string;
  title: string;
  onBack: () => void;
};

type TopMenuBarProps = {
  platformNavigation?: TopMenuPlatformNavigation;
  isPlaying: boolean;
  playbackRate: number;
  loopPlaybackEnabled: boolean;
  hasLoopPlaybackRange: boolean;
  canUndo: boolean;
  canRedo: boolean;
  syncStatus: ProjectSyncStatus;
  syncErrorMessage?: string | null;
  localRevision: number;
  savedRevision: number;
  remoteRevision?: number;
  observedRemoteRevision?: number;
  editingBlockedReason?: string;
  pendingOperationCount: number;
  accessLabel?: string;
  mutationLeaseLabel?: string;
  collaborationStatus?: PlatformCollaborationStatus;
  collaborationPresenceMembers?: AnnotationPresenceMember[];
  currentPlatformUserId?: string;
  showRemoteCollaborationHints?: boolean;
  sharePointerAndSelection?: boolean;
  onShowRemoteCollaborationHintsChange?: (visible: boolean) => void;
  onSharePointerAndSelectionChange?: (enabled: boolean) => void;
  videoFileInputRef: RefObject<HTMLInputElement>;
  srtFileInputRef: RefObject<HTMLInputElement>;
  projectFileInputRef: RefObject<HTMLInputElement>;
  mergeProjectFileInputRef: RefObject<HTMLInputElement>;
  onVideoFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSrtFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onProjectFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onMergeProjectFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSaveProject: () => void;
  onSaveProjectToServer?: () => void;
  onOpenServerMediaBinding?: () => void;
  serverMediaBindingDisabledReason?: string;
  onExportTrack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRepairSentenceCharacterTrack: () => void;
  onOpenSentenceAnnotationSettings: () => void;
  onTogglePlay: () => void;
  onStep: (delta: number) => void;
  onPlaybackRateChange: (rate: number) => void;
  onToggleLoopPlayback: () => void;
  onClearLoopPlaybackRange: () => void;
  waveformVisible: boolean;
  banyanTrackVisible: boolean;
  banyanGridVisible: boolean;
  spectrogramVisible: boolean;
  annotationConfirmationPlacement?: "docked" | "hidden" | "detached";
  onWaveformVisibleChange: (visible: boolean) => void;
  onBanyanTrackVisibleChange: (visible: boolean) => void;
  onBanyanGridVisibleChange: (visible: boolean) => void;
  onSpectrogramVisibleChange: (visible: boolean) => void;
  onToggleAnnotationConfirmationPanel?: () => void;
  onToggleAnnotationConfirmationDetached?: () => void;
  // 「搜索」菜单的可执行条目由 App 统一装配；这里只接收一份现成列表，避免继续膨胀单值 props。
  commandSearchEntries: CommandSearchEntry[];
  // Cmd/Ctrl + K 通过递增的 requestId 通知菜单栏打开搜索面板，不需要把 openMenu 状态提到 App。
  commandSearchOpenRequestId?: number;
};

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5];
const menuOrder = ["文件", "编辑", "播放", "视图", "帮助", "搜索"] as const;

export function TopMenuBar({
  platformNavigation,
  isPlaying,
  playbackRate,
  loopPlaybackEnabled,
  hasLoopPlaybackRange,
  canUndo,
  canRedo,
  syncStatus,
  syncErrorMessage,
  localRevision,
  savedRevision,
  remoteRevision,
  observedRemoteRevision,
  editingBlockedReason,
  pendingOperationCount,
  accessLabel,
  mutationLeaseLabel,
  collaborationStatus,
  collaborationPresenceMembers = [],
  currentPlatformUserId,
  showRemoteCollaborationHints = true,
  sharePointerAndSelection = true,
  onShowRemoteCollaborationHintsChange,
  onSharePointerAndSelectionChange,
  videoFileInputRef,
  srtFileInputRef,
  projectFileInputRef,
  mergeProjectFileInputRef,
  onVideoFileChange,
  onSrtFileChange,
  onProjectFileChange,
  onMergeProjectFileChange,
  onSaveProject,
  onSaveProjectToServer,
  onOpenServerMediaBinding,
  serverMediaBindingDisabledReason,
  onExportTrack,
  onUndo,
  onRedo,
  onRepairSentenceCharacterTrack,
  onOpenSentenceAnnotationSettings,
  onTogglePlay,
  onStep,
  onPlaybackRateChange,
  onToggleLoopPlayback,
  onClearLoopPlaybackRange,
  waveformVisible,
  banyanTrackVisible,
  banyanGridVisible,
  spectrogramVisible,
  annotationConfirmationPlacement,
  onWaveformVisibleChange,
  onBanyanTrackVisibleChange,
  onBanyanGridVisibleChange,
  onSpectrogramVisibleChange,
  onToggleAnnotationConfirmationPanel,
  onToggleAnnotationConfirmationDetached,
  commandSearchEntries,
  commandSearchOpenRequestId,
}: TopMenuBarProps) {
  const [openMenu, setOpenMenu] = useState<(typeof menuOrder)[number] | null>(null);
  const menuBarRef = useRef<HTMLElement>(null);
  const syncStatusLabel = getSyncStatusLabel(
    syncStatus,
    localRevision,
    savedRevision,
    pendingOperationCount,
    remoteRevision,
    observedRemoteRevision,
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

  // 全局快捷键只负责递增 requestId，由菜单栏在这里落地成真实的展开状态。
  useEffect(() => {
    if (commandSearchOpenRequestId === undefined) {
      return;
    }
    setOpenMenu("搜索");
  }, [commandSearchOpenRequestId]);

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
        {platformNavigation ? (
          <button
            type="button"
            className="top-menu-platform-back"
            title={platformNavigation.title}
            onClick={platformNavigation.onBack}
          >
            {platformNavigation.label}
          </button>
        ) : null}
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
              // 搜索面板里有输入焦点，鼠标划过其他菜单不能顺手切走，否则会打断正在输入的查询。
              if (openMenu && openMenu !== "搜索") {
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
              <div
                className={`top-menu-dropdown ${item === "搜索" ? "top-menu-dropdown-search" : ""}`.trim()}
                role="menu"
                aria-label={item}
              >
                {item === "文件" ? (
                  <>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => triggerFileInput(videoFileInputRef)} disabled={Boolean(editingBlockedReason)}>
                      导入本地视频
                    </button>
                    {onOpenServerMediaBinding ? (
                      <button
                        type="button"
                        className="top-menu-dropdown-item"
                        title={serverMediaBindingDisabledReason ?? "从平台资源库关联视频或音频"}
                        disabled={Boolean(serverMediaBindingDisabledReason)}
                        onClick={() => handleAction(onOpenServerMediaBinding)}
                      >
                        关联服务器媒体
                      </button>
                    ) : null}
                    <button type="button" className="top-menu-dropdown-item" onClick={() => triggerFileInput(srtFileInputRef)} disabled={Boolean(editingBlockedReason)}>
                      导入句级 SRT
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => triggerFileInput(projectFileInputRef)} disabled={Boolean(editingBlockedReason)}>
                      导入项目
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => triggerFileInput(mergeProjectFileInputRef)} disabled={Boolean(editingBlockedReason)}>
                      导入并整合标注
                    </button>
                    <div className="top-menu-divider" />
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onSaveProject)}>
                      保存本地项目
                    </button>
                    <button
                      type="button"
                      className="top-menu-dropdown-item"
                      onClick={() => {
                        if (onSaveProjectToServer) {
                          handleAction(onSaveProjectToServer);
                        }
                      }}
                      disabled={!onSaveProjectToServer}
                    >
                      保存平台标注文件
                    </button>
                    <div className="top-menu-divider" />
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onExportTrack)}>
                      导出逐字 SRT
                    </button>
                  </>
                ) : null}
                {item === "编辑" ? (
                  <>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onUndo)} disabled={!canUndo || Boolean(editingBlockedReason)}>
                      撤销
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onRedo)} disabled={!canRedo || Boolean(editingBlockedReason)}>
                      重做
                    </button>
                    <div className="top-menu-divider" />
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onRepairSentenceCharacterTrack)} disabled={Boolean(editingBlockedReason)}>
                      检查句级/逐字文字轨
                    </button>
                    <button type="button" className="top-menu-dropdown-item" onClick={() => handleAction(onOpenSentenceAnnotationSettings)} disabled={Boolean(editingBlockedReason)}>
                      句级标注设置...
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
                  <>
                    <button
                      type="button"
                      className={`top-menu-dropdown-item ${waveformVisible ? "active-option" : ""}`}
                      onClick={() => handleAction(() => onWaveformVisibleChange(!waveformVisible))}
                    >
                      {waveformVisible ? "✓ 音频波形" : "音频波形"}
                    </button>
                    <button
                      type="button"
                      className={`top-menu-dropdown-item ${spectrogramVisible ? "active-option" : ""}`}
                      onClick={() => handleAction(() => onSpectrogramVisibleChange(!spectrogramVisible))}
                    >
                      {spectrogramVisible ? "✓ 人声频谱图" : "人声频谱图"}
                    </button>
                    {annotationConfirmationPlacement &&
                    onToggleAnnotationConfirmationPanel &&
                    onToggleAnnotationConfirmationDetached ? (
                      <>
                        <div className="top-menu-divider" />
                        <button
                          type="button"
                          className={`top-menu-dropdown-item ${
                            annotationConfirmationPlacement === "docked" ? "active-option" : ""
                          }`}
                          onClick={() => handleAction(onToggleAnnotationConfirmationPanel)}
                        >
                          {annotationConfirmationPlacement === "docked"
                            ? "✓ 右侧标注审核"
                            : "右侧标注审核"}
                        </button>
                        <button
                          type="button"
                          className={`top-menu-dropdown-item ${
                            annotationConfirmationPlacement === "detached" ? "active-option" : ""
                          }`}
                          onClick={() => handleAction(onToggleAnnotationConfirmationDetached)}
                        >
                          {annotationConfirmationPlacement === "detached"
                            ? "收回右侧栏"
                            : "在独立窗口显示"}
                        </button>
                      </>
                    ) : null}
                    <div className="top-menu-divider" />
                    <button
                      type="button"
                      className={`top-menu-dropdown-item ${banyanTrackVisible ? "active-option" : ""}`}
                      onClick={() => handleAction(() => onBanyanTrackVisibleChange(!banyanTrackVisible))}
                    >
                      {banyanTrackVisible ? "✓ 板眼轨" : "板眼轨"}
                    </button>
                    <button
                      type="button"
                      className={`top-menu-dropdown-item ${banyanGridVisible ? "active-option" : ""}`}
                      onClick={() => handleAction(() => onBanyanGridVisibleChange(!banyanGridVisible))}
                    >
                      {banyanGridVisible ? "✓ 全局板眼纵线" : "全局板眼纵线"}
                    </button>
                  </>
                ) : null}
                {item === "帮助" ? (
                  <div className="top-menu-note">空格播放/暂停，P 从循环范围起点持续循环，Tab 从循环范围起点播放一遍，Command/Ctrl + K 搜索功能，Command/Ctrl + 左/右 选择当前轨道相邻块，Command/Ctrl + S 保存项目，Command/Ctrl + 拖拽可创建块。</div>
                ) : null}
                {/* 搜索菜单是全功能索引入口：只负责把用户带到已有菜单项或设置字段，不新增第二套设置实现。 */}
                {item === "搜索" ? (
                  <CommandPalette
                    entries={commandSearchEntries}
                    onRun={(entry) => handleAction(entry.run)}
                    onClose={() => setOpenMenu(null)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </nav>
      <div className={`top-menu-status sync-status sync-status-${syncStatus}`}>
        {collaborationStatus === "connected" ? (
          <CollaborationPresenceMenu
            members={collaborationPresenceMembers}
            currentUserId={currentPlatformUserId}
            showRemoteCollaborationHints={showRemoteCollaborationHints}
            sharePointerAndSelection={sharePointerAndSelection}
            onShowRemoteCollaborationHintsChange={onShowRemoteCollaborationHintsChange}
            onSharePointerAndSelectionChange={onSharePointerAndSelectionChange}
          />
        ) : null}
        {collaborationStatus ? (
          <span
            className={`collaboration-status collaboration-status-${collaborationStatus}`}
            title="实时连接负责远端修订提示和在线成员状态，标注保存结果仍以后方文案为准。"
          >
            <span className="collaboration-status-dot" aria-hidden="true" />
            {getCollaborationStatusLabel(collaborationStatus)}
          </span>
        ) : null}
        {collaborationStatus ? " · " : ""}
        {accessLabel ? `${accessLabel} · ` : ""}
        {mutationLeaseLabel ? `${mutationLeaseLabel} · ` : ""}
        <span title={syncStatus === "error" ? syncErrorMessage ?? undefined : undefined}>
          {syncStatusLabel}
        </span>
      </div>
      <input ref={videoFileInputRef} type="file" accept="video/*" onChange={onVideoFileChange} />
      <input ref={srtFileInputRef} type="file" accept=".srt" onChange={onSrtFileChange} />
      <input ref={projectFileInputRef} type="file" accept=".json" onChange={onProjectFileChange} />
      <input ref={mergeProjectFileInputRef} type="file" accept=".json" onChange={onMergeProjectFileChange} />
    </header>
  );
}

function getCollaborationStatusLabel(status: PlatformCollaborationStatus) {
  if (status === "connected") return "实时已连接";
  if (status === "connecting") return "实时连接中";
  if (status === "reconnecting") return "实时重连中";
  if (status === "offline") return "实时离线";
  if (status === "error") return "实时连接异常";
  return "实时未启用";
}

function getSyncStatusLabel(
  status: ProjectSyncStatus,
  localRevision: number,
  savedRevision: number,
  pendingOperationCount: number,
  remoteRevision?: number,
  observedRemoteRevision?: number,
) {
  if (
    status === "saved" &&
    remoteRevision !== undefined &&
    observedRemoteRevision !== undefined &&
    observedRemoteRevision > remoteRevision
  ) {
    return `正在同步服务器 v${observedRemoteRevision}`;
  }
  if (status === "saved") {
    return remoteRevision === undefined
      ? `已保存 · r${savedRevision}`
      : `已同步 · 服务器 v${remoteRevision}`;
  }
  if (status === "saving") {
    return remoteRevision === undefined
      ? `保存中 · r${localRevision}`
      : `保存中 · 基于服务器 v${remoteRevision}`;
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
