import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS,
  buildProjectSnapshotBoundaryEnvelope,
  getAnnotationMutationLeasePurposeForCommand,
  type AnnotationCommandEnvelope,
  type AnnotationMutationPurpose,
  type ProjectSnapshotBoundaryKind,
} from "@xiqu/shared";
import "./index.css";
import { PlatformApiError } from "./api/platformClient";
import { AppShell } from "./components/AppShell";
import type { CommandSearchEntry } from "./components/CommandPalette";
import { EditorSidebarLayout } from "./components/EditorSidebarLayout";
import { FloatingPanelWindow } from "./components/FloatingPanelWindow";
import { InspectorPanel } from "./components/InspectorPanel";
import { LeftWorkspace } from "./components/LeftWorkspace";
import { PreviewPanel } from "./components/PreviewPanel";
import { ResizableSplitLayout } from "./components/ResizableSplitLayout";
import { SpectrogramSettingsPanel } from "./components/SpectrogramSettingsPanel";
import { SubtitleList } from "./components/SubtitleList";
import { SentenceAnnotationSettingsDialog } from "./components/SentenceAnnotationSettingsDialog";
import { Timeline } from "./components/Timeline";
import { TimelinePanel } from "./components/TimelinePanel";
import { TopMenuBar, type TopMenuPlatformNavigation } from "./components/TopMenuBar";
import { VideoPlayer } from "./components/VideoPlayer";
import type { MediaPlaybackController } from "./media/mediaPlaybackController";
import { mockProject } from "./mockData";
import { AnnotationReviewPanel } from "./platform/AnnotationReviewPanel";
import { AnnotationMediaBindingDialog } from "./platform/AnnotationMediaBindingDialog";
import { MediaAudioTrackManagerDialog } from "./platform/MediaAudioTrackManagerDialog";
import {
  PlatformMaintenanceSaveWarningDialog,
  type MaintenanceDraftSaveState,
} from "./platform/PlatformMaintenanceSaveWarningDialog";
import { getPlatformMediaBindingBlockReason } from "./platform/platformMediaBindingPolicy";
import {
  isPlatformMaintenanceError,
  PLATFORM_MAINTENANCE_ERROR_CODE,
} from "./platform/platformMaintenanceSaveWarning";
import { buildPlatformMediaPlaybackSource } from "./platform/platformMediaPlaybackSource";
import {
  buildAnnotationConfirmationViewRecords,
  buildAnnotationRangeCommentViewRecords,
  canShowAnnotationConfirmationRevoke,
  canShowAnnotationRangeCommentWithdraw,
  getAnnotationConfirmationCreateBlocker,
  getAnnotationConfirmationTrackOptions,
  layoutAnnotationReviewTimelineItems,
} from "./platform/annotationConfirmationView";
import {
  type LocalEditorSession,
  PlatformWorkspace,
  type PlatformEditorSession,
} from "./platform/PlatformWorkspace";
import {
  hydrateProjectForClient,
  prepareProjectForServer,
} from "./platform/platformProjectPayload";
import {
  canAttemptPlatformOperationCatchUp,
  catchUpCommittedAnnotationOperations,
} from "./platform/platformOperationCatchUp";
import { usePlatformOperationCatchUp } from "./platform/usePlatformOperationCatchUp";
import { usePlatformCollaborationSession } from "./platform/usePlatformCollaborationSession";
import { buildTimelineSelectionSummary } from "./platform/timelineSelectionSummary";
import { useAnnotationReviews } from "./platform/useAnnotationReviews";
import { usePlatformAutoSave } from "./platform/usePlatformAutoSave";
import { usePlatformDraftPersistence } from "./platform/usePlatformDraftPersistence";
import { usePlatformMutationLease } from "./platform/usePlatformMutationLease";
import {
  type PlatformAnalysisViewport,
  usePlatformMediaAnalysis,
} from "./platform/usePlatformMediaAnalysis";
import { usePlatformAudioTrackSelection } from "./platform/usePlatformAudioTrackSelection";
import { planAtomicAnnotationCommandBatch } from "./platform/platformAtomicCommandPlan";
import { usePlatformAtomicCommandSubmit } from "./platform/usePlatformAtomicCommandSubmit";
import { planPlatformConflictRebase } from "./platform/platformConflictRebase";
import { shouldBlockEditingForRemoteCatchUp } from "./platform/platformRemoteEditGate";
import {
  buildAnnotationClientSyncFailureReport,
  getSyncFailureMismatchFields,
  getSyncFailureMismatchDetails,
} from "./platform/platformSyncFailureDiagnostic";
import {
  isMutationLeaseSubmitFailure,
  requiresLegacySnapshotMigration,
} from "./platform/platformAtomicSubmitPolicy";
import type { PlatformMutationLeaseViewState } from "./platform/platformMutationLeaseRuntime";
import {
  type HistoryAction,
  type ProjectDocumentRecoveryState,
  useProjectDocumentState,
} from "./state/projectDocumentState";
import type {
  ActionAnnotation,
  AttachedPointAnnotation,
  AttachedPointTrack,
  BranchScope,
  BanyanMark,
  BanyanSection,
  BuiltinTrack,
  BuiltinTrackId,
  CharacterAnnotation,
  CharacterToneInfo,
  CustomTrack,
  CustomTrackType,
  GongcheAnnotation,
  GongcheSymbol,
  InspectorFocusRequest,
  InspectorFocusTarget,
  ProjectData,
  ResolvedCustomTrackBlock,
  SavedProjectFile,
  SelectedItem,
  SpectrogramData,
  SpectrogramSettings,
  SubtitleLine,
  TimelineBatchMoveItem,
  TimelineSelectionItem,
  TrackBranchDisplayMode,
  WaveformData,
} from "./types";
import {
  MAX_SENTENCE_ROLE_OPTION_LENGTH,
  MAX_SENTENCE_ROLE_OPTIONS,
} from "./types";
import {
  buildProjectFromLines,
  buildTimelineTrackDefinitions,
  flattenCustomTrackBlocks,
  getBuiltinTrackDefinition,
  getDefaultAttachedPointTrackName,
  getDefaultAttachedPointTypeOptions,
  getDefaultCustomTrackName,
  getDefaultCustomTrackTypeOptions,
  getMissingBuiltinTracks,
  getBranchLaneTrackParts,
  getProjectDuration,
  getNextCustomTrackTypeOptionName,
  normalizeTrackSnapEnabledForProject,
} from "./utils/project";
import {
  describeServerSaveError,
  submitLegacyPendingOperations,
  type PlatformSaveOutcome,
} from "./utils/platformOperations";
import {
  buildTrackSettingCommands,
  findTrackForCommand,
  LOCAL_STATIC_COMMAND_DEFINITIONS,
  PLATFORM_STATIC_COMMAND_DEFINITIONS,
  resolveTrackSettingCommandState,
  type LocalStaticCommandId,
  type PlatformStaticCommandId,
  type TrackSettingCommandTarget,
} from "./utils/commandCatalog";
import { buildProjectAnnotationContentCommand } from "./utils/annotationContentCommand";
import { buildProjectCustomTrackStructureCommand } from "./utils/customTrackStructureCommand";
import {
  buildProjectTrackStructureTransactionCommand,
} from "./utils/trackStructureTransactionCommand";
import { areProjectValuesEqual } from "./utils/projectValueEquality";
import { areEditorProjectsEqual } from "./utils/editorProjectEquality";
import {
  buildProjectAnnotationLifecycleCommand,
  type AnnotationLifecycleTarget,
} from "./utils/annotationLifecycleCommand";
import {
  buildProjectAnnotationStateCommand,
  type AnnotationStateTarget,
} from "./utils/annotationStateCommand";
import {
  buildProjectAnnotationTransactionCommand,
  type AnnotationTransactionPlan,
} from "./utils/annotationTransactionCommand";
import { findAdjacentNavigableBlock } from "./utils/timelineNavigation";
import {
  buildProjectTimelineTimingCommand,
  getGongcheTransactionTargetsForParents,
  type TimelineTimingTarget,
} from "./utils/timelineTimingCommand";
import {
  addBranchLane,
  createBranchLane,
  createDefaultTrackBranching,
  getBranchLaneIds,
  getNextBranchLaneName,
  removeBranchLane,
  recolorBranchLane,
  renameBranchLane,
} from "./utils/trackBranching";
import {
  getBranchLaneColor,
  getNextTrackColor,
  normalizeHexColor,
  resolveCustomTrackColor,
} from "./utils/trackColors";
import {
  exportCharacterTrackToSrt,
  formatSecondsToSrtTime,
  parseSrt,
} from "./utils/srt";
import {
  buildSpectrogramData,
  defaultSpectrogramSettings,
} from "./utils/spectrogram";
import { defaultTimelineLayerVisibility } from "./utils/timelineViewDefaults";
import { buildLocalWaveformData } from "./utils/localMediaAnalysis";
import { createRuntimeUuid } from "./utils/runtimeUuid";
import {
  analyzeSentenceCharacterAlignment,
  createSentenceCharacterRepairs,
  formatSentenceCharacterAlignmentSummary,
} from "./utils/sentenceCharacterAlignment";
import { SENTENCE_DELIVERY_MODE_OPTIONS } from "./utils/sentenceClassification";
import {
  reorderSentenceRoleOptions,
  type SentenceRoleDropEdge,
} from "./utils/sentenceRoleReorder";
import { generateBanyanMarksFromGongche, getBanyanSubtypeLabel } from "./utils/banyan";
import { repairBanyanGongcheReferences } from "./utils/banyanReferenceIntegrity";
import {
  PROJECT_FILE_VERSION,
  getManualVideoImportMessageLines,
  getNormalizedProjectFileName,
  getPersistableProjectData,
  getProjectFileName,
  normalizeImportedProjectFile,
  normalizeProjectVideoUrl,
  shouldPromptForManualVideoImport,
} from "./utils/projectFile";

type CharacterEditLocation = "timeline" | "split-panel";
type CharacterLineAction =
  | "split-block"
  | "set-line-start"
  | "set-line-end"
  | "merge-prev-line"
  | "merge-next-line";

type LineFocusRequest = {
  lineId: string;
  requestId: number;
};

type PointTrackLocation =
  | {
      parentType: "builtin";
      parentTrack: BuiltinTrack;
      pointTrack: AttachedPointTrack;
    }
  | {
      parentType: "custom";
      parentTrack: CustomTrack;
      pointTrack: AttachedPointTrack;
    };

type GongcheParentBlock = {
  parentTrackId: string;
  parentBlockId: string;
  label: string;
  startTime: number;
  endTime: number;
};

type ParsedGongcheEntry = {
  text: string;
  symbols: Array<{
    label: string;
    notation: string;
    rawText: string;
    parenthesized: boolean;
  }>;
};

type TimelineClipboardItem =
  | {
      type: "character";
      sourceTrackId: "character-track";
      sourceLineId: string;
      char: string;
      tone: CharacterToneInfo | null;
      startOffset: number;
      endOffset: number;
    }
  | {
      type: "action";
      sourceTrackId: string;
      label: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      type: "custom-block";
      sourceTrackId: string;
      trackType: CustomTrackType;
      blockType: string;
      text?: string;
      startOffset: number;
      endOffset: number;
    }
  | {
      type: "attached-point";
      sourceTrackId: string;
      parentTrackId: string;
      label: string;
      timeOffset: number;
    }
  | {
      type: "banyan-mark";
      sourceTrackId: "banyan-track";
      mark: Omit<BanyanMark, "id" | "time" | "estimatedTime" | "manualOffset" | "sourceKey" | "sourceTokenIndex">;
      timeOffset: number;
    };

type TimelineClipboard = {
  items: TimelineClipboardItem[];
  baseTime: number;
  primaryTrackId: string | null;
  sourceTrackIds: string[];
};

type TimelinePasteTarget = {
  trackId: string;
  time: number;
};

type PasteConflictResolution = "cancel" | "overwrite" | "replace" | "keep-original";

type PreparedPasteItem =
  | {
      type: "character";
      targetTrackId: "character-track";
      startTime: number;
      endTime: number;
      char: string;
      tone: CharacterToneInfo | null;
      sourceLineId: string;
    }
  | {
      type: "action";
      targetTrackId: string;
      startTime: number;
      endTime: number;
      label: string;
    }
  | {
      type: "custom-block";
      targetTrackId: string;
      trackType: CustomTrackType;
      startTime: number;
      endTime: number;
      blockType: string;
      text?: string;
    }
  | {
      type: "attached-point";
      targetTrackId: string;
      parentTrackId: string;
      time: number;
      label: string;
    }
  | {
      type: "banyan-mark";
      targetTrackId: "banyan-track";
      time: number;
      mark: Omit<BanyanMark, "id" | "time" | "estimatedTime" | "manualOffset" | "sourceKey" | "sourceTokenIndex">;
    };

type PasteConflict = {
  item: PreparedPasteItem;
  existingKeys: string[];
  trackName: string;
};

type PendingPasteState = {
  preparedItems: PreparedPasteItem[];
  conflicts: PasteConflict[];
};

type ImportMergeMode = "replace" | "overlay";

type ImportMergeRow = {
  key: string;
  kind: "builtin-track" | "custom-track" | "attached-point-track";
  sourceTrackId: string;
  sourceTrackName: string;
  sourceTrackType: "character" | "action" | "custom-text" | "custom-action" | "attached-point";
  sourceParentKey?: string;
  sourceParentTrackId?: string;
  sourceParentTrackName?: string;
  importedCount: number;
  targetChoice: string;
  mergeMode: ImportMergeMode;
};

type PendingImportMergeState = {
  fileName: string;
  sourceProject: ProjectData;
  rows: ImportMergeRow[];
  videoWarning: string | null;
};

type ImportMergeTargetOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type ImportMergePreview = {
  targetLabel: string;
  importedCount: number;
  existingCount: number;
  duplicateCount: number;
  disabledReason: string | null;
};

type TimelineContextMenu =
  | {
      type: "line";
      id: string;
      x: number;
      y: number;
      time: number;
    }
  | {
      type: "character";
      id: string;
      x: number;
      y: number;
      trackId: "character-track";
      time: number;
    }
  | {
      type: "action";
      id: string;
      x: number;
      y: number;
      trackId: string;
      time: number;
    }
  | {
      type: "custom-block";
      id: string;
      trackId: string;
      x: number;
      y: number;
      time: number;
    }
  | {
      type: "attached-point";
      id: string;
      trackId: string;
      parentTrackId: string;
      x: number;
      y: number;
      time: number;
    }
  | {
      type: "gongche-block";
      id: string;
      x: number;
      y: number;
      time: number;
    }
  | {
      type: "banyan-mark";
      id: string;
      x: number;
      y: number;
      trackId: "banyan-track";
      time: number;
    }
  | {
      type: "lane";
      trackId: string;
      x: number;
      y: number;
      time: number;
    };

const BANYAN_CONTEXT_SUBTYPE_GROUPS: Array<{
  label: string;
  role: BanyanMark["role"];
  subtypes: BanyanMark["subtype"][];
}> = [
  {
    label: "板",
    role: "ban",
    subtypes: ["mainBan", "headBan", "waistBan", "bottomBan", "zengBan", "waistZengBan"],
  },
  {
    label: "眼",
    role: "yan",
    subtypes: ["middleEye", "smallEye", "sideHeadTailEye", "sideMiddleEye"],
  },
  {
    label: "辅助",
    role: "auxiliary",
    subtypes: ["phraseBoundary", "unknown"],
  },
];

const CHARACTER_CREATE_ATTACH_WINDOW = 1;
const DEFAULT_CHARACTER_DURATION = 1.05;
const MIN_CHARACTER_DURATION = 0.04;
const DEFAULT_ACTION_DURATION = 0.8;
const DEFAULT_CUSTOM_TEXT = "新标注";
const CONTEXT_MENU_GAP = 10;
const CONTEXT_MENU_VIEWPORT_MARGIN = 12;
const IMPORT_MERGE_SKIP = "__skip__";
const IMPORT_MERGE_NEW = "__new__";
const POINT_PASTE_CONFLICT_EPSILON = 0.015;
const trackSnapSignatureCache = new WeakMap<Record<string, boolean>, string>();

// 顶栏搜索的运行时补充信息：勾选态用于在结果里显示 ✓，禁用原因用于解释为什么暂时点不动。
type CommandRuntimeEntry = {
  checked?: boolean;
  disabledReason?: string;
  run: () => void;
};

// 搜索条目的执行体只依赖这一份「最新 handler 快照」，从而把高频状态挡在 useMemo 依赖之外。
type CommandHandlers = {
  currentTime: number;
  triggerFileInput: (ref: RefObject<HTMLInputElement>) => void;
  videoFileInputRef: RefObject<HTMLInputElement>;
  srtFileInputRef: RefObject<HTMLInputElement>;
  projectFileInputRef: RefObject<HTMLInputElement>;
  mergeProjectFileInputRef: RefObject<HTMLInputElement>;
  saveProjectFile: () => Promise<void>;
  saveProjectToServer: (options: { source: "manual" }) => Promise<unknown>;
  handleExport: () => void;
  undo: () => void;
  redo: () => void;
  repairSentenceCharacterTrack: () => void;
  togglePlay: () => void;
  seekTo: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
  updateLoopPlaybackEnabledFromUser: (enabled: boolean) => void;
  clearLoopPlaybackRange: () => void;
  setWaveformVisible: (visible: boolean) => void;
  setSpectrogramSettings: (updater: (previous: SpectrogramSettings) => SpectrogramSettings) => void;
  setBanyanTrackVisible: (visible: boolean) => void;
  setBanyanGridVisible: (visible: boolean) => void;
  setServerMediaDialogOpen: (open: boolean) => void;
  toggleConfirmationPanelDocked: () => void;
  toggleConfirmationDetachedWindow: () => void;
  runTrackSettingCommand: (target: TrackSettingCommandTarget) => void;
  openAudioSettingFromSearch: (focusTarget: InspectorFocusTarget) => void;
  loopPlaybackEnabled: boolean;
};

type EditorWorkbenchProps = {
  editorSession: PlatformEditorSession | null;
  localEditorSession?: LocalEditorSession | null;
  platformNavigation?: TopMenuPlatformNavigation;
};

type AnnotationConfirmationPanelPlacement = "docked" | "hidden" | "detached";

function EditorWorkbench({ editorSession, localEditorSession, platformNavigation }: EditorWorkbenchProps) {
  const initialProject = editorSession?.initialProject ?? localEditorSession?.initialProject ?? mockProject;
  const initialProjectDuration = getProjectDuration(initialProject);
  const initialPlatformFocus = editorSession?.initialFocus;
  const isReadOnly = Boolean(
    editorSession && !editorSession.canWrite,
  );
  const [pendingAnnotationMergeDraft, setPendingAnnotationMergeDraft] = useState(
    editorSession?.pendingMergeDraft ?? null,
  );
  const {
    project,
    projectRef,
    trackSnapEnabled,
    trackSnapEnabledRef,
    undoStack,
    redoStack,
    hasUnsavedChanges,
    pendingOperations,
    syncState,
    transientProjectRef,
    applyProjectWithoutHistory,
    commitProject,
    applyTrackSnapEnabledState,
    markOperationsAsSubmitted,
    markProjectAsSaved,
    acknowledgeAtomicCommandBatch,
    replaceCleanProjectFromRemote,
    rebasePendingProjectFromRemote,
    undoProject,
    redoProject,
    setSyncStatus,
    getRecoveryState,
  } = useProjectDocumentState({
    initialProject,
    initialTrackSnapEnabled: getDefaultTrackSnapEnabled(initialProject),
    areProjectsEqual: projectsEqual,
    areTrackSnapStatesEqual: trackSnapStatesEqual,
    readOnly: isReadOnly,
    initialRecoveryState: editorSession?.initialRecoveryState,
  });
  // transient 只代表拖拽/缩放预览，pointer-up 生成领域命令前不得进入自动保存或浏览器恢复草稿。
  const hasTransientDocumentEdit = transientProjectRef.current !== null;
  const [remoteBaseRevision, setRemoteBaseRevision] = useState(editorSession?.baseRevision ?? 0);
  const [remoteOperationCursor, setRemoteOperationCursor] = useState(
    editorSession?.operationCursor ?? "",
  );
  // observed 表示协作通道已经告知的最高服务器版本；remoteBaseRevision 只表示已进入本地 ProjectData 的版本。
  const [observedRemoteRevision, setObservedRemoteRevision] = useState(
    editorSession?.baseRevision ?? 0,
  );
  const remoteBaseRevisionRef = useRef(remoteBaseRevision);
  const remoteOperationCursorRef = useRef(remoteOperationCursor);
  remoteBaseRevisionRef.current = remoteBaseRevision;
  remoteOperationCursorRef.current = remoteOperationCursor;
  const [saveConflictReviewBusy, setSaveConflictReviewBusy] = useState(false);
  const [saveConflictReviewError, setSaveConflictReviewError] = useState<string | null>(null);
  const [browserOnline, setBrowserOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  const [maintenanceSaveBlocked, setMaintenanceSaveBlocked] = useState(false);
  const [maintenanceWarningOpen, setMaintenanceWarningOpen] = useState(false);
  const [maintenanceDraftState, setMaintenanceDraftState] = useState<MaintenanceDraftSaveState>({
    status: "saving",
  });
  const maintenanceWarningSuppressedRef = useRef(false);
  const lastMaintenanceDraftRevisionRef = useRef<number | null>(null);
  // 连接传输需要独立响应 online/offline；不能依赖文档 dirty 状态是否恰好触发一次重渲染。
  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  // 冲突解除后清理旧交接错误，下一次独立冲突不能显示上一次请求的诊断。
  useEffect(() => {
    if (syncState.status !== "conflict") {
      setSaveConflictReviewBusy(false);
      setSaveConflictReviewError(null);
    }
  }, [syncState.status]);
  // operation 同步状态变化也要触发草稿重写，保证刷新后不会重复提交已进入服务器日志的条目。
  const pendingOperationSignature = useMemo(
    () => pendingOperations.map((operation) => `${operation.id}:${operation.syncState}`).join("|"),
    [pendingOperations],
  );
  // 浏览器草稿仅服务平台可写会话；本地 JSON 和只读文件继续走各自原有保存边界。
  const { flushNow: flushPlatformDraftNow } = usePlatformDraftPersistence({
    enabled: Boolean(editorSession?.canWrite),
    // 待确认整合和 transient 预览都尚未形成可重放历史，不能写入恢复草稿。
    suspended: pendingAnnotationMergeDraft !== null || hasTransientDocumentEdit,
    userId: editorSession?.currentUserId ?? null,
    annotationFileId: editorSession?.annotationFileId ?? null,
    remoteBaseRevision,
    hasUnsavedChanges,
    localRevision: syncState.localRevision,
    pendingOperationSignature,
    getRecoveryState,
    onPersistenceError: (message) => {
      // 冲突交接 flush 失败时保留 conflict 主状态，用户仍需看到并可重试处理入口。
      setSyncStatus(syncState.status === "conflict" ? "conflict" : "error", {
        errorMessage: `本地恢复草稿写入失败：${message}`,
      });
    },
  });
  // 每次完整编辑形成新 revision 后都立即刷新本地草稿；弹窗抑制只影响提示，不影响继续保全草稿。
  const preserveDraftAfterMaintenanceBlock = useCallback(async () => {
    const localRevision = getRecoveryState().localRevision;
    // revision effect 与稍后的自动保存拒绝可能命中同一次编辑；只落一次草稿、只弹一次提示。
    if (lastMaintenanceDraftRevisionRef.current === localRevision) return;
    lastMaintenanceDraftRevisionRef.current = localRevision;
    setMaintenanceSaveBlocked(true);
    setMaintenanceDraftState({ status: "saving" });
    if (!maintenanceWarningSuppressedRef.current) setMaintenanceWarningOpen(true);

    const result = await flushPlatformDraftNow();
    setMaintenanceDraftState(result.ok
      ? { status: "saved" }
      : { status: "failed", message: result.message });
  }, [flushPlatformDraftNow, getRecoveryState]);

  // 首次维护拒绝后，所有编辑类型都通过 localRevision 进入同一提示路径，无需污染各轨道事件处理器。
  useEffect(() => {
    if (
      !maintenanceSaveBlocked ||
      !editorSession?.canWrite ||
      !hasUnsavedChanges ||
      lastMaintenanceDraftRevisionRef.current === syncState.localRevision
    ) {
      return;
    }
    void preserveDraftAfterMaintenanceBlock();
  }, [
    editorSession?.canWrite,
    hasUnsavedChanges,
    maintenanceSaveBlocked,
    preserveDraftAfterMaintenanceBlock,
    syncState.localRevision,
  ]);

  // 该偏好严格限定在一次文件打开会话；文件身份变化时恢复默认提醒行为。
  useEffect(() => {
    maintenanceWarningSuppressedRef.current = false;
    lastMaintenanceDraftRevisionRef.current = null;
    setMaintenanceSaveBlocked(false);
    setMaintenanceWarningOpen(false);
    setMaintenanceDraftState({ status: "saving" });
  }, [editorSession?.annotationFileId]);
  // 只有服务器真实确认提交后才能解除维护阻断；本地草稿成功不能冒充维护已经结束。
  const clearMaintenanceBlockAfterServerCommit = useCallback(() => {
    lastMaintenanceDraftRevisionRef.current = null;
    setMaintenanceSaveBlocked(false);
    setMaintenanceWarningOpen(false);
  }, []);
  // 结构编辑 token 只存在于文件会话级 runtime；丢锁时保留本地草稿并阻断自动盲重试。
  const mutationLease = usePlatformMutationLease({
    client: editorSession?.client ?? null,
    annotationFileId: editorSession?.annotationFileId ?? null,
    baseRevision: remoteBaseRevision,
    enabled: Boolean(editorSession?.canWrite),
    onLeaseLost: (error) => {
      const message = error instanceof Error ? error.message : "结构编辑租约已失效。";
      setSyncStatus("error", { errorMessage: `结构编辑锁失效：${message}；本地草稿仍已保留。` });
      window.alert(`结构编辑锁已经失效：${message}\n本地草稿仍已保留，保存时会重新尝试取得编辑锁。`);
    },
  });
  const mutationLeaseLabel = editorSession
    ? getMutationLeaseStatusLabel(mutationLease.state, Boolean(mutationLease.getToken()))
    : undefined;
  // 平台确认事实独立于项目文档历史；本地会话传入 null，因此不会请求或展示服务端治理状态。
  const annotationReviews = useAnnotationReviews({
    client: editorSession?.client ?? null,
    annotationFileId: editorSession?.annotationFileId ?? null,
  });
  const atomicCommandSubmit = usePlatformAtomicCommandSubmit({
    client: editorSession?.client ?? null,
    annotationFileId: editorSession?.annotationFileId ?? null,
    sessionKey: editorSession
      ? `${editorSession.currentUserId}:${editorSession.annotationFileId}`
      : "local",
    online: browserOnline,
    applyCommitted: (plan, response) => {
      const acknowledgement = acknowledgeAtomicCommandBatch({
        operationIds: plan.operationIds,
        expectedServerBaseProject: plan.serverBaseProject,
        acknowledgedProject: plan.acknowledgedProject,
        acknowledgedTrackSnapEnabled: plan.acknowledgedTrackSnapEnabled,
        serverBaseRevision: plan.request.baseRevision,
        committedRevision: response.committedRevision,
        expectedSavedLocalRevision: plan.expectedSavedLocalRevision,
        acknowledgedLocalRevision: plan.acknowledgedLocalRevision,
      });
      if (acknowledgement.status === "rejected") return acknowledgement;

      // document state 与平台会话必须同步推进；ref 先更新，避免同一 tick 的下一批仍读取旧 revision。
      clearMaintenanceBlockAfterServerCommit();
      remoteBaseRevisionRef.current = response.committedRevision;
      remoteOperationCursorRef.current = response.operationCursor;
      setRemoteBaseRevision(response.committedRevision);
      setObservedRemoteRevision((current) => Math.max(current, response.committedRevision));
      setRemoteOperationCursor(response.operationCursor);
      editorSession?.onRemoteRevisionAdvanced(response.committedRevision, response.operationCursor);
      if (plan.request.mutationLeaseToken) mutationLease.markCommitted();
      mutationLease.advanceBaseRevision(response.committedRevision);
      void annotationReviews.refresh();
      return { status: "applied" };
    },
    onRetryableFailure: (failure) => {
      // runtime 仍在使用同一批 operation IDs 退避，文档保持 saving 而不是启动第二个自动保存事务。
      setSyncStatus("saving", { errorMessage: failure.message });
    },
  });
  // 自动保存只调度已经形成领域命令的可写会话；整合确认和 transient 预览期间必须暂停。
  usePlatformAutoSave({
    enabled: Boolean(editorSession?.canWrite),
    dirty: hasUnsavedChanges,
    suspended: pendingAnnotationMergeDraft !== null || hasTransientDocumentEdit,
    localRevision: syncState.localRevision,
    syncStatus: syncState.status,
    online: browserOnline,
    save: () => saveProjectToServer({ source: "auto" }),
    // 保存命令原则上返回结构化 outcome；合同外异常必须显式阻断并保留 dirty 状态供人工处理。
    onUnexpectedError: (error) => {
      const message = error instanceof Error ? error.message : "未知自动保存错误";
      console.error("自动保存运行时异常", error);
      setSyncStatus("error", { errorMessage: `自动保存异常：${message}` });
    },
  });
  const [confirmationTimelineVisible, setConfirmationTimelineVisible] = useState(true);
  const [confirmationFocusRange, setConfirmationFocusRange] = useState<{
    requestId: number;
    start: number;
    end: number;
  } | null>(null);
  // 比较入口传入的时间是一次性会话起点；普通打开继续保持原有演示时间，不污染项目数据。
  const [currentTime, setCurrentTime] = useState(() => initialPlatformFocus
    ? clampTime(initialPlatformFocus.time, initialProjectDuration)
    : 12.4);
  const [duration, setDuration] = useState(getProjectDuration(initialProject));
  const [selectedItem, setSelectedItem] = useState<SelectedItem>({
    type: "line",
    id: "line-1",
  });
  const [selectedTimelineItems, setSelectedTimelineItems] = useState<TimelineSelectionItem[]>([]);
  // 显示与共享分离：用户可以只隐藏本机提示，也可以停止发布隐私更高的鼠标/选区摘要。
  const [showRemoteCollaborationHints, setShowRemoteCollaborationHints] = useState(true);
  const [sharePointerAndSelection, setSharePointerAndSelection] = useState(true);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  const [isWaveformLoading, setIsWaveformLoading] = useState(false);
  const [localAnalysisError, setLocalAnalysisError] = useState<string | null>(null);
  const [spectrogramData, setSpectrogramData] = useState<SpectrogramData | null>(null);
  const [isSpectrogramLoading, setIsSpectrogramLoading] = useState(false);
  const [spectrogramSettings, setSpectrogramSettings] = useState<SpectrogramSettings>(
    defaultSpectrogramSettings,
  );
  // 高密度辅助轨默认不占用时间轴空间，用户可从“视图”或对应设置面板按需开启。
  const [banyanGridVisible, setBanyanGridVisible] = useState(
    defaultTimelineLayerVisibility.banyanGrid,
  );
  const [banyanTrackVisible, setBanyanTrackVisible] = useState(
    defaultTimelineLayerVisibility.banyanTrack,
  );
  const [waveformVisible, setWaveformVisible] = useState(
    defaultTimelineLayerVisibility.waveform,
  );
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [editingCharacterLocation, setEditingCharacterLocation] = useState<CharacterEditLocation | null>(null);
  const [editingCharacterValue, setEditingCharacterValue] = useState("");
  const [editingCustomTextBlock, setEditingCustomTextBlock] = useState<{
    trackId: string;
    id: string;
  } | null>(null);
  const [editingCustomTextValue, setEditingCustomTextValue] = useState("");
  const [blockContextMenu, setBlockContextMenu] = useState<TimelineContextMenu | null>(null);
  const remoteCatchUpBlocksEditing = shouldBlockEditingForRemoteCatchUp({
    observedRemoteRevision,
    appliedRemoteRevision: remoteBaseRevision,
    hasUnsavedChanges,
    pendingOperationCount: pendingOperations.length,
    hasTransientEdit: transientProjectRef.current !== null,
    hasInlineEdit: editingCharacterId !== null || editingCustomTextBlock !== null,
    hasPendingMergeDraft: pendingAnnotationMergeDraft !== null,
    syncStatus: syncState.status,
  });
  const remoteCatchUpBlockReason = remoteCatchUpBlocksEditing
    ? `正在接收其他账号的修改（服务器 v${observedRemoteRevision}）`
    : undefined;
  const sentenceClassificationEditingBlockedReason = isReadOnly
    ? "当前账号没有写入权限"
    : remoteCatchUpBlockReason;

  // 门禁只阻止尚未开始的新写操作；关闭旧右键菜单并拦截写快捷键，播放、缩放和复制仍可使用。
  useEffect(() => {
    if (!remoteCatchUpBlocksEditing) return;
    setBlockContextMenu(null);
    const blockMutationShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isMutationShortcut = event.key === "Delete" || event.key === "Backspace" ||
        ((event.metaKey || event.ctrlKey) && ["x", "v", "z", "y"].includes(key));
      if (!isMutationShortcut) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", blockMutationShortcut, true);
    return () => window.removeEventListener("keydown", blockMutationShortcut, true);
  }, [remoteCatchUpBlocksEditing]);
  const [inspectorFocusRequest, setInspectorFocusRequest] = useState<InspectorFocusRequest | null>(null);
  // 顶栏搜索面板的执行体全部从这个 ref 读取最新 handler，因此搜索条目不必因播放位置变化而重建。
  const commandHandlersRef = useRef<CommandHandlers>({} as CommandHandlers);
  // Cmd/Ctrl + K 只递增一个请求号，由 TopMenuBar 负责把它翻译成真实的菜单展开状态。
  const [commandSearchOpenRequestId, setCommandSearchOpenRequestId] = useState<number | undefined>(undefined);
  const [timelineClipboard, setTimelineClipboard] = useState<TimelineClipboard | null>(null);
  const [pendingPasteState, setPendingPasteState] = useState<PendingPasteState | null>(null);
  const [pendingImportMergeState, setPendingImportMergeState] = useState<PendingImportMergeState | null>(null);
  const [zoom, setZoom] = useState(20);
  const [loopPlaybackRange, setLoopPlaybackRange] = useState<{ start: number; end: number } | null>(null);
  const [loopPlaybackEnabled, setLoopPlaybackEnabled] = useState(false);
  const [lineFocusRequest, setLineFocusRequest] = useState<LineFocusRequest | null>(null);
  // 平台初始焦点只供 Timeline 首次挂载消费，清理后用户滚动不会被再次拉回。
  const [initialPlatformFocusRange, setInitialPlatformFocusRange] = useState(() =>
    initialPlatformFocus
      ? {
          requestId: 1,
          start: clampTime(initialPlatformFocus.start - 1.5, initialProjectDuration),
          end: clampTime(initialPlatformFocus.end + 1.5, initialProjectDuration),
        }
      : null);
  const [isSubtitlePanelCollapsed, setIsSubtitlePanelCollapsed] = useState(false);
  const [isSplitPanelCollapsed, setIsSplitPanelCollapsed] = useState(false);
  const [isConfirmationPanelCollapsed, setIsConfirmationPanelCollapsed] = useState(false);
  const [confirmationPanelPlacement, setConfirmationPanelPlacement] =
    useState<AnnotationConfirmationPanelPlacement>("docked");
  const [manualVideoRelinkPrompt, setManualVideoRelinkPrompt] = useState<ProjectData["video"] | null>(null);
  const [serverMediaDialogOpen, setServerMediaDialogOpen] = useState(false);
  const [analysisAudioDialogOpen, setAnalysisAudioDialogOpen] = useState(false);
  const [audioTrackManagerOpen, setAudioTrackManagerOpen] = useState(false);
  const [sentenceAnnotationSettingsOpen, setSentenceAnnotationSettingsOpen] = useState(false);
  const [analysisViewport, setAnalysisViewport] = useState<PlatformAnalysisViewport | null>(null);
  const [serverMediaBindingBusy, setServerMediaBindingBusy] = useState(false);
  const [currentProjectFileName, setCurrentProjectFileName] = useState<string | null>(null);
  const [previewDetachedWindow, setPreviewDetachedWindow] = useState<Window | null>(null);
  const [timelineDetachedWindow, setTimelineDetachedWindow] = useState<Window | null>(null);
  const [confirmationDetachedWindow, setConfirmationDetachedWindow] = useState<Window | null>(null);
  const isPreviewDetached = Boolean(previewDetachedWindow && !previewDetachedWindow.closed);
  const isTimelineDetached = Boolean(timelineDetachedWindow && !timelineDetachedWindow.closed);
  const isConfirmationDetached = confirmationPanelPlacement === "detached" &&
    Boolean(confirmationDetachedWindow && !confirmationDetachedWindow.closed);
  const videoRef = useRef<MediaPlaybackController>(null);
  const platformMedia = editorSession?.media;
  const platformClient = editorSession?.client;
  // 监听音轨是文件会话状态，不进入标注 ProjectData；共享默认只有用户显式操作时才写平台设置。
  const platformAudioTracks = usePlatformAudioTrackSelection({
    client: platformClient ?? null,
    annotationFileId: editorSession?.annotationFileId ?? null,
    primaryMediaResourceId: platformMedia?.resourceId ?? null,
    canWrite: Boolean(editorSession?.canWrite),
    enabled: Boolean(editorSession && platformMedia),
  });
  useEffect(() => {
    // 音轨管理器只属于当前文件与主媒体组合；切换会话不能沿用上一媒体的打开状态。
    setAudioTrackManagerOpen(false);
  }, [editorSession?.annotationFileId, platformMedia?.resourceId]);
  const platformMediaAnalysis = usePlatformMediaAnalysis({
    client: platformClient ?? null,
    currentUserId: editorSession?.currentUserId ?? null,
    annotationFileId: editorSession?.annotationFileId ?? null,
    enabled: Boolean(editorSession),
    canWrite: Boolean(editorSession?.canWrite),
    viewport: analysisViewport,
    spectrogramVisible: spectrogramSettings.visible,
    analysisPreset: spectrogramSettings.analysisPreset,
    showPitch: spectrogramSettings.showPitchContour,
  });
  const displayedWaveformData = editorSession
    ? platformMediaAnalysis.waveformData
    : waveformData;
  const displayedSpectrogramData = editorSession
    ? platformMediaAnalysis.spectrogramData
    : spectrogramData;
  const playbackSource = useMemo(() => buildPlatformMediaPlaybackSource({
    media: platformMedia,
    nativeUrl: project.video.url,
    requiresManualImport: Boolean(project.video.requiresManualImport),
    loadAliyunVodSession: (resourceId) => {
      if (!platformClient) return Promise.reject(new Error("平台媒体会话已结束。"));
      return platformClient.createAliyunVodPlaybackSession(resourceId);
    },
  }), [platformClient, platformMedia, project.video.requiresManualImport, project.video.url]);
  // 临时范围播放意图，统一表达 P 临时持续循环和 Tab 单次范围播放两种运行时行为，
  // 避免多个含义重叠的布尔 ref 互相覆盖。null 表示无临时意图（仅持久循环或普通播放）。
  const rangePlaybackIntentRef = useRef<RangePlaybackIntent | null>(null);
  const videoFileInputRef = useRef<HTMLInputElement>(null);
  const srtFileInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const mergeProjectFileInputRef = useRef<HTMLInputElement>(null);
  const waveformRequestIdRef = useRef(0);
  const spectrogramRequestIdRef = useRef(0);
  const serverSaveInFlightRef = useRef(false);
  const serverSaveCompletionRef = useRef<Promise<void> | null>(null);
  const resolveServerSaveCompletionRef = useRef<(() => void) | null>(null);
  // ref 负责同步阻止重复提交，state 负责让追赶与媒体门禁在保存结束后重新计算。
  // 仅修改 ref 不会触发渲染，失败会话可能因此永久停留在“保存中不可追赶”的旧判断中。
  const [serverSaveInFlight, setServerSaveInFlight] = useState(false);
  const syncFailureRuntimeIdRef = useRef(createRuntimeUuid());
  const syncFailureMismatchFieldsRef = useRef<string[]>([]);
  const syncFailureMismatchDetailsRef = useRef<ReturnType<typeof getSyncFailureMismatchDetails>>([]);
  const lastReportedSyncFailureRef = useRef<string | null>(null);
  // acquire 需要等待网络；这一门禁串行化结构、批量导入和批量修复，避免连续点击重复提交。
  const exclusiveMutationInFlightRef = useRef(false);
  // 媒体改绑会替换平台注入的运行时 URL，因此只允许在文档完全 clean 时执行；
  // 本地文件导入仍走原有编辑命令和撤销历史，不受这条平台治理门禁影响。
  const serverMediaBindingDisabledReason = editorSession
    ? getPlatformMediaBindingBlockReason({
        canWrite: editorSession.canWrite,
        hasUnsavedChanges,
        pendingOperationCount: pendingOperations.length,
        hasTransientEdit: transientProjectRef.current !== null,
        hasInlineEdit: editingCharacterId !== null || editingCustomTextBlock !== null,
        hasPendingMergeDraft: pendingAnnotationMergeDraft !== null,
        syncStatus: syncState.status,
        saveInFlight: serverSaveInFlight,
        appliedRemoteRevision: remoteBaseRevision,
        observedRemoteRevision,
      })
    : undefined;
  const canAttemptRemoteCatchUp = canAttemptPlatformOperationCatchUp({
    hasUnsavedChanges,
    pendingOperationCount: pendingOperations.length,
    hasTransientEdit: transientProjectRef.current !== null,
    hasInlineEdit: editingCharacterId !== null || editingCustomTextBlock !== null,
    hasPendingMergeDraft: pendingAnnotationMergeDraft !== null,
    syncStatus: syncState.status,
    saveInFlight: serverSaveInFlight,
    mediaBindingBusy: serverMediaBindingBusy,
  });

  // 每个异常 error 状态只上报一次有界诊断；维护拒绝属于预期门禁，不应反向制造诊断写入重试。
  useEffect(() => {
    if (
      !editorSession ||
      maintenanceSaveBlocked ||
      syncState.status !== "error" ||
      !syncState.errorMessage
    ) {
      if (syncState.status !== "error") {
        lastReportedSyncFailureRef.current = null;
        syncFailureMismatchFieldsRef.current = [];
        syncFailureMismatchDetailsRef.current = [];
      }
      return;
    }
    const report = buildAnnotationClientSyncFailureReport({
      clientRuntimeId: syncFailureRuntimeIdRef.current,
      errorMessage: syncState.errorMessage,
      syncState,
      appRemoteRevision: remoteBaseRevision,
      observedRemoteRevision,
      hasUnsavedChanges,
      saveInFlight: serverSaveInFlight,
      online: browserOnline,
      pendingOperations,
      mismatchFields: syncFailureMismatchFieldsRef.current,
      mismatchDetails: syncFailureMismatchDetailsRef.current,
    });
    const signature = JSON.stringify({
      fileId: editorSession.annotationFileId,
      category: report.category,
      reason: report.reason,
    });
    if (lastReportedSyncFailureRef.current === signature) return;
    lastReportedSyncFailureRef.current = signature;
    let cancelled = false;
    let retryTimer: number | null = null;
    const submitDiagnostic = async (attempt: number) => {
      try {
        await editorSession.client.reportAnnotationClientSyncFailure(
          editorSession.annotationFileId,
          report,
        );
      } catch (error) {
        if (cancelled) return;
        if (attempt < 2) {
          // API 重启或短暂离线时保留同一份失败快照，不能在重试时读取已经变化的文档状态。
          retryTimer = window.setTimeout(() => void submitDiagnostic(attempt + 1), 2_000 * (attempt + 1));
          return;
        }
        lastReportedSyncFailureRef.current = null;
        // 诊断通道不可用时仅写控制台，不能覆盖真正的同步失败原因。
        console.warn("客户端同步失败诊断未能写入服务端审计日志。", error);
      }
    };
    void submitDiagnostic(0);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [
    browserOnline,
    editorSession,
    hasUnsavedChanges,
    maintenanceSaveBlocked,
    observedRemoteRevision,
    pendingOperations,
    remoteBaseRevision,
    serverSaveInFlight,
    syncState,
  ]);
  // clean 平台会话低频追赶已提交 revision；行内编辑、保存、拖拽和整合期间必须暂停。
  // 完全没有本地修改的 error 会话也允许追赶，以修复服务端已提交但客户端确认链异常后的永久卡死。
  const requestPlatformCatchUp = usePlatformOperationCatchUp({
    enabled: Boolean(editorSession),
    blocked: !canAttemptRemoteCatchUp,
    online: browserOnline,
    sessionKey: editorSession?.annotationFileId ?? "local",
    knownRevision: remoteBaseRevision,
    cursor: remoteOperationCursor,
    check: async (facts) => {
      if (!editorSession) {
        return {
          status: "up_to_date",
          revision: facts.knownRevision,
          cursor: facts.cursor,
        };
      }
      return catchUpCommittedAnnotationOperations({
        annotationFileId: editorSession.annotationFileId,
        project: projectRef.current,
        knownRevision: facts.knownRevision,
        cursor: facts.cursor,
        listPage: (annotationFileId, options) =>
          editorSession.client.listCommittedAnnotationOperations(annotationFileId, options),
      });
    },
    apply: async (result, requestFacts) => {
      if (!editorSession || result.status === "up_to_date") return;

      if (result.status === "applied") {
        // 命令结果仍需通过 document clean 门禁；请求期间发生编辑时直接丢弃，不尝试自动 rebase。
        if (!replaceCleanProjectFromRemote(result.project, result.revision)) return;
        setObservedRemoteRevision((current) => Math.max(current, result.revision));
        setRemoteBaseRevision(result.revision);
        setRemoteOperationCursor(result.cursor);
        editorSession.onRemoteRevisionAdvanced(result.revision, result.cursor);
        void annotationReviews.refresh();
        return;
      }

      // 证据不足时重取权威 payload；await 前后的会话、revision、cursor 与 clean 状态必须仍完全一致。
      const latestFile = await editorSession.client.getAnnotationFile<ProjectData>(
        editorSession.annotationFileId,
      );
      if (
        remoteBaseRevisionRef.current !== requestFacts.knownRevision ||
        remoteOperationCursorRef.current !== requestFacts.cursor ||
        latestFile.revision < requestFacts.knownRevision
      ) return;
      const latestProject = hydrateProjectForClient(latestFile.payload, editorSession.client, latestFile.media);
      if (!replaceCleanProjectFromRemote(latestProject, latestFile.revision)) return;
      setObservedRemoteRevision((current) => Math.max(current, latestFile.revision));
      setRemoteBaseRevision(latestFile.revision);
      setRemoteOperationCursor(latestFile.operationCursor);
      editorSession.onAnnotationFileSaved(latestFile);
      void annotationReviews.refresh();
    },
    // 网络失败只保留当前 snapshot/cursor 等待下轮；不能把 clean 文档伪装成保存错误或冲突。
    onError: (error) => {
      console.warn("平台远端操作追赶失败，将在稍后重试。", error);
    },
  });
  const collaborationSession = usePlatformCollaborationSession({
    client: editorSession?.client ?? null,
    annotationFileId: editorSession?.annotationFileId ?? null,
    enabled: Boolean(editorSession),
    online: browserOnline,
    currentUserId: editorSession?.currentUserId ?? null,
    onMessage: (message) => {
      // ready 也可能观察到打开文件后、socket 建立前发生的新 revision；两类消息统一只唤醒 HTTP 追赶。
      if (
        (message.type === "session.ready" || message.type === "annotation.revision.advanced") &&
        message.annotationFileId === editorSession?.annotationFileId &&
        (message.type === "session.ready" || message.revision > remoteBaseRevisionRef.current)
      ) {
        setObservedRemoteRevision((current) => Math.max(current, message.revision));
        // ready/reconnect 总是触发一次权威 HTTP 检查；即使 revision 数值相同，cursor 也可能已推进。
        requestPlatformCatchUp();
      } else if (
        message.type === "annotation.review.changed" &&
        message.annotationFileId === editorSession?.annotationFileId
      ) {
        // 评论与确认不推进文档 revision；收到独立失效提示后只重读审核事实。
        void annotationReviews.refresh();
      }
    },
    onError: (error) => {
      console.warn("平台实时通知连接异常；HTTP 轮询仍会继续同步。", error);
    },
  });
  // 播放头、鼠标和选区摘要只是当前协作会话的瞬时预览，不进入 ProjectData、撤销历史或恢复草稿。
  useEffect(() => {
    collaborationSession.updatePlayhead({ time: currentTime, playing: isPlaying });
  }, [collaborationSession.updatePlayhead, currentTime, isPlaying]);
  const collaborationSelectionSummary = useMemo(
    () => buildTimelineSelectionSummary(project, selectedTimelineItems),
    [project, selectedTimelineItems],
  );
  useEffect(() => {
    collaborationSession.updateSelection(
      sharePointerAndSelection ? collaborationSelectionSummary : null,
    );
  }, [collaborationSelectionSummary, collaborationSession.updateSelection, sharePointerAndSelection]);
  const collaborationPointerSourceRef = useRef<string | null>(null);
  useEffect(() => {
    if (sharePointerAndSelection) return;
    collaborationPointerSourceRef.current = null;
    collaborationSession.updatePointer(null);
  }, [collaborationSession.updatePointer, sharePointerAndSelection]);
  const updateCollaborationPointer = useCallback((sourceId: string, time: number | null) => {
    if (!sharePointerAndSelection) {
      collaborationPointerSourceRef.current = null;
      collaborationSession.updatePointer(null);
      return;
    }
    if (time !== null) {
      collaborationPointerSourceRef.current = sourceId;
      collaborationSession.updatePointer({ time });
      return;
    }
    // 独立窗口接管鼠标后，旧 Timeline 迟到的 leave 不能清除新窗口位置。
    if (collaborationPointerSourceRef.current !== sourceId) return;
    collaborationPointerSourceRef.current = null;
    collaborationSession.updatePointer(null);
  }, [collaborationSession.updatePointer, sharePointerAndSelection]);
  useEffect(() => {
    const clearPointer = () => {
      collaborationPointerSourceRef.current = null;
      collaborationSession.updatePointer(null);
    };
    const clearHiddenPointer = () => {
      if (document.hidden) clearPointer();
    };
    window.addEventListener("blur", clearPointer);
    document.addEventListener("visibilitychange", clearHiddenPointer);
    return () => {
      window.removeEventListener("blur", clearPointer);
      document.removeEventListener("visibilitychange", clearHiddenPointer);
    };
  }, [collaborationSession.updatePointer]);
  const preferredCharacterEditLocationRef = useRef<CharacterEditLocation>("timeline");
  const blockContextMenuRef = useRef<HTMLDivElement>(null);
  const [blockContextMenuPosition, setBlockContextMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const timelinePasteTargetRef = useRef<TimelinePasteTarget | null>(null);
  const timelineTrackDefinitions = useMemo(
    () => buildTimelineTrackDefinitions(project.builtinTracks, project.customTracks, project.activeTrackOrder),
    [project.activeTrackOrder, project.builtinTracks, project.customTracks],
  );
  // 确认轨道选项只从当前项目真实持久轨道生成，不复用包含派生伪轨的 Timeline definitions。
  const confirmationTrackOptions = useMemo(
    () => getAnnotationConfirmationTrackOptions(project),
    [project.builtinTracks, project.customTracks],
  );
  const confirmationViewRecords = useMemo(
    () => buildAnnotationConfirmationViewRecords(
      annotationReviews.confirmations?.confirmations ?? [],
      annotationReviews.confirmations?.currentRevision ?? remoteBaseRevision,
      confirmationTrackOptions,
    ),
    [
      annotationReviews.confirmations,
      confirmationTrackOptions,
      remoteBaseRevision,
    ],
  );
  const commentViewRecords = useMemo(
    () => buildAnnotationRangeCommentViewRecords(
      annotationReviews.comments?.items ?? [],
      annotationReviews.comments?.currentRevision ?? remoteBaseRevision,
      confirmationTrackOptions,
    ),
    [annotationReviews.comments, confirmationTrackOptions, remoteBaseRevision],
  );
  const reviewTimelineItems = useMemo(
    () => layoutAnnotationReviewTimelineItems({
      confirmations: confirmationViewRecords,
      comments: commentViewRecords,
    }),
    [commentViewRecords, confirmationViewRecords],
  );
  // Timeline 只接收渲染所需的扁平只读字段，不依赖平台 API 记录结构或权限判断。
  const reviewTimelineRanges = useMemo(
    () => reviewTimelineItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      startTime: item.startTime,
      endTime: item.endTime,
      label: item.label,
      lane: item.lane,
      lifecycle: item.lifecycle,
      freshness: item.freshness,
    })),
    [reviewTimelineItems],
  );
  const confirmationCreateBlocker = getAnnotationConfirmationCreateBlocker({
    canReview: editorSession?.canReview ?? false,
    hasRange: Boolean(loopPlaybackRange),
    hasUnsavedChanges,
    editorRevision: remoteBaseRevision,
    serverRevision: annotationReviews.confirmations?.currentRevision ??
      annotationReviews.comments?.currentRevision ?? null,
    loading: annotationReviews.loading,
  });
  const customBlocks = useMemo(
    () => flattenCustomTrackBlocks(project.customTracks),
    [project.customTracks],
  );
  const missingBuiltinTracks = useMemo(
    () => getMissingBuiltinTracks(project.builtinTracks),
    [project.builtinTracks],
  );
  const activeBuiltinTrackIds = useMemo(
    () => new Set(project.builtinTracks.map((track) => track.id)),
    [project.builtinTracks],
  );
  const importMergePreviews = useMemo(() => {
    if (!pendingImportMergeState) {
      return {};
    }
    return Object.fromEntries(
      pendingImportMergeState.rows.map((row) => [
        row.key,
        getImportMergePreview(projectRef.current, pendingImportMergeState.sourceProject, pendingImportMergeState.rows, row),
      ]),
    ) as Record<string, ImportMergePreview>;
  }, [pendingImportMergeState]);

  useEffect(() => {
    const currentTrackSnapState = trackSnapEnabledRef.current;
    const nextTrackSnapState = (() => {
      const next = Object.fromEntries(
        timelineTrackDefinitions.map((track) => [track.id, currentTrackSnapState[track.id] ?? true]),
      );
      const currentKeys = Object.keys(currentTrackSnapState);
      const nextKeys = Object.keys(next);
      const changed = currentKeys.length !== nextKeys.length ||
        nextKeys.some((key) => currentTrackSnapState[key] !== next[key]);
      return changed ? next : currentTrackSnapState;
    })();

    if (nextTrackSnapState !== currentTrackSnapState) {
      applyTrackSnapEnabledState(nextTrackSnapState, { recordOperation: false });
    }
  }, [applyTrackSnapEnabledState, timelineTrackDefinitions, trackSnapEnabledRef]);

  useEffect(() => {
    if (!hasUnsavedChanges) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!localEditorSession || localEditorSession.source !== "json") {
      return;
    }
    setManualVideoRelinkPrompt(
      shouldPromptForManualVideoImport(localEditorSession.initialProject.video)
        ? localEditorSession.initialProject.video
        : null,
    );
  }, [localEditorSession?.id]);

  function applySelection(
    nextSelectedItem: SelectedItem,
    timelineItems?: TimelineSelectionItem[],
    options?: { syncLoopPlaybackRange?: boolean },
  ) {
    setSelectedItem(nextSelectedItem);
    // 导入项目时只是恢复界面焦点，不能让“选中第一句”覆盖文件中保存的循环范围。
    if (options?.syncLoopPlaybackRange !== false) {
      syncLoopPlaybackRangeFromSelection(nextSelectedItem);
    }
    if (timelineItems !== undefined) {
      setSelectedTimelineItems(timelineItems);
      return;
    }
    if (nextSelectedItem?.type === "character" || nextSelectedItem?.type === "action") {
      setSelectedTimelineItems([{ type: nextSelectedItem.type, id: nextSelectedItem.id }]);
      return;
    }
    if (nextSelectedItem?.type === "custom-block") {
      setSelectedTimelineItems([
        {
          type: "custom-block",
          id: nextSelectedItem.id,
          trackId: nextSelectedItem.trackId,
          branchLaneId: nextSelectedItem.branchLaneId,
        },
      ]);
      return;
    }
    if (nextSelectedItem?.type === "attached-point") {
      setSelectedTimelineItems([
        {
          type: "attached-point",
          id: nextSelectedItem.id,
          trackId: nextSelectedItem.trackId,
          parentTrackId: nextSelectedItem.parentTrackId,
        },
      ]);
      return;
    }
    setSelectedTimelineItems([]);
  }

  function syncLoopPlaybackRangeFromSelection(nextSelectedItem: SelectedItem) {
    if (!nextSelectedItem) {
      return;
    }
    const currentProject = projectRef.current;
    if (nextSelectedItem.type === "line") {
      const line = currentProject.subtitleLines.find((item) => item.id === nextSelectedItem.id);
      if (line && line.endTime - line.startTime > 0.001) {
        setLoopPlaybackRange({ start: line.startTime, end: line.endTime });
      }
      return;
    }
    if (nextSelectedItem.type === "character") {
      const track = currentProject.builtinTracks.find((item) => item.id === "character-track");
      const character = currentProject.characterAnnotations.find((item) => item.id === nextSelectedItem.id);
      if (track?.autoSetLoopRangeOnSelect && character) {
        setLoopPlaybackRange({ start: character.startTime, end: character.endTime });
      }
      return;
    }
    if (nextSelectedItem.type === "action") {
      const action = currentProject.actionAnnotations.find((item) => item.id === nextSelectedItem.id);
      const track = action
        ? currentProject.builtinTracks.find((item) => item.id === action.trackId)
        : null;
      if (track?.autoSetLoopRangeOnSelect && action) {
        setLoopPlaybackRange({ start: action.startTime, end: action.endTime });
      }
      return;
    }
    if (nextSelectedItem.type === "custom-block") {
      const track = currentProject.customTracks.find((item) => item.id === nextSelectedItem.trackId);
      const block = track?.blocks.find((item) => item.id === nextSelectedItem.id);
      if (track?.autoSetLoopRangeOnSelect && block) {
        setLoopPlaybackRange({ start: block.startTime, end: block.endTime });
      }
      return;
    }
    if (nextSelectedItem.type === "gongche-block") {
      const block = currentProject.gongcheAnnotations.find((item) => item.id === nextSelectedItem.id);
      const parentTrack = block
        ? currentProject.builtinTracks.find((item) => item.id === block.parentTrackId) ??
          currentProject.customTracks.find((item) => item.id === block.parentTrackId)
        : null;
      if (parentTrack?.autoSetLoopRangeOnSelect && block) {
        setLoopPlaybackRange({ start: block.startTime, end: block.endTime });
      }
    }
  }

  function updateTimelinePasteTarget(trackId: string, time: number) {
    timelinePasteTargetRef.current = {
      trackId,
      time: Math.max(0, time),
    };
  }

  function closeTimelineContextMenu() {
    setBlockContextMenu(null);
  }

  const selectedLineId = selectedItem?.type === "line"
    ? selectedItem.id
    : selectedItem?.type === "character"
      ? project.characterAnnotations.find((item) => item.id === selectedItem.id)?.lineId ?? null
      : null;

  const focusRange = useMemo(() => {
    if (confirmationFocusRange) {
      return confirmationFocusRange;
    }
    if (!lineFocusRequest) {
      return initialPlatformFocusRange;
    }
    const line = project.subtitleLines.find((item) => item.id === lineFocusRequest.lineId);
    if (!line) {
      return null;
    }
    return {
      requestId: lineFocusRequest.requestId,
      start: Math.max(0, line.startTime - 1.5),
      end: line.endTime + 1.5,
    };
  }, [confirmationFocusRange, initialPlatformFocusRange, lineFocusRequest, project.subtitleLines]);

  // Timeline 回报已接收后按来源清理请求；用户触发句级定位时一并淘汰尚未消费的启动焦点。
  const handleFocusRangeHandled = useCallback(() => {
    if (confirmationFocusRange) {
      setConfirmationFocusRange(null);
      return;
    }
    if (lineFocusRequest) {
      setLineFocusRequest(null);
      setInitialPlatformFocusRange(null);
      return;
    }
    setInitialPlatformFocusRange(null);
  }, [confirmationFocusRange, lineFocusRequest]);

  useEffect(() => {
    setDuration(
      Math.max(
        videoRef.current?.getSnapshot().duration || 0,
        getProjectDuration(project),
      ),
    );
  }, [project]);

  useEffect(() => {
    videoRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  useEffect(() => {
    const player = videoRef.current;
    const intent = rangePlaybackIntentRef.current;
    if (previewTime !== null || !loopPlaybackRange || !player) {
      return;
    }
    if (loopPlaybackRange.end - loopPlaybackRange.start <= 0.001) {
      return;
    }
    // 沿用现有与 playbackRate 相关的终点阈值，避免高速播放越过终点。
    const loopEndThreshold = Math.max(0.01, 0.04 / Math.max(playbackRate, 0.25));
    if (intent?.mode === "play-range-once") {
      // 范围已经由选择或拖动改变时，旧意图交给下方清理 effect 取消，不能套用到新范围。
      if (!doesRangePlaybackIntentMatch(intent, loopPlaybackRange)) {
        return;
      }
      if (currentTime < intent.playbackEnd - loopEndThreshold && !player.getSnapshot().ended) {
        return;
      }
      // 单次范围播放到终点：校正到 end、暂停、清除意图、恢复进入前的持久循环设置，不跳回起点。
      finishOneShotRangePlayback(intent);
      return;
    }
    if (
      intent?.mode === "temporary-continuous-loop" &&
      !doesRangePlaybackIntentMatch(intent, loopPlaybackRange)
    ) {
      return;
    }
    if (!isPlaying || currentTime < loopPlaybackRange.end - loopEndThreshold) {
      return;
    }
    // 持久循环或 P 临时持续循环：到终点跳回起点。
    if (!loopPlaybackEnabled) {
      return;
    }
    const nextTime = clampTime(loopPlaybackRange.start, duration);
    void player.seek(nextTime);
    setCurrentTime(nextTime);
  }, [currentTime, duration, isPlaying, loopPlaybackEnabled, loopPlaybackRange, playbackRate, previewTime]);

  // 持久循环被关闭时，终止 P 临时持续循环意图；单次播放意图不在此清理
  //（由终点、空格、清除范围或切换视频处理）。
  useEffect(() => {
    if (!loopPlaybackEnabled) {
      if (rangePlaybackIntentRef.current?.mode === "temporary-continuous-loop") {
        rangePlaybackIntentRef.current = null;
      }
    }
  }, [loopPlaybackEnabled]);

  // 清除、替换循环范围或切换视频时，不能留下指向旧范围的单次/临时播放意图。
  // 依赖具体边界而不是“是否为空”，因此块选择把 A 范围换成 B 范围也会取消旧播放意图。
  useEffect(() => {
    const intent = rangePlaybackIntentRef.current;
    if (
      intent &&
      (!loopPlaybackRange || !doesRangePlaybackIntentMatch(intent, loopPlaybackRange))
    ) {
      cancelRangePlaybackIntent();
    }
  }, [loopPlaybackRange?.start, loopPlaybackRange?.end]);

  useEffect(() => {
    cancelRangePlaybackIntent();
  }, [project.video.url]);

  useEffect(() => {
    const videoUrl = project.video.url;
    const requestId = waveformRequestIdRef.current + 1;
    waveformRequestIdRef.current = requestId;

    if (editorSession || !videoUrl) {
      setWaveformData(null);
      setSpectrogramData(null);
      setLocalAnalysisError(null);
      setIsWaveformLoading(false);
      setIsSpectrogramLoading(false);
      return;
    }

    let cancelled = false;
    setIsWaveformLoading(true);
    setLocalAnalysisError(null);
    setSpectrogramData(null);

    const abortController = new AbortController();
    void buildLocalWaveformData(videoUrl, abortController.signal)
      .then((nextWaveformData) => {
        if (cancelled || waveformRequestIdRef.current !== requestId) {
          return;
        }
        setWaveformData(nextWaveformData);
      })
      .catch((error: unknown) => {
        if (cancelled || waveformRequestIdRef.current !== requestId) {
          return;
        }
        setWaveformData(null);
        setLocalAnalysisError(
          error instanceof Error ? error.message : "无法分析本机媒体中的音频。",
        );
      })
      .finally(() => {
        if (cancelled || waveformRequestIdRef.current !== requestId) {
          return;
        }
        setIsWaveformLoading(false);
      });

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [editorSession, project.video.url]);

  useEffect(() => {
    const requestId = spectrogramRequestIdRef.current + 1;
    spectrogramRequestIdRef.current = requestId;

    if (editorSession || !spectrogramSettings.visible || !waveformData) {
      setSpectrogramData(null);
      setIsSpectrogramLoading(false);
      return;
    }

    if (
      spectrogramData &&
      spectrogramData.analysisPreset === spectrogramSettings.analysisPreset &&
      (!spectrogramSettings.showPitchContour || spectrogramData.pitchFrames)
    ) {
      return;
    }

    const abortController = new AbortController();
    setIsSpectrogramLoading(true);

    void buildSpectrogramData(
      waveformData,
      spectrogramSettings.showPitchContour,
      spectrogramSettings.analysisPreset,
      abortController.signal,
    )
      .then((nextSpectrogramData) => {
        if (
          abortController.signal.aborted ||
          spectrogramRequestIdRef.current !== requestId
        ) {
          return;
        }
        setSpectrogramData(nextSpectrogramData);
      })
      .catch(() => {
        if (
          abortController.signal.aborted ||
          spectrogramRequestIdRef.current !== requestId
        ) {
          return;
        }
        setSpectrogramData(null);
      })
      .finally(() => {
        if (
          abortController.signal.aborted ||
          spectrogramRequestIdRef.current !== requestId
        ) {
          return;
        }
        setIsSpectrogramLoading(false);
      });

    return () => {
      abortController.abort();
    };
  }, [
    editorSession,
    spectrogramData,
    spectrogramSettings.analysisPreset,
    spectrogramSettings.showPitchContour,
    spectrogramSettings.visible,
    waveformData,
  ]);

  const handleGlobalKeyDown = useCallback((event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveProjectFile();
      return;
    }
    if (isEditableKeyboardTarget(event.target)) {
      return;
    }
    // Cmd/Ctrl + K 打开顶栏「搜索」：只递增请求号，真正的展开由 TopMenuBar 负责。
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setCommandSearchOpenRequestId(performance.now());
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      if (tryConsumeSpaceForRangeIntent()) {
        return;
      }
      togglePlay();
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      playLoopFromRangeStart();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "Tab") {
      event.preventDefault();
      playLoopRangeOnce();
      return;
    }
    // Command/Ctrl + 左右：选择当前逻辑轨道相邻块，优先于普通方向键的时间步进。
    if ((event.metaKey || event.ctrlKey) && event.key === "ArrowLeft") {
      event.preventDefault();
      selectAdjacentTimelineBlock("previous");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "ArrowRight") {
      event.preventDefault();
      selectAdjacentTimelineBlock("next");
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekTo(currentTime - (event.shiftKey ? 1 : 0.04));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekTo(currentTime + (event.shiftKey ? 1 : 0.04));
    }
    if (event.key === "Enter") {
      if (selectedItem?.type === "character" && !editingCharacterId) {
        event.preventDefault();
        startCharacterTextEdit(selectedItem.id, preferredCharacterEditLocationRef.current);
      }
      if (
        selectedItem?.type === "custom-block" &&
        !editingCustomTextBlock &&
        findCustomBlock(projectRef.current.customTracks, selectedItem.trackId, selectedItem.id)?.trackType === "text"
      ) {
        event.preventDefault();
        startCustomTextEdit(selectedItem.trackId, selectedItem.id);
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAllTimelineItems();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copyTimelineSelection();
      closeTimelineContextMenu();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "x") {
      event.preventDefault();
      cutTimelineSelection();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      pasteTimelineClipboard();
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (
        selectedTimelineItems.length > 0 ||
        selectedItem?.type === "character" ||
        selectedItem?.type === "action" ||
        selectedItem?.type === "custom-block" ||
        selectedItem?.type === "gongche-block" ||
        selectedItem?.type === "attached-point" ||
        selectedItem?.type === "banyan-mark"
      ) {
        event.preventDefault();
        deleteSelected();
      }
    }
  }, [
    currentTime,
    editingCharacterId,
    editingCustomTextBlock,
    previewTime,
    selectedItem,
    selectedTimelineItems,
    timelineClipboard,
    undoStack,
    redoStack,
    project,
    trackSnapEnabled,
    duration,
    loopPlaybackRange,
    loopPlaybackEnabled,
  ]);

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [handleGlobalKeyDown]);

  useEffect(() => {
    const preventPageZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
      }
    };

    const preventGestureZoom = (event: Event) => {
      event.preventDefault();
    };

    window.addEventListener("wheel", preventPageZoom, { passive: false, capture: true });
    document.addEventListener("gesturestart", preventGestureZoom, { passive: false });
    document.addEventListener("gesturechange", preventGestureZoom, { passive: false });
    document.addEventListener("gestureend", preventGestureZoom, { passive: false });

    return () => {
      window.removeEventListener("wheel", preventPageZoom, { capture: true });
      document.removeEventListener("gesturestart", preventGestureZoom);
      document.removeEventListener("gesturechange", preventGestureZoom);
      document.removeEventListener("gestureend", preventGestureZoom);
    };
  }, []);

  const activeCharacters = useMemo(() => {
    if (!selectedLineId) {
      return [];
    }
    return sortCharactersByTime(project.characterAnnotations.filter((item) => item.lineId === selectedLineId));
  }, [project.characterAnnotations, selectedLineId]);

  function toggleSubtitlePanelCollapsed() {
    setIsSubtitlePanelCollapsed((current) => !current);
  }

  function toggleSplitPanelCollapsed() {
    setIsSplitPanelCollapsed((current) => !current);
  }

  function toggleConfirmationPanelCollapsed() {
    setIsConfirmationPanelCollapsed((current) => !current);
  }

  function requestInspectorFocus(target: InspectorFocusRequest["target"]) {
    setInspectorFocusRequest({
      target,
      requestId: performance.now(),
    });
  }

  function openBranchTrackSettings(trackId: string) {
    setLineFocusRequest(null);
    applySelection({ type: "custom-track", id: trackId });
    requestInspectorFocus("track-branching");
    setBlockContextMenu(null);
  }

  function enableBranchTrackAndOpenSettings(trackId: string) {
    // 未启用分叉的轨道也从右键进入同一套 Inspector 设置，避免把分叉编辑拆成两套入口。
    setCustomTrackBranchingEnabled(trackId, true);
    openBranchTrackSettings(trackId);
  }

  function openBlockBranchScopeSettings(trackId: string, blockId: string) {
    setLineFocusRequest(null);
    applySelection({ type: "custom-block", trackId, id: blockId });
    requestInspectorFocus("block-branch-scope");
    setBlockContextMenu(null);
  }

  // 顶栏搜索跳转到某条轨道的设置字段：与右键菜单走完全相同的三步（清除行聚焦 → 选中轨道 → 请求 Inspector 聚焦），
  // 本身不产生任何文档变更、操作记录或撤销历史。
  function openTrackSettingFromSearch(target: TrackSettingCommandTarget) {
    setLineFocusRequest(null);
    if (target.trackKind === "attached-point" && target.parentTrackId) {
      applySelection({
        type: "attached-point-track",
        id: target.trackId,
        parentTrackId: target.parentTrackId,
      });
    } else if (target.trackKind === "builtin") {
      applySelection({ type: "builtin-track", id: target.trackId as BuiltinTrackId });
    } else {
      applySelection({ type: "custom-track", id: target.trackId });
    }
    requestInspectorFocus(target.focusTarget);
    setBlockContextMenu(null);
  }

  // 开关类轨道设置在搜索结果里点击即翻转，与直接点面板上的开关等价：
  // 走同一批 handler，因此同样进入撤销历史和平台租约流程。同时仍然定位并高亮该字段，
  // 让用户看到被改动的是哪条轨道的哪个开关。非开关字段（名称、颜色、类型列表）只做定位。
  function runTrackSettingCommand(target: TrackSettingCommandTarget) {
    openTrackSettingFromSearch(target);
    if (!target.toggle) {
      return;
    }
    const track = findTrackForCommand(
      target.trackId,
      projectRef.current.builtinTracks,
      projectRef.current.customTracks,
    );
    if (!track) {
      return;
    }
    if (target.field === "track-snap") {
      applyTrackSnapEnabledState({
        ...trackSnapEnabledRef.current,
        [target.trackId]: !trackSnapEnabledRef.current[target.trackId],
      });
      return;
    }
    // 两个吸附细项在轨道头总开关关闭时于面板上不可编辑，搜索也必须遵守同一条门禁。
    if (
      (target.field === "waveform-snap" || target.field === "parent-boundary-snap") &&
      !trackSnapEnabledRef.current[target.trackId]
    ) {
      return;
    }
    if (target.field === "waveform-snap") {
      updateTrackWaveformSnap(target.trackId, !track.snapToWaveformKeypoints);
      return;
    }
    if (target.field === "parent-boundary-snap") {
      const current = "snapToParentBoundaries" in track ? track.snapToParentBoundaries : false;
      updateAttachedPointTrackParentSnap(target.trackId, !current);
      return;
    }
    if (target.field === "auto-loop-range") {
      updateTrackAutoLoopRange(target.trackId, !track.autoSetLoopRangeOnSelect);
      return;
    }
    if (target.field === "branching" && "branching" in track) {
      setCustomTrackBranchingEnabled(target.trackId, !track.branching?.enabled);
    }
  }

  // 音频分析设置只在选中波形/频谱轨时渲染。选中态与轨道可见性无关，
  // 因此即使用户把波形和频谱都隐藏了，搜索仍然能把设置面板重新调出来。
  function openAudioSettingFromSearch(focusTarget: InspectorFocusTarget) {
    setLineFocusRequest(null);
    applySelection({ type: "waveform-track" });
    requestInspectorFocus(focusTarget);
    setBlockContextMenu(null);
  }

  // 命令执行体通过 ref 读取最新的 handler 和播放位置，避免把 currentTime 之类的高频状态
  // 放进 useMemo 依赖后，每一帧都重建一遍搜索条目。
  commandHandlersRef.current = {
    currentTime,
    triggerFileInput: (ref: RefObject<HTMLInputElement>) => ref.current?.click(),
    videoFileInputRef,
    srtFileInputRef,
    projectFileInputRef,
    mergeProjectFileInputRef,
    saveProjectFile,
    saveProjectToServer,
    handleExport,
    undo,
    redo,
    repairSentenceCharacterTrack,
    togglePlay,
    seekTo,
    setPlaybackRate,
    updateLoopPlaybackEnabledFromUser,
    clearLoopPlaybackRange,
    setWaveformVisible,
    setSpectrogramSettings,
    setBanyanTrackVisible,
    setBanyanGridVisible,
    setServerMediaDialogOpen,
    toggleConfirmationPanelDocked,
    toggleConfirmationDetachedWindow,
    runTrackSettingCommand,
    openAudioSettingFromSearch,
    loopPlaybackEnabled,
  };

  // 轨道级设置条目随项目结构变化重建；播放位置、选中项等高频状态不参与这里的依赖。
  const trackSettingCommands = useMemo(
    () => buildTrackSettingCommands(project.builtinTracks, project.customTracks),
    [project.builtinTracks, project.customTracks],
  );

  // 把「命令目录」和「运行时」装配成搜索面板可直接使用的条目。
  // 静态部分用必填 Record 建表：目录里新增定义却忘记接线时，tsc 会直接报错而不是留下一个死入口。
  const commandSearchEntries = useMemo<CommandSearchEntry[]>(() => {
    const handlers = () => commandHandlersRef.current;
    const localRuntime: Record<LocalStaticCommandId, CommandRuntimeEntry> = {
      "file.import-video": {
        disabledReason: remoteCatchUpBlockReason,
        run: () => handlers().triggerFileInput(handlers().videoFileInputRef),
      },
      "file.import-srt": {
        disabledReason: remoteCatchUpBlockReason,
        run: () => handlers().triggerFileInput(handlers().srtFileInputRef),
      },
      "file.import-project": {
        disabledReason: remoteCatchUpBlockReason,
        run: () => handlers().triggerFileInput(handlers().projectFileInputRef),
      },
      "file.import-merge-project": {
        disabledReason: remoteCatchUpBlockReason,
        run: () => handlers().triggerFileInput(handlers().mergeProjectFileInputRef),
      },
      "file.save-local": { run: () => void handlers().saveProjectFile() },
      "file.export-character-srt": { run: () => handlers().handleExport() },
      "edit.undo": {
        disabledReason: remoteCatchUpBlockReason ?? (undoStack.length > 0 ? undefined : "没有可撤销的编辑"),
        run: () => handlers().undo(),
      },
      "edit.redo": {
        disabledReason: remoteCatchUpBlockReason ?? (redoStack.length > 0 ? undefined : "没有可重做的编辑"),
        run: () => handlers().redo(),
      },
      "edit.repair-sentence-character-track": {
        disabledReason: remoteCatchUpBlockReason,
        run: () => handlers().repairSentenceCharacterTrack(),
      },
      "playback.toggle": { run: () => handlers().togglePlay() },
      "playback.step-back-100ms": { run: () => handlers().seekTo(handlers().currentTime - 0.1) },
      "playback.step-forward-100ms": { run: () => handlers().seekTo(handlers().currentTime + 0.1) },
      "playback.step-back-frame": { run: () => handlers().seekTo(handlers().currentTime - 0.04) },
      "playback.step-forward-frame": { run: () => handlers().seekTo(handlers().currentTime + 0.04) },
      "playback.rate-0.5": {
        checked: playbackRate === 0.5,
        run: () => handlers().setPlaybackRate(0.5),
      },
      "playback.rate-0.75": {
        checked: playbackRate === 0.75,
        run: () => handlers().setPlaybackRate(0.75),
      },
      "playback.rate-1": {
        checked: playbackRate === 1,
        run: () => handlers().setPlaybackRate(1),
      },
      "playback.rate-1.25": {
        checked: playbackRate === 1.25,
        run: () => handlers().setPlaybackRate(1.25),
      },
      "playback.rate-1.5": {
        checked: playbackRate === 1.5,
        run: () => handlers().setPlaybackRate(1.5),
      },
      "playback.toggle-loop": {
        checked: Boolean(loopPlaybackRange) && loopPlaybackEnabled,
        disabledReason: loopPlaybackRange ? undefined : "请先在时间轴上创建循环选区",
        run: () => handlers().updateLoopPlaybackEnabledFromUser(!handlers().loopPlaybackEnabled),
      },
      "playback.clear-loop-range": {
        disabledReason: loopPlaybackRange ? undefined : "当前没有循环选区",
        run: () => handlers().clearLoopPlaybackRange(),
      },
      "view.waveform": {
        checked: waveformVisible,
        run: () => handlers().setWaveformVisible(!waveformVisible),
      },
      "view.spectrogram": {
        checked: spectrogramSettings.visible,
        run: () =>
          handlers().setSpectrogramSettings((prev) => ({ ...prev, visible: !prev.visible })),
      },
      "view.banyan-track": {
        checked: banyanTrackVisible,
        run: () => handlers().setBanyanTrackVisible(!banyanTrackVisible),
      },
      "view.banyan-grid": {
        checked: banyanGridVisible,
        run: () => handlers().setBanyanGridVisible(!banyanGridVisible),
      },
      "audio.panel": { run: () => handlers().openAudioSettingFromSearch("audio-waveform-visible") },
      // F0 是布尔开关，与视图菜单里的可见性开关同类：点击即翻转，并定位高亮到所在分组。
      "audio.pitch-contour": {
        checked: spectrogramSettings.showPitchContour,
        run: () => {
          handlers().openAudioSettingFromSearch("audio-pitch-contour");
          handlers().setSpectrogramSettings((previous) => ({
            ...previous,
            showPitchContour: !previous.showPitchContour,
          }));
        },
      },
      "audio.frequency-scale": {
        run: () => handlers().openAudioSettingFromSearch("audio-frequency-scale"),
      },
      "audio.frequency-preset": {
        run: () => handlers().openAudioSettingFromSearch("audio-frequency-preset"),
      },
      "audio.analysis-preset": {
        run: () => handlers().openAudioSettingFromSearch("audio-analysis-preset"),
      },
    };

    // 平台条目在本地模式下不写入运行时，搜索结果里因此完全不出现，
    // 不需要额外的禁用文案，也不可能被点成报错入口。
    const platformRuntime: Partial<Record<PlatformStaticCommandId, CommandRuntimeEntry>> =
      editorSession
        ? {
            "file.bind-server-media": {
              disabledReason: serverMediaBindingDisabledReason,
              run: () => handlers().setServerMediaDialogOpen(true),
            },
            "file.save-server": {
              disabledReason: editorSession.canWrite ? undefined : "当前账号没有写入权限",
              run: () => void handlers().saveProjectToServer({ source: "manual" }),
            },
            "view.annotation-confirmation-docked": {
              checked: confirmationPanelPlacement === "docked",
              run: () => handlers().toggleConfirmationPanelDocked(),
            },
            "view.annotation-confirmation-detached": {
              checked: confirmationPanelPlacement === "detached",
              run: () => handlers().toggleConfirmationDetachedWindow(),
            },
            "audio.analysis-source": {
              run: () => handlers().openAudioSettingFromSearch("audio-analysis-source"),
            },
          }
        : {};

    const entries: CommandSearchEntry[] = [];
    for (const definition of LOCAL_STATIC_COMMAND_DEFINITIONS) {
      entries.push({ ...definition, ...localRuntime[definition.id] });
    }
    for (const definition of PLATFORM_STATIC_COMMAND_DEFINITIONS) {
      const runtime = platformRuntime[definition.id];
      if (runtime) {
        entries.push({ ...definition, ...runtime });
      }
    }
    // 轨道设置条目共用一个通用执行体，新增轨道或字段都不需要在这里逐条接线；
    // 勾选态和禁用原因由纯函数按当前项目推导，规则与 Inspector 面板上的开关完全一致。
    for (const definition of trackSettingCommands) {
      if (definition.target.kind !== "track-setting") {
        continue;
      }
      const target = definition.target;
      const state = resolveTrackSettingCommandState(
        target,
        project.builtinTracks,
        project.customTracks,
        trackSnapEnabled,
      );
      entries.push({
        ...definition,
        checked: state.checked,
        disabledReason: state.disabledReason,
        run: () => handlers().runTrackSettingCommand(target),
      });
    }
    return entries;
  }, [
    banyanGridVisible,
    banyanTrackVisible,
    confirmationPanelPlacement,
    editorSession,
    loopPlaybackEnabled,
    loopPlaybackRange,
    playbackRate,
    project.builtinTracks,
    project.customTracks,
    redoStack.length,
    remoteCatchUpBlockReason,
    serverMediaBindingDisabledReason,
    spectrogramSettings.showPitchContour,
    spectrogramSettings.visible,
    trackSettingCommands,
    trackSnapEnabled,
    undoStack.length,
    waveformVisible,
  ]);

  const contextMenuLine = blockContextMenu?.type === "line"
    ? project.subtitleLines.find((item) => item.id === blockContextMenu.id) ?? null
    : null;
  const contextMenuCharacter = blockContextMenu?.type === "character"
    ? project.characterAnnotations.find((item) => item.id === blockContextMenu.id) ?? null
    : null;
  const contextMenuAction = blockContextMenu?.type === "action"
    ? project.actionAnnotations.find((item) => item.id === blockContextMenu.id) ?? null
    : null;
  const contextMenuCustomBlock = blockContextMenu?.type === "custom-block"
    ? customBlocks.find((item) =>
        item.id === blockContextMenu.id && item.trackId === blockContextMenu.trackId,
      ) ?? null
    : null;
  const contextMenuAttachedPoint = blockContextMenu?.type === "attached-point"
    ? findPointTrackLocation(project, blockContextMenu.trackId)?.pointTrack.points.find((item) =>
        item.id === blockContextMenu.id,
      ) ?? null
    : null;
  const contextMenuGongcheBlock = blockContextMenu?.type === "gongche-block"
    ? project.gongcheAnnotations.find((item) => item.id === blockContextMenu.id) ?? null
    : null;
  const contextMenuBanyanMark = blockContextMenu?.type === "banyan-mark"
    ? project.banyanMarks.find((item) => item.id === blockContextMenu.id) ?? null
    : null;
  const contextMenuSplitCharacters = contextMenuCharacter
    ? getSplittableCharacters(contextMenuCharacter.char)
    : [];
  const selectedCharacterLineMergeContext = contextMenuCharacter
    ? getSelectedCharacterLineMergeContext(contextMenuCharacter.id, project)
    : null;
  const contextMenuActionTrack = contextMenuAction
    ? timelineTrackDefinitions.find((track) => track.id === contextMenuAction.trackId) ?? null
    : null;
  const contextMenuCustomTrack = contextMenuCustomBlock
    ? project.customTracks.find((track) => track.id === contextMenuCustomBlock.trackId) ?? null
    : null;
  const contextMenuLaneBranchParts = blockContextMenu?.type === "lane"
    ? getBranchLaneTrackParts(blockContextMenu.trackId)
    : null;
  const contextMenuLaneTrackId = blockContextMenu?.type === "lane"
    ? contextMenuLaneBranchParts?.parentTrackId ?? blockContextMenu.trackId
    : null;
  const contextMenuLaneCustomTrack = contextMenuLaneTrackId
    ? project.customTracks.find((track) => track.id === contextMenuLaneTrackId) ?? null
    : null;
  const contextMenuAttachedPointTrackLocation = blockContextMenu?.type === "attached-point"
    ? findPointTrackLocation(project, blockContextMenu.trackId)
    : null;
  const contextMenuAttachedPointTrack = contextMenuAttachedPointTrackLocation?.pointTrack ?? null;
  const canPasteTimelineClipboard = Boolean(timelineClipboard?.items.length);

  useLayoutEffect(() => {
    if (!blockContextMenu || !blockContextMenuRef.current) {
      setBlockContextMenuPosition(null);
      return;
    }

    const menu = blockContextMenuRef.current;
    const { innerWidth, innerHeight } = window;
    const menuRect = menu.getBoundingClientRect();
    let left = blockContextMenu.x + CONTEXT_MENU_GAP;
    let top = blockContextMenu.y + CONTEXT_MENU_GAP;

    if (left + menuRect.width > innerWidth - CONTEXT_MENU_VIEWPORT_MARGIN) {
      left = blockContextMenu.x - menuRect.width - CONTEXT_MENU_GAP;
    }
    if (top + menuRect.height > innerHeight - CONTEXT_MENU_VIEWPORT_MARGIN) {
      top = blockContextMenu.y - menuRect.height - CONTEXT_MENU_GAP;
    }

    left = Math.max(
      CONTEXT_MENU_VIEWPORT_MARGIN,
      Math.min(left, innerWidth - menuRect.width - CONTEXT_MENU_VIEWPORT_MARGIN),
    );
    top = Math.max(
      CONTEXT_MENU_VIEWPORT_MARGIN,
      Math.min(top, innerHeight - menuRect.height - CONTEXT_MENU_VIEWPORT_MARGIN),
    );

    setBlockContextMenuPosition((current) =>
      current?.left === left && current?.top === top ? current : { left, top },
    );
  }, [
    blockContextMenu,
    contextMenuSplitCharacters.length,
    contextMenuActionTrack,
    selectedCharacterLineMergeContext?.selectedCharacters.length,
    selectedCharacterLineMergeContext?.canMergeIntoPrevious,
    selectedCharacterLineMergeContext?.canMergeIntoNext,
    project.characterAnnotations,
    project.actionAnnotations,
  ]);

  useEffect(() => {
    if (!editingCharacterId) {
      return;
    }
    const editingCharacter = project.characterAnnotations.find((item) => item.id === editingCharacterId);
    if (!editingCharacter || (selectedLineId && editingCharacter.lineId !== selectedLineId)) {
      setEditingCharacterId(null);
      setEditingCharacterLocation(null);
      setEditingCharacterValue("");
    }
  }, [editingCharacterId, project.characterAnnotations, selectedLineId]);

  useEffect(() => {
    if (!editingCustomTextBlock) {
      return;
    }
    const editingBlock = findCustomBlock(project.customTracks, editingCustomTextBlock.trackId, editingCustomTextBlock.id);
    if (
      !editingBlock ||
      editingBlock.trackType !== "text" ||
      selectedItem?.type !== "custom-block" ||
      selectedItem.id !== editingCustomTextBlock.id ||
      selectedItem.trackId !== editingCustomTextBlock.trackId
    ) {
      cancelCustomTextEdit();
    }
  }, [editingCustomTextBlock, project.customTracks, selectedItem]);

  useEffect(() => {
    if (!blockContextMenu) {
      return;
    }

    const handleClose = () => {
      setBlockContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBlockContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handleClose);
    window.addEventListener("scroll", handleClose, true);
    window.addEventListener("resize", handleClose);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handleClose);
      window.removeEventListener("scroll", handleClose, true);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [blockContextMenu]);

  function projectsEqual(left: ProjectData, right: ProjectData) {
    return areEditorProjectsEqual(left, right);
  }

  // 选择性整合只在用户于目标编辑器再次确认时写入本地历史，并严格形成一个可撤销操作。
  async function applyPendingAnnotationMergeDraft() {
    const draft = pendingAnnotationMergeDraft;
    if (!draft) return;
    if (!projectsEqual(projectRef.current, draft.baseProject)) {
      window.alert("目标文件在草稿准备后已被编辑。请取消本草稿并重新比较，避免覆盖当前改动。");
      return;
    }
    let staleAfterLease = false;
    const committed = await runControlledSnapshotMutation("merge_project", (baseProject) => {
      staleAfterLease = !projectsEqual(baseProject, draft.baseProject);
      return staleAfterLease ? baseProject : draft.mergedProject;
    });
    if (staleAfterLease) {
      window.alert("取得整合锁后目标文件已发生变化。请取消本草稿并重新比较。");
      return;
    }
    if (committed) setPendingAnnotationMergeDraft(null);
  }

  // 浏览器草稿整合的取消意味着明确放弃本地恢复内容；普通文件整合仍保持原有无副作用取消。
  function cancelPendingAnnotationMergeDraft() {
    const draft = pendingAnnotationMergeDraft;
    if (!draft) return;
    if (
      draft.sourceKind === "browser-draft" &&
      !window.confirm("放弃这次本地草稿整合后，浏览器中的旧草稿将被清除。是否继续？")
    ) {
      return;
    }
    setPendingAnnotationMergeDraft(null);
  }

  // 409 处理先沿草稿串行队列固定当前文档，再由 Workspace 重读服务器并打开既有结构化比较。
  async function openSaveConflictReview() {
    if (
      !editorSession ||
      syncState.status !== "conflict" ||
      saveConflictReviewBusy
    ) return;
    setSaveConflictReviewBusy(true);
    setSaveConflictReviewError(null);
    try {
      const flushed = await flushPlatformDraftNow();
      if (!flushed.ok) {
        setSaveConflictReviewError(flushed.message);
        return;
      }
      const opened = await editorSession.openSaveConflictReview();
      if (!opened.ok) setSaveConflictReviewError(opened.message);
    } finally {
      setSaveConflictReviewBusy(false);
    }
  }

  function seekTo(time: number) {
    const safeTime = Math.max(0, Math.min(time, duration));
    setPreviewTime(null);
    setCurrentTime(safeTime);
    void videoRef.current?.seek(safeTime);
  }

  function togglePlay() {
    const player = videoRef.current;
    const snapshot = player?.getSnapshot();
    if (!player || !snapshot?.ready) return;
    const needsLoopStartSeek =
      snapshot.paused &&
      loopPlaybackEnabled &&
      loopPlaybackRange &&
      (currentTime < loopPlaybackRange.start || currentTime > loopPlaybackRange.end);
    if (previewTime !== null) {
      setPreviewTime(null);
      // 预览组件会执行唯一一次正式播放头恢复 seek；这里先声明播放意图，避免两次异步 seek 互相取消。
      void player.play();
      return;
    }
    if (needsLoopStartSeek && loopPlaybackRange) {
      const nextTime = clampTime(loopPlaybackRange.start, duration);
      setCurrentTime(nextTime);
      void player.seek(nextTime, { playAfterSeek: true });
      return;
    }
    if (snapshot.paused) {
      void player.play();
    } else {
      player.pause();
    }
  }

  function playLoopFromRangeStart() {
    const player = videoRef.current;
    if (!player?.getSnapshot().ready || !loopPlaybackRange) {
      return;
    }
    if (loopPlaybackRange.end - loopPlaybackRange.start <= 0.001) {
      return;
    }
    const nextTime = clampTime(loopPlaybackRange.start, duration);
    setPreviewTime(null);
    // P 取消任何单次播放意图，切换为持续循环。持久循环已开时不标临时（空格走普通暂停），
    // 否则标 temporary-continuous-loop（空格退出临时循环并继续普通播放）。
    rangePlaybackIntentRef.current = loopPlaybackEnabled
      ? null
      : {
          mode: "temporary-continuous-loop",
          rangeStart: loopPlaybackRange.start,
          rangeEnd: loopPlaybackRange.end,
        };
    setLoopPlaybackEnabled(true);
    setCurrentTime(nextTime);
    void player.seek(nextTime, { playAfterSeek: true });
  }

  // Tab：从循环范围起点播放一遍，到终点暂停不跳回。
  // 无论当前播放头在哪、是否在播放，都重新跳到范围起点开始单次播放。
  function playLoopRangeOnce() {
    const player = videoRef.current;
    const snapshot = player?.getSnapshot();
    if (!player || !snapshot?.ready || !loopPlaybackRange) {
      return;
    }
    if (loopPlaybackRange.end - loopPlaybackRange.start <= 0.001) {
      return;
    }
    const mediaDuration = Number.isFinite(snapshot.duration) && snapshot.duration > 0
      ? snapshot.duration
      : duration;
    const nextTime = clampTime(loopPlaybackRange.start, mediaDuration);
    const playbackEnd = clampTime(loopPlaybackRange.end, mediaDuration);
    if (playbackEnd - nextTime <= 0.001) {
      return;
    }
    setPreviewTime(null);
    // restoreLoopEnabled = 进入 Tab 前的持久循环状态。
    // P 临时持续循环期间 loopPlaybackEnabled 被临时设 true，但持久实为 false，需要识别并还原。
    const wasTemporaryContinuous = rangePlaybackIntentRef.current?.mode === "temporary-continuous-loop";
    const restoreLoopEnabled = wasTemporaryContinuous ? false : loopPlaybackEnabled;
    if (wasTemporaryContinuous) {
      // 结束 P 临时循环：把被临时打开的 loopPlaybackEnabled 关回 false。
      setLoopPlaybackEnabled(false);
    }
    rangePlaybackIntentRef.current = {
      mode: "play-range-once",
      restoreLoopEnabled,
      rangeStart: loopPlaybackRange.start,
      rangeEnd: loopPlaybackRange.end,
      playbackEnd,
    };
    setCurrentTime(nextTime);
    void player.seek(nextTime, { playAfterSeek: true });
  }

  // 空格时处理临时范围播放意图。
  // - P 临时持续循环：退出临时循环并继续普通播放，返回 true（空格被消费）。
  // - 单次范围播放：取消单次意图，返回 false 让 togglePlay 执行正常暂停（不误判成 P 退出）。
  // - 无意图：返回 false，空格走普通播放/暂停。
  function tryConsumeSpaceForRangeIntent() {
    const intent = rangePlaybackIntentRef.current;
    if (intent?.mode === "temporary-continuous-loop") {
      cancelRangePlaybackIntent();
      setPreviewTime(null);
      if (videoRef.current?.getSnapshot().paused) {
        void videoRef.current.play();
      }
      return true;
    }
    if (intent?.mode === "play-range-once") {
      rangePlaybackIntentRef.current = null;
      return false;
    }
    return false;
  }

  // Command/Ctrl + 左右：选择当前逻辑轨道内的相邻可导航块。
  // 通过 applySelection 统一入口，使开启「选中块时更新循环范围」的轨道自动联动循环范围。
  function selectAdjacentTimelineBlock(direction: "previous" | "next") {
    const target = findAdjacentNavigableBlock(projectRef.current, selectedItem, direction);
    if (target) {
      applySelection(target);
    }
  }

  function finishOneShotRangePlayback(intent: Extract<RangePlaybackIntent, { mode: "play-range-once" }>) {
    const player = videoRef.current;
    rangePlaybackIntentRef.current = null;
    if (player) {
      // 先使任何旧的“跳转后播放”命令失效，再把媒体校正到单次范围终点。
      player.pause();
      void player.seek(intent.playbackEnd);
    }
    setCurrentTime(intent.playbackEnd);
    setLoopPlaybackEnabled(intent.restoreLoopEnabled);
  }

  function cancelRangePlaybackIntent() {
    const intent = rangePlaybackIntentRef.current;
    rangePlaybackIntentRef.current = null;
    if (intent?.mode === "temporary-continuous-loop") {
      setLoopPlaybackEnabled(false);
    }
  }

  function updateLoopPlaybackEnabledFromUser(enabled: boolean) {
    const intent = rangePlaybackIntentRef.current;
    if (intent?.mode === "play-range-once") {
      // 用户在单次播放期间的新选择优先，结束时不得恢复旧的循环开关值。
      rangePlaybackIntentRef.current = { ...intent, restoreLoopEnabled: enabled };
    } else {
      rangePlaybackIntentRef.current = null;
    }
    setLoopPlaybackEnabled(enabled);
  }

  function updateLoopPlaybackRangeFromTimeline(range: { start: number; end: number } | null) {
    cancelRangePlaybackIntent();
    setLoopPlaybackRange(range);
    setLoopPlaybackEnabled(Boolean(range));
  }

  function clearLoopPlaybackRange() {
    cancelRangePlaybackIntent();
    setLoopPlaybackRange(null);
    setLoopPlaybackEnabled(false);
  }

  function updateCharacter(id: string, changes: Partial<CharacterAnnotation>, recordHistory = true) {
    const currentProject = projectRef.current;
    const baseProject = transientProjectRef.current ?? currentProject;
    const currentCharacter = currentProject.characterAnnotations.find((item) => item.id === id);
    const timingParentBefore = currentCharacter &&
      (changes.startTime !== undefined || changes.endTime !== undefined)
      ? new Map([[getGongcheParentKey("character-track", currentCharacter.id), toCharacterGongcheParent(currentCharacter)]])
      : new Map<string, GongcheParentBlock>();
    const nextProject = synchronizeGongcheWithChangedParents({
      ...currentProject,
      characterAnnotations: currentProject.characterAnnotations.map((item) =>
        item.id === id ? { ...item, ...changes } : item,
      ),
    }, timingParentBefore);
    const synchronizedProject =
      currentCharacter && (
        changes.char !== undefined ||
        changes.startTime !== undefined ||
        changes.endTime !== undefined
      )
        ? syncSubtitleLine(nextProject, currentCharacter.lineId)
        : nextProject;
    if (recordHistory) {
      const isTimingOnly = Object.keys(changes).every((key) =>
        key === "startTime" || key === "endTime",
      );
      const changedKeys = Object.keys(changes);
      const isCharacterTextOnly = changedKeys.length === 1 && changedKeys[0] === "char";
      if (isTimingOnly && currentCharacter) {
        const gongcheTargets = getGongcheTransactionTargetsForParents(
          baseProject,
          synchronizedProject,
          "character-track",
          [id],
        );
        // 逐字边界会级联句边界、工尺块和内部符号，必须由一个事务完整解释最终项目。
        commitProjectWithTransaction(baseProject, synchronizedProject, {
          timingTargets: [
            { entityType: "character", entityId: id },
            { entityType: "sentence", entityId: currentCharacter.lineId },
            ...gongcheTargets.timingTargets,
          ],
          stateTargets: gongcheTargets.stateTargets,
        });
        return;
      }
      // 逐字文本会同步句文本，因此 content 命令同时包含 character 与其 sentence 两个稳定目标。
      const commandEnvelope = isCharacterTextOnly && currentCharacter
        ? buildProjectAnnotationContentCommand(baseProject, synchronizedProject, [
            { entityType: "character", entityId: id, field: "char" },
            { entityType: "sentence", entityId: currentCharacter.lineId, field: "text" },
          ])
        : null;
      commitProject(synchronizedProject, baseProject, commandEnvelope ? { commandEnvelope } : {});
    } else {
      applyProjectWithoutHistory(synchronizedProject);
    }
  }

  function updateLinePosition(
    id: string,
    changes: Pick<SubtitleLine, "startTime" | "endTime">,
    recordHistory = true,
  ) {
    const currentProject = projectRef.current;
    const baseProject = transientProjectRef.current ?? currentProject;
    const currentLine = currentProject.subtitleLines.find((line) => line.id === id);
    if (!currentLine) {
      return;
    }
    const deltaSeconds = changes.startTime - currentLine.startTime;
    const hasCharacters = currentProject.characterAnnotations.some((item) => item.lineId === id);
    const timingParentsBefore = new Map(
      currentProject.characterAnnotations
        .filter((item) => item.lineId === id)
        .map((item) => [getGongcheParentKey("character-track", item.id), toCharacterGongcheParent(item)]),
    );

    const shiftedProject = synchronizeGongcheWithChangedParents({
      ...currentProject,
      subtitleLines: currentProject.subtitleLines.map((line) =>
        line.id === id
          ? { ...line, startTime: changes.startTime, endTime: changes.endTime }
          : line,
      ),
      characterAnnotations: hasCharacters
        ? currentProject.characterAnnotations.map((item) =>
            item.lineId === id
              ? {
                  ...item,
                  startTime: item.startTime + deltaSeconds,
                  endTime: item.endTime + deltaSeconds,
                }
              : item,
          )
        : currentProject.characterAnnotations,
    }, timingParentsBefore);

    const synchronizedProject = hasCharacters
      ? syncSubtitleLine(shiftedProject, id)
      : shiftedProject;

    if (recordHistory) {
      const characterIds = baseProject.characterAnnotations
        .filter((item) => item.lineId === id)
        .map((item) => item.id);
      const gongcheTargets = getGongcheTransactionTargetsForParents(
        baseProject,
        synchronizedProject,
        "character-track",
        characterIds,
      );
      // 句块移动会级联逐字、工尺块和工尺符号，全部变化由同一事务原子提交。
      commitProjectWithTransaction(baseProject, synchronizedProject, {
        timingTargets: [
          { entityType: "sentence", entityId: id },
          ...characterIds.map((entityId): TimelineTimingTarget => ({
            entityType: "character",
            entityId,
          })),
          ...gongcheTargets.timingTargets,
        ],
        stateTargets: gongcheTargets.stateTargets,
      });
    } else {
      applyProjectWithoutHistory(synchronizedProject);
    }
  }

  function updateSentenceClassification(
    id: string,
    changes: Partial<Pick<SubtitleLine, "deliveryMode" | "roleType">>,
  ) {
    const baseProject = projectRef.current;
    const currentLine = baseProject.subtitleLines.find((line) => line.id === id);
    if (!currentLine) return;
    if (
      changes.roleType !== undefined &&
      changes.roleType !== null &&
      !baseProject.sentenceAnnotationConfig.roleOptions.includes(changes.roleType)
    ) {
      window.alert("所选角色行当已不存在，请刷新设置后重试。");
      return;
    }
    const nextProject: ProjectData = {
      ...baseProject,
      subtitleLines: baseProject.subtitleLines.map((line) =>
        line.id === id ? { ...line, ...changes } : line),
    };
    const contentTargets = (Object.keys(changes) as Array<keyof typeof changes>).flatMap((field) =>
      currentLine[field] !== changes[field]
        ? [{ entityType: "sentence" as const, entityId: id, field }]
        : []);
    // 没有实际字段变化时不制造历史和待提交操作；协作端也无需接收空命令。
    if (contentTargets.length === 0) return;
    const commandEnvelope = buildProjectAnnotationContentCommand(baseProject, nextProject, contentTargets);
    if (!commandEnvelope) {
      window.alert("句级分类更新未能生成有效命令，项目没有被修改。");
      return;
    }
    commitProject(nextProject, baseProject, { commandEnvelope });
  }

  // 角色列表变更与所有受影响句子在同一租约事务中提交，避免协作端看到悬空角色。
  function updateSentenceRoleOptions(
    buildUpdate: (baseProject: ProjectData) => {
      roleOptions: string[];
      replaceRole?: { from: string; to: string | null };
    },
  ) {
    const buildNextProject = (baseProject: ProjectData): ProjectData => {
      const update = buildUpdate(baseProject);
      const nextLines = update.replaceRole
        ? baseProject.subtitleLines.map((line) =>
            line.roleType === update.replaceRole?.from
              ? { ...line, roleType: update.replaceRole.to }
              : line)
        : baseProject.subtitleLines;
      return {
        ...baseProject,
        sentenceAnnotationConfig: { roleOptions: update.roleOptions },
        subtitleLines: nextLines,
      };
    };
    return runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        stateTargets: [{
          entityType: "sentence-annotation-config",
          entityId: "sentence-annotation-config",
        }],
        contentTargets: baseProject.subtitleLines.flatMap((line) => {
          const nextLine = nextProject.subtitleLines.find((candidate) => candidate.id === line.id);
          return nextLine?.roleType !== line.roleType
            ? [{ entityType: "sentence" as const, entityId: line.id, field: "roleType" as const }]
            : [];
        }),
      }),
    );
  }

  function addSentenceRoleOption(name: string) {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > MAX_SENTENCE_ROLE_OPTION_LENGTH) {
      return Promise.resolve(false);
    }
    return updateSentenceRoleOptions((baseProject) => ({
      roleOptions: baseProject.sentenceAnnotationConfig.roleOptions.length >= MAX_SENTENCE_ROLE_OPTIONS
        ? baseProject.sentenceAnnotationConfig.roleOptions
        : appendUniqueTypeOption(baseProject.sentenceAnnotationConfig.roleOptions, normalizedName),
    }));
  }

  function renameSentenceRoleOption(previousName: string, name: string) {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > MAX_SENTENCE_ROLE_OPTION_LENGTH) {
      return Promise.resolve(false);
    }
    return updateSentenceRoleOptions((baseProject) => {
      const roleIndex = baseProject.sentenceAnnotationConfig.roleOptions.indexOf(previousName);
      if (roleIndex < 0 || baseProject.sentenceAnnotationConfig.roleOptions.some(
        (option, optionIndex) => optionIndex !== roleIndex && option === normalizedName,
      )) return { roleOptions: baseProject.sentenceAnnotationConfig.roleOptions };
      return {
        roleOptions: baseProject.sentenceAnnotationConfig.roleOptions.map((option, optionIndex) =>
          optionIndex === roleIndex ? normalizedName : option),
        replaceRole: { from: previousName, to: normalizedName },
      };
    });
  }

  function reorderSentenceRoleOption(
    sourceRole: string,
    targetRole: string,
    edge: SentenceRoleDropEdge,
  ) {
    const currentOptions = projectRef.current.sentenceAnnotationConfig.roleOptions;
    if (!reorderSentenceRoleOptions(currentOptions, sourceRole, targetRole, edge)) {
      // 放回原插入位置属于成功的无操作，不获取结构租约，也不向对话框报告保存失败。
      return Promise.resolve(true);
    }
    return updateSentenceRoleOptions((baseProject) => {
      const latestOptions = baseProject.sentenceAnnotationConfig.roleOptions;
      return {
        // 以角色名称定位最新项目，避免取得结构租约期间列表变化后误移动另一个角色。
        roleOptions: reorderSentenceRoleOptions(latestOptions, sourceRole, targetRole, edge)
          ?? latestOptions,
      };
    });
  }

  function removeSentenceRoleOption(previousName: string, replacement: string | null) {
    return updateSentenceRoleOptions((baseProject) => {
      if (!previousName || (replacement !== null && (
        replacement === previousName ||
        !baseProject.sentenceAnnotationConfig.roleOptions.includes(replacement)
      ))) return { roleOptions: baseProject.sentenceAnnotationConfig.roleOptions };
      return {
        roleOptions: baseProject.sentenceAnnotationConfig.roleOptions.filter((option) => option !== previousName),
        replaceRole: { from: previousName, to: replacement },
      };
    });
  }

  function startCharacterTextEdit(id: string, location: CharacterEditLocation) {
    const currentCharacter = projectRef.current.characterAnnotations.find((item) => item.id === id);
    if (!currentCharacter) {
      return;
    }
    preferredCharacterEditLocationRef.current = location;
    applySelection({ type: "character", id });
    setEditingCharacterId(id);
    setEditingCharacterLocation(location);
    setEditingCharacterValue(currentCharacter.char);
  }

  function cancelCharacterTextEdit() {
    setEditingCharacterId(null);
    setEditingCharacterLocation(null);
    setEditingCharacterValue("");
  }

  function commitCharacterTextEdit(id: string) {
    const currentCharacter = projectRef.current.characterAnnotations.find((item) => item.id === id);
    if (!currentCharacter) {
      cancelCharacterTextEdit();
      return;
    }
    const normalizedChar = editingCharacterValue.trim();
    if (!normalizedChar) {
      window.alert("字内容不能为空。");
      return;
    }
    if (normalizedChar === currentCharacter.char) {
      cancelCharacterTextEdit();
      return;
    }
    if (!isSingleHanCharacter(normalizedChar)) {
      const confirmed = window.confirm(
        `当前输入为“${normalizedChar}”。通常这里建议使用单个汉字。是否仍然继续修改？`,
      );
      if (!confirmed) {
        return;
      }
    }
    updateCharacter(id, { char: normalizedChar });
    cancelCharacterTextEdit();
  }

  // 保存和结构写入共用一个内存屏障：保存先开始时结构写入等待；结构写入先开始时保存入口直接让出。
  // 这样租约不会在一批尚未携带 token 的普通命令已经出发后才被创建。
  async function waitForActiveServerSave() {
    const completion = serverSaveCompletionRef.current;
    if (completion) await completion;
  }

  function beginServerSaveCompletion() {
    let resolveCompletion: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    serverSaveCompletionRef.current = completion;
    resolveServerSaveCompletionRef.current = resolveCompletion;
    return completion;
  }

  function finishServerSaveCompletion(completion: Promise<void>) {
    if (serverSaveCompletionRef.current !== completion) return;
    const resolveCompletion = resolveServerSaveCompletionRef.current;
    serverSaveCompletionRef.current = null;
    resolveServerSaveCompletionRef.current = null;
    resolveCompletion?.();
  }

  // 所有受租约保护的写入共用这一串行入口；拿到租约后必须基于最新项目重新计算结果。
  async function runExclusiveProjectMutation(
    purpose: AnnotationMutationPurpose,
    buildNextProject: (baseProject: ProjectData) => ProjectData,
    buildCommand: (
      baseProject: ProjectData,
      nextProject: ProjectData,
    ) => AnnotationCommandEnvelope | null,
    historyAction: HistoryAction = "edit",
  ) {
    const previewBase = projectRef.current;
    if (areProjectValuesEqual(previewBase, buildNextProject(previewBase))) {
      return false;
    }
    if (exclusiveMutationInFlightRef.current) {
      return false;
    }

    exclusiveMutationInFlightRef.current = true;
    try {
      // 已经发出的普通保存先完成；exclusive 标志已同步置位，因此等待期间不会再启动第二批保存。
      await waitForActiveServerSave();
      // 等待中的保存可能刚刚消费旧租约，必须在等待结束后判断本次 acquire 是否新建了租约。
      const hadLease = Boolean(mutationLease.getToken());
      // 结构写入只记录定位事实，不记录项目内容、临时媒体 URL 或租约凭据，方便区分“未发请求”和“服务端拒绝”。
      console.info("开始结构编辑事务。", {
        purpose,
        platformFile: Boolean(editorSession),
        remoteRevision: remoteBaseRevisionRef.current,
        observedRemoteRevision,
        hadLease,
      });
      if (editorSession) await mutationLease.acquire(purpose);
      // acquire 期间普通内容编辑仍可发生；拿锁后必须基于最新项目重建，不能覆盖这段时间的新内容。
      const baseProject = projectRef.current;
      const nextProject = buildNextProject(baseProject);
      if (areProjectValuesEqual(baseProject, nextProject)) {
        if (editorSession && !hadLease) await mutationLease.release().catch(() => undefined);
        return false;
      }
      const commandEnvelope = buildCommand(baseProject, nextProject);
      if (!commandEnvelope) {
        // builder 无法证明完整差异时不修改项目；这类失败必须能从控制台看出发生在请求之前。
        console.warn("结构编辑事务未能生成完整命令。", {
          purpose,
          remoteRevision: remoteBaseRevisionRef.current,
          pendingOperationCount: pendingOperations.length,
        });
        if (editorSession && !hadLease) await mutationLease.release().catch(() => undefined);
        window.alert("本次变更无法形成完整且有界的协作命令，项目未被修改。请拆分操作后重试。");
        return false;
      }
      // 命令进入 document state 后才由自动保存器发往 API；此处不把 token 或完整 payload 写入日志。
      console.info("结构编辑事务已写入本地命令队列。", {
        purpose,
        commandType: commandEnvelope.command.type,
        remoteRevision: remoteBaseRevisionRef.current,
      });
      commitProject(nextProject, baseProject, { commandEnvelope, action: historyAction });
      return true;
    } catch (error) {
      // 只保留稳定错误分类和 message；错误对象可能包含服务端 details，不能直接序列化到诊断日志。
      console.error("结构编辑事务失败，未完成本地提交。", {
        purpose,
        remoteRevision: remoteBaseRevisionRef.current,
        errorMessage: error instanceof Error ? error.message : "未知结构编辑错误",
      });
      window.alert(formatMutationLeaseError(error));
      return false;
    } finally {
      exclusiveMutationInFlightRef.current = false;
    }
  }

  // 结构写入继续保留语义清晰的薄封装，避免普通调用点感知租约 purpose。
  function runTrackStructureMutation(
    buildNextProject: (baseProject: ProjectData) => ProjectData,
    buildCommand: (baseProject: ProjectData, nextProject: ProjectData) => AnnotationCommandEnvelope | null,
  ) {
    return runExclusiveProjectMutation("track_structure", buildNextProject, buildCommand);
  }

  // 无法安全拆成有界增量的批量操作只记录严格边界；同 revision 的完整保存仍是唯一内容权威。
  function runControlledSnapshotMutation(
    kind: ProjectSnapshotBoundaryKind,
    buildNextProject: (baseProject: ProjectData) => ProjectData,
  ) {
    const commandEnvelope = buildProjectSnapshotBoundaryEnvelope(createRuntimeUuid(), kind);
    const purpose = commandEnvelope
      ? getAnnotationMutationLeasePurposeForCommand(commandEnvelope)
      : null;
    if (!commandEnvelope || !purpose) return Promise.resolve(false);
    return runExclusiveProjectMutation(
      purpose,
      buildNextProject,
      () => commandEnvelope,
      getSnapshotBoundaryHistoryAction(kind),
    );
  }

  // 平台结构写入先取得数据库租约；本地模式复用同一纯 updater，但不会产生网络请求。
  async function updateCustomTrackStructure(
    trackId: string,
    updater: (track: CustomTrack) => CustomTrack,
  ) {
    const buildNextProject = (baseProject: ProjectData): ProjectData => ({
      ...baseProject,
      customTracks: baseProject.customTracks.map((track) =>
        track.id === trackId ? updater(track) : track,
      ) as CustomTrack[],
    });
    return runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) =>
        buildProjectCustomTrackStructureCommand(baseProject, nextProject, [trackId]),
    );
  }

  // 既有内建轨配置必须经结构事务和租约提交，不能再落入无法 clean replay 的 snapshot operation。
  async function updateBuiltinTrackStructure(
    trackId: BuiltinTrackId,
    updater: (track: BuiltinTrack) => BuiltinTrack,
  ) {
    const buildNextProject = (baseProject: ProjectData): ProjectData => {
      const beforeTrack = baseProject.builtinTracks.find((track) => track.id === trackId);
      if (!beforeTrack) return baseProject;
      const afterTrack = updater(beforeTrack);
      const nextProject = {
        ...baseProject,
        builtinTracks: baseProject.builtinTracks.map((track) =>
          track.id === trackId ? afterTrack : track,
        ),
      };
      return nextProject;
    };
    return runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        builtinTrackStructureIds: [trackId],
      }),
    );
  }

  function findPointTrackLocation(projectToSearch: ProjectData, pointTrackId: string): PointTrackLocation | null {
    for (const track of projectToSearch.builtinTracks) {
      const pointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
      if (pointTrack) {
        return {
          parentType: "builtin",
          parentTrack: track,
          pointTrack,
        };
      }
    }
    for (const track of projectToSearch.customTracks) {
      const pointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
      if (pointTrack) {
        return {
          parentType: "custom",
          parentTrack: track,
          pointTrack,
        };
      }
    }
    return null;
  }

  // 所有附属点轨修改先生成完整 nextProject；调用者再决定 transient、history 或领域命令语义。
  function buildProjectWithUpdatedAttachedPointTrack(
    projectToUpdate: ProjectData,
    pointTrackId: string,
    updater: (pointTrack: AttachedPointTrack) => AttachedPointTrack,
  ): ProjectData | null {
    const location = findPointTrackLocation(projectToUpdate, pointTrackId);
    if (!location) return null;
    const updateTrackList = (tracks: AttachedPointTrack[]) => tracks.map((pointTrack) =>
      pointTrack.id === pointTrackId ? updater(pointTrack) : pointTrack,
    );
    return {
      ...projectToUpdate,
      builtinTracks: location.parentType === "builtin"
        ? projectToUpdate.builtinTracks.map((track) => track.id === location.parentTrack.id
          ? { ...track, attachedPointTracks: updateTrackList(track.attachedPointTracks ?? []) }
          : track)
        : projectToUpdate.builtinTracks,
      customTracks: location.parentType === "custom"
        ? projectToUpdate.customTracks.map((track) => track.id === location.parentTrack.id
          ? { ...track, attachedPointTracks: updateTrackList(track.attachedPointTracks ?? []) } as CustomTrack
          : track)
        : projectToUpdate.customTracks,
    };
  }

  // 点轨配置以“父轨类型 + 父轨 id + 点轨 id”寻址，避免递归轨道出现同名时误改其他集合。
  async function updateAttachedPointTrackStructure(
    pointTrackId: string,
    updater: (pointTrack: AttachedPointTrack) => AttachedPointTrack,
  ) {
    const buildNextProject = (baseProject: ProjectData): ProjectData =>
      buildProjectWithUpdatedAttachedPointTrack(baseProject, pointTrackId, updater) ?? baseProject;
    return runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => {
        const location = findPointTrackLocation(baseProject, pointTrackId);
        const nextLocation = findPointTrackLocation(nextProject, pointTrackId);
        if (!location || !nextLocation) return null;
        const nextPoints = new Map(nextLocation.pointTrack.points.map((point) => [point.id, point]));
        return buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
          attachedPointTrackStructureTargets: [{
            pointTrackId,
            parentTrackId: location.parentTrack.id,
            parentTrackType: location.parentType,
          }],
          // 点轨类型改名/删除只为真正变化的既有点生成 content child，点生命周期不属于本 updater。
          contentTargets: location.pointTrack.points.flatMap((point) =>
            nextPoints.get(point.id)?.label !== point.label
              ? [{ entityType: "attached-point" as const, entityId: point.id, trackId: pointTrackId,
                  field: "label" as const }]
              : []),
        });
      },
    );
  }

  // 创建/删除调用点只声明候选实体；完整差异门禁证明命令覆盖 next 后才写领域 envelope，否则保留快照。
  function commitProjectWithLifecycle(
    baseProject: ProjectData,
    nextProject: ProjectData,
    targets: readonly AnnotationLifecycleTarget[],
  ) {
    const commandEnvelope = buildProjectAnnotationLifecycleCommand(baseProject, nextProject, targets);
    commitProject(nextProject, baseProject, commandEnvelope ? { commandEnvelope } : {});
  }

  // 板眼和工尺符号的耦合字段使用完整状态命令，不能拆成彼此独立的字符串 operation。
  function commitProjectWithState(
    baseProject: ProjectData,
    nextProject: ProjectData,
    targets: readonly AnnotationStateTarget[],
  ) {
    const commandEnvelope = buildProjectAnnotationStateCommand(baseProject, nextProject, targets);
    commitProject(nextProject, baseProject, commandEnvelope ? { commandEnvelope } : {});
  }

  // 句同步和工尺级联必须作为一个 operation 提交；builder 证明不了完整闭包时安全回退快照。
  function commitProjectWithTransaction(
    baseProject: ProjectData,
    nextProject: ProjectData,
    plan: AnnotationTransactionPlan,
  ) {
    const commandEnvelope = buildProjectAnnotationTransactionCommand(baseProject, nextProject, plan);
    commitProject(nextProject, baseProject, commandEnvelope ? { commandEnvelope } : {});
  }

  function updateAttachedPoint(
    pointTrackId: string,
    pointId: string,
    changes: Partial<AttachedPointAnnotation>,
    recordHistory = true,
  ) {
    const currentProject = projectRef.current;
    const baseProject = transientProjectRef.current ?? currentProject;
    const nextProject = buildProjectWithUpdatedAttachedPointTrack(
      currentProject,
      pointTrackId,
      (pointTrack) => ({
        ...pointTrack,
        points: pointTrack.points.map((point) =>
          point.id === pointId ? { ...point, ...changes } : point,
        ),
      }),
    );
    if (!nextProject) return;
    if (!recordHistory) {
      applyProjectWithoutHistory(nextProject);
      return;
    }
    const changedKeys = Object.keys(changes);
    const isLabelOnly = changedKeys.length === 1 && changedKeys[0] === "label";
    // 本轮只迁移附属点 label；尚未接入命令的时间或复合字段继续安全记录 legacy snapshot operation。
    const commandEnvelope = isLabelOnly
      ? buildProjectAnnotationContentCommand(baseProject, nextProject, [{
          entityType: "attached-point",
          entityId: pointId,
          trackId: pointTrackId,
          field: "label",
        }])
      : null;
    commitProject(nextProject, baseProject, commandEnvelope ? { commandEnvelope } : {});
  }

  function changeAttachedPoint(
    pointTrackId: string,
    pointId: string,
    changes: Partial<AttachedPointAnnotation>,
  ) {
    updateAttachedPoint(pointTrackId, pointId, changes, false);
  }

  function commitAttachedPoint(
    pointTrackId: string,
    pointId: string,
    changes: Partial<AttachedPointAnnotation>,
  ) {
    updateAttachedPoint(pointTrackId, pointId, changes, true);
  }

  function addAttachedPointTrack(parentTrackId: string) {
    const previewProject = projectRef.current;
    const builtinParent = previewProject.builtinTracks.find((track) => track.id === parentTrackId);
    const customParent = previewProject.customTracks.find((track) => track.id === parentTrackId);
    if (!builtinParent && !customParent) {
      return;
    }
    const parentTrack = builtinParent ?? customParent;
    const parentTrackType = builtinParent ? "builtin" as const : "custom" as const;
    const nextPointTrack: AttachedPointTrack = {
      id: `point-track-${createRuntimeUuid()}`,
      name: getDefaultAttachedPointTrackName(parentTrack?.attachedPointTracks ?? []),
      typeOptions: getDefaultAttachedPointTypeOptions(),
      points: [],
      snapToWaveformKeypoints: false,
      snapToParentBoundaries: true,
    };
    const buildNextProject = (baseProject: ProjectData): ProjectData => ({
      ...baseProject,
      builtinTracks: parentTrackType === "builtin"
        ? baseProject.builtinTracks.map((track) => track.id === parentTrackId
          ? {
              ...track,
              attachedPointTracksExpanded: true,
              attachedPointTracks: [...track.attachedPointTracks, nextPointTrack],
            }
          : track)
        : baseProject.builtinTracks,
      customTracks: parentTrackType === "custom"
        ? baseProject.customTracks.map((track) => track.id === parentTrackId
          ? {
              ...track,
              attachedPointTracksExpanded: true,
              attachedPointTracks: [...track.attachedPointTracks, nextPointTrack],
            } as CustomTrack
          : track) as CustomTrack[]
        : baseProject.customTracks,
    });
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        attachedPointTrackLifecycleTargets: [{
          pointTrackId: nextPointTrack.id,
          parentTrackId,
          parentTrackType,
        }],
      }),
    ).then((committed) => {
      if (committed) applySelection({ type: "attached-point-track", id: nextPointTrack.id, parentTrackId });
    });
  }

  function toggleAttachedPointTracks(parentTrackId: string) {
    const currentProject = projectRef.current;
    if (currentProject.builtinTracks.some((track) => track.id === parentTrackId)) {
      void updateBuiltinTrackStructure(parentTrackId as BuiltinTrackId, (track) => ({
        ...track,
        attachedPointTracksExpanded: !track.attachedPointTracksExpanded,
      }));
      return;
    }
    if (currentProject.customTracks.some((track) => track.id === parentTrackId)) {
      void updateCustomTrackStructure(parentTrackId, (track) => ({
        ...track,
        attachedPointTracksExpanded: !track.attachedPointTracksExpanded,
      }) as CustomTrack);
    }
  }

  function moveTrack(trackId: string, direction: "up" | "down") {
    // acquire 可能等待网络，因此顺序变换必须对拿锁后的最新 base 重算，不能闭包捕获旧数组。
    void runTrackStructureMutation(
      (baseProject) => {
        const currentIndex = baseProject.activeTrackOrder.findIndex((id) => id === trackId);
        const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= baseProject.activeTrackOrder.length) {
          return baseProject;
        }
        const nextOrder = [...baseProject.activeTrackOrder];
        const [movedId] = nextOrder.splice(currentIndex, 1);
        nextOrder.splice(targetIndex, 0, movedId);
        return { ...baseProject, activeTrackOrder: nextOrder };
      },
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        includeTrackOrder: true,
      }),
    );
  }

  function reorderTrack(trackId: string, insertionIndex: number) {
    void runTrackStructureMutation(
      (baseProject) => {
        const currentIndex = baseProject.activeTrackOrder.findIndex((id) => id === trackId);
        if (currentIndex < 0) return baseProject;
        const nextOrder = [...baseProject.activeTrackOrder];
        const [movedId] = nextOrder.splice(currentIndex, 1);
        const targetIndex = Math.max(0, Math.min(insertionIndex, nextOrder.length));
        if (targetIndex === currentIndex) return baseProject;
        nextOrder.splice(targetIndex, 0, movedId);
        return { ...baseProject, activeTrackOrder: nextOrder };
      },
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        includeTrackOrder: true,
      }),
    );
  }

  function updateCustomBlock(
    trackId: string,
    blockId: string,
    changes: {
      startTime?: number;
      endTime?: number;
      text?: string;
      type?: string;
      branchScope?: BranchScope;
    },
    recordHistory = true,
  ) {
    const changedKeys = Object.keys(changes);
    if (recordHistory && changedKeys.length === 1 && changedKeys[0] === "branchScope") {
      void updateCustomTrackStructure(trackId, (track) => ({
        ...track,
        blocks: track.blocks.map((block) =>
          block.id === blockId ? { ...block, branchScope: changes.branchScope } : block,
        ) as CustomTrack["blocks"],
      }) as CustomTrack);
      return;
    }
    const currentProject = projectRef.current;
    const baseProject = transientProjectRef.current ?? currentProject;
    const currentBlock = findCustomBlock(currentProject.customTracks, trackId, blockId);
    const timingParentsBefore = currentBlock &&
      (changes.startTime !== undefined || changes.endTime !== undefined)
      ? new Map([[getGongcheParentKey(trackId, blockId), toCustomBlockGongcheParent(currentBlock)]])
      : new Map<string, GongcheParentBlock>();
    const nextProject = synchronizeGongcheWithChangedParents({
      ...currentProject,
      customTracks: currentProject.customTracks.map((track) =>
        track.id === trackId
          ? {
              ...track,
              blocks: track.blocks.map((block) =>
                block.id === blockId ? { ...block, ...changes } : block,
              ) as CustomTrack["blocks"],
            }
          : track,
      ) as CustomTrack[],
    }, timingParentsBefore);
    if (recordHistory) {
      const isTimingOnly = changedKeys.every((key) =>
        key === "startTime" || key === "endTime",
      );
      const contentField = changedKeys.length === 1 && changes.text !== undefined
        ? "text"
        : changedKeys.length === 1 && changes.type !== undefined
          ? "type"
          : null;
      if (isTimingOnly && currentBlock) {
        const gongcheTargets = getGongcheTransactionTargetsForParents(
          baseProject,
          nextProject,
          trackId,
          [blockId],
        );
        // 自定义父块与工尺子树共用原子事务，递归分支归属仍由独立结构命令负责。
        commitProjectWithTransaction(baseProject, nextProject, {
          timingTargets: [
            { entityType: "custom-block", entityId: blockId, trackId },
            ...gongcheTargets.timingTargets,
          ],
          stateTargets: gongcheTargets.stateTargets,
        });
        return;
      }
      // 自定义块 timing 与内容使用不同领域命令；分叉归属等结构变化仍回退 snapshot。
      const commandEnvelope = contentField && currentBlock
        ? buildProjectAnnotationContentCommand(baseProject, nextProject, [{
            entityType: "custom-block",
            entityId: blockId,
            trackId,
            field: contentField,
          }])
        : null;
      commitProject(nextProject, baseProject, commandEnvelope ? { commandEnvelope } : {});
    } else {
      applyProjectWithoutHistory(nextProject);
    }
  }

  function startCustomTextEdit(trackId: string, blockId: string) {
    const currentBlock = findCustomBlock(projectRef.current.customTracks, trackId, blockId);
    if (!currentBlock || currentBlock.trackType !== "text") {
      return;
    }
    applySelection({ type: "custom-block", trackId, id: blockId });
    setEditingCustomTextBlock({ trackId, id: blockId });
    setEditingCustomTextValue(currentBlock.text ?? "");
  }

  function cancelCustomTextEdit() {
    setEditingCustomTextBlock(null);
    setEditingCustomTextValue("");
  }

  function commitCustomTextEdit(trackId: string, blockId: string) {
    const currentBlock = findCustomBlock(projectRef.current.customTracks, trackId, blockId);
    if (!currentBlock || currentBlock.trackType !== "text") {
      cancelCustomTextEdit();
      return;
    }
    const normalizedText = editingCustomTextValue.trim();
    if (!normalizedText) {
      window.alert("文字 block 的内容不能为空。");
      return;
    }
    if (normalizedText === currentBlock.text) {
      cancelCustomTextEdit();
      return;
    }
    updateCustomBlock(trackId, blockId, { text: normalizedText });
    cancelCustomTextEdit();
  }

  function updateAction(id: string, changes: Partial<ActionAnnotation>, recordHistory = true) {
    const currentProject = projectRef.current;
    const baseProject = transientProjectRef.current ?? currentProject;
    const currentAction = currentProject.actionAnnotations.find((item) => item.id === id);
    const nextProject = {
      ...currentProject,
      actionAnnotations: currentProject.actionAnnotations.map((item) =>
        item.id === id ? { ...item, ...changes } : item,
      ),
    };
    if (recordHistory) {
      const isTimingOnly = Object.keys(changes).every((key) =>
        key === "startTime" || key === "endTime",
      );
      const changedKeys = Object.keys(changes);
      const isLabelOnly = changedKeys.length === 1 && changedKeys[0] === "label";
      // 旧动作轨纯时间和标签分别进入各自命令；轨道身份等结构变化仍保留 snapshot 语义。
      const commandEnvelope = isTimingOnly && currentAction
        ? buildProjectTimelineTimingCommand(baseProject, nextProject, [{
            entityType: "action",
            entityId: id,
            trackId: currentAction.trackId,
          }])
        : isLabelOnly && currentAction
          ? buildProjectAnnotationContentCommand(baseProject, nextProject, [{
              entityType: "action",
              entityId: id,
              trackId: currentAction.trackId,
              field: "label",
            }])
        : null;
      commitProject(nextProject, baseProject, commandEnvelope ? { commandEnvelope } : {});
    } else {
      applyProjectWithoutHistory(nextProject);
    }
  }

  function applyActionLabel(id: string, label: string) {
    updateAction(id, { label });
  }

  function applyCustomBlockType(trackId: string, blockId: string, type: string) {
    updateCustomBlock(trackId, blockId, { type });
  }

  function applyAttachedPointLabel(pointTrackId: string, pointId: string, label: string) {
    updateAttachedPoint(pointTrackId, pointId, { label });
  }

  function applyBanyanMarkSubtype(id: string, subtype: BanyanMark["subtype"]) {
    updateBanyanMark(id, {
      subtype,
      role: getBanyanRoleForSubtype(subtype),
      confidence: "manual",
    });
  }

  function createContextMenuTypeOption(target: Exclude<
    TimelineContextMenu["type"],
    "line" | "lane" | "gongche-block" | "banyan-mark"
  >) {
    if (!blockContextMenu || blockContextMenu.type !== target) {
      return;
    }
    const rawValue = window.prompt("新建类型名称");
    const nextType = normalizeNewTypeOption(rawValue);
    if (!nextType) {
      return;
    }
    const currentProject = projectRef.current;

    if (target === "action") {
      const actionId = blockContextMenu.id;
      const action = currentProject.actionAnnotations.find((item) => item.id === actionId);
      if (!action) {
        return;
      }
      applyActionLabel(actionId, nextType);
      setBlockContextMenu(null);
      return;
    }

    if (target === "custom-block") {
      const customBlockMenu = blockContextMenu;
      const targetTrack = currentProject.customTracks.find((track) => track.id === customBlockMenu.trackId);
      if (!targetTrack) {
        return;
      }
      if (targetTrack.typeOptions.includes(nextType)) {
        applyCustomBlockType(targetTrack.id, customBlockMenu.id, nextType);
      } else {
        const buildNextProject = (baseProject: ProjectData): ProjectData => ({
          ...baseProject,
          customTracks: baseProject.customTracks.map((track) => track.id === targetTrack.id
            ? {
                ...track,
                typeOptions: appendUniqueTypeOption(track.typeOptions, nextType),
                blocks: track.blocks.map((block) =>
                  block.id === customBlockMenu.id ? { ...block, type: nextType } : block) as CustomTrack["blocks"],
              } as CustomTrack
            : track) as CustomTrack[],
        });
        void runTrackStructureMutation(buildNextProject, (baseProject, nextProject) =>
          buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
            customTrackStructureIds: [targetTrack.id],
            contentTargets: [{ entityType: "custom-block", entityId: customBlockMenu.id,
              trackId: targetTrack.id, field: "type" }],
          }));
      }
      setBlockContextMenu(null);
      return;
    }

    if (target === "attached-point") {
      const pointMenu = blockContextMenu;
      const location = findPointTrackLocation(currentProject, pointMenu.trackId);
      if (!location) {
        return;
      }
      if (location.pointTrack.typeOptions.includes(nextType)) {
        applyAttachedPointLabel(pointMenu.trackId, pointMenu.id, nextType);
      } else {
        void updateAttachedPointTrackStructure(pointMenu.trackId, (pointTrack) => ({
          ...pointTrack,
          typeOptions: appendUniqueTypeOption(pointTrack.typeOptions, nextType),
          points: pointTrack.points.map((point) =>
            point.id === pointMenu.id ? { ...point, label: nextType } : point),
        }));
      }
      setBlockContextMenu(null);
    }
  }

  function getCopyableTimelineSelection(currentProject: ProjectData) {
    const explicitSelection: TimelineSelectionItem[] = selectedTimelineItems.length > 0
      ? selectedTimelineItems
      : selectedItem?.type === "character" || selectedItem?.type === "action"
        ? [{ type: selectedItem.type, id: selectedItem.id }]
        : selectedItem?.type === "attached-point"
          ? [{
              type: "attached-point",
              id: selectedItem.id,
              trackId: selectedItem.trackId,
              parentTrackId: selectedItem.parentTrackId,
            }]
        : selectedItem?.type === "custom-block"
          ? [{ type: "custom-block", id: selectedItem.id, trackId: selectedItem.trackId }]
        : selectedItem?.type === "banyan-mark"
          ? [{ type: "banyan-mark", id: selectedItem.id }]
          : [];

    return explicitSelection
      .map((item) => resolveTimelineSelectionItem(currentProject, item))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) =>
        left.startTime - right.startTime ||
        left.endTime - right.endTime ||
        left.trackId.localeCompare(right.trackId) ||
        left.id.localeCompare(right.id),
      );
  }

  function copyTimelineSelection() {
    const selection = getCopyableTimelineSelection(projectRef.current);
    if (selection.length === 0) {
      return false;
    }

    const baseTime = Math.min(...selection.map((item) => item.startTime));
    const clipboardItems: TimelineClipboardItem[] = selection.map((item) => {
      if (item.type === "character") {
        return {
          type: "character",
          sourceTrackId: "character-track",
          sourceLineId: item.lineId,
          char: item.char,
          tone: item.tone ?? null,
          startOffset: item.startTime - baseTime,
          endOffset: item.endTime - baseTime,
        };
      }
      if (item.type === "action") {
        return {
          type: "action",
          sourceTrackId: item.trackId,
          label: item.label,
          startOffset: item.startTime - baseTime,
          endOffset: item.endTime - baseTime,
        };
      }
      if (item.type === "attached-point") {
        return {
          type: "attached-point",
          sourceTrackId: item.trackId,
          parentTrackId: item.parentTrackId,
          label: item.label,
          timeOffset: item.startTime - baseTime,
        };
      }
      if (item.type === "banyan-mark") {
        return {
          type: "banyan-mark",
          sourceTrackId: "banyan-track",
          mark: {
            sectionId: item.sectionId,
            sourceSymbol: item.sourceSymbol,
            role: item.role,
            subtype: item.subtype,
            segment: item.segment,
            beatIndex: item.beatIndex,
            cycleIndex: item.cycleIndex,
            strength: item.strength,
            attachment: item.attachment,
            linkedGongcheAnnotationId: item.linkedGongcheAnnotationId,
            linkedGongcheSymbolId: item.linkedGongcheSymbolId,
            linkedGongcheSymbolIds: item.linkedGongcheSymbolIds ? [...item.linkedGongcheSymbolIds] : undefined,
            confidence: item.confidence,
            durationHint: item.durationHint,
            orphaned: item.orphaned,
            comment: item.comment,
          },
          timeOffset: item.startTime - baseTime,
        };
      }
      return {
        type: "custom-block",
        sourceTrackId: item.trackId,
        trackType: item.trackType,
        blockType: item.typeValue,
        text: item.text,
        startOffset: item.startTime - baseTime,
        endOffset: item.endTime - baseTime,
      };
    });

    setTimelineClipboard({
      items: clipboardItems,
      baseTime,
      primaryTrackId: selection[0]?.trackId ?? null,
      sourceTrackIds: Array.from(new Set(selection.map((item) => item.trackId))),
    });
    return true;
  }

  function cutTimelineSelection() {
    if (!copyTimelineSelection()) {
      return;
    }
    deleteSelected();
    closeTimelineContextMenu();
  }

  function pasteTimelineClipboard() {
    const clipboard = timelineClipboard;
    if (!clipboard || clipboard.items.length === 0) {
      return;
    }

    const currentProject = projectRef.current;
    const pasteTarget = resolveTimelinePasteTarget(
      currentProject,
      clipboard,
      timelinePasteTargetRef.current,
      currentTime,
    );
    if (!pasteTarget) {
      window.alert("当前没有可用的粘贴目标。请先在时间轴上点击或右键目标轨道位置。");
      return;
    }

    const preparedItems = buildPreparedPasteItems(currentProject, clipboard, pasteTarget);
    if (preparedItems.length === 0) {
      window.alert("当前剪贴板内容无法粘贴到该轨道。请检查目标轨道类型是否兼容。");
      return;
    }

    const conflicts = detectPasteConflicts(currentProject, preparedItems);
    if (conflicts.length > 0) {
      setPendingPasteState({ preparedItems, conflicts });
      closeTimelineContextMenu();
      return;
    }

    applyPreparedPaste(preparedItems, "overwrite");
    closeTimelineContextMenu();
  }

  function applyPendingPasteResolution(resolution: PasteConflictResolution) {
    const pendingPaste = pendingPasteState;
    setPendingPasteState(null);
    if (!pendingPaste || resolution === "cancel") {
      return;
    }
    applyPreparedPaste(pendingPaste.preparedItems, resolution);
  }

  function applyPreparedPaste(
    preparedItems: PreparedPasteItem[],
    resolution: Exclude<PasteConflictResolution, "cancel">,
  ) {
    const currentProject = projectRef.current;
    const conflicts = detectPasteConflicts(currentProject, preparedItems);
    const conflictingKeys = new Set(conflicts.flatMap((conflict) => conflict.existingKeys));
    const safeItems = resolution === "keep-original"
      ? preparedItems.filter((item) => !findConflictingKeysForPreparedItem(currentProject, item).length)
      : preparedItems;

    if (safeItems.length === 0) {
      return;
    }

    const sourceLineIds = Array.from(
      new Set(
        safeItems.flatMap((item) => (item.type === "character" ? [item.sourceLineId] : [])),
      ),
    );
    const newLineIdMap = new Map(
      sourceLineIds.map((sourceLineId) => [sourceLineId, `line-${createRuntimeUuid()}`]),
    );

    const insertedCharacters = safeItems.flatMap((item) =>
      item.type === "character"
        ? [{
            id: `char-${createRuntimeUuid()}`,
            lineId: newLineIdMap.get(item.sourceLineId) ?? `line-${createRuntimeUuid()}`,
            char: item.char,
            startTime: item.startTime,
            endTime: item.endTime,
            tone: item.tone ?? null,
          }]
        : [],
    );
    const insertedActions = safeItems.flatMap((item) =>
      item.type === "action"
        ? [{
            id: `${item.targetTrackId}-${createRuntimeUuid()}`,
            trackId: item.targetTrackId,
            label: item.label,
            startTime: item.startTime,
            endTime: item.endTime,
          }]
        : [],
    );
    const insertedPointsByTrack = new Map<string, AttachedPointAnnotation[]>();
    for (const item of safeItems) {
      if (item.type !== "attached-point") {
        continue;
      }
      const points = insertedPointsByTrack.get(item.targetTrackId) ?? [];
      points.push({
        id: `point-${createRuntimeUuid()}`,
        time: item.time,
        label: item.label,
      });
      insertedPointsByTrack.set(item.targetTrackId, points);
    }
    const insertedBanyanMarks = safeItems.flatMap((item) =>
      item.type === "banyan-mark"
        ? [{
            ...item.mark,
            id: `banyan-mark-${createRuntimeUuid()}`,
            time: item.time,
            estimatedTime: item.time,
            manualOffset: 0,
            sourceKey: undefined,
            sourceTokenIndex: undefined,
            sourceSymbol: item.mark.sourceSymbol || "",
            confidence: "manual" as const,
            orphaned: item.mark.orphaned ?? false,
            linkedGongcheSymbolIds: item.mark.linkedGongcheSymbolIds
              ? [...item.mark.linkedGongcheSymbolIds]
              : undefined,
          }]
        : [],
    );
    const insertedCustomBlocksByTrack = new Map<string, Array<CustomTrack["blocks"][number]>>();
    for (const item of safeItems) {
      if (item.type !== "custom-block") {
        continue;
      }
      const blocks: Array<CustomTrack["blocks"][number]> = insertedCustomBlocksByTrack.get(item.targetTrackId) ?? [];
      blocks.push(
        item.trackType === "text"
          ? {
              id: `custom-block-${createRuntimeUuid()}`,
              startTime: item.startTime,
              endTime: item.endTime,
              text: item.text ?? DEFAULT_CUSTOM_TEXT,
              type: item.blockType,
            }
          : {
              id: `custom-block-${createRuntimeUuid()}`,
              startTime: item.startTime,
              endTime: item.endTime,
              type: item.blockType,
            },
      );
      insertedCustomBlocksByTrack.set(item.targetTrackId, blocks);
    }

    const nextCharacterAnnotations = currentProject.characterAnnotations
      .filter((item) => !(resolution === "replace" && conflictingKeys.has(`character:${item.id}`)))
      .concat(insertedCharacters);

    const nextActionAnnotations = currentProject.actionAnnotations
      .filter((item) => !(resolution === "replace" && conflictingKeys.has(`action:${item.id}`)))
      .concat(insertedActions);

    const nextCustomTracks = currentProject.customTracks.map((track) => ({
      ...track,
      attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) =>
        ({
          ...pointTrack,
          points: [
            ...pointTrack.points.filter((point) => !(resolution === "replace" && conflictingKeys.has(`attached-point:${pointTrack.id}:${point.id}`))),
            ...(insertedPointsByTrack.get(pointTrack.id) ?? []),
          ].sort((left, right) => left.time - right.time),
        })
      ),
      blocks: [
        ...(resolution === "replace"
          ? track.blocks.filter((block) => !conflictingKeys.has(`custom-block:${track.id}:${block.id}`))
          : track.blocks),
        ...(insertedCustomBlocksByTrack.get(track.id) ?? []),
      ] as CustomTrack["blocks"],
    })) as CustomTrack[];
    const nextBuiltinTracks = currentProject.builtinTracks.map((track) => ({
      ...track,
      attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
        ...pointTrack,
        points: [
          ...pointTrack.points.filter((point) => !(resolution === "replace" && conflictingKeys.has(`attached-point:${pointTrack.id}:${point.id}`))),
          ...(insertedPointsByTrack.get(pointTrack.id) ?? []),
        ].sort((left, right) => left.time - right.time),
      })),
    }));

    const affectedLineIds = new Set<string>([
      ...currentProject.characterAnnotations
        .filter((item) => resolution === "replace" && conflictingKeys.has(`character:${item.id}`))
        .map((item) => item.lineId),
      ...Array.from(newLineIdMap.values()),
    ]);

    const nextProject = syncSubtitleLines(
      {
        ...currentProject,
        characterAnnotations: nextCharacterAnnotations,
        banyanMarks: [
          ...currentProject.banyanMarks.filter((mark) =>
            !(resolution === "replace" && conflictingKeys.has(`banyan-mark:${mark.id}`)),
          ),
          ...insertedBanyanMarks,
        ].sort((left, right) => left.time - right.time || left.id.localeCompare(right.id)),
        actionAnnotations: nextActionAnnotations,
        builtinTracks: nextBuiltinTracks,
        customTracks: nextCustomTracks,
      },
      Array.from(affectedLineIds),
    );

    const nextSelectedItems: TimelineSelectionItem[] = [
      ...insertedCharacters.map((annotation) => ({ type: "character" as const, id: annotation.id })),
      ...insertedActions.map((annotation) => ({ type: "action" as const, id: annotation.id })),
      ...Array.from(insertedPointsByTrack.entries()).flatMap(([trackId, points]) =>
        points.map((point) => ({
          type: "attached-point" as const,
          id: point.id,
          trackId,
          parentTrackId: findPointTrackLocation(nextProject, trackId)?.parentTrack.id ?? "",
        })),
      ),
      ...Array.from(insertedCustomBlocksByTrack.entries()).flatMap(([trackId, blocks]) =>
        blocks.map((block) => ({ type: "custom-block" as const, id: block.id, trackId })),
      ),
      ...insertedBanyanMarks.map((mark) => ({ type: "banyan-mark" as const, id: mark.id })),
    ];

    commitProject(nextProject);
    if (nextSelectedItems.length > 0) {
      const primaryItem = nextSelectedItems[0];
      applySelection(
        primaryItem.type === "custom-block"
          ? { type: "custom-block", id: primaryItem.id, trackId: primaryItem.trackId }
          : primaryItem.type === "attached-point"
            ? {
                type: "attached-point",
                id: primaryItem.id,
                trackId: primaryItem.trackId,
                parentTrackId: primaryItem.parentTrackId,
              }
          : primaryItem.type === "banyan-mark"
            ? { type: "banyan-mark", id: primaryItem.id }
          : { type: primaryItem.type, id: primaryItem.id },
        nextSelectedItems,
      );
    }
  }

  function updateTimelineSelectionBatch(items: TimelineBatchMoveItem[], recordHistory = true) {
    if (items.length === 0) {
      return;
    }

    const currentProject = projectRef.current;
    const baseProject = transientProjectRef.current ?? currentProject;
    const timingParentsBefore = new Map<string, GongcheParentBlock>();
    const characterUpdates = new Map(
      items
        .filter((item): item is TimelineBatchMoveItem & { type: "character" } => item.type === "character")
        .map((item) => [item.id, item]),
    );
    const actionUpdates = new Map(
      items
        .filter((item): item is TimelineBatchMoveItem & { type: "action" } => item.type === "action")
        .map((item) => [item.id, item]),
    );
    const attachedPointUpdates = new Map(
      items
        .filter(
          (item): item is TimelineBatchMoveItem & { type: "attached-point"; trackId: string } =>
            item.type === "attached-point",
        )
        .map((item) => [`${item.trackId}:${item.id}`, item]),
    );
    const customBlockUpdates = new Map(
      items
        .filter(
          (item): item is TimelineBatchMoveItem & { type: "custom-block"; trackId: string } =>
            item.type === "custom-block",
        )
        .map((item) => [`${item.trackId}:${item.id}`, item]),
    );
    const banyanMarkUpdates = new Map(
      items
        .filter((item): item is TimelineBatchMoveItem & { type: "banyan-mark" } => item.type === "banyan-mark")
        .map((item) => [item.id, item]),
    );
    const affectedLineIds = new Set<string>();
    for (const item of characterUpdates.values()) {
      const character = currentProject.characterAnnotations.find((candidate) => candidate.id === item.id);
      if (character) {
        timingParentsBefore.set(getGongcheParentKey("character-track", character.id), toCharacterGongcheParent(character));
      }
    }
    for (const item of customBlockUpdates.values()) {
      const block = findCustomBlock(currentProject.customTracks, item.trackId, item.id);
      if (block?.trackType === "text") {
        timingParentsBefore.set(getGongcheParentKey(item.trackId, item.id), toCustomBlockGongcheParent(block));
      }
    }

    const nextProject = synchronizeGongcheWithChangedParents({
      ...currentProject,
      characterAnnotations: currentProject.characterAnnotations.map((item) => {
        const update = characterUpdates.get(item.id);
        if (!update) {
          return item;
        }
        affectedLineIds.add(item.lineId);
        return {
          ...item,
          startTime: update.startTime,
          endTime: update.endTime,
        };
      }),
      actionAnnotations: currentProject.actionAnnotations.map((item) => {
        const update = actionUpdates.get(item.id);
        if (!update) {
          return item;
        }
        return {
          ...item,
          startTime: update.startTime,
          endTime: update.endTime,
        };
      }),
      banyanMarks: currentProject.banyanMarks.map((item) => {
        const update = banyanMarkUpdates.get(item.id);
        if (!update) {
          return item;
        }
        return {
          ...item,
          time: update.startTime,
          manualOffset: update.startTime - item.estimatedTime,
          confidence: "manual",
        };
      }),
      builtinTracks: currentProject.builtinTracks.map((track) => ({
        ...track,
        attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
          ...pointTrack,
          points: pointTrack.points.map((point) => {
            const update = attachedPointUpdates.get(`${pointTrack.id}:${point.id}`);
            if (!update) {
              return point;
            }
            return {
              ...point,
              time: update.startTime,
            };
          }),
        })),
      })),
      customTracks: currentProject.customTracks.map((track) => ({
        ...track,
        attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
          ...pointTrack,
          points: pointTrack.points.map((point) => {
            const update = attachedPointUpdates.get(`${pointTrack.id}:${point.id}`);
            if (!update) {
              return point;
            }
            return {
              ...point,
              time: update.startTime,
            };
          }),
        })),
        blocks: track.blocks.map((block) => {
          const update = customBlockUpdates.get(`${track.id}:${block.id}`);
          if (!update) {
            return block;
          }
          return {
            ...block,
            startTime: update.startTime,
            endTime: update.endTime,
          };
        }) as CustomTrack["blocks"],
      })) as CustomTrack[],
    }, timingParentsBefore);

    const synchronizedProject = affectedLineIds.size > 0
      ? syncSubtitleLines(nextProject, Array.from(affectedLineIds))
      : nextProject;

    if (recordHistory) {
      // 多选移动按真实选择目标构造批量命令，并补齐句级边界与派生工尺时间。
      const directTargets = items.flatMap((item): TimelineTimingTarget[] => {
        if (item.type === "character") {
          return [{ entityType: "character", entityId: item.id }];
        }
        if (item.type === "action") {
          const action = baseProject.actionAnnotations.find((candidate) => candidate.id === item.id);
          return action
            ? [{ entityType: "action", entityId: item.id, trackId: action.trackId }]
            : [];
        }
        if (item.type === "custom-block") {
          return [{ entityType: "custom-block", entityId: item.id, trackId: item.trackId }];
        }
        if (item.type === "attached-point") {
          return [{ entityType: "attached-point", entityId: item.id, trackId: item.trackId }];
        }
        return [{ entityType: "banyan-mark", entityId: item.id }];
      });
      const gongcheTimingTargets = new Map<string, TimelineTimingTarget>();
      const gongcheStateTargets = new Map<string, AnnotationStateTarget>();
      const gongcheTargetGroups = [
        ...Array.from(customBlockUpdates.values(), (item) =>
          getGongcheTransactionTargetsForParents(
            baseProject,
            synchronizedProject,
            item.trackId,
            [item.id],
          )),
        getGongcheTransactionTargetsForParents(
          baseProject,
          synchronizedProject,
          "character-track",
          [...characterUpdates.keys()],
        ),
      ];
      // 所有父轨级联目标在这里统一去重，避免字符轨与多个自定义轨分别维护两套合并逻辑。
      for (const targets of gongcheTargetGroups) {
        for (const target of targets.timingTargets) {
          gongcheTimingTargets.set(`${target.trackId}:${target.entityId}`, target);
        }
        for (const target of targets.stateTargets) {
          gongcheStateTargets.set(`${target.trackId}:${target.entityId}`, target);
        }
      }

      // 多选可能同时跨多个父轨道；Map 去重后把所有外层 timing 和符号 state 放入一个事务。
      commitProjectWithTransaction(baseProject, synchronizedProject, {
        timingTargets: [
          ...directTargets,
          ...Array.from(affectedLineIds, (entityId): TimelineTimingTarget => ({
            entityType: "sentence",
            entityId,
          })),
          ...gongcheTimingTargets.values(),
        ],
        stateTargets: [...gongcheStateTargets.values()],
      });
    } else {
      applyProjectWithoutHistory(synchronizedProject);
    }
  }

  function createCharacterAtTime(time: number, explicitEndTime?: number) {
    const currentProject = projectRef.current;
    if (!currentProject.builtinTracks.some((track) => track.id === "character-track")) {
      return;
    }
    const normalizedTime = Math.max(0, time);
    const requestedRange = normalizeCharacterCreationRequest(normalizedTime, explicitEndTime);
    const characterId = `char-${createRuntimeUuid()}`;
    const char = "新";
    // 逐字块可能同时创建/更新句级实体，必须用结构事务一次提交，避免云端把字符和句子拆成两条链。
    const buildNextProject = (baseProject: ProjectData): ProjectData => {
      const target = findCharacterCreationTarget(baseProject.subtitleLines, normalizedTime);
      if (target) {
        const range = getCharacterCreationRange(target.line, target.position, requestedRange);
        return syncSubtitleLine({
          ...baseProject,
          characterAnnotations: [
            ...baseProject.characterAnnotations,
            {
              id: characterId,
              lineId: target.line.id,
              char,
              startTime: range.startTime,
              endTime: range.endTime,
              tone: null,
            },
          ],
        }, target.line.id);
      }
      const lineId = `line-${createRuntimeUuid()}`;
      return {
        ...baseProject,
        subtitleLines: sortSubtitleLines([
          ...baseProject.subtitleLines,
          {
            id: lineId,
            text: char,
            startTime: requestedRange.startTime,
            endTime: requestedRange.endTime,
            deliveryMode: null,
            roleType: null,
          },
        ]),
        characterAnnotations: [
          ...baseProject.characterAnnotations,
          {
            id: characterId,
            lineId,
            char,
            startTime: requestedRange.startTime,
            endTime: requestedRange.endTime,
            tone: null,
          },
        ],
      };
    };
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => {
        const target = findCharacterCreationTarget(baseProject.subtitleLines, normalizedTime);
        const createdCharacter = nextProject.characterAnnotations.find((item) => item.id === characterId);
        if (!createdCharacter) return null;
        const lineId = createdCharacter.lineId;
        return buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
          contentTargets: target
            ? [{ entityType: "sentence", entityId: lineId, field: "text" }]
            : [],
          timingTargets: target
            ? [{ entityType: "sentence", entityId: lineId }]
            : [],
          lifecycleTargets: target
            ? [{ entityType: "character", entityId: characterId }]
            : [
                { entityType: "sentence", entityId: lineId },
                { entityType: "character", entityId: characterId },
              ],
        });
      },
    ).then((committed) => {
      if (!committed) return;
      preferredCharacterEditLocationRef.current = "timeline";
      applySelection({ type: "character", id: characterId });
      setEditingCharacterId(characterId);
      setEditingCharacterLocation("timeline");
      setEditingCharacterValue(char);
    });
  }

  function createActionAtTime(trackId: string, startTime: number, explicitEndTime?: number) {
    const currentProject = projectRef.current;
    if (!currentProject.builtinTracks.some((track) => track.id === trackId)) {
      return;
    }
    const safeStartTime = Math.max(0, startTime);
    const safeEndTime = explicitEndTime !== undefined
      ? Math.max(safeStartTime, explicitEndTime)
      : safeStartTime + DEFAULT_ACTION_DURATION;
    const actionId = `${trackId}-${createRuntimeUuid()}`;
    // 动作块创建原来直接落入 legacy project.commit，平台原子保存无法重放；现在和其他结构实体统一走事务。
    const buildNextProject = (baseProject: ProjectData): ProjectData => ({
      ...baseProject,
      actionAnnotations: [
        ...baseProject.actionAnnotations,
        {
          id: actionId,
          trackId,
          label: "其他",
          startTime: safeStartTime,
          endTime: safeEndTime,
        },
      ],
    });
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        lifecycleTargets: [{ entityType: "action", entityId: actionId, trackId }],
      }),
    ).then((committed) => {
      if (committed) applySelection({ type: "action", id: actionId });
    });
  }

  function addBuiltinTrack(trackId: BuiltinTrackId) {
    void runTrackStructureMutation(
      (baseProject) => baseProject.builtinTracks.some((track) => track.id === trackId)
        ? baseProject
        : {
            ...baseProject,
            builtinTracks: [...baseProject.builtinTracks, getBuiltinTrackDefinition(trackId)],
            activeTrackOrder: [...baseProject.activeTrackOrder, trackId],
          },
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        builtinTrackLifecycleTargets: [{ trackId }],
      }),
    );
  }

  function deleteBuiltinTrack(trackId: BuiltinTrackId) {
    const currentProject = projectRef.current;
    const targetTrack = currentProject.builtinTracks.find((track) => track.id === trackId);
    if (!targetTrack) {
      return;
    }
    const affectedCharacterCount = trackId === "character-track"
      ? currentProject.characterAnnotations.length
      : 0;
    const affectedActionCount = trackId === "character-track"
      ? 0
      : currentProject.actionAnnotations.filter((item) => item.trackId === trackId).length;
    const affectedPointCount = (targetTrack.attachedPointTracks ?? []).reduce(
      (sum, pointTrack) => sum + pointTrack.points.length,
      0,
    );
    const affectedGongcheCount = currentProject.gongcheAnnotations.filter((item) =>
      item.parentTrackId === trackId,
    ).length;
    const affectedCount = affectedCharacterCount + affectedActionCount + affectedPointCount + affectedGongcheCount;
    const confirmed = window.confirm(
      `确定要删除轨道“${targetTrack.name}”吗？` +
        `\n删除轨道会同时删除轨道上的全部标注` +
        (affectedCount > 0 ? `（当前共 ${affectedCount} 条）` : "") +
        `。`,
    );
    if (!confirmed) {
      return;
    }

    const buildNextProject = (baseProject: ProjectData) => {
      if (!baseProject.builtinTracks.some((track) => track.id === trackId)) return baseProject;
      const projectWithoutTrack = {
        ...baseProject,
        builtinTracks: baseProject.builtinTracks.filter((track) => track.id !== trackId),
        activeTrackOrder: baseProject.activeTrackOrder.filter((id) => id !== trackId),
        characterAnnotations: trackId === "character-track" ? [] : baseProject.characterAnnotations,
        actionAnnotations: trackId === "character-track"
          ? baseProject.actionAnnotations
          : baseProject.actionAnnotations.filter((item) => item.trackId !== trackId),
        gongcheAnnotations: baseProject.gongcheAnnotations.filter((item) => item.parentTrackId !== trackId),
      };
      return repairBanyanGongcheReferences(projectWithoutTrack).project;
    };
    const overflowBoundary = buildProjectSnapshotBoundaryEnvelope(
      createRuntimeUuid(),
      "builtin_track_lifecycle_overflow",
    );
    if (!overflowBoundary) return;
    void runExclusiveProjectMutation(
      "bulk_repair",
      buildNextProject,
      (baseProject, nextProject) => {
        const repairResult = repairBanyanGongcheReferences({
          ...baseProject,
          gongcheAnnotations: baseProject.gongcheAnnotations.filter((item) => item.parentTrackId !== trackId),
        });
        const gongcheTargets = baseProject.gongcheAnnotations
          .filter((item) => item.parentTrackId === trackId)
          .map((item) => ({ entityType: "gongche-block" as const, entityId: item.id, trackId }));
        const ownedTargets: AnnotationLifecycleTarget[] = baseProject.characterAnnotations.map((item) => ({
          entityType: "character" as const,
          entityId: item.id,
        }));
        return buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
          builtinTrackLifecycleTargets: [{ trackId }],
          stateTargets: repairResult.changedMarkIds.map((entityId) => ({
            entityType: "banyan-mark" as const,
            entityId,
          })),
          lifecycleTargetGroups: [gongcheTargets, ownedTargets],
        }) ?? overflowBoundary;
      },
    ).then((committed) => {
      if (!committed) return;
      // 只有项目真正提交后才清理 UI 选择，租约失败不能让界面先丢失当前上下文。
      if (trackId === "character-track") cancelCharacterTextEdit();
      applySelection(null);
      setSelectedTimelineItems((items) => items.filter((item) =>
        trackId === "character-track" ? item.type !== "character" : item.type !== "action"));
    });
  }

  function addCustomTrack(trackType: CustomTrackType) {
    const previewProject = projectRef.current;
    const color = getNextTrackColor(previewProject.customTracks);
    const nextTrack: CustomTrack = trackType === "text"
      ? {
          id: `custom-track-${createRuntimeUuid()}`,
          name: getDefaultCustomTrackName(previewProject.customTracks, trackType),
          trackType,
          color,
          typeOptions: getDefaultCustomTrackTypeOptions(),
          blocks: [],
          attachedPointTracks: [],
          attachedPointTracksExpanded: false,
        }
      : {
          id: `custom-track-${createRuntimeUuid()}`,
          name: getDefaultCustomTrackName(previewProject.customTracks, trackType),
          trackType,
          color,
          typeOptions: getDefaultCustomTrackTypeOptions(),
        blocks: [],
        attachedPointTracks: [],
        attachedPointTracksExpanded: false,
        snapToWaveformKeypoints: false,
      };

    const buildNextProject = (baseProject: ProjectData): ProjectData => ({
      ...baseProject,
      customTracks: [...baseProject.customTracks, nextTrack] as CustomTrack[],
      activeTrackOrder: [...baseProject.activeTrackOrder, nextTrack.id],
    });
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        customTrackLifecycleTargets: [{ trackId: nextTrack.id }],
      }),
    ).then((committed) => {
      if (committed) applySelection({ type: "custom-track", id: nextTrack.id });
    });
  }

  function createAttachedPoint(pointTrackId: string, time: number) {
    const currentProject = projectRef.current;
    const location = findPointTrackLocation(currentProject, pointTrackId);
    if (!location) {
      return;
    }
    const nextPoint: AttachedPointAnnotation = {
      id: `point-${createRuntimeUuid()}`,
      time: Math.max(0, time),
      label: location.pointTrack.typeOptions[0] ?? "标记 1",
    };
    const parentTrackId = location.parentTrack.id;
    // 附属点也是轨道结构事务的一部分；否则平台保存只能看到旧的 lifecycle leaf，无法和结构租约保持一致。
    const buildNextProject = (baseProject: ProjectData): ProjectData =>
      buildProjectWithUpdatedAttachedPointTrack(baseProject, pointTrackId, (pointTrack) => ({
        ...pointTrack,
        points: [...pointTrack.points, nextPoint].sort((left, right) => left.time - right.time),
      })) ?? baseProject;
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => {
        const nextLocation = findPointTrackLocation(nextProject, pointTrackId);
        if (!nextLocation) return null;
        return buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
          lifecycleTargets: [{
            entityType: "attached-point",
            entityId: nextPoint.id,
            trackId: pointTrackId,
          }],
        });
      },
    ).then((committed) => {
      if (!committed) return;
      applySelection({
        type: "attached-point",
        id: nextPoint.id,
        trackId: pointTrackId,
        parentTrackId,
      });
    });
  }

  function createCustomBlock(
    trackId: string,
    startTime: number,
    explicitEndTime?: number,
    branchScope?: BranchScope,
  ) {
    const currentProject = projectRef.current;
    const targetTrack = currentProject.customTracks.find((track) => track.id === trackId);
    if (!targetTrack) return;
    const safeStartTime = Math.max(0, startTime);
    const endTime = explicitEndTime === undefined
      ? safeStartTime + DEFAULT_ACTION_DURATION
      : Math.max(safeStartTime + MIN_CHARACTER_DURATION, explicitEndTime);
    const defaultType = targetTrack.typeOptions[0] ?? "类型 1";
    // undefined 可选字段不进入实体对象，确保命令重建和 JSON 往返使用同一规范结构。
    const nextBlock = targetTrack.trackType === "text"
      ? {
          id: `custom-block-${createRuntimeUuid()}`,
          startTime: safeStartTime,
          endTime,
          text: DEFAULT_CUSTOM_TEXT,
          type: defaultType,
          ...(branchScope ? { branchScope } : {}),
        }
      : {
          id: `custom-block-${createRuntimeUuid()}`,
          startTime: safeStartTime,
          endTime,
          type: defaultType,
          ...(branchScope ? { branchScope } : {}),
        };

    const buildNextProject = (baseProject: ProjectData): ProjectData => ({
      ...baseProject,
      customTracks: baseProject.customTracks.map((track) =>
        track.id === trackId
          ? { ...track, blocks: [...track.blocks, nextBlock] as CustomTrack["blocks"] }
          : track,
      ) as CustomTrack[],
    });
    // 自定义文字/动作块的创建与删除共用结构租约，避免平台文件在保存器中退回旧 snapshot 路径。
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        lifecycleTargets: [{ entityType: "custom-block", entityId: nextBlock.id, trackId }],
      }),
    ).then((committed) => {
      if (!committed) return;
      applySelection({ type: "custom-block", trackId, id: nextBlock.id });
      if (targetTrack.trackType === "text") {
        setEditingCustomTextBlock({ trackId, id: nextBlock.id });
        setEditingCustomTextValue(DEFAULT_CUSTOM_TEXT);
      }
    });
  }

  function createGongcheBlock(parentTrackId: string, parentBlockId: string) {
    const currentProject = projectRef.current;
    const parentBlock = findGongcheParentBlock(currentProject, parentTrackId, parentBlockId);
    if (!parentBlock) {
      return;
    }
    const existingBlock = currentProject.gongcheAnnotations.find((item) =>
      item.parentTrackId === parentTrackId && item.parentBlockId === parentBlockId,
    );
    if (existingBlock) {
      applySelection({ type: "gongche-block", id: existingBlock.id });
      return;
    }
    const nextBlock: GongcheAnnotation = {
      id: `gongche-${createRuntimeUuid()}`,
      parentTrackId,
      parentBlockId,
      startTime: parentBlock.startTime,
      endTime: parentBlock.endTime,
      symbols: [{
        id: `gongche-symbol-${createRuntimeUuid()}`,
        label: "合",
        notation: "",
        rawText: "合",
        parenthesized: false,
        startTime: parentBlock.startTime,
        endTime: parentBlock.endTime,
        assetUrl: null,
      }],
    };
    // 工尺附属块引用父块，创建也必须进入结构事务，保证父轨结构锁和子块生命周期在同一命令中确认。
    const buildNextProject = (baseProject: ProjectData) => ({
      ...baseProject,
      gongcheAnnotations: [...baseProject.gongcheAnnotations, nextBlock],
    });
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        lifecycleTargets: [{ entityType: "gongche-block", entityId: nextBlock.id, trackId: parentTrackId }],
      }),
    ).then((committed) => {
      if (committed) applySelection({ type: "gongche-block", id: nextBlock.id });
    });
  }

  function createGongcheBlockAtTime(parentTrackId: string, time: number) {
    const parentBlock = findGongcheParentBlockAtTime(projectRef.current, parentTrackId, time);
    if (!parentBlock) {
      return;
    }
    createGongcheBlock(parentTrackId, parentBlock.parentBlockId);
  }

  function updateGongcheBlock(
    id: string,
    changes: Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">>,
    recordHistory = true,
  ) {
    const currentProject = projectRef.current;
    const baseProject = transientProjectRef.current ?? currentProject;
    const currentBlock = currentProject.gongcheAnnotations.find((item) => item.id === id);
    if (!currentBlock) {
      return;
    }
    const parentBlock = findGongcheParentBlock(currentProject, currentBlock.parentTrackId, currentBlock.parentBlockId);
    const nextBlock = normalizeGongcheBlockTiming({
      ...currentBlock,
      ...changes,
    }, parentBlock);
    let nextProject = {
      ...currentProject,
      gongcheAnnotations: currentProject.gongcheAnnotations.map((item) =>
        item.id === id ? nextBlock : item,
      ),
    };
    if (recordHistory) {
      const baseBlock = baseProject.gongcheAnnotations.find((item) => item.id === id);
      if (!baseBlock) {
        commitProject(nextProject, baseProject);
        return;
      }
      const baseSymbolIds = new Set(baseBlock.symbols.map((symbol) => symbol.id));
      const nextSymbolIds = new Set(nextBlock.symbols.map((symbol) => symbol.id));
      const deletedSymbols = baseBlock.symbols.filter((symbol) => !nextSymbolIds.has(symbol.id));
      const createdSymbols = nextBlock.symbols.filter((symbol) => !baseSymbolIds.has(symbol.id));
      const survivingSymbols = nextBlock.symbols.filter((symbol) => baseSymbolIds.has(symbol.id));

      // 删除 symbol 时先修复板眼引用；state 子命令会在 lifecycle 删除前断开强引用。
      const repaired = deletedSymbols.length > 0 ? repairBanyanGongcheReferences(nextProject) : null;
      if (repaired) nextProject = repaired.project;
      const lifecycleTargets: AnnotationLifecycleTarget[] = [
        ...deletedSymbols.map((symbol) => ({
          entityType: "gongche-symbol" as const,
          entityId: symbol.id,
          trackId: id,
        })),
        ...createdSymbols.map((symbol) => ({
          entityType: "gongche-symbol" as const,
          entityId: symbol.id,
          trackId: id,
        })),
      ];
      const stateTargets: AnnotationStateTarget[] = [
        ...survivingSymbols.map((symbol) => ({
          entityType: "gongche-symbol" as const,
          entityId: symbol.id,
          trackId: id,
        })),
        ...(repaired?.changedMarkIds ?? []).map((entityId) => ({
          entityType: "banyan-mark" as const,
          entityId,
        })),
      ];
      const blockTimingChanged = baseBlock.startTime !== nextBlock.startTime || baseBlock.endTime !== nextBlock.endTime;
      commitProjectWithTransaction(baseProject, nextProject, {
        timingTargets: blockTimingChanged
          ? [{ entityType: "gongche-block", entityId: id, trackId: currentBlock.parentTrackId }]
          : [],
        stateTargets,
        lifecycleTargets,
      });
    } else {
      applyProjectWithoutHistory(nextProject);
    }
  }

  function changeGongcheBlock(
    id: string,
    changes: Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">>,
  ) {
    updateGongcheBlock(id, changes, false);
  }

  function commitGongcheBlock(
    id: string,
    changes: Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">>,
  ) {
    updateGongcheBlock(id, changes, true);
  }

  async function importGongcheText(parentTrackId: string, sourceText: string) {
    const parsedEntries = parseGongcheSourceText(sourceText);
    // 预览与取得租约后的重算共用同一个纯准备器；无匹配结果时仍向用户返回解析统计。
    const prepareImport = (baseProject: ProjectData) => {
      const parentBlocks = getOrderedGongcheParentBlocks(baseProject, parentTrackId);
      const alignedPairs = alignGongcheEntriesToParentBlocks(parsedEntries, parentBlocks);
      const importedBlocks: GongcheAnnotation[] = [];
      let updated = 0;
      for (const pair of alignedPairs) {
        const entry = parsedEntries[pair.entryIndex];
        const parentBlock = parentBlocks[pair.parentIndex];
        const existingBlock = baseProject.gongcheAnnotations.find((item) =>
          item.parentTrackId === parentTrackId && item.parentBlockId === parentBlock.parentBlockId,
        );
        if (existingBlock) updated += 1;
        importedBlocks.push({
          id: existingBlock?.id ?? `gongche-${createRuntimeUuid()}`,
          parentTrackId,
          parentBlockId: parentBlock.parentBlockId,
          startTime: parentBlock.startTime,
          endTime: parentBlock.endTime,
          symbols: distributeParsedGongcheSymbols(entry.symbols, parentBlock.startTime, parentBlock.endTime),
        });
      }
      const stats = {
        parsed: parsedEntries.length,
        imported: importedBlocks.length - updated,
        updated,
        unmatched: parsedEntries.length - importedBlocks.length,
      };
      if (importedBlocks.length === 0) return { project: baseProject, stats };
      const importedKeys = new Set(importedBlocks.map((block) =>
        getGongcheParentKey(block.parentTrackId, block.parentBlockId)));
      // 批量替换可能生成新符号 id；保留板眼记录并把失效强引用转为待复核孤立状态。
      const project = repairBanyanGongcheReferences({
        ...baseProject,
        gongcheAnnotations: [
          ...baseProject.gongcheAnnotations.filter((block) =>
            !importedKeys.has(getGongcheParentKey(block.parentTrackId, block.parentBlockId))),
          ...importedBlocks,
        ],
      }).project;
      return { project, stats };
    };
    let committedResult = prepareImport(projectRef.current);
    if (areProjectValuesEqual(projectRef.current, committedResult.project)) return committedResult.stats;
    const committed = await runControlledSnapshotMutation("import_gongche", (baseProject) => {
      committedResult = prepareImport(baseProject);
      return committedResult.project;
    });
    return committed ? committedResult.stats : null;
  }

  async function generateBanyanFromGongche() {
    const currentProject = projectRef.current;
    const result = generateBanyanMarksFromGongche(currentProject);
    const currentSectionIds = new Set(currentProject.banyanSections.map((section) => section.id));
    const currentMarkIds = new Set(currentProject.banyanMarks.map((mark) => mark.id));
    const nextSectionIds = new Set(result.project.banyanSections.map((section) => section.id));
    const nextMarkIds = new Set(result.project.banyanMarks.map((mark) => mark.id));
    const lifecycleTargets: AnnotationLifecycleTarget[] = [
      ...currentProject.banyanSections
        .filter((section) => !nextSectionIds.has(section.id))
        .map((section) => ({ entityType: "banyan-section" as const, entityId: section.id })),
      ...result.project.banyanSections
        .filter((section) => !currentSectionIds.has(section.id))
        .map((section) => ({ entityType: "banyan-section" as const, entityId: section.id })),
      ...currentProject.banyanMarks
        .filter((mark) => !nextMarkIds.has(mark.id))
        .map((mark) => ({ entityType: "banyan-mark" as const, entityId: mark.id })),
      ...result.project.banyanMarks
        .filter((mark) => !currentMarkIds.has(mark.id))
        .map((mark) => ({ entityType: "banyan-mark" as const, entityId: mark.id })),
    ];
    const stateTargets: AnnotationStateTarget[] = [
      ...result.project.banyanSections
        .filter((section) => currentSectionIds.has(section.id))
        .map((section) => ({ entityType: "banyan-section" as const, entityId: section.id })),
      ...result.project.banyanMarks
        .filter((mark) => currentMarkIds.has(mark.id))
        .map((mark) => ({ entityType: "banyan-mark" as const, entityId: mark.id })),
    ];
    const commandEnvelope = buildProjectAnnotationTransactionCommand(
      currentProject,
      result.project,
      { stateTargets, lifecycleTargets },
    );
    if (commandEnvelope) {
      commitProject(result.project, currentProject, { commandEnvelope });
      return result.stats;
    }
    if (areProjectValuesEqual(currentProject, result.project)) return result.stats;

    // 超出普通事务预算时才进入批量修复边界；拿锁后重新生成，避免覆盖等待期间的新工尺内容。
    let committedStats = result.stats;
    const committed = await runControlledSnapshotMutation("generate_banyan", (baseProject) => {
      const latestResult = generateBanyanMarksFromGongche(baseProject);
      committedStats = latestResult.stats;
      return latestResult.project;
    });
    return committed ? committedStats : null;
  }

  function updateBanyanMark(id: string, changes: Partial<BanyanMark>, recordHistory = true) {
    const currentProject = projectRef.current;
    const baseProject = transientProjectRef.current ?? currentProject;
    const currentMark = currentProject.banyanMarks.find((item) => item.id === id);
    if (!currentMark) {
      return;
    }
    const estimatedTime = typeof changes.estimatedTime === "number" ? Math.max(0, changes.estimatedTime) : currentMark.estimatedTime;
    const nextTime = typeof changes.time === "number" ? Math.max(0, changes.time) : currentMark.time;
    const nextMark: BanyanMark = {
      ...currentMark,
      ...changes,
      time: nextTime,
      estimatedTime,
      manualOffset: nextTime - estimatedTime,
      confidence: changes.confidence ?? (Math.abs(nextTime - currentMark.time) > 0.0005 ? "manual" : currentMark.confidence),
    };
    const nextProject = {
      ...currentProject,
      banyanMarks: currentProject.banyanMarks.map((item) => item.id === id ? nextMark : item),
    };
    if (recordHistory) {
      const isTimingOnly = Object.keys(changes).every((key) => key === "time");
      // 板眼位置以零长度时间区间记录；类型、来源和人工审校字段变化不伪装成移动命令。
      const commandEnvelope = isTimingOnly
        ? buildProjectTimelineTimingCommand(baseProject, nextProject, [{
            entityType: "banyan-mark",
            entityId: id,
          }])
        : null;
      if (commandEnvelope) commitProject(nextProject, baseProject, { commandEnvelope });
      else commitProjectWithState(baseProject, nextProject, [{ entityType: "banyan-mark", entityId: id }]);
    } else {
      applyProjectWithoutHistory(nextProject);
    }
  }

  function changeBanyanMark(id: string, changes: Partial<BanyanMark>) {
    updateBanyanMark(id, changes, false);
  }

  function commitBanyanMark(id: string, changes: Partial<BanyanMark>) {
    updateBanyanMark(id, changes, true);
  }

  function createBanyanMark(time: number) {
    const currentProject = projectRef.current;
    const safeTime = Math.max(0, time);
    const section = findBanyanSectionAtTime(currentProject.banyanSections, safeTime) ??
      currentProject.banyanSections[0] ??
      null;
    const nextSection = section ?? {
      id: `banyan-section-${createRuntimeUuid()}`,
      name: "板眼区段",
      startTime: safeTime,
      endTime: Math.max(safeTime + 1, getProjectDuration(currentProject)),
      cycleType: "yi_ban_san_yan_zeng" as const,
      freeRhythm: false,
      beatCount: 8,
      hasZengBan: true,
      source: "manual",
    };
    const nextMark: BanyanMark = {
      id: `banyan-mark-${createRuntimeUuid()}`,
      sectionId: nextSection.id,
      time: safeTime,
      estimatedTime: safeTime,
      sourceSymbol: "",
      role: "ban",
      subtype: "mainBan",
      segment: "main",
      beatIndex: 1,
      cycleIndex: null,
      strength: "strong",
      attachment: "unknown",
      linkedGongcheAnnotationId: null,
      linkedGongcheSymbolId: null,
      confidence: "manual",
      manualOffset: 0,
      durationHint: null,
      orphaned: false,
      comment: "",
    };
    const nextProject = {
      ...currentProject,
      banyanSections: section ? currentProject.banyanSections : [...currentProject.banyanSections, nextSection],
      banyanMarks: [...currentProject.banyanMarks, nextMark].sort((left, right) => left.time - right.time),
    };
    commitProjectWithTransaction(currentProject, nextProject, {
      lifecycleTargets: [
        ...(section ? [] : [{ entityType: "banyan-section" as const, entityId: nextSection.id }]),
        { entityType: "banyan-mark", entityId: nextMark.id },
      ],
    });
    applySelection({ type: "banyan-mark", id: nextMark.id });
  }

  function applyCharacterLineAction(id: string, action: CharacterLineAction) {
    const currentProject = projectRef.current;
    const currentCharacter = currentProject.characterAnnotations.find((item) => item.id === id);
    if (!currentCharacter) {
      return;
    }

    const sortedLines = sortSubtitleLines(currentProject.subtitleLines);
    const currentLineIndex = sortedLines.findIndex((line) => line.id === currentCharacter.lineId);
    const lineCharacters = sortCharactersByTime(
      currentProject.characterAnnotations.filter((item) => item.lineId === currentCharacter.lineId),
    );
    const characterIndex = lineCharacters.findIndex((item) => item.id === id);

    if (currentLineIndex === -1 || characterIndex === -1) {
      return;
    }

    if (action === "split-block") {
      const splitCharacters = getSplittableCharacters(currentCharacter.char);
      if (splitCharacters.length <= 1) {
        return;
      }
      const sliceDuration = (currentCharacter.endTime - currentCharacter.startTime) / splitCharacters.length;
      const splitAnnotations = splitCharacters.map((char, index) => ({
        ...currentCharacter,
        id: index === 0 ? currentCharacter.id : `char-${createRuntimeUuid()}`,
        char,
        startTime: currentCharacter.startTime + sliceDuration * index,
        endTime: index === splitCharacters.length - 1
          ? currentCharacter.endTime
          : currentCharacter.startTime + sliceDuration * (index + 1),
      }));
      const splitProject = syncSubtitleLine(
        {
          ...currentProject,
          characterAnnotations: [
            ...currentProject.characterAnnotations.filter((item) => item.id !== currentCharacter.id),
            ...splitAnnotations,
          ],
        },
        currentCharacter.lineId,
      );
      commitProject(splitProject);
      applySelection({ type: "character", id: splitAnnotations[0].id });
      return;
    }

    if (action === "merge-prev-line" || action === "merge-next-line") {
      const adjacentLine = action === "merge-prev-line"
        ? sortedLines[currentLineIndex - 1]
        : sortedLines[currentLineIndex + 1];
      if (!adjacentLine) {
        return;
      }
      const mergedProject = syncSubtitleLines(
        {
          ...currentProject,
          characterAnnotations: currentProject.characterAnnotations.map((item) =>
            item.id === id ? { ...item, lineId: adjacentLine.id } : item,
          ),
        },
        [currentCharacter.lineId, adjacentLine.id],
      );
      commitProject(mergedProject);
      return;
    }

    if (action === "set-line-start") {
      if (characterIndex === 0) {
        return;
      }
      const movedCharacters = new Set(lineCharacters.slice(0, characterIndex).map((item) => item.id));
      const newLineId = `line-${createRuntimeUuid()}`;
      const splitProject = syncSubtitleLines(
        {
          ...currentProject,
          subtitleLines: [
            ...currentProject.subtitleLines,
            {
              id: newLineId,
              text: "",
              startTime: lineCharacters[0].startTime,
              endTime: lineCharacters[characterIndex - 1].endTime,
              deliveryMode: currentProject.subtitleLines.find((line) => line.id === currentCharacter.lineId)?.deliveryMode ?? null,
              roleType: currentProject.subtitleLines.find((line) => line.id === currentCharacter.lineId)?.roleType ?? null,
            },
          ],
          characterAnnotations: currentProject.characterAnnotations.map((item) =>
            movedCharacters.has(item.id) ? { ...item, lineId: newLineId } : item,
          ),
        },
        [newLineId, currentCharacter.lineId],
      );
      commitProject(splitProject);
      return;
    }

    if (characterIndex === lineCharacters.length - 1) {
      return;
    }
    const movedCharacters = new Set(lineCharacters.slice(characterIndex + 1).map((item) => item.id));
    const newLineId = `line-${createRuntimeUuid()}`;
    const splitProject = syncSubtitleLines(
      {
        ...currentProject,
        subtitleLines: [
          ...currentProject.subtitleLines,
          {
            id: newLineId,
            text: "",
            startTime: lineCharacters[characterIndex + 1].startTime,
            endTime: lineCharacters[lineCharacters.length - 1].endTime,
            deliveryMode: currentProject.subtitleLines.find((line) => line.id === currentCharacter.lineId)?.deliveryMode ?? null,
            roleType: currentProject.subtitleLines.find((line) => line.id === currentCharacter.lineId)?.roleType ?? null,
          },
        ],
        characterAnnotations: currentProject.characterAnnotations.map((item) =>
          movedCharacters.has(item.id) ? { ...item, lineId: newLineId } : item,
        ),
      },
      [newLineId, currentCharacter.lineId],
    );
    commitProject(splitProject);
  }

  function getSelectedCharacterLineMergeContext(
    triggerCharacterId: string,
    currentProject: ProjectData = projectRef.current,
  ) {
    if (
      selectedTimelineItems.length < 2 ||
      !selectedTimelineItems.every((item) => item.type === "character") ||
      !selectedTimelineItems.some((item) => item.id === triggerCharacterId)
    ) {
      return null;
    }

    const selectedIds = new Set(selectedTimelineItems.map((item) => item.id));
    const sortedCharacters = sortCharactersByTime(currentProject.characterAnnotations);
    const selectedCharacters = sortedCharacters.filter((character) => selectedIds.has(character.id));
    if (selectedCharacters.length !== selectedIds.size || selectedCharacters.length < 2) {
      return null;
    }

    const firstCharacter = selectedCharacters[0];
    const lastCharacter = selectedCharacters[selectedCharacters.length - 1];
    const firstIndex = sortedCharacters.findIndex((character) => character.id === firstCharacter.id);
    const lastIndex = sortedCharacters.findIndex((character) => character.id === lastCharacter.id);
    if (firstIndex < 0 || lastIndex < firstIndex) {
      return null;
    }

    const rangeCharacters = sortedCharacters.slice(firstIndex, lastIndex + 1);
    const skippedCount = rangeCharacters.filter((character) => !selectedIds.has(character.id)).length;
    const adjacentAvailability = getMergedCharacterLineAdjacentAvailability(currentProject, rangeCharacters);
    return {
      selectedCharacters,
      rangeCharacters,
      firstCharacter,
      lastCharacter,
      skippedCount,
      canMergeIntoPrevious: adjacentAvailability.previous,
      canMergeIntoNext: adjacentAvailability.next,
    };
  }

  function mergeSelectedCharactersIntoLine(
    triggerCharacterId: string,
    mergeInto?: "previous" | "next",
  ) {
    const currentProject = projectRef.current;
    const mergeContext = getSelectedCharacterLineMergeContext(triggerCharacterId, currentProject);
    if (!mergeContext) {
      return;
    }

    if (mergeContext.skippedCount > 0 && mergeContext.selectedCharacters.length > 2) {
      const confirmed = window.confirm(
        [
          `当前选中了 ${mergeContext.selectedCharacters.length} 个字块，但首尾之间共有 ${mergeContext.rangeCharacters.length} 个字块，`,
          `中间跳过了 ${mergeContext.skippedCount} 个未选字块。`,
          "",
          `首字：${formatCharacterMergeEndpoint(mergeContext.firstCharacter)}`,
          `末字：${formatCharacterMergeEndpoint(mergeContext.lastCharacter)}`,
          "",
          "是否从首字合并到末字，并把中间未选字块也纳入新句？",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }
    }

    const newLineId = `line-${createRuntimeUuid()}`;
    const nextProject = buildProjectWithMergedCharacterLine(
      currentProject,
      mergeContext.rangeCharacters,
      newLineId,
    );
    const finalResult = mergeInto
      ? mergeCharacterLineIntoAdjacentLine(nextProject, newLineId, mergeInto)
      : { project: nextProject, lineId: newLineId };

    if (!finalResult) {
      return;
    }

    commitProject(finalResult.project);
    applySelection({ type: "line", id: finalResult.lineId });
    setLineFocusRequest({ lineId: finalResult.lineId, requestId: Date.now() });
  }

  function deleteSelected() {
    const currentProject = projectRef.current;
    const timelineSelection: TimelineSelectionItem[] = selectedTimelineItems.length > 0
      ? selectedTimelineItems
      : selectedItem?.type === "character" || selectedItem?.type === "action"
        ? [{ type: selectedItem.type, id: selectedItem.id }]
        : selectedItem?.type === "attached-point"
          ? [{
              type: "attached-point",
              id: selectedItem.id,
              trackId: selectedItem.trackId,
              parentTrackId: selectedItem.parentTrackId,
            }]
        : selectedItem?.type === "custom-block"
          ? [{ type: "custom-block", id: selectedItem.id, trackId: selectedItem.trackId }]
        : selectedItem?.type === "banyan-mark"
          ? [{ type: "banyan-mark", id: selectedItem.id }]
        : [];

    if (timelineSelection.length > 0) {
      if (timelineSelection.length > 10) {
        const confirmed = window.confirm(`当前将删除 ${timelineSelection.length} 个已选中的时间轴项目。是否继续？`);
        if (!confirmed) {
          return;
        }
      }

      const characterIds = new Set(
        timelineSelection
          .filter((item): item is TimelineSelectionItem & { type: "character" } => item.type === "character")
          .map((item) => item.id),
      );
      const actionIds = new Set(
        timelineSelection
          .filter((item): item is TimelineSelectionItem & { type: "action" } => item.type === "action")
          .map((item) => item.id),
      );
      const customBlockKeys = new Set(
        timelineSelection
          .filter(
            (item): item is Extract<TimelineSelectionItem, { type: "custom-block" }> =>
              item.type === "custom-block",
          )
          .map((item) => `${item.trackId}:${item.id}`),
      );
      const gongcheParentKeys = new Set([
        ...Array.from(characterIds).map((id) => getGongcheParentKey("character-track", id)),
        ...Array.from(customBlockKeys),
      ]);
      const attachedPointKeys = new Set(
        timelineSelection
          .filter(
            (item): item is Extract<TimelineSelectionItem, { type: "attached-point" }> =>
              item.type === "attached-point",
          )
          .map((item) => `${item.trackId}:${item.id}`),
      );
      const banyanMarkIds = new Set(
        timelineSelection
          .filter((item): item is TimelineSelectionItem & { type: "banyan-mark" } => item.type === "banyan-mark")
          .map((item) => item.id),
      );
      const affectedLineIds = new Set(
        currentProject.characterAnnotations
          .filter((item) => characterIds.has(item.id))
          .map((item) => item.lineId),
      );

      let nextProject = syncSubtitleLines(
        {
          ...currentProject,
          characterAnnotations: currentProject.characterAnnotations.filter((item) => !characterIds.has(item.id)),
          banyanMarks: currentProject.banyanMarks.filter((item) => !banyanMarkIds.has(item.id)),
          gongcheAnnotations: currentProject.gongcheAnnotations.filter((item) =>
            !gongcheParentKeys.has(getGongcheParentKey(item.parentTrackId, item.parentBlockId)),
          ),
          actionAnnotations: currentProject.actionAnnotations.filter((item) => !actionIds.has(item.id)),
          builtinTracks: currentProject.builtinTracks.map((track) => ({
            ...track,
            attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
              ...pointTrack,
              points: pointTrack.points.filter((point) => !attachedPointKeys.has(`${pointTrack.id}:${point.id}`)),
            })),
          })),
          customTracks: currentProject.customTracks.map((track) => ({
            ...track,
            attachedPointTracks: (track.attachedPointTracks ?? []).map((pointTrack) => ({
              ...pointTrack,
              points: pointTrack.points.filter((point) => !attachedPointKeys.has(`${pointTrack.id}:${point.id}`)),
            })),
            blocks: track.blocks.filter((block) => !customBlockKeys.has(`${track.id}:${block.id}`)) as CustomTrack["blocks"],
          })) as CustomTrack[],
        },
        Array.from(affectedLineIds),
      );
      const repairedBanyan = repairBanyanGongcheReferences(nextProject);
      nextProject = repairedBanyan.project;

      if (editingCharacterId && characterIds.has(editingCharacterId)) {
        cancelCharacterTextEdit();
      }
      if (
        editingCustomTextBlock &&
        customBlockKeys.has(`${editingCustomTextBlock.trackId}:${editingCustomTextBlock.id}`)
      ) {
        cancelCustomTextEdit();
      }
      const lifecycleTargets: AnnotationLifecycleTarget[] = [
        ...Array.from(characterIds, (entityId): AnnotationLifecycleTarget => ({
          entityType: "character",
          entityId,
        })),
        ...timelineSelection.flatMap((item) => item.type === "custom-block"
          ? [{ entityType: "custom-block" as const, trackId: item.trackId, entityId: item.id }]
          : []),
        ...timelineSelection.flatMap((item) => item.type === "attached-point"
          ? [{ entityType: "attached-point" as const, trackId: item.trackId, entityId: item.id }]
          : []),
        ...currentProject.gongcheAnnotations.flatMap((item): AnnotationLifecycleTarget[] =>
          gongcheParentKeys.has(getGongcheParentKey(item.parentTrackId, item.parentBlockId))
            ? [{ entityType: "gongche-block", entityId: item.id, trackId: item.parentTrackId }]
            : []),
        ...Array.from(banyanMarkIds, (entityId): AnnotationLifecycleTarget => ({
          entityType: "banyan-mark",
          entityId,
        })),
      ];
      const deletedLineIds = Array.from(affectedLineIds).filter((lineId) =>
        !nextProject.subtitleLines.some((line) => line.id === lineId));
      lifecycleTargets.push(...deletedLineIds.map((entityId): AnnotationLifecycleTarget => ({
        entityType: "sentence",
        entityId,
      })));
      const survivingLineIds = Array.from(affectedLineIds).filter((lineId) =>
        nextProject.subtitleLines.some((line) => line.id === lineId));
      // 混入未迁移 action/板眼时，事务完整差异门禁会拒绝局部事实并保留原 snapshot operation。
      commitProjectWithTransaction(currentProject, nextProject, {
        contentTargets: survivingLineIds.map((entityId) => ({
          entityType: "sentence" as const,
          entityId,
          field: "text" as const,
        })),
        timingTargets: survivingLineIds.map((entityId) => ({ entityType: "sentence" as const, entityId })),
        stateTargets: repairedBanyan.changedMarkIds.map((entityId) => ({
          entityType: "banyan-mark" as const,
          entityId,
        })),
        lifecycleTargets,
      });
      applySelection(null);
      return;
    }

    if (!selectedItem) {
      return;
    }
    if (selectedItem.type === "character") {
      const currentCharacter = currentProject.characterAnnotations.find((item) => item.id === selectedItem.id);
      if (!currentCharacter) {
        return;
      }
      let nextProject = syncSubtitleLine({
        ...currentProject,
        characterAnnotations: currentProject.characterAnnotations.filter((item) => item.id !== selectedItem.id),
        gongcheAnnotations: currentProject.gongcheAnnotations.filter((item) =>
          item.parentTrackId !== "character-track" || item.parentBlockId !== selectedItem.id,
        ),
      }, currentCharacter.lineId);
      const removedGongche = currentProject.gongcheAnnotations.filter((item) =>
        item.parentTrackId === "character-track" && item.parentBlockId === selectedItem.id);
      const repairedBanyan = repairBanyanGongcheReferences(nextProject);
      nextProject = repairedBanyan.project;
      const lineStillExists = nextProject.subtitleLines.some((line) => line.id === currentCharacter.lineId);
      commitProjectWithTransaction(currentProject, nextProject, {
        contentTargets: lineStillExists
          ? [{ entityType: "sentence", entityId: currentCharacter.lineId, field: "text" }]
          : [],
        timingTargets: lineStillExists
          ? [{ entityType: "sentence", entityId: currentCharacter.lineId }]
          : [],
        stateTargets: repairedBanyan.changedMarkIds.map((entityId) => ({
          entityType: "banyan-mark" as const,
          entityId,
        })),
        lifecycleTargets: [
          { entityType: "character", entityId: selectedItem.id },
          ...(lineStillExists ? [] : [{ entityType: "sentence" as const, entityId: currentCharacter.lineId }]),
          ...removedGongche.map((item): AnnotationLifecycleTarget => ({
            entityType: "gongche-block",
            entityId: item.id,
            trackId: item.parentTrackId,
          })),
        ],
      });
      if (editingCharacterId === selectedItem.id) {
        cancelCharacterTextEdit();
      }
      applySelection(null);
    }
    if (selectedItem.type === "action") {
      const action = currentProject.actionAnnotations.find((item) => item.id === selectedItem.id);
      if (!action) return;
      const buildNextProject = (baseProject: ProjectData): ProjectData => ({
        ...baseProject,
        actionAnnotations: baseProject.actionAnnotations.filter((item) => item.id !== selectedItem.id),
      });
      void runTrackStructureMutation(
        buildNextProject,
        (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
          lifecycleTargets: [{ entityType: "action", entityId: selectedItem.id, trackId: action.trackId }],
        }),
      ).then((committed) => {
        if (committed) applySelection(null);
      });
    }
    if (selectedItem.type === "custom-block") {
      const buildRawNextProject = (baseProject: ProjectData): ProjectData => ({
        ...baseProject,
        gongcheAnnotations: baseProject.gongcheAnnotations.filter((item) =>
          item.parentTrackId !== selectedItem.trackId || item.parentBlockId !== selectedItem.id,
        ),
        customTracks: baseProject.customTracks.map((track) =>
          track.id === selectedItem.trackId
            ? {
                ...track,
                blocks: track.blocks.filter((block) => block.id !== selectedItem.id) as CustomTrack["blocks"],
              }
            : track,
        ) as CustomTrack[],
      });
      const buildNextProject = (baseProject: ProjectData) =>
        repairBanyanGongcheReferences(buildRawNextProject(baseProject)).project;
      // 自定义块删除也必须和工尺级联、板眼引用修复一起进入结构事务；不能按“有没有级联”切回两套保存协议。
      void runTrackStructureMutation(
        buildNextProject,
        (baseProject, latestNextProject) => {
          const removedGongche = baseProject.gongcheAnnotations.filter((item) =>
            item.parentTrackId === selectedItem.trackId && item.parentBlockId === selectedItem.id);
          const repairedBanyan = repairBanyanGongcheReferences(buildRawNextProject(baseProject));
          return buildProjectTrackStructureTransactionCommand(
            baseProject,
            latestNextProject,
            {
              stateTargets: repairedBanyan.changedMarkIds.map((entityId) => ({
              entityType: "banyan-mark" as const,
              entityId,
              })),
              lifecycleTargets: [
                { entityType: "custom-block", entityId: selectedItem.id, trackId: selectedItem.trackId },
                ...removedGongche.map((item): AnnotationLifecycleTarget => ({
                  entityType: "gongche-block",
                  entityId: item.id,
                  trackId: item.parentTrackId,
                })),
              ],
            },
          );
        },
      ).then((committed) => {
        if (!committed) return;
        if (
          editingCustomTextBlock?.trackId === selectedItem.trackId &&
          editingCustomTextBlock.id === selectedItem.id
        ) {
          cancelCustomTextEdit();
        }
        applySelection(null);
      });
    }
    if (selectedItem.type === "gongche-block") {
      const currentBlock = currentProject.gongcheAnnotations.find((item) => item.id === selectedItem.id);
      if (!currentBlock) return;
      let nextProject = {
        ...currentProject,
        gongcheAnnotations: currentProject.gongcheAnnotations.filter((item) => item.id !== selectedItem.id),
      };
      const repairedBanyan = repairBanyanGongcheReferences(nextProject);
      nextProject = repairedBanyan.project;
      commitProjectWithTransaction(currentProject, nextProject, {
        stateTargets: repairedBanyan.changedMarkIds.map((entityId) => ({
          entityType: "banyan-mark" as const,
          entityId,
        })),
        lifecycleTargets: [{
          entityType: "gongche-block",
          entityId: selectedItem.id,
          trackId: currentBlock.parentTrackId,
        }],
      });
      applySelection(null);
    }
    if (selectedItem.type === "attached-point") {
      const location = findPointTrackLocation(currentProject, selectedItem.trackId);
      if (!location) {
        return;
      }
      const buildNextProject = (baseProject: ProjectData) => buildProjectWithUpdatedAttachedPointTrack(
        baseProject,
        selectedItem.trackId,
        (pointTrack) => ({
        ...pointTrack,
        points: pointTrack.points.filter((point) => point.id !== selectedItem.id),
        }),
      ) ?? baseProject;
      void runTrackStructureMutation(
        buildNextProject,
        (baseProject, latestNextProject) => buildProjectTrackStructureTransactionCommand(
          baseProject,
          latestNextProject,
          {
            lifecycleTargets: [{
              entityType: "attached-point",
              entityId: selectedItem.id,
              trackId: selectedItem.trackId,
            }],
          },
        ),
      ).then((committed) => {
        if (committed) applySelection(null);
      });
    }
    if (selectedItem.type === "banyan-mark") {
      const nextProject = {
        ...currentProject,
        banyanMarks: currentProject.banyanMarks.filter((item) => item.id !== selectedItem.id),
      };
      commitProjectWithLifecycle(currentProject, nextProject, [{
        entityType: "banyan-mark",
        entityId: selectedItem.id,
      }]);
      applySelection({ type: "banyan-track" });
    }
    if (selectedItem.type === "attached-point-track") {
      deleteAttachedPointTrack(selectedItem.id);
    }
    if (selectedItem.type === "builtin-track") {
      deleteBuiltinTrack(selectedItem.id);
    }
    if (selectedItem.type === "custom-track") {
      deleteCustomTrack(selectedItem.id);
    }
  }

  function selectAllTimelineItems() {
    const currentProject = projectRef.current;
    const items: TimelineSelectionItem[] = [
      ...currentProject.characterAnnotations.map((item) => ({ type: "character" as const, id: item.id })),
      ...currentProject.actionAnnotations.map((item) => ({ type: "action" as const, id: item.id })),
      ...currentProject.builtinTracks.flatMap((track) =>
        (track.attachedPointTracks ?? []).flatMap((pointTrack) =>
          pointTrack.points.map((point) => ({
            type: "attached-point" as const,
            id: point.id,
            trackId: pointTrack.id,
            parentTrackId: track.id,
          })),
        ),
      ),
      ...currentProject.customTracks.flatMap((track) =>
        (track.attachedPointTracks ?? []).flatMap((pointTrack) =>
          pointTrack.points.map((point) => ({
            type: "attached-point" as const,
            id: point.id,
            trackId: pointTrack.id,
            parentTrackId: track.id,
          })),
        ),
      ),
      ...currentProject.banyanMarks.map((item) => ({ type: "banyan-mark" as const, id: item.id })),
      ...flattenCustomTrackBlocks(currentProject.customTracks).map((item) => ({
        type: "custom-block" as const,
        id: item.id,
        trackId: item.trackId,
      })),
    ];
    applySelection(items[0] ?? null, items);
  }

  // 时间轴框选创建动作沿用同一结构事务入口，避免拖拽路径重新落回 legacy project.commit。
  function createAction(trackId: string, startTime: number, endTime: number) {
    createActionAtTime(trackId, startTime, endTime);
  }

  function renameCustomTrack(trackId: string, name: string) {
    const normalizedName = name.trimStart();
    void updateCustomTrackStructure(trackId, (track) => ({
      ...track,
      name: normalizedName.length > 0 ? normalizedName : track.name,
    }) as CustomTrack);
  }

  function updateCustomTrackColor(trackId: string, color: string) {
    const normalizedColor = normalizeHexColor(color);
    if (!normalizedColor) {
      return;
    }
    void updateCustomTrackStructure(trackId, (track) => ({
      ...track,
      color: normalizedColor,
    }) as CustomTrack);
  }

  function renameBuiltinTrack(trackId: BuiltinTrackId, name: string) {
    const normalizedName = name.trimStart();
    void updateBuiltinTrackStructure(trackId, (track) => ({
      ...track,
      name: normalizedName.length > 0 ? normalizedName : track.name,
    }));
  }

  function renameAttachedPointTrack(pointTrackId: string, name: string) {
    const normalizedName = name.trimStart();
    void updateAttachedPointTrackStructure(pointTrackId, (pointTrack) => ({
      ...pointTrack,
      name: normalizedName.length > 0 ? normalizedName : pointTrack.name,
    }));
  }

  function setCustomTrackBranchingEnabled(trackId: string, enabled: boolean) {
    void updateCustomTrackStructure(trackId, (track) => ({
      ...track,
      branching: {
        ...(track.branching ?? createDefaultTrackBranching()),
        enabled,
      },
    }) as CustomTrack);
  }

  function setCustomTrackBranchDisplayMode(trackId: string, displayMode: TrackBranchDisplayMode) {
    void updateCustomTrackStructure(trackId, (track) => ({
      ...track,
      branching: {
        ...(track.branching ?? createDefaultTrackBranching()),
        displayMode,
        enabled: true,
      },
    }) as CustomTrack);
  }

  function addCustomTrackBranchLane(trackId: string, parentLaneId: string | null) {
    const track = projectRef.current.customTracks.find((item) => item.id === trackId);
    if (!track) {
      return;
    }
    const currentBranching = track.branching ?? createDefaultTrackBranching();
    const fallbackName = getNextBranchLaneName(currentBranching.lanes, parentLaneId);
    const rawName = window.prompt("请输入分叉名称", fallbackName);
    const name = rawName?.trim();
    if (!name) {
      return;
    }
    const laneColor = getBranchLaneColor(resolveCustomTrackColor(track), currentBranching.lanes, parentLaneId);
    const nextLane = createBranchLane(name, parentLaneId, laneColor);
    void updateCustomTrackStructure(trackId, (currentTrack) => {
      const branching = currentTrack.branching ?? createDefaultTrackBranching();
      return {
        ...currentTrack,
        branching: {
          ...branching,
          enabled: true,
          lanes: addBranchLane(branching.lanes, parentLaneId, nextLane),
        },
      } as CustomTrack;
    });
  }

  function updateCustomTrackBranchLaneColor(trackId: string, laneId: string, color: string) {
    const normalizedColor = normalizeHexColor(color);
    if (!normalizedColor) {
      return;
    }
    void updateCustomTrackStructure(trackId, (track) => {
      if (!track.branching) {
        return track;
      }
      return {
        ...track,
        branching: {
          ...track.branching,
          lanes: recolorBranchLane(track.branching.lanes, laneId, normalizedColor),
        },
      } as CustomTrack;
    });
  }

  function renameCustomTrackBranchLane(trackId: string, laneId: string, name: string) {
    const normalizedName = name.trimStart();
    void updateCustomTrackStructure(trackId, (track) => {
      if (!track.branching || normalizedName.length === 0) {
        return track;
      }
      return {
        ...track,
        branching: {
          ...track.branching,
          lanes: renameBranchLane(track.branching.lanes, laneId, normalizedName),
        },
      } as CustomTrack;
    });
  }

  function deleteCustomTrackBranchLane(trackId: string, laneId: string) {
    void updateCustomTrackStructure(trackId, (track) => {
      if (!track.branching) {
        return track;
      }
      const laneIdsBefore = new Set(getBranchLaneIds(track.branching.lanes));
      const nextLanes = removeBranchLane(track.branching.lanes, laneId);
      const laneIdsAfter = new Set(getBranchLaneIds(nextLanes));
      const removedLaneIds = new Set(Array.from(laneIdsBefore).filter((id) => !laneIdsAfter.has(id)));
      // 删除分叉只移除结构，不销毁标注内容；失去所有分叉归属的块回到根轨。
      const blocks = track.blocks.map((block) => {
        if (!block.branchScope || block.branchScope.mode !== "lanes") {
          return block;
        }
        const laneIds = block.branchScope.laneIds.filter((id) => !removedLaneIds.has(id));
        return {
          ...block,
          branchScope: laneIds.length > 0 ? { mode: "lanes" as const, laneIds } : { mode: "root" as const },
        };
      }) as CustomTrack["blocks"];
      return {
        ...track,
        branching: {
          ...track.branching,
          lanes: nextLanes,
        },
        blocks,
      } as CustomTrack;
    });
  }

  function updateTrackWaveformSnap(trackId: string, enabled: boolean) {
    const builtinTrack = projectRef.current.builtinTracks.find((track) => track.id === trackId);
    if (builtinTrack) {
      void updateBuiltinTrackStructure(trackId as BuiltinTrackId, (track) => ({
        ...track,
        snapToWaveformKeypoints: enabled,
      }));
      return;
    }

    const customTrack = projectRef.current.customTracks.find((track) => track.id === trackId);
    if (customTrack) {
      void updateCustomTrackStructure(trackId, (track) => ({
        ...track,
        snapToWaveformKeypoints: enabled,
      }) as CustomTrack);
      return;
    }

    void updateAttachedPointTrackStructure(trackId, (pointTrack) => ({
      ...pointTrack,
      snapToWaveformKeypoints: enabled,
    }));
  }

  function updateTrackAutoLoopRange(trackId: string, enabled: boolean) {
    const builtinTrack = projectRef.current.builtinTracks.find((track) => track.id === trackId);
    if (builtinTrack) {
      void updateBuiltinTrackStructure(trackId as BuiltinTrackId, (track) => ({
        ...track,
        autoSetLoopRangeOnSelect: enabled,
      }));
      return;
    }

    const customTrack = projectRef.current.customTracks.find((track) => track.id === trackId);
    if (customTrack) {
      void updateCustomTrackStructure(trackId, (track) => ({
        ...track,
        autoSetLoopRangeOnSelect: enabled,
      }) as CustomTrack);
      return;
    }

    void updateAttachedPointTrackStructure(trackId, (pointTrack) => ({
      ...pointTrack,
      autoSetLoopRangeOnSelect: enabled,
    }));
  }

  function updateAttachedPointTrackParentSnap(pointTrackId: string, enabled: boolean) {
    void updateAttachedPointTrackStructure(pointTrackId, (pointTrack) => ({
      ...pointTrack,
      snapToParentBoundaries: enabled,
    }));
  }

  function moveCustomTrack(trackId: string, direction: "up" | "down") {
    moveTrack(trackId, direction);
  }

  function moveBuiltinTrack(trackId: BuiltinTrackId, direction: "up" | "down") {
    moveTrack(trackId, direction);
  }

  function reorderCustomTrack(trackId: string, insertionIndex: number) {
    reorderTrack(trackId, insertionIndex);
  }

  function reorderBuiltinTrack(trackId: BuiltinTrackId, insertionIndex: number) {
    reorderTrack(trackId, insertionIndex);
  }

  function updateCustomTrackTypeOption(trackId: string, index: number, value: string) {
    const normalizedValue = value.trimStart();
    const buildNextProject = (baseProject: ProjectData): ProjectData => ({
      ...baseProject,
      customTracks: baseProject.customTracks.map((track) => {
        const previousValue = track.id === trackId ? track.typeOptions[index] : undefined;
        if (track.id !== trackId || previousValue === undefined) return track;
        const nextValue = normalizedValue.length > 0 ? normalizedValue : previousValue;
        return {
          ...track,
          typeOptions: track.typeOptions.map((option, optionIndex) =>
            optionIndex === index ? nextValue : option),
          blocks: track.blocks.map((block) =>
            block.type === previousValue ? { ...block, type: nextValue } : block,
          ) as CustomTrack["blocks"],
        } as CustomTrack;
      }) as CustomTrack[],
    });
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => {
        const baseTrack = baseProject.customTracks.find((track) => track.id === trackId);
        const nextTrack = nextProject.customTracks.find((track) => track.id === trackId);
        if (!baseTrack || !nextTrack) return null;
        return buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
          customTrackStructureIds: [trackId],
          contentTargets: baseTrack.blocks.flatMap((block) =>
            nextTrack.blocks.find((candidate) => candidate.id === block.id)?.type !== block.type
              ? [{ entityType: "custom-block" as const, entityId: block.id, trackId, field: "type" as const }]
              : []),
        });
      },
    );
  }

  function updateAttachedPointTrackTypeOption(pointTrackId: string, index: number, value: string) {
    const location = findPointTrackLocation(projectRef.current, pointTrackId);
    if (!location || index < 0 || index >= location.pointTrack.typeOptions.length) {
      return;
    }
    const normalizedValue = value.trimStart();
    const nextValue = normalizedValue.length > 0 ? normalizedValue : location.pointTrack.typeOptions[index];
    void updateAttachedPointTrackStructure(pointTrackId, (pointTrack) => ({
        // updater 在持锁后的最新点轨上读取旧类型，避免 acquire 等待期间闭包值过期。
        ...pointTrack,
        typeOptions: pointTrack.typeOptions.map((option, optionIndex) =>
          optionIndex === index ? nextValue : option),
        points: pointTrack.points.map((point) =>
          point.label === pointTrack.typeOptions[index] ? { ...point, label: nextValue } : point),
      }));
  }

  function addCustomTrackTypeOption(trackId: string) {
    void updateCustomTrackStructure(trackId, (track) => ({
      ...track,
      typeOptions: [...track.typeOptions, getNextCustomTrackTypeOptionName(track.typeOptions)],
    }) as CustomTrack);
  }

  function addAttachedPointTrackTypeOption(pointTrackId: string) {
    void updateAttachedPointTrackStructure(pointTrackId, (pointTrack) => ({
      ...pointTrack,
      typeOptions: [...pointTrack.typeOptions, getNextCustomTrackTypeOptionName(pointTrack.typeOptions)],
    }));
  }

  function moveCustomTrackTypeOption(trackId: string, index: number, direction: "up" | "down") {
    void updateCustomTrackStructure(trackId, (track) => {
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= track.typeOptions.length) {
        return track;
      }
      const nextTypeOptions = [...track.typeOptions];
      const [movedOption] = nextTypeOptions.splice(index, 1);
      nextTypeOptions.splice(targetIndex, 0, movedOption);
      return {
        ...track,
        typeOptions: nextTypeOptions,
      } as CustomTrack;
    });
  }

  function moveAttachedPointTrackTypeOption(pointTrackId: string, index: number, direction: "up" | "down") {
    void updateAttachedPointTrackStructure(pointTrackId, (pointTrack) => {
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= pointTrack.typeOptions.length) {
        return pointTrack;
      }
      const nextTypeOptions = [...pointTrack.typeOptions];
      const [movedOption] = nextTypeOptions.splice(index, 1);
      nextTypeOptions.splice(targetIndex, 0, movedOption);
      return {
        ...pointTrack,
        typeOptions: nextTypeOptions,
      };
    });
  }

  function reorderCustomTrackTypeOption(trackId: string, fromIndex: number, insertionIndex: number) {
    void updateCustomTrackStructure(trackId, (track) => {
      if (
        fromIndex < 0 ||
        fromIndex >= track.typeOptions.length ||
        insertionIndex < 0 ||
        insertionIndex > track.typeOptions.length - 1
      ) {
        return track;
      }
      const nextTypeOptions = [...track.typeOptions];
      const [movedOption] = nextTypeOptions.splice(fromIndex, 1);
      const normalizedInsertionIndex = Math.max(0, Math.min(insertionIndex, nextTypeOptions.length));
      if (normalizedInsertionIndex === fromIndex) {
        return track;
      }
      nextTypeOptions.splice(normalizedInsertionIndex, 0, movedOption);
      return {
        ...track,
        typeOptions: nextTypeOptions,
      } as CustomTrack;
    });
  }

  function reorderAttachedPointTrackTypeOption(pointTrackId: string, fromIndex: number, insertionIndex: number) {
    void updateAttachedPointTrackStructure(pointTrackId, (pointTrack) => {
      if (
        fromIndex < 0 ||
        fromIndex >= pointTrack.typeOptions.length ||
        insertionIndex < 0 ||
        insertionIndex > pointTrack.typeOptions.length - 1
      ) {
        return pointTrack;
      }
      const nextTypeOptions = [...pointTrack.typeOptions];
      const [movedOption] = nextTypeOptions.splice(fromIndex, 1);
      const normalizedInsertionIndex = Math.max(0, Math.min(insertionIndex, nextTypeOptions.length));
      if (normalizedInsertionIndex === fromIndex) {
        return pointTrack;
      }
      nextTypeOptions.splice(normalizedInsertionIndex, 0, movedOption);
      return {
        ...pointTrack,
        typeOptions: nextTypeOptions,
      };
    });
  }

  function removeCustomTrackTypeOption(trackId: string, index: number) {
    const buildNextProject = (baseProject: ProjectData): ProjectData => ({
      ...baseProject,
      customTracks: baseProject.customTracks.map((track) => {
        if (track.id !== trackId || track.typeOptions.length <= 1 ||
          index < 0 || index >= track.typeOptions.length) return track;
        const removedValue = track.typeOptions[index];
        const nextTypeOptions = track.typeOptions.filter((_, optionIndex) => optionIndex !== index);
        const fallbackType = nextTypeOptions[0] ?? "类型 1";
        return {
          ...track,
          typeOptions: nextTypeOptions,
          blocks: track.blocks.map((block) =>
            block.type === removedValue ? { ...block, type: fallbackType } : block,
          ) as CustomTrack["blocks"],
        } as CustomTrack;
      }) as CustomTrack[],
    });
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => {
        const baseTrack = baseProject.customTracks.find((track) => track.id === trackId);
        const nextTrack = nextProject.customTracks.find((track) => track.id === trackId);
        if (!baseTrack || !nextTrack) return null;
        return buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
          customTrackStructureIds: [trackId],
          contentTargets: baseTrack.blocks.flatMap((block) =>
            nextTrack.blocks.find((candidate) => candidate.id === block.id)?.type !== block.type
              ? [{ entityType: "custom-block" as const, entityId: block.id, trackId, field: "type" as const }]
              : []),
        });
      },
    );
  }

  function removeAttachedPointTrackTypeOption(pointTrackId: string, index: number) {
    const location = findPointTrackLocation(projectRef.current, pointTrackId);
    if (!location) {
      return;
    }
    const options = location.pointTrack.typeOptions;
    if (options.length <= 1 || index < 0 || index >= options.length) {
      return;
    }
    void updateAttachedPointTrackStructure(pointTrackId, (pointTrack) => {
      const removedValue = pointTrack.typeOptions[index];
      if (removedValue === undefined || pointTrack.typeOptions.length <= 1) return pointTrack;
      const nextTypeOptions = pointTrack.typeOptions.filter((_, optionIndex) => optionIndex !== index);
      const fallbackOption = nextTypeOptions[0] ?? "标记 1";
      return {
        ...pointTrack,
        typeOptions: nextTypeOptions,
        points: pointTrack.points.map((point) =>
          point.label === removedValue ? { ...point, label: fallbackOption } : point),
      };
    });
  }

  function deleteCustomTrack(trackId: string) {
    const currentProject = projectRef.current;
    const track = currentProject.customTracks.find((item) => item.id === trackId);
    if (!track) {
      return;
    }
    const blockCount = track.blocks.length;
    const pointCount = (track.attachedPointTracks ?? []).reduce((sum, pointTrack) => sum + pointTrack.points.length, 0);
    const gongcheCount = currentProject.gongcheAnnotations.filter((item) => item.parentTrackId === trackId).length;
    const confirmed = window.confirm(
      `确定要删除轨道“${track.name}”吗？` +
        `\n删除轨道会同时删除轨道上的全部标注` +
        (blockCount + pointCount + gongcheCount > 0 ? `（当前共 ${blockCount + pointCount + gongcheCount} 条）` : "") +
        `，此操作会进入撤销历史。`,
    );
    if (!confirmed) {
      return;
    }
    const buildNextProject = (baseProject: ProjectData): ProjectData => {
      const projectWithoutTrack = {
        ...baseProject,
        activeTrackOrder: baseProject.activeTrackOrder.filter((id) => id !== trackId),
        customTracks: baseProject.customTracks.filter((item) => item.id !== trackId) as CustomTrack[],
        gongcheAnnotations: baseProject.gongcheAnnotations.filter((item) => item.parentTrackId !== trackId),
      };
      // 删除拥有者后，板眼记录保留但必须先断开指向已删除工尺的强引用。
      return repairBanyanGongcheReferences(projectWithoutTrack).project;
    };
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        customTrackLifecycleTargets: [{ trackId }],
        lifecycleTargets: baseProject.gongcheAnnotations
          .filter((item) => item.parentTrackId === trackId)
          .map((item) => ({ entityType: "gongche-block" as const, entityId: item.id, trackId })),
        stateTargets: baseProject.banyanMarks.flatMap((mark) => {
          const nextMark = nextProject.banyanMarks.find((candidate) => candidate.id === mark.id);
          return nextMark && !areProjectValuesEqual(mark, nextMark)
            ? [{ entityType: "banyan-mark" as const, entityId: mark.id }]
            : [];
        }),
      }),
    ).then((committed) => {
      if (!committed) return;
      if (editingCustomTextBlock?.trackId === trackId) cancelCustomTextEdit();
      if (
        (selectedItem?.type === "custom-track" && selectedItem.id === trackId) ||
        (selectedItem?.type === "custom-block" && selectedItem.trackId === trackId) ||
        (selectedItem?.type === "gongche-track" && selectedItem.parentTrackId === trackId) ||
        (selectedItem?.type === "gongche-block" &&
          currentProject.gongcheAnnotations.some((item) => item.id === selectedItem.id && item.parentTrackId === trackId)) ||
        (selectedItem?.type === "attached-point-track" && selectedItem.parentTrackId === trackId) ||
        (selectedItem?.type === "attached-point" && selectedItem.parentTrackId === trackId)
      ) applySelection(null);
    });
  }

  function deleteAttachedPointTrack(pointTrackId: string) {
    const currentProject = projectRef.current;
    const location = findPointTrackLocation(currentProject, pointTrackId);
    if (!location) {
      return;
    }
    const pointCount = location.pointTrack.points.length;
    const confirmed = window.confirm(
      `确定要删除附属打点轨“${location.pointTrack.name}”吗？` +
        `\n删除后会同时删除轨道上的全部打点` +
        (pointCount > 0 ? `（当前共 ${pointCount} 个）` : "") +
        `。`,
    );
    if (!confirmed) {
      return;
    }
    const parentTrackId = location.parentTrack.id;
    const parentTrackType = location.parentType;
    const buildNextProject = (baseProject: ProjectData): ProjectData => ({
      ...baseProject,
      builtinTracks: parentTrackType === "builtin"
        ? baseProject.builtinTracks.map((track) => track.id === parentTrackId
          ? { ...track, attachedPointTracks: track.attachedPointTracks.filter((item) => item.id !== pointTrackId) }
          : track)
        : baseProject.builtinTracks,
      customTracks: parentTrackType === "custom"
        ? baseProject.customTracks.map((track) => track.id === parentTrackId
          ? ({
              ...track,
              attachedPointTracks: track.attachedPointTracks.filter((item) => item.id !== pointTrackId),
            } as CustomTrack)
          : track) as CustomTrack[]
        : baseProject.customTracks,
    });
    void runTrackStructureMutation(
      buildNextProject,
      (baseProject, nextProject) => buildProjectTrackStructureTransactionCommand(baseProject, nextProject, {
        attachedPointTrackLifecycleTargets: [{ pointTrackId, parentTrackId, parentTrackType }],
      }),
    ).then((committed) => {
      if (committed && (
        (selectedItem?.type === "attached-point-track" && selectedItem.id === pointTrackId) ||
        (selectedItem?.type === "attached-point" && selectedItem.trackId === pointTrackId)
      )) applySelection(null);
    });
  }

  function undo() {
    const previousEntry = undoStack[undoStack.length - 1];
    if (!previousEntry) return;
    if (requiresUndoConfirmation(previousEntry.action) &&
      !window.confirm(getUndoConfirmationMessage(previousEntry.action))) return;
    const purpose = getAnnotationMutationLeasePurposeForCommand(previousEntry.commandEnvelope);
    if (purpose) {
      void runHistoryMutationWithLease(purpose, () => undoProject(() => true));
      return;
    }
    undoProject(() => true);
  }

  function redo() {
    const nextEntry = redoStack[redoStack.length - 1];
    const purpose = getAnnotationMutationLeasePurposeForCommand(nextEntry?.commandEnvelope);
    if (purpose) {
      void runHistoryMutationWithLease(purpose, redoProject);
      return;
    }
    redoProject();
  }

  async function runHistoryMutationWithLease(
    purpose: AnnotationMutationPurpose,
    mutation: () => boolean,
  ) {
    if (exclusiveMutationInFlightRef.current) return;
    exclusiveMutationInFlightRef.current = true;
    try {
      await waitForActiveServerSave();
      const hadLease = Boolean(mutationLease.getToken());
      if (editorSession) {
        await mutationLease.acquire(purpose);
      }
      const changed = mutation();
      if (!changed && editorSession && !hadLease) {
        await mutationLease.release().catch(() => undefined);
      }
    } catch (error) {
      window.alert(formatMutationLeaseError(error));
    } finally {
      exclusiveMutationInFlightRef.current = false;
    }
  }

  async function importSrtFile(file: File) {
    const text = await file.text();
    const lines = parseSrt(text);
    const committed = await runControlledSnapshotMutation(
      "import_srt",
      (baseProject) => buildProjectFromLines(lines, baseProject.video),
    );
    if (!committed) return;
    applySelection(lines[0] ? { type: "line", id: lines[0].id } : null);
    if (lines[0]) {
      seekTo(lines[0].startTime);
    }
  }

  async function handleVideoImport(file: File) {
    const playbackUrl = URL.createObjectURL(file);
    videoRef.current?.pause();
    setPreviewTime(null);
    setIsPlaying(false);
    setCurrentTime(0);
    commitProject({
      ...projectRef.current,
      video: {
        url: playbackUrl,
        name: file.name,
        source: "embedded",
        filePath: null,
        requiresManualImport: false,
      },
    }, undefined, { action: "import-video" });
  }

  async function importProjectFile(file: File) {
    try {
      if (hasUnsavedChanges) {
        const confirmed = window.confirm("当前项目还有未保存修改。确定要导入新项目并覆盖当前内容吗？");
        if (!confirmed) {
          return;
        }
      }
      const text = await file.text();
      const parsed = JSON.parse(text) as SavedProjectFile | ProjectData;
      const normalized = normalizeImportedProjectFile(parsed);
      const hydratedProject = normalized.project;
      const shouldManuallyImportVideo = shouldPromptForManualVideoImport(hydratedProject.video);
      const normalizedTrackSnapEnabled = normalizeTrackSnapEnabledForProject(
        hydratedProject,
        normalized.uiState?.trackSnapEnabled,
      );
      const committed = areProjectValuesEqual(projectRef.current, hydratedProject)
        ? true
        : await runControlledSnapshotMutation("import_project", () => hydratedProject);
      if (!committed) return;
      applyTrackSnapEnabledState(normalizedTrackSnapEnabled);
      setZoom(normalized.uiState?.zoom ?? 20);
      setPlaybackRate(normalized.uiState?.playbackRate ?? 1);
      setLoopPlaybackEnabled(Boolean(normalized.uiState?.loopPlaybackEnabled));
      setLoopPlaybackRange(normalized.uiState?.loopPlaybackRange ?? null);
      setPreviewTime(null);
      setLineFocusRequest(null);
      setBlockContextMenu(null);
      cancelCharacterTextEdit();
      cancelCustomTextEdit();
      applySelection(
        hydratedProject.subtitleLines[0] ? { type: "line", id: hydratedProject.subtitleLines[0].id } : null,
        undefined,
        { syncLoopPlaybackRange: false },
      );
      seekTo(
        clampTime(
          normalized.uiState?.currentTime ?? hydratedProject.subtitleLines[0]?.startTime ?? 0,
          getProjectDuration(hydratedProject),
        ),
      );
      // 本地打开 JSON 可视为新的干净工作副本；平台文件必须等待真正的服务器保存后才能变为 clean。
      if (!editorSession) markProjectAsSaved(hydratedProject, normalizedTrackSnapEnabled);
      setCurrentProjectFileName(getNormalizedProjectFileName(file.name));
      if (shouldManuallyImportVideo) {
        setManualVideoRelinkPrompt(hydratedProject.video);
      } else {
        setManualVideoRelinkPrompt(null);
      }
    } catch {
      window.alert("导入项目失败。请选择由本工具导出的项目 JSON，或检查文件内容是否完整。");
    }
  }

  function repairSentenceCharacterTrack() {
    const currentProject = projectRef.current;
    const report = analyzeSentenceCharacterAlignment(currentProject);
    const conflictCount =
      report.textMismatchLines.length +
      report.timeOutOfRangeCharacters.length +
      report.orphanCharacters.length +
      report.overlappingCharacters.length;
    const summary = formatSentenceCharacterAlignmentSummary(report);

    if (report.missingLineCharacters.length === 0) {
      window.alert([
        "句级文字轨和逐字文字轨检查完成。",
        "",
        ...summary,
        conflictCount > 0
          ? "当前存在需要人工检查的冲突，本功能不会自动覆盖已有逐字块。"
          : "没有发现需要自动补齐的句级字幕。",
      ].join("\n"));
      return;
    }

    const repairPreviewLines = report.missingLineCharacters
      .slice(0, 5)
      .map(({ line }) => `- ${line.id} ${formatSecondsToSrtTime(line.startTime)}-${formatSecondsToSrtTime(line.endTime)} “${line.text}”`);
    const confirmed = window.confirm([
      "句级文字轨和逐字文字轨检查完成。",
      "",
      ...summary,
      "",
      `将为 ${report.missingLineCharacters.length} 条没有逐字块的句级字幕创建“整句文字块”。`,
      "已有逐字块不会被拆分、覆盖或删除。",
      conflictCount > 0
        ? "注意：当前还存在冲突项，本次只补齐缺失句，冲突项需要之后人工检查。"
        : "",
      "",
      "示例：",
      ...repairPreviewLines,
      report.missingLineCharacters.length > repairPreviewLines.length ? "- ..." : "",
      "",
      "是否继续？",
    ].filter(Boolean).join("\n"));

    if (!confirmed) {
      return;
    }

    const repairResult = createSentenceCharacterRepairs(currentProject, report);
    if (repairResult.createdCharacters.length === 0) {
      window.alert("没有可创建的整句文字块。请检查句级字幕是否为空。");
      return;
    }

    let committedRepairResult = repairResult;
    void runControlledSnapshotMutation(
      "repair_sentence_character_track",
      (baseProject) => {
        committedRepairResult = createSentenceCharacterRepairs(
          baseProject,
          analyzeSentenceCharacterAlignment(baseProject),
        );
        return committedRepairResult.project;
      },
    ).then((committed) => {
      if (!committed) return;
      const firstCreatedCharacter = committedRepairResult.createdCharacters[0];
      if (!firstCreatedCharacter) return;
      applySelection({ type: "character", id: firstCreatedCharacter.id });
      setLineFocusRequest({ lineId: firstCreatedCharacter.lineId, requestId: Date.now() });
      seekTo(firstCreatedCharacter.startTime);
      window.alert(`已创建 ${committedRepairResult.createdCharacters.length} 个整句文字块。`);
    });
  }

  async function importAndMergeProjectFile(file: File) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SavedProjectFile | ProjectData;
      const normalized = normalizeImportedProjectFile(parsed);
      const sourceProject = normalized.project;
      const currentProject = projectRef.current;
      const mergeRows = buildInitialImportMergeRows(currentProject, sourceProject);
      if (mergeRows.length === 0) {
        window.alert("导入的项目里没有可整合的轨道内容。");
        return;
      }
      setPendingImportMergeState({
        fileName: file.name,
        sourceProject,
        rows: mergeRows,
        videoWarning: getImportMergeVideoWarning(currentProject, sourceProject),
      });
      setManualVideoRelinkPrompt(null);
    } catch {
      window.alert("导入整合失败。请选择由本工具导出的项目 JSON，或检查文件内容是否完整。");
    }
  }

  function updateImportMergeRow(rowKey: string, updates: Partial<Pick<ImportMergeRow, "targetChoice" | "mergeMode">>) {
    setPendingImportMergeState((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        rows: current.rows.map((row) =>
          row.key === rowKey
            ? {
                ...row,
                ...updates,
              }
            : row),
      };
    });
  }

  async function applyImportMerge() {
    const pendingState = pendingImportMergeState;
    if (!pendingState) {
      return;
    }
    const currentProject = projectRef.current;
    const prepared = prepareImportMerge(currentProject, pendingState.sourceProject, pendingState.rows);
    if (prepared.skippedAll) {
      window.alert("当前整合设置没有可导入的轨道内容。请至少选择一条轨道进行替换或叠加。");
      return;
    }
    if (prepared.warnings.length > 0) {
      const confirmed = window.confirm(`整合前发现以下问题：\n\n${prepared.warnings.join("\n")}\n\n是否继续整合？`);
      if (!confirmed) {
        return;
      }
    }
    let skippedAfterLease = false;
    const committed = await runControlledSnapshotMutation(
      "merge_project",
      (baseProject) => {
        // acquire 期间目标轨道可能被普通编辑；提交时必须重新归一化目标，不能沿用弹窗确认前的旧计划。
        const latestPrepared = prepareImportMerge(baseProject, pendingState.sourceProject, pendingState.rows);
        skippedAfterLease = latestPrepared.skippedAll;
        return skippedAfterLease
          ? baseProject
          : applyPreparedImportMerge(baseProject, pendingState.sourceProject, latestPrepared.plans);
      },
    );
    if (skippedAfterLease) {
      window.alert("取得整合锁后，当前设置已没有可导入的轨道内容。请重新检查整合目标。");
      return;
    }
    if (committed) setPendingImportMergeState(null);
  }

  async function updateServerMediaBinding(mediaResourceId: string | null) {
    const session = editorSession;
    if (!session) throw new Error("当前不是平台标注文件，无法关联服务器媒体。");
    const blockedReason = getPlatformMediaBindingBlockReason({
      canWrite: session.canWrite,
      hasUnsavedChanges,
      pendingOperationCount: pendingOperations.length,
      hasTransientEdit: transientProjectRef.current !== null,
      hasInlineEdit: editingCharacterId !== null || editingCustomTextBlock !== null,
      hasPendingMergeDraft: pendingAnnotationMergeDraft !== null,
      syncStatus: syncState.status,
      saveInFlight: serverSaveInFlightRef.current,
      appliedRemoteRevision: remoteBaseRevisionRef.current,
      observedRemoteRevision,
    });
    if (blockedReason) throw new Error(blockedReason);

    setServerMediaBindingBusy(true);
    try {
      let authoritativeFile = await session.client.updateAnnotationMedia<ProjectData>(
        session.annotationFileId,
        { mediaResourceId },
      );
      let nextProject = hydrateProjectForClient(
        authoritativeFile.payload,
        session.client,
        authoritativeFile.media,
      );
      // 关联关系独立存于数据库，不应制造文档命令、撤销记录或 dirty 状态。
      // 用服务器回包中的权威 payload/revision 原子替换 clean 基线，避免保留旧媒体 URL。
      if (!replaceCleanProjectFromRemote(nextProject, authoritativeFile.revision)) {
        // 请求发出前已经在途的 clean catch-up 仍可能先落地。只权威重读并重试一次；
        // 如果期间出现本地 dirty/transient 状态，document gate 会继续拒绝覆盖。
        authoritativeFile = await session.client.getAnnotationFile<ProjectData>(session.annotationFileId);
        nextProject = hydrateProjectForClient(
          authoritativeFile.payload,
          session.client,
          authoritativeFile.media,
        );
        if (!replaceCleanProjectFromRemote(nextProject, authoritativeFile.revision)) {
          throw new Error("媒体关系已保存，但编辑器状态在请求期间发生变化。请关闭窗口并重新打开文件。");
        }
      }
      remoteBaseRevisionRef.current = authoritativeFile.revision;
      remoteOperationCursorRef.current = authoritativeFile.operationCursor;
      setRemoteBaseRevision(authoritativeFile.revision);
      setObservedRemoteRevision((current) => Math.max(current, authoritativeFile.revision));
      setRemoteOperationCursor(authoritativeFile.operationCursor);
      mutationLease.advanceBaseRevision(authoritativeFile.revision);
      session.onAnnotationFileSaved(authoritativeFile);
      setIsPlaying(false);
      setPreviewTime(null);
      setCurrentTime(0);
      setServerMediaDialogOpen(false);
    } finally {
      setServerMediaBindingBusy(false);
    }
  }

  async function saveProjectFile() {
    if (editingCharacterId) {
      commitCharacterTextEdit(editingCharacterId);
    }
    if (editingCustomTextBlock) {
      commitCustomTextEdit(editingCustomTextBlock.trackId, editingCustomTextBlock.id);
    }

    const projectToSave = projectRef.current;
    const persistableProject = getPersistableProjectData(projectToSave);
    const savePayload: SavedProjectFile = {
      version: PROJECT_FILE_VERSION,
      project: persistableProject,
      uiState: {
        zoom,
        currentTime,
        playbackRate,
        trackSnapEnabled: trackSnapEnabledRef.current,
        loopPlaybackEnabled,
        loopPlaybackRange,
      },
    };
    downloadBlob(
      JSON.stringify(savePayload, null, 2),
      getProjectFileName(projectToSave, currentProjectFileName),
      "application/json",
    );
    markProjectAsSaved(projectToSave, trackSnapEnabledRef.current);
  }

  async function saveProjectToServer(options: {
    source: "manual" | "auto";
  } = { source: "manual" }): Promise<PlatformSaveOutcome> {
    const interactive = options.source === "manual";
    if (!editorSession) {
      if (interactive) window.alert("当前不是平台工作区。请从项目库打开工作区后再保存。");
      return { status: "skipped", reason: "not-platform" };
    }
    // 标注文件只读：无 write 权限时不发起保存请求。
    if (!editorSession.canWrite) {
      if (interactive) window.alert("当前标注文件为只读状态，你只能查看和导航，不能保存。");
      return { status: "skipped", reason: "read-only" };
    }
    // 结构命令可能正在等待租约；此时启动普通保存会形成“无 token 请求先出发、租约随后生效”的竞态。
    if (exclusiveMutationInFlightRef.current) {
      if (interactive) window.alert("结构编辑正在完成，请稍后再保存。");
      return { status: "skipped", reason: "busy" };
    }
    // 自动保存 timer 可能与 pointer-up 落在相邻帧；同步 ref 门禁保证预览状态不会早于 operation 被冻结。
    if (transientProjectRef.current !== null) {
      if (interactive) window.alert("当前拖拽尚未结束，请松开鼠标后再保存。");
      return { status: "skipped", reason: "transient-edit" };
    }
    if (serverSaveInFlightRef.current) {
      if (interactive) window.alert("正在保存到服务器，请等待本次保存完成。");
      return { status: "skipped", reason: "busy" };
    }
    // 手动保存会先提交当前输入框；自动保存不打断输入法或尚未确认的文字编辑会话。
    const hadInlineEditor = interactive && Boolean(editingCharacterId || editingCustomTextBlock);
    if (interactive && editingCharacterId) {
      commitCharacterTextEdit(editingCharacterId);
    }
    if (interactive && editingCustomTextBlock) {
      commitCustomTextEdit(editingCustomTextBlock.trackId, editingCustomTextBlock.id);
    }
    if (!hasUnsavedChanges && !hadInlineEditor) {
      return { status: "skipped", reason: "clean" };
    }

    serverSaveInFlightRef.current = true;
    const saveCompletion = beginServerSaveCompletion();
    setServerSaveInFlight(true);
    syncFailureMismatchFieldsRef.current = [];
    syncFailureMismatchDetailsRef.current = [];
    setSyncStatus("saving");
    try {
      // 保存事务先冻结项目与 pending 链。网络等待期间产生的新编辑不会混入本次批次，
      // 仍由 document state 保留为 dirty，并在本次结束后进入下一轮自动保存。
      const frozenRecoveryState = getRecoveryState();
      const frozenTargetProject = frozenRecoveryState.currentProject;
      let batchSavedProject = frozenRecoveryState.savedProject;
      let batchSavedTrackSnapEnabled = frozenRecoveryState.savedTrackSnapEnabled;
      let batchSavedLocalRevision = frozenRecoveryState.savedRevision;
      let remainingFrozenOperations = frozenRecoveryState.pendingOperations;

      // 原子批次可能已经确认了前面的 operation，后续批次才发现命令链损坏。
      // 快照恢复必须只覆盖“尚未确认的后缀”，否则会把已提交 operation 再次带入 PUT，
      // 服务端会按 committedRevision 拒绝整次恢复，造成恢复路径自身再次同步失败。
      const getRemainingRecoveryState = (): ProjectDocumentRecoveryState => ({
        ...frozenRecoveryState,
        savedProject: batchSavedProject,
        savedTrackSnapEnabled: batchSavedTrackSnapEnabled,
        savedRevision: batchSavedLocalRevision,
        pendingOperations: remainingFrozenOperations,
      });

      if (remainingFrozenOperations.length === 0) {
        const hasUnrepresentedChanges =
          !projectsEqual(frozenRecoveryState.currentProject, frozenRecoveryState.savedProject) ||
          !trackSnapStatesEqual(
            frozenRecoveryState.currentTrackSnapEnabled,
            frozenRecoveryState.savedTrackSnapEnabled,
          );
        return hasUnrepresentedChanges
          ? saveLegacyProjectSnapshot(editorSession, options.source, frozenRecoveryState)
          : { status: "saved" };
      }

      while (remainingFrozenOperations.length > 0) {
        let planResult = planAtomicAnnotationCommandBatch({
          savedProject: batchSavedProject,
          currentProject: frozenTargetProject,
          serverRevision: remoteBaseRevisionRef.current,
          savedLocalRevision: batchSavedLocalRevision,
          savedTrackSnapEnabled: batchSavedTrackSnapEnabled,
          pendingOperations: remainingFrozenOperations,
          // 结构编辑通常在 commitProject 前已经取得租约；首轮 planner 必须携带现有 token。
          // 若此刻尚无 token，下面仍会按 requiredLeasePurpose acquire 后重新规划。
          mutationLeaseToken: mutationLease.getToken(),
          maxBatchSize: Math.min(
            MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS,
            remainingFrozenOperations.length,
          ),
        });

        if (planResult.status === "no_operations") {
          return { status: "saved" };
        }
        if (planResult.status === "legacy_required") {
          return saveLegacyProjectSnapshot(editorSession, options.source, getRemainingRecoveryState());
        }
        if (planResult.status === "blocked") {
          syncFailureMismatchFieldsRef.current = getSyncFailureMismatchFields(planResult.issues);
          syncFailureMismatchDetailsRef.current = getSyncFailureMismatchDetails(planResult.issues);
          if (planResult.reason === "local_chain_mismatch") {
            // 旧版本或历史失败恢复留下的本地命令链可能已经无法从 savedProject 重放到当前项目。
            // 继续把新操作追加到这条坏链只会让每次创建块都失败；这里转入一次完整快照恢复，
            // 仍使用同一 server revision、同一结构租约和服务端乐观锁，不会绕过并发保护。
            console.warn("检测到本地命令链与当前项目不一致，尝试受约束的完整快照恢复。", {
              purpose: "pending-command-chain-recovery",
              remoteRevision: remoteBaseRevisionRef.current,
              pendingOperationCount: remainingFrozenOperations.length,
              mismatchFields: syncFailureMismatchFieldsRef.current,
            });
            return saveLegacyProjectSnapshot(editorSession, options.source, getRemainingRecoveryState());
          }
          const message = `本地命令链无法安全提交（${planResult.reason}），请保留草稿并进入冲突检查。`;
          setSyncStatus("error", { errorMessage: message });
          if (interactive) window.alert(message);
          return { status: "error", retryable: false, message };
        }

        if (planResult.plan.requiredLeasePurpose && !mutationLease.getToken()) {
          await mutationLease.acquire(planResult.plan.requiredLeasePurpose);
          // acquire 期间用户仍可编辑，但本事务必须重新审计同一冻结链，不能把后来编辑混入请求。
          planResult = planAtomicAnnotationCommandBatch({
            savedProject: batchSavedProject,
            currentProject: frozenTargetProject,
            serverRevision: remoteBaseRevisionRef.current,
            savedLocalRevision: batchSavedLocalRevision,
            savedTrackSnapEnabled: batchSavedTrackSnapEnabled,
            pendingOperations: remainingFrozenOperations,
            mutationLeaseToken: mutationLease.getToken(),
            maxBatchSize: Math.min(
              MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS,
              remainingFrozenOperations.length,
            ),
          });
          if (planResult.status !== "ready") {
            if (planResult.status === "legacy_required") {
              return saveLegacyProjectSnapshot(editorSession, options.source, getRemainingRecoveryState());
            }
            const message = `取得结构编辑锁后命令链已变化（${planResult.status}），请重新保存。`;
            setSyncStatus("error", { errorMessage: message });
            return { status: "error", retryable: false, message };
          }
        }

        const result = await atomicCommandSubmit.submit(planResult.plan);
        if (result.status === "committed") {
          batchSavedProject = planResult.plan.acknowledgedProject;
          batchSavedTrackSnapEnabled = planResult.plan.acknowledgedTrackSnapEnabled;
          batchSavedLocalRevision = planResult.plan.acknowledgedLocalRevision;
          remainingFrozenOperations = remainingFrozenOperations.slice(planResult.plan.operationIds.length);
          continue;
        }
        if (result.status === "failed") {
          const failure = result.failure;
          // 仅记录稳定分类，不输出命令 payload 或租约 token，便于定位确定性 API 拒绝。
          console.error(
            `原子命令提交失败 [${failure.status}/${failure.code ?? "no-code"}]：${failure.message}`,
          );
          if (requiresLegacySnapshotMigration(failure)) {
            // 浏览器已经迁移、服务器仍保存旧格式的导入文件无法直接重放领域命令。
            // 仅在服务端明确返回该代码时，以同一 revision 和租约执行一次完整快照迁移。
            return saveLegacyProjectSnapshot(editorSession, options.source, getRemainingRecoveryState());
          }
          if (isMutationLeaseSubmitFailure(failure)) {
            // 服务端已证明当前 token 不能继续使用；先清本地状态并尽力释放，下一次保存才能重新 acquire。
            await mutationLease.release().catch(() => undefined);
          }
          const isMaintenanceFailure = failure.code === PLATFORM_MAINTENANCE_ERROR_CODE;
          if (isMaintenanceFailure) {
            await preserveDraftAfterMaintenanceBlock();
          }
          if (failure.status === "conflict") {
            const rebase = await tryAutomaticConcurrentRebase(editorSession);
            if (rebase.status === "applied") {
              const message = "已协调其他账号的并发修改，正在基于最新版本重新保存。";
              if (interactive) window.alert(message);
              return { status: "rebased", message };
            }
          }
          // 诊断和顶部提示保留稳定服务端错误码，下一次失败无需依赖控制台才能判断租约/协议原因。
          const failureMessage = failure.code
            ? `${failure.message}（${failure.code}）`
            : failure.message;
          const outcome: PlatformSaveOutcome = failure.status === "offline"
            ? { status: "offline", retryable: true, message: failureMessage }
            : failure.status === "conflict"
              ? { status: "conflict", retryable: false, message: failureMessage }
              : { status: "error", retryable: failure.retryable, message: failureMessage };
          setSyncStatus(outcome.status, { errorMessage: outcome.message });
          if (interactive && !isMaintenanceFailure) window.alert(outcome.message);
          return outcome;
        }
        if (result.status === "protocol_error") {
          const message = `服务器原子确认合同异常：${result.reason}`;
          setSyncStatus("error", { errorMessage: message });
          if (interactive) window.alert(message);
          return { status: "error", retryable: false, message };
        }
        return { status: "skipped", reason: "busy" };
      }
      return { status: "saved" };
    } catch (error) {
      const classified = describeServerSaveError(error);
      const isMaintenanceFailure = isPlatformMaintenanceError(error);
      if (isMaintenanceFailure) await preserveDraftAfterMaintenanceBlock();
      setSyncStatus(classified.status, { errorMessage: classified.message });
      console.error("保存到服务器失败:", error);
      if (interactive && !isMaintenanceFailure) window.alert(classified.message);
      return classified;
    } finally {
      serverSaveInFlightRef.current = false;
      finishServerSaveCompletion(saveCompletion);
      // 必须通过 state 唤醒一次渲染，使 clean error 会话重新获得权威 HTTP 追赶资格。
      setServerSaveInFlight(false);
    }
  }

  // 409 后先严格重放；同一 timing/content 目标冲突时，再基于最新服务器值协调并重建命令。
  // lifecycle、结构、legacy、snapshot、track-snap 或请求期间新增编辑仍停在显式冲突检查。
  async function tryAutomaticConcurrentRebase(
    session: PlatformEditorSession,
  ): Promise<{ status: "applied" } | { status: "unavailable"; reason: string }> {
    const expectedRemoteRevision = remoteBaseRevisionRef.current;
    const localState = getRecoveryState();
    const latestFile = await session.client.getAnnotationFile<ProjectData>(session.annotationFileId);
    if (latestFile.revision <= expectedRemoteRevision) {
      return { status: "unavailable", reason: "server_revision_not_newer" };
    }
    const latestServerProject = hydrateProjectForClient(latestFile.payload, session.client, latestFile.media);
    const plan = planPlatformConflictRebase({
      baseRevision: expectedRemoteRevision,
      latestRevision: latestFile.revision,
      savedProject: localState.savedProject,
      currentProject: localState.currentProject,
      latestServerProject,
      savedLocalRevision: localState.savedRevision,
      pendingOperations: localState.pendingOperations,
      allowConcurrentValueResolution: true,
    });
    if (plan.status !== "rebase_ready") {
      return { status: "unavailable", reason: plan.status };
    }

    // 结构命令的旧租约绑定旧 revision；先释放，重提时由普通保存路径按最新基线重新取得。
    if (plan.requiredLeasePurpose) {
      await mutationLease.release().catch(() => undefined);
    }
    const applied = rebasePendingProjectFromRemote({
      expectedCurrentProject: localState.currentProject,
      expectedSavedProject: localState.savedProject,
      expectedLocalRevision: localState.localRevision,
      expectedSavedRevision: localState.savedRevision,
      latestServerProject,
      rebasedCurrentProject: plan.rebasedProject,
      rebasedPendingOperations: plan.rebasedPendingOperations,
      remoteRevision: latestFile.revision,
    });
    if (applied.status !== "applied") {
      return { status: "unavailable", reason: applied.reason };
    }

    remoteBaseRevisionRef.current = latestFile.revision;
    remoteOperationCursorRef.current = latestFile.operationCursor;
    setRemoteBaseRevision(latestFile.revision);
    setObservedRemoteRevision((current) => Math.max(current, latestFile.revision));
    setRemoteOperationCursor(latestFile.operationCursor);
    session.onRemoteRevisionAdvanced(latestFile.revision, latestFile.operationCursor);
    mutationLease.advanceBaseRevision(latestFile.revision);
    void annotationReviews.refresh();
    return { status: "applied" };
  }

  // 只有 planner 明确识别出的旧语义才能走完整快照；该兼容通道不能吞掉原子命令 precondition 错误。
  async function saveLegacyProjectSnapshot(
    session: PlatformEditorSession,
    source: "manual" | "auto",
    frozenRecoveryState = getRecoveryState(),
  ): Promise<PlatformSaveOutcome> {
    const submittedOperationIds: string[] = [];
    const pendingSnapshot = frozenRecoveryState.pendingOperations;
    const coveredOperationIds = pendingSnapshot.map((operation) => operation.id);
    const savedLocalRevision = pendingSnapshot.length > 0
      ? Math.max(...pendingSnapshot.map((operation) => operation.localRevision))
      : frozenRecoveryState.localRevision;
    const projectSnapshot = frozenRecoveryState.currentProject;
    const trackSnapSnapshot = frozenRecoveryState.currentTrackSnapEnabled;
    const requiredLeasePurpose = pendingSnapshot
      .map((operation) => getAnnotationMutationLeasePurposeForCommand(operation.commandEnvelope))
      .find((purpose): purpose is AnnotationMutationPurpose => purpose !== null);
    try {
      if (requiredLeasePurpose && !mutationLease.getToken()) {
        await mutationLease.acquire(requiredLeasePurpose);
      }
      const mutationLeaseToken = mutationLease.getToken();
      if (pendingSnapshot.length > 0) {
        await submitLegacyPendingOperations(
          session.client,
          session.annotationFileId,
          pendingSnapshot,
          remoteBaseRevisionRef.current,
          (operationId) => submittedOperationIds.push(operationId),
          mutationLeaseToken,
        );
      }
      const savedFile = await session.client.saveAnnotationFile<ProjectData>(session.annotationFileId, {
        baseRevision: remoteBaseRevisionRef.current,
        payload: prepareProjectForServer(getPersistableProjectData(projectSnapshot)),
        clientOperationIds: coveredOperationIds,
        ...(mutationLeaseToken ? { mutationLeaseToken } : {}),
      });
      if (mutationLeaseToken) mutationLease.markCommitted();
      mutationLease.advanceBaseRevision(savedFile.revision);
      remoteBaseRevisionRef.current = savedFile.revision;
      remoteOperationCursorRef.current = savedFile.operationCursor;
      setRemoteBaseRevision(savedFile.revision);
      setObservedRemoteRevision((current) => Math.max(current, savedFile.revision));
      setRemoteOperationCursor(savedFile.operationCursor);
      session.onAnnotationFileSaved(savedFile);
      markProjectAsSaved(projectSnapshot, trackSnapSnapshot, {
        acknowledgedOperationIds: coveredOperationIds,
        savedLocalRevision,
      });
      clearMaintenanceBlockAfterServerCommit();
      void annotationReviews.refresh();
      return { status: "saved" };
    } catch (error) {
      if (submittedOperationIds.length > 0) markOperationsAsSubmitted(submittedOperationIds);
      const classified = describeServerSaveError(error);
      const isMaintenanceFailure = isPlatformMaintenanceError(error);
      if (isMaintenanceFailure) await preserveDraftAfterMaintenanceBlock();
      setSyncStatus(classified.status, { errorMessage: classified.message });
      console.error("兼容快照保存失败:", error);
      if (source === "manual" && !isMaintenanceFailure) window.alert(classified.message);
      return classified;
    }
  }

  function handleExport() {
    downloadBlob(
      exportCharacterTrackToSrt(project.characterAnnotations),
      "character_track.srt",
      "application/x-subrip",
    );
  }

  function openDetachedWindow(
    title: string,
    name: string,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
  ) {
    const left = Math.max(0, Math.round(window.screenX + offsetX));
    const top = Math.max(0, Math.round(window.screenY + offsetY));
    const features = [
      "popup=yes",
      "resizable=yes",
      "scrollbars=no",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
    ].join(",");
    const popup = window.open("", name, features);
    if (!popup) {
      window.alert("浏览器阻止了弹出窗口。请允许本站点弹出窗口后再试。");
      return null;
    }
    popup.document.title = title;
    popup.focus();
    return popup;
  }

  function closePreviewDetachedWindow() {
    setPreviewDetachedWindow((currentWindow) => {
      if (currentWindow && !currentWindow.closed) {
        currentWindow.close();
      }
      return null;
    });
  }

  function closeTimelineDetachedWindow() {
    setTimelineDetachedWindow((currentWindow) => {
      if (currentWindow && !currentWindow.closed) {
        currentWindow.close();
      }
      return null;
    });
  }

  function closeConfirmationDetachedWindow(
    nextPlacement: Exclude<AnnotationConfirmationPanelPlacement, "detached"> = "docked",
  ) {
    setConfirmationDetachedWindow((currentWindow) => {
      if (currentWindow && !currentWindow.closed) {
        currentWindow.close();
      }
      return null;
    });
    setConfirmationPanelPlacement(nextPlacement);
  }

  // “标注审核面板”菜单只控制右栏停靠；若当前在独立窗口，点击会明确收回右栏。
  function toggleConfirmationPanelDocked() {
    if (confirmationPanelPlacement === "docked") {
      setConfirmationPanelPlacement("hidden");
      return;
    }
    if (confirmationPanelPlacement === "detached") {
      closeConfirmationDetachedWindow("docked");
      return;
    }
    setConfirmationPanelPlacement("docked");
  }

  function togglePreviewDetachedWindow() {
    if (previewDetachedWindow && !previewDetachedWindow.closed) {
      closePreviewDetachedWindow();
      return;
    }
    const popup = openDetachedWindow("视频播放器", "xiqu-preview-window", 760, 480, 80, 80);
    if (popup) {
      setPreviewDetachedWindow(popup);
    }
  }

  function toggleTimelineDetachedWindow() {
    if (timelineDetachedWindow && !timelineDetachedWindow.closed) {
      closeTimelineDetachedWindow();
      return;
    }
    const popup = openDetachedWindow("多轨时间轴", "xiqu-timeline-window", 1180, 620, 120, 120);
    if (popup) {
      setTimelineDetachedWindow(popup);
    }
  }

  function toggleConfirmationDetachedWindow() {
    if (isConfirmationDetached) {
      closeConfirmationDetachedWindow("docked");
      return;
    }
    const popup = openDetachedWindow("标注审核", "xiqu-confirmation-window", 520, 760, 160, 100);
    if (popup) {
      setConfirmationDetachedWindow(popup);
      setConfirmationPanelPlacement("detached");
    }
  }

  function renderPreviewWorkspace(detached: boolean) {
    return (
      <VideoPlayer
        ref={videoRef}
        source={playbackSource}
        audioSelection={platformAudioTracks.audioSelection}
        playbackRate={playbackRate}
        currentTime={currentTime}
        previewTime={previewTime}
        isPlaying={isPlaying}
        isDetached={detached}
        onToggleDetached={togglePreviewDetachedWindow}
        onLoadedMetadata={(nextDuration) => setDuration(Math.max(nextDuration, getProjectDuration(project)))}
        onTimeUpdate={setCurrentTime}
        onPlayStateChange={setIsPlaying}
        onAudioPlaybackStateChange={platformAudioTracks.onRuntimeStateChange}
        onAudioPlaybackError={platformAudioTracks.onRuntimeError}
      />
    );
  }

  function renderTimelineWorkspace(detached: boolean) {
    return (
      <Timeline
        editingBlockedReason={remoteCatchUpBlockReason}
        subtitleLines={project.subtitleLines}
        sentenceAnnotationConfig={project.sentenceAnnotationConfig}
        builtinTracks={project.builtinTracks}
        characterAnnotations={project.characterAnnotations}
        gongcheAnnotations={project.gongcheAnnotations}
        banyanSections={project.banyanSections}
        banyanMarks={project.banyanMarks}
        banyanGridVisible={banyanGridVisible}
        banyanTrackVisible={banyanTrackVisible}
        waveformVisible={waveformVisible}
        actionAnnotations={project.actionAnnotations}
        customTracks={project.customTracks}
        trackDefinitions={timelineTrackDefinitions}
        missingBuiltinTracks={missingBuiltinTracks}
        waveformData={displayedWaveformData}
        isWaveformLoading={editorSession
          ? platformMediaAnalysis.statusLoading || platformMediaAnalysis.assetsLoading
          : isWaveformLoading}
        spectrogramData={displayedSpectrogramData}
        isSpectrogramLoading={editorSession
          ? platformMediaAnalysis.statusLoading || platformMediaAnalysis.assetsLoading
          : isSpectrogramLoading}
        spectrogramSettings={spectrogramSettings}
        currentTime={currentTime}
        remoteActivities={showRemoteCollaborationHints ? collaborationSession.remoteActivities : []}
        pointerSourceId={detached ? "detached-timeline" : "main-timeline"}
        onTransientPointerTimeChange={updateCollaborationPointer}
        loopPlaybackRange={loopPlaybackRange}
        loopPlaybackEnabled={loopPlaybackEnabled}
        reviewRanges={editorSession && confirmationTimelineVisible
          ? reviewTimelineRanges
          : []}
        reviewRangesVisible={Boolean(editorSession && confirmationTimelineVisible)}
        onSelectReviewRange={(range) => {
          seekTo(range.startTime);
          setLineFocusRequest(null);
          setInitialPlatformFocusRange(null);
          setConfirmationFocusRange({
            requestId: Date.now(),
            start: range.startTime,
            end: range.endTime,
          });
        }}
        isDetached={detached}
        selectedItem={selectedItem}
        selectedTimelineItems={selectedTimelineItems}
        trackSnapEnabled={trackSnapEnabled}
        zoom={zoom}
        duration={duration}
        focusRange={focusRange}
        onFocusRangeHandled={handleFocusRangeHandled}
        getProjectSnapshot={() => projectRef.current}
        onZoomChange={setZoom}
        onViewportTimeRangeChange={(nextViewport) => {
          if (!editorSession) return;
          setAnalysisViewport((current) => current &&
            current.startTime === nextViewport.startTime &&
            current.endTime === nextViewport.endTime &&
            current.zoom === nextViewport.zoom
            ? current
            : nextViewport);
        }}
        onToggleTrackSnap={(trackId) => {
          applyTrackSnapEnabledState({
            ...trackSnapEnabledRef.current,
            [trackId]: !trackSnapEnabledRef.current[trackId],
          });
        }}
        onLoopPlaybackRangeChange={updateLoopPlaybackRangeFromTimeline}
        onLoopPlaybackEnabledChange={updateLoopPlaybackEnabledFromUser}
        onToggleDetached={toggleTimelineDetachedWindow}
        onSeek={seekTo}
        onPreviewFrame={setPreviewTime}
        onSelectItem={(item) => {
          setLineFocusRequest(null);
          if (item?.type === "character") {
            preferredCharacterEditLocationRef.current = "timeline";
          }
          applySelection(item);
        }}
        onCloseContextMenu={closeTimelineContextMenu}
        onSelectTimelineItems={(items, primaryItem) => {
          setLineFocusRequest(null);
          if (primaryItem?.type === "character") {
            preferredCharacterEditLocationRef.current = "timeline";
          }
          applySelection(primaryItem, items);
        }}
        onSelectLineOverlay={(lineId) => {
          setLineFocusRequest(null);
          applySelection({ type: "line", id: lineId });
        }}
        editingCharacterId={editingCharacterId}
        editingCharacterLocation={editingCharacterLocation}
        editingCharacterValue={editingCharacterValue}
        editingCustomTextBlock={editingCustomTextBlock}
        editingCustomTextValue={editingCustomTextValue}
        onEditingCharacterValueChange={setEditingCharacterValue}
        onEditingCustomTextValueChange={setEditingCustomTextValue}
        onCommitCharacterTextEdit={commitCharacterTextEdit}
        onCommitCustomTextEdit={commitCustomTextEdit}
        onCancelCharacterTextEdit={cancelCharacterTextEdit}
        onCancelCustomTextEdit={cancelCustomTextEdit}
        onEditCharacterText={(id) => startCharacterTextEdit(id, "timeline")}
        onEditCustomTextBlock={startCustomTextEdit}
        onCreateCharacterAtTime={createCharacterAtTime}
        onCreateActionAtTime={createActionAtTime}
        onCreateCustomBlock={createCustomBlock}
        onCreateGongcheBlockAtTime={createGongcheBlockAtTime}
        onAddCustomTrack={addCustomTrack}
        onUpdatePasteTarget={updateTimelinePasteTarget}
        onSelectBuiltinTrack={(trackId) => {
          setLineFocusRequest(null);
          applySelection({ type: "builtin-track", id: trackId });
        }}
        onAddBuiltinTrack={addBuiltinTrack}
        onSelectTrack={(trackId) => {
          setLineFocusRequest(null);
          applySelection(
            activeBuiltinTrackIds.has(trackId as BuiltinTrackId)
              ? { type: "builtin-track", id: trackId as BuiltinTrackId }
              : { type: "custom-track", id: trackId },
          );
        }}
        onSelectAttachedPointTrack={(trackId, parentTrackId) => {
          setLineFocusRequest(null);
          applySelection({ type: "attached-point-track", id: trackId, parentTrackId });
        }}
        onMoveTrack={(trackId, direction) => {
          if (activeBuiltinTrackIds.has(trackId as BuiltinTrackId)) {
            moveBuiltinTrack(trackId as BuiltinTrackId, direction);
          } else {
            moveCustomTrack(trackId, direction);
          }
        }}
        onReorderTrack={(trackId, insertionIndex) => {
          if (activeBuiltinTrackIds.has(trackId as BuiltinTrackId)) {
            reorderBuiltinTrack(trackId as BuiltinTrackId, insertionIndex);
          } else {
            reorderCustomTrack(trackId, insertionIndex);
          }
        }}
        onToggleAttachedPointTracks={toggleAttachedPointTracks}
        onDeleteBuiltinTrack={deleteBuiltinTrack}
        onDeleteCustomTrack={deleteCustomTrack}
        onOpenLineContextMenu={(id, time, x, y) => {
          setLineFocusRequest(null);
          applySelection({ type: "line", id });
          setBlockContextMenu({ type: "line", id, time, x, y });
        }}
        onOpenCharacterContextMenu={(id, time, x, y) => {
          preferredCharacterEditLocationRef.current = "timeline";
          updateTimelinePasteTarget("character-track", time);
          setBlockContextMenu({
            type: "character",
            id,
            trackId: "character-track",
            time,
            x,
            y,
          });
        }}
        onOpenActionContextMenu={(id, time, x, y) => {
          const action = projectRef.current.actionAnnotations.find((item) => item.id === id);
          updateTimelinePasteTarget(action?.trackId ?? "", time);
          setBlockContextMenu({
            type: "action",
            id,
            trackId: action?.trackId ?? "",
            time,
            x,
            y,
          });
        }}
        onOpenCustomBlockContextMenu={(trackId, id, time, x, y) => {
          updateTimelinePasteTarget(trackId, time);
          setBlockContextMenu({
            type: "custom-block",
            trackId,
            id,
            time,
            x,
            y,
          });
        }}
        onOpenAttachedPointContextMenu={(trackId, parentTrackId, id, time, x, y) => {
          updateTimelinePasteTarget(trackId, time);
          setBlockContextMenu({
            type: "attached-point",
            trackId,
            parentTrackId,
            id,
            time,
            x,
            y,
          });
        }}
        onOpenGongcheBlockContextMenu={(id, time, x, y) => {
          setBlockContextMenu({
            type: "gongche-block",
            id,
            time,
            x,
            y,
          });
        }}
        onOpenBanyanMarkContextMenu={(id, time, x, y) => {
          updateTimelinePasteTarget("banyan-track", time);
          setBlockContextMenu({
            type: "banyan-mark",
            trackId: "banyan-track",
            id,
            time,
            x,
            y,
          });
        }}
        onOpenLaneContextMenu={(trackId, time, x, y) => {
          const branchLaneParts = getBranchLaneTrackParts(trackId);
          updateTimelinePasteTarget(branchLaneParts?.parentTrackId ?? trackId, time);
          setBlockContextMenu({ type: "lane", trackId, time, x, y });
        }}
        onLineChange={(id, changes) => updateLinePosition(id, changes, false)}
        onLineCommit={(id, changes) => updateLinePosition(id, changes, true)}
        onCharacterChange={(id, changes) => updateCharacter(id, changes, false)}
        onCharacterCommit={(id, changes) => updateCharacter(id, changes, true)}
        onActionChange={(id, changes) => updateAction(id, changes, false)}
        onActionCommit={(id, changes) => updateAction(id, changes, true)}
        onAttachedPointChange={changeAttachedPoint}
        onAttachedPointCommit={commitAttachedPoint}
        onGongcheBlockChange={changeGongcheBlock}
        onGongcheBlockCommit={commitGongcheBlock}
        onBanyanMarkChange={changeBanyanMark}
        onBanyanMarkCommit={commitBanyanMark}
        onCreateBanyanMark={createBanyanMark}
        onCustomBlockChange={(trackId, id, changes) => updateCustomBlock(trackId, id, changes, false)}
        onCustomBlockCommit={(trackId, id, changes) => updateCustomBlock(trackId, id, changes, true)}
        onBatchMoveChange={(items) => updateTimelineSelectionBatch(items, false)}
        onBatchMoveCommit={(items) => updateTimelineSelectionBatch(items, true)}
        onCreateAction={createAction}
        onCreateAttachedPoint={createAttachedPoint}
      />
    );
  }

  // 停靠面板和独立窗口共享同一套审核数据与命令；只有容器、折叠能力和对话框 Portal 目标不同。
  function renderAnnotationConfirmationWorkspace(detached: boolean) {
    if (!editorSession) return null;
    return (
      <AnnotationReviewPanel
        confirmations={confirmationViewRecords}
        comments={commentViewRecords}
        currentRevision={annotationReviews.confirmations?.currentRevision ??
          annotationReviews.comments?.currentRevision ?? null}
        editorRevision={remoteBaseRevision}
        range={loopPlaybackRange}
        trackOptions={confirmationTrackOptions}
        canReview={editorSession.canReview}
        createBlocker={confirmationCreateBlocker}
        loading={annotationReviews.loading}
        loadingMoreComments={annotationReviews.loadingMoreComments}
        hasMoreComments={Boolean(annotationReviews.comments?.nextCursor)}
        mutationPending={annotationReviews.mutationPending}
        error={annotationReviews.error}
        timelineVisible={confirmationTimelineVisible}
        collapsed={detached ? false : isConfirmationPanelCollapsed}
        onToggleCollapse={detached ? undefined : toggleConfirmationPanelCollapsed}
        portalContainer={detached ? confirmationDetachedWindow?.document.body : undefined}
        onTimelineVisibleChange={setConfirmationTimelineVisible}
        onRefresh={annotationReviews.refresh}
        onLoadMoreComments={annotationReviews.loadMoreComments}
        onCreateConfirmation={({ scope, note }) => annotationReviews.createConfirmation({
          confirmedRevision: remoteBaseRevision,
          scope,
          note,
        })}
        onCreateComment={({ scope, body }) => annotationReviews.createComment({
          commentedRevision: remoteBaseRevision,
          scope,
          body,
        })}
        onRevokeConfirmation={(record, reason) => annotationReviews.revokeConfirmation(
          record.record.id,
          { reason },
        )}
        onWithdrawComment={(record, reason) => annotationReviews.withdrawComment(
          record.record.id,
          { reason },
        )}
        canRevokeConfirmation={(record) => canShowAnnotationConfirmationRevoke({
          record,
          canReview: editorSession.canReview,
          currentUserId: editorSession.currentUserId,
          currentUserRoles: editorSession.currentUserRoles,
          hasOwnerAuthority: editorSession.canRevokeAnyConfirmation,
        })}
        canWithdrawComment={(record) => canShowAnnotationRangeCommentWithdraw({
          record,
          canReview: editorSession.canReview,
          currentUserId: editorSession.currentUserId,
          currentUserRoles: editorSession.currentUserRoles,
          hasOwnerAuthority: editorSession.canRevokeAnyConfirmation,
        })}
        onNavigate={(scope) => {
          seekTo(scope.startTime);
          setLineFocusRequest(null);
          setInitialPlatformFocusRange(null);
          setConfirmationFocusRange({
            requestId: Date.now(),
            start: scope.startTime,
            end: scope.endTime,
          });
        }}
      />
    );
  }

  return (
    <AppShell
      menuBar={(
        <TopMenuBar
          platformNavigation={platformNavigation}
          audioTrackSelector={platformAudioTracks.active ? {
            options: platformAudioTracks.options,
            selectedTrackId: platformAudioTracks.selectedTrackId,
            loading: platformAudioTracks.loading,
            refreshing: platformAudioTracks.refreshing,
            loadError: platformAudioTracks.loadError,
            runtimeState: platformAudioTracks.runtimeState,
            runtimeError: platformAudioTracks.runtimeError,
            canSetDefault: platformAudioTracks.canSetDefault,
            canManageTracks: platformAudioTracks.canManageTracks,
            defaultUpdatingTrackId: platformAudioTracks.defaultUpdatingTrackId,
            defaultUpdateError: platformAudioTracks.defaultUpdateError,
            onSelect: (trackId) => {
              platformAudioTracks.selectTrack(trackId);
            },
            onRefresh: () => {
              void platformAudioTracks.refresh();
            },
            onRetry: platformAudioTracks.retry,
            onSetDefault: (trackId) => {
              void platformAudioTracks.setAsDefault(trackId);
            },
            onManageTracks: () => setAudioTrackManagerOpen(true),
          } : undefined}
          isPlaying={isPlaying}
          playbackRate={playbackRate}
          loopPlaybackEnabled={loopPlaybackEnabled}
          hasLoopPlaybackRange={Boolean(loopPlaybackRange)}
          canUndo={undoStack.length > 0}
          canRedo={redoStack.length > 0}
          syncStatus={syncState.status}
          syncErrorMessage={syncState.errorMessage}
          localRevision={syncState.localRevision}
          savedRevision={syncState.savedRevision}
          remoteRevision={editorSession ? remoteBaseRevision : undefined}
          observedRemoteRevision={editorSession ? observedRemoteRevision : undefined}
          editingBlockedReason={remoteCatchUpBlockReason}
          pendingOperationCount={pendingOperations.length}
          accessLabel={editorSession?.accessLabel}
          mutationLeaseLabel={mutationLeaseLabel}
          collaborationStatus={editorSession ? collaborationSession.status : undefined}
          collaborationPresenceMembers={collaborationSession.members}
          currentPlatformUserId={editorSession?.currentUserId}
          showRemoteCollaborationHints={showRemoteCollaborationHints}
          sharePointerAndSelection={sharePointerAndSelection}
          onShowRemoteCollaborationHintsChange={setShowRemoteCollaborationHints}
          onSharePointerAndSelectionChange={setSharePointerAndSelection}
          videoFileInputRef={videoFileInputRef}
          srtFileInputRef={srtFileInputRef}
          projectFileInputRef={projectFileInputRef}
          mergeProjectFileInputRef={mergeProjectFileInputRef}
          onTogglePlay={togglePlay}
          onStep={(delta) => seekTo(currentTime + delta)}
          onPlaybackRateChange={setPlaybackRate}
          onToggleLoopPlayback={() => updateLoopPlaybackEnabledFromUser(!loopPlaybackEnabled)}
          onClearLoopPlaybackRange={clearLoopPlaybackRange}
          onVideoFileChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              setManualVideoRelinkPrompt(null);
              void handleVideoImport(file);
            }
            event.target.value = "";
          }}
          onSrtFileChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importSrtFile(file);
            }
            event.target.value = "";
          }}
          onProjectFileChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importProjectFile(file);
            }
            event.target.value = "";
          }}
          onMergeProjectFileChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importAndMergeProjectFile(file);
            }
            event.target.value = "";
          }}
          onSaveProject={() => {
            void saveProjectFile();
          }}
          onSaveProjectToServer={editorSession?.canWrite ? () => {
            void saveProjectToServer({ source: "manual" });
          } : undefined}
          onOpenServerMediaBinding={editorSession ? () => setServerMediaDialogOpen(true) : undefined}
          serverMediaBindingDisabledReason={serverMediaBindingDisabledReason}
          onExportTrack={handleExport}
          onUndo={undo}
          onRedo={redo}
          onRepairSentenceCharacterTrack={repairSentenceCharacterTrack}
          onOpenSentenceAnnotationSettings={() => setSentenceAnnotationSettingsOpen(true)}
          waveformVisible={waveformVisible}
          banyanTrackVisible={banyanTrackVisible}
          banyanGridVisible={banyanGridVisible}
          spectrogramVisible={spectrogramSettings.visible}
          annotationConfirmationPlacement={editorSession ? confirmationPanelPlacement : undefined}
          onWaveformVisibleChange={setWaveformVisible}
          onBanyanTrackVisibleChange={setBanyanTrackVisible}
          onBanyanGridVisibleChange={setBanyanGridVisible}
          onSpectrogramVisibleChange={(visible) => setSpectrogramSettings((prev) => ({ ...prev, visible }))}
          onToggleAnnotationConfirmationPanel={editorSession
            ? toggleConfirmationPanelDocked
            : undefined}
          onToggleAnnotationConfirmationDetached={editorSession
            ? toggleConfirmationDetachedWindow
            : undefined}
          commandSearchEntries={commandSearchEntries}
          commandSearchOpenRequestId={commandSearchOpenRequestId}
        />
      )}
    >
      {/* 保存冲突不自动打断编辑；用户明确触发后才固定草稿并进入服务器比较。 */}
      {editorSession && syncState.status === "conflict" && !pendingAnnotationMergeDraft ? (
        <section className="platform-save-conflict-bar" role="alert">
          <span>
            <strong>服务器文件已有新版本</strong>
            <small>当前本地编辑仍安全保留，处理前不会覆盖服务器。</small>
          </span>
          {saveConflictReviewError ? <em>{saveConflictReviewError}</em> : null}
          <button
            type="button"
            disabled={saveConflictReviewBusy}
            onClick={() => void openSaveConflictReview()}
          >
            {saveConflictReviewBusy ? "正在读取最新文件…" : "检查并处理冲突"}
          </button>
        </section>
      ) : null}
      {editorSession ? (
        <PlatformMaintenanceSaveWarningDialog
          open={maintenanceWarningOpen}
          draftState={maintenanceDraftState}
          onClose={() => setMaintenanceWarningOpen(false)}
          onSuppressForSession={() => {
            maintenanceWarningSuppressedRef.current = true;
            setMaintenanceWarningOpen(false);
          }}
        />
      ) : null}
      {/* 整合草稿确认栏属于编辑会话而非保存版本；取消不改历史，应用后仍需用户正常保存。 */}
      {pendingAnnotationMergeDraft ? (
        <section className="annotation-merge-draft-bar" role="status">
          <span>
            <strong>待应用的选择性整合</strong>
            <small>
              {pendingAnnotationMergeDraft.sourceFileName} → {pendingAnnotationMergeDraft.targetFileName}
              · 新增 {pendingAnnotationMergeDraft.summary.added}
              · 替换 {pendingAnnotationMergeDraft.summary.replaced}
              · 保留目标 {pendingAnnotationMergeDraft.summary.keptTarget}
            </small>
          </span>
          <em>应用后形成一次可撤销编辑，不会自动保存到服务器。</em>
          <button
            type="button"
            onClick={cancelPendingAnnotationMergeDraft}
          >
            {pendingAnnotationMergeDraft.sourceKind === "browser-draft"
              ? "放弃本地草稿整合"
              : "取消"}
          </button>
          <button
            type="button"
            className="primary"
            onClick={applyPendingAnnotationMergeDraft}
          >
            应用到当前文档
          </button>
        </section>
      ) : null}
      {editorSession ? (
        <AnnotationMediaBindingDialog
          client={editorSession.client}
          parentId={editorSession.parentId}
          current={editorSession.media}
          open={serverMediaDialogOpen}
          busy={serverMediaBindingBusy}
          allowUnbound
          onOpenChange={(open) => {
            if (!serverMediaBindingBusy) setServerMediaDialogOpen(open);
          }}
          onConfirm={updateServerMediaBinding}
        />
      ) : null}
      {editorSession && platformMedia && platformAudioTracks.canManageTracks ? (
        <MediaAudioTrackManagerDialog
          client={editorSession.client}
          primaryMediaResourceId={platformMedia.resourceId}
          primaryMediaSourceType={platformMedia.sourceType}
          parentId={editorSession.parentId}
          open={audioTrackManagerOpen}
          onOpenChange={setAudioTrackManagerOpen}
          onChanged={async () => {
            await platformAudioTracks.refresh();
          }}
        />
      ) : null}
      {editorSession ? (
        <AnnotationMediaBindingDialog
          client={editorSession.client}
          parentId={editorSession.parentId}
          open={analysisAudioDialogOpen}
          busy={platformMediaAnalysis.mutationPending}
          pickerMode="analysis-audio"
          title="选择分析音频"
          description="上传音频将完全绕过 VOD；也可固定另一项 VOD 媒资"
          onOpenChange={setAnalysisAudioDialogOpen}
          onConfirm={async (mediaResourceId) => {
            if (!mediaResourceId) return;
            const updated = await platformMediaAnalysis.updateSource({
              mode: "media_override",
              overrideMediaResourceId: mediaResourceId,
              offsetSeconds: platformMediaAnalysis.status?.setting.offsetSeconds ?? 0,
            });
            if (updated) setAnalysisAudioDialogOpen(false);
          }}
        />
      ) : null}
      <SentenceAnnotationSettingsDialog
        open={sentenceAnnotationSettingsOpen}
        roleOptions={project.sentenceAnnotationConfig.roleOptions}
        onOpenChange={setSentenceAnnotationSettingsOpen}
        onAdd={addSentenceRoleOption}
        onRename={renameSentenceRoleOption}
        onReorder={reorderSentenceRoleOption}
        onRemove={removeSentenceRoleOption}
        disabledReason={sentenceClassificationEditingBlockedReason}
      />
      <ResizableSplitLayout
        orientation="horizontal"
        initialPrimarySize={0.74}
        minPrimarySize={760}
        minSecondarySize={320}
        storageKey="layout:main-workspace"
        className="workspace-shell"
        primaryClassName="workspace-region"
        secondaryClassName="workspace-region workspace-sidebar"
        primary={(
          <LeftWorkspace
            previewDetached={isPreviewDetached}
            timelineDetached={isTimelineDetached}
            previewPanel={(
              <PreviewPanel>
                {renderPreviewWorkspace(false)}
              </PreviewPanel>
            )}
            timelinePanel={(
              <TimelinePanel>
                {renderTimelineWorkspace(false)}
              </TimelinePanel>
            )}
          />
        )}
        secondary={(
          <EditorSidebarLayout
            subtitleCollapsed={isSubtitlePanelCollapsed}
            splitCollapsed={isSplitPanelCollapsed}
            confirmationCollapsed={isConfirmationPanelCollapsed}
            subtitlePanel={(
              <SubtitleList
                subtitleLines={project.subtitleLines}
                sentenceAnnotationConfig={project.sentenceAnnotationConfig}
                currentTime={currentTime}
                selectedLineId={selectedLineId}
                collapsed={isSubtitlePanelCollapsed}
                onToggleCollapse={toggleSubtitlePanelCollapsed}
                onSelectLine={(lineId) => {
                  setLineFocusRequest({ lineId, requestId: Date.now() });
                  applySelection({ type: "line", id: lineId });
                  const line = project.subtitleLines.find((item) => item.id === lineId);
                  if (line) {
                    seekTo(line.startTime);
                  }
                }}
                onClassificationChange={updateSentenceClassification}
              />
            )}
            splitPanel={(
              <section className={["panel", "split-panel", isSplitPanelCollapsed ? "is-collapsed" : ""].join(" ")}>
                <div className="panel-header">
                  <h2>当前句逐字拆分</h2>
                  <div className="panel-header-actions">
                    {!isSplitPanelCollapsed ? <span>{activeCharacters.length} 字</span> : null}
                    <button
                      type="button"
                      className="panel-collapse-button"
                      title={isSplitPanelCollapsed ? "展开面板" : "最小化面板"}
                      aria-label={isSplitPanelCollapsed ? "展开面板" : "最小化面板"}
                      onClick={toggleSplitPanelCollapsed}
                    >
                      {isSplitPanelCollapsed ? "▸" : "—"}
                    </button>
                  </div>
                </div>
                {!isSplitPanelCollapsed ? (
                  <div className="character-grid">
                    {activeCharacters.map((item) => {
                      const isEditing = editingCharacterId === item.id && editingCharacterLocation === "split-panel";
                      const className = [
                        "character-chip",
                        selectedItem?.type === "character" && selectedItem.id === item.id ? "selected" : "",
                        currentTime >= item.startTime && currentTime <= item.endTime ? "active" : "",
                        isEditing ? "editing" : "",
                      ].join(" ");

                      if (isEditing) {
                        return (
                          <div key={item.id} className={className}>
                            <input
                              className="character-chip-input"
                              value={editingCharacterValue}
                              autoFocus
                              onChange={(event) => setEditingCharacterValue(event.target.value)}
                              onBlur={() => commitCharacterTextEdit(item.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  commitCharacterTextEdit(item.id);
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  cancelCharacterTextEdit();
                                }
                              }}
                            />
                            <small>{item.startTime.toFixed(2)} - {item.endTime.toFixed(2)}</small>
                          </div>
                        );
                      }

                      return (
                        <button
                          key={item.id}
                          className={className}
                          onClick={() => {
                            preferredCharacterEditLocationRef.current = "split-panel";
                            applySelection({ type: "character", id: item.id });
                          }}
                          onDoubleClick={() => startCharacterTextEdit(item.id, "split-panel")}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            preferredCharacterEditLocationRef.current = "split-panel";
                            applySelection({ type: "character", id: item.id });
                            setBlockContextMenu({
                              type: "character",
                              id: item.id,
                              trackId: "character-track",
                              time: item.startTime,
                              x: event.clientX,
                              y: event.clientY,
                            });
                            updateTimelinePasteTarget("character-track", item.startTime);
                          }}
                        >
                          <span>{item.char}</span>
                          <small>{item.startTime.toFixed(2)} - {item.endTime.toFixed(2)}</small>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            )}
            confirmationPanel={editorSession && confirmationPanelPlacement === "docked"
              ? renderAnnotationConfirmationWorkspace(false)
              : null}
            inspectorPanel={(
              <div className="editor-inspector-stack">
                <div className="editor-inspector-content">
                  {remoteCatchUpBlockReason ? (
                    <div className="editor-inspector-edit-gate" role="status">
                      <span>{remoteCatchUpBlockReason}</span>
                    </div>
                  ) : null}
                  {selectedItem?.type === "waveform-track" || selectedItem?.type === "spectrogram-track" ? (
                    <SpectrogramSettingsPanel
                      settings={spectrogramSettings}
                      isWaveformLoading={editorSession
                        ? platformMediaAnalysis.statusLoading || platformMediaAnalysis.assetsLoading
                        : isWaveformLoading}
                      hasWaveformData={Boolean(displayedWaveformData)}
                      waveformVisible={waveformVisible}
                      isLoading={editorSession
                        ? platformMediaAnalysis.statusLoading || platformMediaAnalysis.assetsLoading
                        : isSpectrogramLoading}
                      hasData={Boolean(displayedSpectrogramData)}
                      analysisError={editorSession ? null : localAnalysisError}
                      onSettingsChange={setSpectrogramSettings}
                      onWaveformVisibleChange={setWaveformVisible}
                      focusRequest={inspectorFocusRequest}
                      platformAnalysis={editorSession ? {
                        status: platformMediaAnalysis.status,
                        canWrite: editorSession.canWrite,
                        loading: platformMediaAnalysis.statusLoading,
                        mutationPending: platformMediaAnalysis.mutationPending,
                        error: platformMediaAnalysis.error,
                        onChooseSource: () => setAnalysisAudioDialogOpen(true),
                        onRestoreAutomatic: () => {
                          void platformMediaAnalysis.updateSource({
                            mode: "auto",
                            offsetSeconds: 0,
                          });
                        },
                        onStartAnalysis: (force) => {
                          void platformMediaAnalysis.startAnalysis(force);
                        },
                        preloadPending: platformMediaAnalysis.preloadPending,
                        preloadProgress: platformMediaAnalysis.preloadProgress,
                        preloadError: platformMediaAnalysis.preloadError,
                        onStartPreload: () => {
                          void platformMediaAnalysis.startPreload();
                        },
                        onCancelPreload: platformMediaAnalysis.cancelPreload,
                      } : undefined}
                    />
                  ) : (
                    <InspectorPanel
                      selectedItem={selectedItem}
                      subtitleLines={project.subtitleLines}
                      sentenceAnnotationConfig={project.sentenceAnnotationConfig}
                      characterAnnotations={project.characterAnnotations}
                      gongcheAnnotations={project.gongcheAnnotations}
                      banyanSections={project.banyanSections}
                      banyanMarks={project.banyanMarks}
                      banyanGridVisible={banyanGridVisible}
                      banyanTrackVisible={banyanTrackVisible}
                      actionAnnotations={project.actionAnnotations}
                      builtinTracks={project.builtinTracks}
                      customTracks={project.customTracks}
                      trackDefinitions={timelineTrackDefinitions}
                      trackSnapEnabled={trackSnapEnabled}
                      onCharacterUpdate={updateCharacter}
                      onLineClassificationChange={updateSentenceClassification}
                      onOpenSentenceAnnotationSettings={() => setSentenceAnnotationSettingsOpen(true)}
                      onCreateGongcheBlock={createGongcheBlock}
                      onGongcheBlockUpdate={(id, changes) => updateGongcheBlock(id, changes)}
                      onImportGongcheText={importGongcheText}
                      onGenerateBanyanFromGongche={generateBanyanFromGongche}
                      onBanyanGridVisibleChange={setBanyanGridVisible}
                      onBanyanTrackVisibleChange={setBanyanTrackVisible}
                      onBanyanMarkUpdate={(id, changes) => updateBanyanMark(id, changes)}
                      onActionUpdate={updateAction}
                      onAttachedPointUpdate={commitAttachedPoint}
                      onTrackWaveformSnapChange={updateTrackWaveformSnap}
                      onTrackAutoLoopRangeChange={updateTrackAutoLoopRange}
                      onAttachedPointTrackParentSnapChange={updateAttachedPointTrackParentSnap}
                      onSelectParentTrack={(trackId) =>
                        applySelection(
                          activeBuiltinTrackIds.has(trackId as BuiltinTrackId)
                            ? { type: "builtin-track", id: trackId as BuiltinTrackId }
                            : { type: "custom-track", id: trackId },
                        )
                      }
                      onBuiltinTrackRename={renameBuiltinTrack}
                      onDeleteBuiltinTrack={deleteBuiltinTrack}
                      onAddAttachedPointTrack={addAttachedPointTrack}
                      onToggleAttachedPointTracks={toggleAttachedPointTracks}
                      onSelectAttachedPointTrack={(trackId, parentTrackId) =>
                        applySelection({ type: "attached-point-track", id: trackId, parentTrackId })
                      }
                      onAttachedPointTrackRename={renameAttachedPointTrack}
                      onAttachedPointTrackTypeOptionChange={updateAttachedPointTrackTypeOption}
                      onAddAttachedPointTrackTypeOption={addAttachedPointTrackTypeOption}
                      onMoveAttachedPointTrackTypeOption={moveAttachedPointTrackTypeOption}
                      onReorderAttachedPointTrackTypeOption={reorderAttachedPointTrackTypeOption}
                      onRemoveAttachedPointTrackTypeOption={removeAttachedPointTrackTypeOption}
                      onDeleteAttachedPointTrack={deleteAttachedPointTrack}
                      onCustomTrackRename={renameCustomTrack}
                      onCustomTrackColorChange={updateCustomTrackColor}
                      onCustomTrackTypeOptionChange={updateCustomTrackTypeOption}
                      onAddCustomTrackTypeOption={addCustomTrackTypeOption}
                      onMoveCustomTrackTypeOption={moveCustomTrackTypeOption}
                      onReorderCustomTrackTypeOption={reorderCustomTrackTypeOption}
                      onRemoveCustomTrackTypeOption={removeCustomTrackTypeOption}
                      onDeleteCustomTrack={deleteCustomTrack}
                      onCustomTrackBranchingEnabledChange={setCustomTrackBranchingEnabled}
                      onCustomTrackBranchDisplayModeChange={setCustomTrackBranchDisplayMode}
                      onAddCustomTrackBranchLane={addCustomTrackBranchLane}
                      onCustomTrackBranchLaneRename={renameCustomTrackBranchLane}
                      onCustomTrackBranchLaneColorChange={updateCustomTrackBranchLaneColor}
                      onDeleteCustomTrackBranchLane={deleteCustomTrackBranchLane}
                      inspectorFocusRequest={inspectorFocusRequest}
                      onCustomBlockUpdate={updateCustomBlock}
                      onDeleteSelected={deleteSelected}
                    />
                  )}
                </div>
              </div>
            )}
          />
        )}
      />
      <div className="workspace-float-layer">
        {previewDetachedWindow && !previewDetachedWindow.closed ? (
          <FloatingPanelWindow
            title="视频播放器"
            targetWindow={previewDetachedWindow}
            onClose={closePreviewDetachedWindow}
            onGlobalKeyDown={handleGlobalKeyDown}
          >
            {renderPreviewWorkspace(true)}
          </FloatingPanelWindow>
        ) : null}
        {timelineDetachedWindow && !timelineDetachedWindow.closed ? (
          <FloatingPanelWindow
            title="多轨时间轴"
            targetWindow={timelineDetachedWindow}
            onClose={closeTimelineDetachedWindow}
            onGlobalKeyDown={handleGlobalKeyDown}
          >
            {renderTimelineWorkspace(true)}
          </FloatingPanelWindow>
        ) : null}
        {isConfirmationDetached && confirmationDetachedWindow ? (
          <FloatingPanelWindow
            title="标注审核"
            targetWindow={confirmationDetachedWindow}
            onClose={() => closeConfirmationDetachedWindow("docked")}
            onGlobalKeyDown={handleGlobalKeyDown}
          >
            {renderAnnotationConfirmationWorkspace(true)}
          </FloatingPanelWindow>
        ) : null}
      </div>
      {blockContextMenu ? (
        <div
          ref={blockContextMenuRef}
          className="character-context-menu"
          style={{
            left: blockContextMenuPosition?.left ?? blockContextMenu.x + CONTEXT_MENU_GAP,
            top: blockContextMenuPosition?.top ?? blockContextMenu.y + CONTEXT_MENU_GAP,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {blockContextMenu.type === "lane" ? (
            <>
              <div className="character-context-menu-label">时间轴</div>
              {contextMenuLaneCustomTrack?.branching?.enabled ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      // 分叉子轨只是显示层；展开/合并必须写回父自定义轨道。
                      setCustomTrackBranchDisplayMode(
                        contextMenuLaneCustomTrack.id,
                        contextMenuLaneCustomTrack.branching?.displayMode === "expanded" ? "merged" : "expanded",
                      );
                      setBlockContextMenu(null);
                    }}
                  >
                    {contextMenuLaneCustomTrack.branching.displayMode === "expanded" ? "合并显示分叉" : "展开显示分叉"}
                  </button>
                  <button
                    type="button"
                    onClick={() => openBranchTrackSettings(contextMenuLaneCustomTrack.id)}
                  >
                    设置分叉轨道
                  </button>
                  <div className="character-context-menu-divider" />
                </>
              ) : null}
              {contextMenuLaneCustomTrack && !contextMenuLaneCustomTrack.branching?.enabled ? (
                <>
                  <button
                    type="button"
                    onClick={() => enableBranchTrackAndOpenSettings(contextMenuLaneCustomTrack.id)}
                  >
                    新增分叉轨道...
                  </button>
                  <div className="character-context-menu-divider" />
                </>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
            </>
          ) : null}
          {contextMenuLine ? (
            <>
              <div
                className="character-context-menu-label sentence-context-summary"
                title={contextMenuLine.text}
              >
                句级标注 · {contextMenuLine.text}
              </div>
              <div className="character-context-menu-divider" />
              <div className="character-context-menu-label">发声方式</div>
              <button
                type="button"
                className={contextMenuLine.deliveryMode === null ? "menu-option-active" : ""}
                disabled={Boolean(sentenceClassificationEditingBlockedReason)}
                title={sentenceClassificationEditingBlockedReason}
                onClick={() => {
                  updateSentenceClassification(contextMenuLine.id, { deliveryMode: null });
                  setBlockContextMenu(null);
                }}
              >
                {contextMenuLine.deliveryMode === null ? "✓ 未选择" : "未选择"}
              </button>
              {SENTENCE_DELIVERY_MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={contextMenuLine.deliveryMode === option.value ? "menu-option-active" : ""}
                  disabled={Boolean(sentenceClassificationEditingBlockedReason)}
                  title={sentenceClassificationEditingBlockedReason}
                  onClick={() => {
                    updateSentenceClassification(contextMenuLine.id, { deliveryMode: option.value });
                    setBlockContextMenu(null);
                  }}
                >
                  {contextMenuLine.deliveryMode === option.value ? `✓ ${option.label}` : option.label}
                </button>
              ))}
              <div className="character-context-menu-divider" />
              <div className="character-context-menu-label">角色行当</div>
              <button
                type="button"
                className={contextMenuLine.roleType === null ? "menu-option-active" : ""}
                disabled={Boolean(sentenceClassificationEditingBlockedReason)}
                title={sentenceClassificationEditingBlockedReason}
                onClick={() => {
                  updateSentenceClassification(contextMenuLine.id, { roleType: null });
                  setBlockContextMenu(null);
                }}
              >
                {contextMenuLine.roleType === null ? "✓ 未选择" : "未选择"}
              </button>
              {project.sentenceAnnotationConfig.roleOptions.length === 0 ? (
                <button type="button" disabled>尚未设置角色行当</button>
              ) : project.sentenceAnnotationConfig.roleOptions.map((role) => (
                <button
                  key={role}
                  type="button"
                  className={contextMenuLine.roleType === role ? "menu-option-active" : ""}
                  disabled={Boolean(sentenceClassificationEditingBlockedReason)}
                  title={sentenceClassificationEditingBlockedReason}
                  onClick={() => {
                    updateSentenceClassification(contextMenuLine.id, { roleType: role });
                    setBlockContextMenu(null);
                  }}
                >
                  {contextMenuLine.roleType === role ? `✓ ${role}` : role}
                </button>
              ))}
              <div className="character-context-menu-divider" />
              <button
                type="button"
                onClick={() => {
                  setBlockContextMenu(null);
                  setSentenceAnnotationSettingsOpen(true);
                }}
              >
                管理角色行当...
              </button>
            </>
          ) : null}
          {contextMenuCharacter ? (
            <>
              <button
                type="button"
                onClick={() => {
                  copyTimelineSelection();
                  setBlockContextMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => {
                  cutTimelineSelection();
                }}
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
              <div className="character-context-menu-divider" />
              {selectedCharacterLineMergeContext ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      mergeSelectedCharactersIntoLine(contextMenuCharacter.id);
                      setBlockContextMenu(null);
                    }}
                  >
                    合并为一句
                  </button>
                  {selectedCharacterLineMergeContext.canMergeIntoPrevious ? (
                    <button
                      type="button"
                      onClick={() => {
                        mergeSelectedCharactersIntoLine(contextMenuCharacter.id, "previous");
                        setBlockContextMenu(null);
                      }}
                    >
                      合并后并入前一句
                    </button>
                  ) : null}
                  {selectedCharacterLineMergeContext.canMergeIntoNext ? (
                    <button
                      type="button"
                      onClick={() => {
                        mergeSelectedCharactersIntoLine(contextMenuCharacter.id, "next");
                        setBlockContextMenu(null);
                      }}
                    >
                      合并后并入后一句
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  {contextMenuSplitCharacters.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => {
                        applyCharacterLineAction(contextMenuCharacter.id, "split-block");
                        setBlockContextMenu(null);
                      }}
                    >
                      拆分
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      applyCharacterLineAction(contextMenuCharacter.id, "set-line-start");
                      setBlockContextMenu(null);
                    }}
                  >
                    设为本句首字
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      applyCharacterLineAction(contextMenuCharacter.id, "set-line-end");
                      setBlockContextMenu(null);
                    }}
                  >
                    设为本句末字
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      applyCharacterLineAction(contextMenuCharacter.id, "merge-prev-line");
                      setBlockContextMenu(null);
                    }}
                  >
                    并入前一句
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      applyCharacterLineAction(contextMenuCharacter.id, "merge-next-line");
                      setBlockContextMenu(null);
                    }}
                  >
                    并入后一句
                  </button>
                </>
              )}
            </>
          ) : null}
          {contextMenuAction ? (
            <>
              <button
                type="button"
                onClick={() => {
                  copyTimelineSelection();
                  setBlockContextMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => {
                  cutTimelineSelection();
                }}
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
              <div className="character-context-menu-divider" />
              <div className="character-context-menu-label">
                {contextMenuActionTrack?.name ?? "动作标签"}
              </div>
              {[contextMenuAction.label].map((label) => (
                <button
                  key={label}
                  type="button"
                  className={contextMenuAction.label === label ? "menu-option-active" : ""}
                  onClick={() => {
                    applyActionLabel(contextMenuAction.id, label);
                    setBlockContextMenu(null);
                  }}
                >
                  {contextMenuAction.label === label ? `✓ ${label}` : label}
                </button>
              ))}
              <div className="character-context-menu-divider" />
              <button
                type="button"
                onClick={() => createContextMenuTypeOption("action")}
              >
                新建类型...
              </button>
            </>
          ) : null}
          {contextMenuCustomBlock && contextMenuCustomTrack ? (
            <>
              <button
                type="button"
                onClick={() => {
                  copyTimelineSelection();
                  setBlockContextMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => {
                  cutTimelineSelection();
                }}
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
              <div className="character-context-menu-divider" />
              <div className="character-context-menu-label">
                {contextMenuCustomTrack.name}
              </div>
              {contextMenuCustomTrack.typeOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={contextMenuCustomBlock.type === option ? "menu-option-active" : ""}
                  onClick={() => {
                    applyCustomBlockType(contextMenuCustomTrack.id, contextMenuCustomBlock.id, option);
                    setBlockContextMenu(null);
                  }}
                >
                  {contextMenuCustomBlock.type === option ? `✓ ${option}` : option}
                </button>
              ))}
              <div className="character-context-menu-divider" />
              <button
                type="button"
                onClick={() => createContextMenuTypeOption("custom-block")}
              >
                新建类型...
              </button>
              {contextMenuCustomTrack.branching?.enabled ? (
                <>
                  <div className="character-context-menu-divider" />
                  <button
                    type="button"
                    onClick={() =>
                      openBlockBranchScopeSettings(contextMenuCustomTrack.id, contextMenuCustomBlock.id)
                    }
                  >
                    设置分叉归属
                  </button>
                </>
              ) : null}
            </>
          ) : null}
          {contextMenuAttachedPoint ? (
            <>
              <div className="character-context-menu-label">附属点</div>
              <button
                type="button"
                onClick={() => {
                  copyTimelineSelection();
                  setBlockContextMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => {
                  cutTimelineSelection();
                }}
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteSelected();
                  setBlockContextMenu(null);
                }}
              >
                删除
              </button>
              <div className="character-context-menu-divider" />
              <div className="character-context-menu-label">
                {contextMenuAttachedPointTrack?.name ?? "点类型"}
              </div>
              {(contextMenuAttachedPointTrack?.typeOptions ?? [contextMenuAttachedPoint.label]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={contextMenuAttachedPoint.label === option ? "menu-option-active" : ""}
                  onClick={() => {
                    if (blockContextMenu?.type !== "attached-point") {
                      return;
                    }
                    applyAttachedPointLabel(blockContextMenu.trackId, contextMenuAttachedPoint.id, option);
                    setBlockContextMenu(null);
                  }}
                >
                  {contextMenuAttachedPoint.label === option ? `✓ ${option}` : option}
                </button>
              ))}
              <div className="character-context-menu-divider" />
              <button
                type="button"
                onClick={() => createContextMenuTypeOption("attached-point")}
              >
                新建类型...
              </button>
            </>
          ) : null}
          {contextMenuBanyanMark ? (
            <>
              <div className="character-context-menu-label">板眼点</div>
              <button
                type="button"
                onClick={() => {
                  copyTimelineSelection();
                  setBlockContextMenu(null);
                }}
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => {
                  cutTimelineSelection();
                }}
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteSelected();
                  setBlockContextMenu(null);
                }}
              >
                删除
              </button>
              <div className="character-context-menu-divider" />
              {BANYAN_CONTEXT_SUBTYPE_GROUPS.map((group) => (
                <div key={group.role}>
                  <div className="character-context-menu-label">{group.label}</div>
                  {group.subtypes.map((subtype) => (
                    <button
                      key={subtype}
                      type="button"
                      className={contextMenuBanyanMark.subtype === subtype ? "menu-option-active" : ""}
                      onClick={() => {
                        applyBanyanMarkSubtype(contextMenuBanyanMark.id, subtype);
                        setBlockContextMenu(null);
                      }}
                    >
                      {contextMenuBanyanMark.subtype === subtype
                        ? `✓ ${getBanyanSubtypeLabel(subtype)}`
                        : getBanyanSubtypeLabel(subtype)}
                    </button>
                  ))}
                </div>
              ))}
            </>
          ) : null}
          {contextMenuGongcheBlock ? (
            <>
              <div className="character-context-menu-label">工尺谱块</div>
              <button
                type="button"
                onClick={() => {
                  applySelection({ type: "gongche-block", id: contextMenuGongcheBlock.id });
                  setBlockContextMenu(null);
                }}
              >
                打开编辑
              </button>
              <button
                type="button"
                onClick={() => {
                  pasteTimelineClipboard();
                }}
                disabled={!canPasteTimelineClipboard}
              >
                粘贴到此处
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteSelected();
                  setBlockContextMenu(null);
                }}
              >
                删除
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {pendingPasteState ? (
        <div className="app-modal-backdrop" onClick={() => applyPendingPasteResolution("cancel")}>
          <div className="app-modal" onClick={(event) => event.stopPropagation()}>
            <h2>检测到粘贴冲突</h2>
            <p>目标时间范围内已有现有块。请选择这次粘贴的处理方式。</p>
            <p>
              当前共有 {pendingPasteState.conflicts.length} 个冲突块，涉及{" "}
              {new Set(pendingPasteState.conflicts.map((conflict) => conflict.trackName)).size} 条轨道。
            </p>
            <div className="app-modal-actions">
              <button type="button" className="secondary" onClick={() => applyPendingPasteResolution("cancel")}>
                取消
              </button>
              <button type="button" onClick={() => applyPendingPasteResolution("overwrite")}>
                覆盖
              </button>
              <button type="button" onClick={() => applyPendingPasteResolution("replace")}>
                替换
              </button>
              <button type="button" onClick={() => applyPendingPasteResolution("keep-original")}>
                保留原块
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingImportMergeState ? (
        <div className="app-modal-backdrop" onClick={() => setPendingImportMergeState(null)}>
          <div className="app-modal import-merge-modal" onClick={(event) => event.stopPropagation()}>
            <h2>整合外部标注</h2>
            <p>已读取项目文件：{pendingImportMergeState.fileName}</p>
            {pendingImportMergeState.videoWarning ? (
              <p className="import-merge-warning">{pendingImportMergeState.videoWarning}</p>
            ) : (
              <p>已按轨道类型和名称给出一版默认对齐结果。你可以在确认后替换内容或叠加内容。</p>
            )}
            <div className="import-merge-list">
              {pendingImportMergeState.rows.map((row) => {
                const targetOptions = getImportMergeTargetOptions(project, pendingImportMergeState.rows, row);
                const normalizedTargetChoice = getNormalizedImportMergeTargetChoice(
                  project,
                  pendingImportMergeState.rows,
                  row,
                );
                const preview = importMergePreviews[row.key];
                const isDisabled = Boolean(preview?.disabledReason);
                return (
                  <div
                    key={row.key}
                    className={[
                      "import-merge-row",
                      row.kind === "attached-point-track" ? "is-attached" : "",
                      isDisabled ? "is-disabled" : "",
                    ].join(" ")}
                  >
                    <div className="import-merge-row-copy">
                      <strong>{row.sourceTrackName}</strong>
                      <span>
                        {getImportMergeRowTypeLabel(row)} · {row.importedCount} 项
                        {row.sourceParentTrackName ? ` · 附属于 ${row.sourceParentTrackName}` : ""}
                      </span>
                      {preview?.disabledReason ? (
                        <span className="import-merge-note">{preview.disabledReason}</span>
                      ) : normalizedTargetChoice === IMPORT_MERGE_SKIP ? (
                        <span className="import-merge-note">当前将跳过这条轨道。</span>
                      ) : row.mergeMode === "replace" ? (
                        <span className="import-merge-note">将替换目标轨当前的 {preview?.existingCount ?? 0} 项内容。</span>
                      ) : preview && preview.duplicateCount > 0 ? (
                        <span className="import-merge-note">
                          检测到 {preview.duplicateCount} 项重复内容，叠加时会自动跳过。
                        </span>
                      ) : (
                        <span className="import-merge-note">将把内容叠加到目标轨道。</span>
                      )}
                    </div>
                    <div className="import-merge-row-controls">
                      <label>
                        <span>目标轨道</span>
                        <select
                          value={normalizedTargetChoice}
                          onChange={(event) => updateImportMergeRow(row.key, { targetChoice: event.target.value })}
                        >
                          {targetOptions.map((option) => (
                            <option key={option.value} value={option.value} disabled={option.disabled}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span>导入方式</span>
                        <select
                          value={row.mergeMode}
                          disabled={isDisabled || normalizedTargetChoice === IMPORT_MERGE_SKIP}
                          onChange={(event) =>
                            updateImportMergeRow(row.key, { mergeMode: event.target.value as ImportMergeMode })}
                        >
                          <option value="overlay">叠加内容</option>
                          <option value="replace">替换内容</option>
                        </select>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="app-modal-actions">
              <button type="button" className="secondary" onClick={() => setPendingImportMergeState(null)}>
                取消
              </button>
              <button type="button" onClick={applyImportMerge}>
                整合导入
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {manualVideoRelinkPrompt ? (
        <div className="app-modal-backdrop" onClick={() => setManualVideoRelinkPrompt(null)}>
          <div className="app-modal" onClick={(event) => event.stopPropagation()}>
            <h2>需要重新导入视频</h2>
            {getManualVideoImportMessageLines(manualVideoRelinkPrompt).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <div className="app-modal-actions">
              <button
                type="button"
                onClick={() => {
                  videoFileInputRef.current?.click();
                }}
              >
                选择视频文件
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setManualVideoRelinkPrompt(null)}
              >
                稍后再说
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

type ResolvedClipboardSelectionItem =
  | {
      type: "character";
      id: string;
      trackId: "character-track";
      lineId: string;
      char: string;
      tone: CharacterToneInfo | null;
      startTime: number;
      endTime: number;
    }
  | {
      type: "action";
      id: string;
      trackId: string;
      label: string;
      startTime: number;
      endTime: number;
    }
  | {
      type: "custom-block";
      id: string;
      trackId: string;
      trackType: CustomTrackType;
      typeValue: string;
      text?: string;
      startTime: number;
      endTime: number;
    }
  | {
      type: "attached-point";
      id: string;
      trackId: string;
      parentTrackId: string;
      label: string;
      startTime: number;
      endTime: number;
    }
  | (BanyanMark & {
      type: "banyan-mark";
      trackId: "banyan-track";
      startTime: number;
      endTime: number;
    });

function locatePointTrack(
  project: ProjectData,
  pointTrackId: string,
) {
  for (const track of project.builtinTracks) {
    const pointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
    if (pointTrack) {
      return {
        parentTrack: track,
        pointTrack,
      };
    }
  }
  for (const track of project.customTracks) {
    const pointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === pointTrackId);
    if (pointTrack) {
      return {
        parentTrack: track,
        pointTrack,
      };
    }
  }
  return null;
}

function buildInitialImportMergeRows(
  currentProject: ProjectData,
  sourceProject: ProjectData,
) {
  const rows: ImportMergeRow[] = [];
  const orderedSourceTrackIds = sourceProject.activeTrackOrder.length > 0
    ? sourceProject.activeTrackOrder
    : [
        ...sourceProject.builtinTracks.map((track) => track.id),
        ...sourceProject.customTracks.map((track) => track.id),
      ];

  for (const trackId of orderedSourceTrackIds) {
    const builtinTrack = sourceProject.builtinTracks.find((track) => track.id === trackId);
    if (builtinTrack) {
      const importedCount = getImportMergeBuiltinItemCount(sourceProject, builtinTrack.id);
      if (importedCount > 0 || builtinTrack.attachedPointTracks.length > 0) {
        rows.push({
          key: `builtin:${builtinTrack.id}`,
          kind: "builtin-track",
          sourceTrackId: builtinTrack.id,
          sourceTrackName: builtinTrack.name,
          sourceTrackType: builtinTrack.type,
          importedCount,
          targetChoice: currentProject.builtinTracks.some((track) => track.id === builtinTrack.id)
            ? builtinTrack.id
            : IMPORT_MERGE_NEW,
          mergeMode: "overlay",
        });
      }
      for (const pointTrack of builtinTrack.attachedPointTracks) {
        if (pointTrack.points.length === 0) {
          continue;
        }
        const targetBuiltinTrack = currentProject.builtinTracks.find((track) => track.id === builtinTrack.id);
        const matchedPointTrack = targetBuiltinTrack?.attachedPointTracks.find((track) => track.name === pointTrack.name);
        rows.push({
          key: `attached:${builtinTrack.id}:${pointTrack.id}`,
          kind: "attached-point-track",
          sourceTrackId: pointTrack.id,
          sourceTrackName: pointTrack.name,
          sourceTrackType: "attached-point",
          sourceParentKey: `builtin:${builtinTrack.id}`,
          sourceParentTrackId: builtinTrack.id,
          sourceParentTrackName: builtinTrack.name,
          importedCount: pointTrack.points.length,
          targetChoice: matchedPointTrack?.id ?? IMPORT_MERGE_NEW,
          mergeMode: "overlay",
        });
      }
      continue;
    }

    const customTrack = sourceProject.customTracks.find((track) => track.id === trackId);
    if (!customTrack) {
      continue;
    }
    const importedCount = customTrack.blocks.length;
    if (importedCount > 0 || customTrack.attachedPointTracks.length > 0) {
      const matchedTrack = currentProject.customTracks.find((track) =>
        track.trackType === customTrack.trackType && track.name === customTrack.name);
      rows.push({
        key: `custom:${customTrack.id}`,
        kind: "custom-track",
        sourceTrackId: customTrack.id,
        sourceTrackName: customTrack.name,
        sourceTrackType: customTrack.trackType === "text" ? "custom-text" : "custom-action",
        importedCount,
        targetChoice: matchedTrack?.id ?? IMPORT_MERGE_NEW,
        mergeMode: "overlay",
      });
    }
    for (const pointTrack of customTrack.attachedPointTracks) {
      if (pointTrack.points.length === 0) {
        continue;
      }
      const matchedTrack = currentProject.customTracks.find((track) =>
        track.trackType === customTrack.trackType && track.name === customTrack.name);
      const matchedPointTrack = matchedTrack?.attachedPointTracks.find((track) => track.name === pointTrack.name);
      rows.push({
        key: `attached:${customTrack.id}:${pointTrack.id}`,
        kind: "attached-point-track",
        sourceTrackId: pointTrack.id,
        sourceTrackName: pointTrack.name,
        sourceTrackType: "attached-point",
        sourceParentKey: `custom:${customTrack.id}`,
        sourceParentTrackId: customTrack.id,
        sourceParentTrackName: customTrack.name,
        importedCount: pointTrack.points.length,
        targetChoice: matchedPointTrack?.id ?? IMPORT_MERGE_NEW,
        mergeMode: "overlay",
      });
    }
  }

  return rows;
}

function getImportMergeVideoWarning(
  currentProject: ProjectData,
  sourceProject: ProjectData,
) {
  const currentVideoName = currentProject.video.name?.trim();
  const sourceVideoName = sourceProject.video.name?.trim();
  const currentVideoUrl = normalizeProjectVideoUrl(currentProject.video.url);
  const sourceVideoUrl = normalizeProjectVideoUrl(sourceProject.video.url);

  if (currentVideoName && sourceVideoName && currentVideoName !== sourceVideoName) {
    return `当前项目视频为“${currentVideoName}”，导入项目视频为“${sourceVideoName}”。请先确认它们对应的是同一视频。`;
  }
  if (currentVideoUrl && sourceVideoUrl && currentVideoUrl !== sourceVideoUrl) {
    return "当前项目与导入项目的视频链接不一致。请先确认它们对应的是同一视频。";
  }
  return null;
}

function getImportMergeTargetOptions(
  currentProject: ProjectData,
  rows: ImportMergeRow[],
  row: ImportMergeRow,
): ImportMergeTargetOption[] {
  if (row.kind === "builtin-track") {
    const builtinTrack = currentProject.builtinTracks.find((track) => track.id === row.sourceTrackId);
    return [
      ...(builtinTrack ? [{ value: builtinTrack.id, label: `对齐到 ${builtinTrack.name}` }] : []),
      { value: IMPORT_MERGE_NEW, label: "新建对应内建轨" },
      { value: IMPORT_MERGE_SKIP, label: "跳过此轨道" },
    ];
  }

  if (row.kind === "custom-track") {
    const compatibleTracks = currentProject.customTracks.filter((track) =>
      (row.sourceTrackType === "custom-text" && track.trackType === "text") ||
      (row.sourceTrackType === "custom-action" && track.trackType === "action"));
    return [
      ...compatibleTracks.map((track) => ({
        value: track.id,
        label: `对齐到 ${track.name}`,
      })),
      { value: IMPORT_MERGE_NEW, label: "新建同类轨道" },
      { value: IMPORT_MERGE_SKIP, label: "跳过此轨道" },
    ];
  }

  const parentRow = rows.find((candidate) => candidate.key === row.sourceParentKey);
  if (!parentRow) {
    return [{ value: IMPORT_MERGE_SKIP, label: "跳过此轨道" }];
  }
  const normalizedParentChoice = getNormalizedImportMergeTargetChoice(currentProject, rows, parentRow);
  if (normalizedParentChoice === IMPORT_MERGE_SKIP) {
    return [{ value: IMPORT_MERGE_SKIP, label: "父轨道已跳过" }];
  }
  if (normalizedParentChoice === IMPORT_MERGE_NEW) {
    return [
      { value: IMPORT_MERGE_NEW, label: "在新父轨下新建打点轨" },
      { value: IMPORT_MERGE_SKIP, label: "跳过此轨道" },
    ];
  }
  const parentTrack = findTopLevelTrackById(currentProject, normalizedParentChoice);
  const attachedPointTracks = parentTrack?.attachedPointTracks ?? [];
  return [
    ...attachedPointTracks.map((track) => ({
      value: track.id,
      label: `对齐到 ${track.name}`,
    })),
    { value: IMPORT_MERGE_NEW, label: "在父轨下新建打点轨" },
    { value: IMPORT_MERGE_SKIP, label: "跳过此轨道" },
  ];
}

function getNormalizedImportMergeTargetChoice(
  currentProject: ProjectData,
  rows: ImportMergeRow[],
  row: ImportMergeRow,
) {
  const options = getImportMergeTargetOptions(currentProject, rows, row);
  return options.some((option) => option.value === row.targetChoice)
    ? row.targetChoice
    : (options[0]?.value ?? IMPORT_MERGE_SKIP);
}

function getImportMergePreview(
  currentProject: ProjectData,
  sourceProject: ProjectData,
  rows: ImportMergeRow[],
  row: ImportMergeRow,
): ImportMergePreview {
  const targetOptions = getImportMergeTargetOptions(currentProject, rows, row);
  const normalizedTargetChoice = getNormalizedImportMergeTargetChoice(currentProject, rows, row);
  const targetLabel = targetOptions.find((option) => option.value === normalizedTargetChoice)?.label ?? "未选择";

  if (row.kind === "attached-point-track") {
    const parentRow = rows.find((candidate) => candidate.key === row.sourceParentKey);
    const normalizedParentChoice = parentRow
      ? getNormalizedImportMergeTargetChoice(currentProject, rows, parentRow)
      : IMPORT_MERGE_SKIP;
    if (!parentRow || normalizedParentChoice === IMPORT_MERGE_SKIP) {
      return {
        targetLabel,
        importedCount: row.importedCount,
        existingCount: 0,
        duplicateCount: 0,
        disabledReason: "父轨道当前设置为跳过，附属打点轨不会导入。",
      };
    }
  }

  if (normalizedTargetChoice === IMPORT_MERGE_SKIP || normalizedTargetChoice === IMPORT_MERGE_NEW) {
    return {
      targetLabel,
      importedCount: row.importedCount,
      existingCount: 0,
      duplicateCount: 0,
      disabledReason: null,
    };
  }

  return {
    targetLabel,
    importedCount: row.importedCount,
    existingCount: getExistingImportMergeItemCount(currentProject, normalizedTargetChoice, row),
    duplicateCount: countImportMergeDuplicates(currentProject, sourceProject, normalizedTargetChoice, row),
    disabledReason: null,
  };
}

function prepareImportMerge(
  currentProject: ProjectData,
  _sourceProject: ProjectData,
  rows: ImportMergeRow[],
) {
  const plans = rows.map((row) => ({
    ...row,
    targetChoice: getNormalizedImportMergeTargetChoice(currentProject, rows, row),
  }));
  return {
    plans,
    warnings: [] as string[],
    skippedAll: plans.every((row) => row.targetChoice === IMPORT_MERGE_SKIP),
  };
}

function applyPreparedImportMerge(
  currentProject: ProjectData,
  sourceProject: ProjectData,
  plans: ImportMergeRow[],
) {
  let nextProject = cloneProjectForMerge(currentProject);
  const resolvedTargetIds = new Map<string, string | null>();

  for (const row of plans.filter((candidate) => candidate.kind !== "attached-point-track")) {
    if (row.targetChoice === IMPORT_MERGE_SKIP) {
      resolvedTargetIds.set(row.key, null);
      continue;
    }

    if (row.kind === "builtin-track") {
      const sourceTrack = sourceProject.builtinTracks.find((track) => track.id === row.sourceTrackId);
      if (!sourceTrack) {
        resolvedTargetIds.set(row.key, null);
        continue;
      }
      const targetTrackId: BuiltinTrackId = row.targetChoice === IMPORT_MERGE_NEW
        ? ensureBuiltinTrackForMerge(nextProject, sourceTrack)
        : row.targetChoice as BuiltinTrackId;
      resolvedTargetIds.set(row.key, targetTrackId);
      nextProject = mergeBuiltinTrackFromImport(nextProject, sourceProject, sourceTrack, targetTrackId, row.mergeMode);
      continue;
    }

    const sourceTrack = sourceProject.customTracks.find((track) => track.id === row.sourceTrackId);
    if (!sourceTrack) {
      resolvedTargetIds.set(row.key, null);
      continue;
    }
    const targetTrackId = row.targetChoice === IMPORT_MERGE_NEW
      ? createCustomTrackForMerge(nextProject, sourceTrack)
      : row.targetChoice;
    resolvedTargetIds.set(row.key, targetTrackId);
    nextProject = mergeCustomTrackFromImport(nextProject, sourceTrack, targetTrackId, row.mergeMode);
  }

  for (const row of plans.filter((candidate) => candidate.kind === "attached-point-track")) {
    if (row.targetChoice === IMPORT_MERGE_SKIP) {
      continue;
    }
    const parentTargetId = row.sourceParentKey ? resolvedTargetIds.get(row.sourceParentKey) : null;
    if (!parentTargetId) {
      continue;
    }
    const sourceTrack = findAttachedPointTrackInProject(sourceProject, row.sourceParentTrackId ?? "", row.sourceTrackId);
    if (!sourceTrack) {
      continue;
    }
    const targetTrackId = row.targetChoice === IMPORT_MERGE_NEW
      ? createAttachedPointTrackForMerge(nextProject, parentTargetId, sourceTrack)
      : row.targetChoice;
    nextProject = mergeAttachedPointTrackFromImport(
      nextProject,
      parentTargetId,
      sourceTrack,
      targetTrackId,
      row.mergeMode,
    );
  }

  return nextProject;
}

function getImportMergeRowTypeLabel(row: ImportMergeRow) {
  if (row.kind === "attached-point-track") {
    return "附属打点轨";
  }
  if (row.sourceTrackType === "character") {
    return "逐字轨";
  }
  if (row.sourceTrackType === "action") {
    return "动作轨";
  }
  if (row.sourceTrackType === "custom-text") {
    return "自定义文字轨";
  }
  return "自定义动作轨";
}

function getImportMergeBuiltinItemCount(project: ProjectData, trackId: string) {
  if (trackId === "character-track") {
    return project.characterAnnotations.length;
  }
  return project.actionAnnotations.filter((item) => item.trackId === trackId).length;
}

function getExistingImportMergeItemCount(
  project: ProjectData,
  targetTrackId: string,
  row: ImportMergeRow,
) {
  if (row.kind === "builtin-track") {
    if (row.sourceTrackType === "character") {
      return project.characterAnnotations.length;
    }
    return project.actionAnnotations.filter((item) => item.trackId === targetTrackId).length;
  }
  if (row.kind === "custom-track") {
    return project.customTracks.find((track) => track.id === targetTrackId)?.blocks.length ?? 0;
  }
  const parentTrack = findTopLevelTrackByAttachedPointTrackId(project, targetTrackId);
  return parentTrack?.attachedPointTracks.find((track) => track.id === targetTrackId)?.points.length ?? 0;
}

function countImportMergeDuplicates(
  currentProject: ProjectData,
  sourceProject: ProjectData,
  targetTrackId: string,
  row: ImportMergeRow,
) {
  if (row.kind === "builtin-track") {
    if (row.sourceTrackType === "character") {
      return sourceProject.characterAnnotations.filter((sourceItem) =>
        currentProject.characterAnnotations.some((targetItem) => areCharactersEquivalent(sourceItem, targetItem))).length;
    }
    return sourceProject.actionAnnotations.filter((sourceItem) =>
      sourceItem.trackId === row.sourceTrackId &&
      currentProject.actionAnnotations.some((targetItem) =>
        targetItem.trackId === targetTrackId && areActionsEquivalent(sourceItem, targetItem))).length;
  }

  if (row.kind === "custom-track") {
    const sourceTrack = sourceProject.customTracks.find((track) => track.id === row.sourceTrackId);
    const targetTrack = currentProject.customTracks.find((track) => track.id === targetTrackId);
    if (!sourceTrack || !targetTrack) {
      return 0;
    }
    return sourceTrack.blocks.filter((sourceBlock) =>
      targetTrack.blocks.some((targetBlock) => areCustomBlocksEquivalent(sourceBlock, targetBlock, sourceTrack.trackType))).length;
  }

  const sourceTrack = findAttachedPointTrackInProject(sourceProject, row.sourceParentTrackId ?? "", row.sourceTrackId);
  const targetTrack = findAttachedPointTrackInProject(
    currentProject,
    findTopLevelTrackByAttachedPointTrackId(currentProject, targetTrackId)?.id ?? "",
    targetTrackId,
  );
  if (!sourceTrack || !targetTrack) {
    return 0;
  }
  return sourceTrack.points.filter((sourcePoint) =>
    targetTrack.points.some((targetPoint) => areAttachedPointsEquivalent(sourcePoint, targetPoint))).length;
}

function cloneProjectForMerge(project: ProjectData): ProjectData {
  return {
    ...project,
    sentenceAnnotationConfig: {
      roleOptions: [...project.sentenceAnnotationConfig.roleOptions],
    },
    subtitleLines: project.subtitleLines.map((line) => ({ ...line })),
    characterAnnotations: project.characterAnnotations.map((item) => ({ ...item })),
    gongcheAnnotations: project.gongcheAnnotations.map((item) => ({
      ...item,
      symbols: item.symbols.map((symbol) => ({ ...symbol })),
    })),
    banyanSections: project.banyanSections.map((item) => ({ ...item })),
    banyanMarks: project.banyanMarks.map((item) => ({
      ...item,
      linkedGongcheSymbolIds: item.linkedGongcheSymbolIds ? [...item.linkedGongcheSymbolIds] : undefined,
    })),
    actionAnnotations: project.actionAnnotations.map((item) => ({ ...item })),
    builtinTracks: project.builtinTracks.map((track) => ({
      ...track,
      attachedPointTracks: track.attachedPointTracks.map((pointTrack) => cloneAttachedPointTrack(pointTrack)),
    })),
    customTracks: project.customTracks.map((track) =>
      track.trackType === "text"
        ? {
            ...track,
            typeOptions: [...track.typeOptions],
            blocks: track.blocks.map((block) => ({ ...block })),
            attachedPointTracks: track.attachedPointTracks.map((pointTrack) => cloneAttachedPointTrack(pointTrack)),
          }
        : {
            ...track,
            typeOptions: [...track.typeOptions],
            blocks: track.blocks.map((block) => ({ ...block })),
            attachedPointTracks: track.attachedPointTracks.map((pointTrack) => cloneAttachedPointTrack(pointTrack)),
          }),
    activeTrackOrder: [...project.activeTrackOrder],
  };
}

function cloneAttachedPointTrack(track: AttachedPointTrack): AttachedPointTrack {
  return {
    ...track,
    typeOptions: [...track.typeOptions],
    points: track.points.map((point) => ({ ...point })),
  };
}

function ensureBuiltinTrackForMerge(project: ProjectData, sourceTrack: BuiltinTrack) {
  if (project.builtinTracks.some((track) => track.id === sourceTrack.id)) {
    return sourceTrack.id;
  }
  const nextTrack: BuiltinTrack = {
    ...getBuiltinTrackDefinition(sourceTrack.id),
    name: sourceTrack.name,
    snapToWaveformKeypoints: Boolean(sourceTrack.snapToWaveformKeypoints),
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
  };
  project.builtinTracks.push(nextTrack);
  if (!project.activeTrackOrder.includes(nextTrack.id)) {
    project.activeTrackOrder.push(nextTrack.id);
  }
  return nextTrack.id;
}

function createCustomTrackForMerge(project: ProjectData, sourceTrack: CustomTrack) {
  const trackId = `custom-track-${createRuntimeUuid()}`;
  const color = normalizeHexColor(sourceTrack.color) ?? getNextTrackColor(project.customTracks);
  const nextTrack: CustomTrack = sourceTrack.trackType === "text"
    ? {
        id: trackId,
        name: sourceTrack.name,
        trackType: "text",
        color,
        typeOptions: [...sourceTrack.typeOptions],
        blocks: [],
        attachedPointTracks: [],
        attachedPointTracksExpanded: false,
        snapToWaveformKeypoints: Boolean(sourceTrack.snapToWaveformKeypoints),
      }
    : {
        id: trackId,
        name: sourceTrack.name,
        trackType: "action",
        color,
        typeOptions: [...sourceTrack.typeOptions],
        blocks: [],
        attachedPointTracks: [],
        attachedPointTracksExpanded: false,
        snapToWaveformKeypoints: Boolean(sourceTrack.snapToWaveformKeypoints),
      };
  project.customTracks.push(nextTrack);
  project.activeTrackOrder.push(nextTrack.id);
  return nextTrack.id;
}

function createAttachedPointTrackForMerge(
  project: ProjectData,
  parentTrackId: string,
  sourceTrack: AttachedPointTrack,
) {
  const trackId = `point-track-${createRuntimeUuid()}`;
  const nextTrack: AttachedPointTrack = {
    id: trackId,
    name: sourceTrack.name,
    typeOptions: [...sourceTrack.typeOptions],
    points: [],
    snapToWaveformKeypoints: Boolean(sourceTrack.snapToWaveformKeypoints),
    snapToParentBoundaries: Boolean(sourceTrack.snapToParentBoundaries),
  };
  return updateAttachedPointTrackCollection(project, parentTrackId, (tracks) => [...tracks, nextTrack]);
}

function mergeBuiltinTrackFromImport(
  project: ProjectData,
  sourceProject: ProjectData,
  sourceTrack: BuiltinTrack,
  targetTrackId: BuiltinTrackId,
  mergeMode: ImportMergeMode,
) {
  project.builtinTracks = project.builtinTracks.map((track) =>
    track.id === targetTrackId
      ? {
          ...track,
          snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints || sourceTrack.snapToWaveformKeypoints),
        }
      : track);

  if (sourceTrack.type === "character") {
    project.sentenceAnnotationConfig = {
      roleOptions: mergeUniqueStrings(
        project.sentenceAnnotationConfig.roleOptions,
        sourceProject.sentenceAnnotationConfig.roleOptions,
      ),
    };
    const sourceCharacters = sourceProject.characterAnnotations;
    const oldLineIds = project.characterAnnotations.map((item) => item.lineId);
    const incomingCharacters = sourceCharacters.map((item) => ({
      ...item,
      id: `char-${createRuntimeUuid()}`,
    }));
    const nonDuplicateCharacters = incomingCharacters.filter((item) =>
      !project.characterAnnotations.some((existing) => areCharactersEquivalent(item, existing)));
    project.characterAnnotations = mergeMode === "replace"
      ? incomingCharacters
      : [...project.characterAnnotations, ...nonDuplicateCharacters];
    const importedLineIds = new Set(sourceCharacters.map((item) => item.lineId));
    const sourceLines = sourceProject.subtitleLines.filter((line) => importedLineIds.has(line.id));
    const sourceLineById = new Map(sourceLines.map((line) => [line.id, line]));
    // 逐字整合仍以 lineId 保持句字关系；覆盖模式采用来源分类，叠加模式不覆盖目标已有学术标注。
    project.subtitleLines = [
      ...project.subtitleLines.map((line) =>
        mergeMode === "replace" && sourceLineById.has(line.id)
          ? { ...sourceLineById.get(line.id)! }
          : line),
      ...sourceLines.filter((sourceLine) =>
        !project.subtitleLines.some((line) => line.id === sourceLine.id)).map((line) => ({ ...line })),
    ];
    return syncSubtitleLines(project, [
      ...oldLineIds,
      ...incomingCharacters.map((item) => item.lineId),
    ]);
  }

  const sourceActions = sourceProject.actionAnnotations.filter((item) => item.trackId === sourceTrack.id);
  const incomingActions = sourceActions.map((item) => ({
    ...item,
    id: `${targetTrackId}-${createRuntimeUuid()}`,
    trackId: targetTrackId,
  }));
  const nonDuplicateActions = incomingActions.filter((item) =>
    !project.actionAnnotations.some((existing) =>
      existing.trackId === targetTrackId && areActionsEquivalent(item, existing)));
  project.actionAnnotations = mergeMode === "replace"
    ? [
        ...project.actionAnnotations.filter((item) => item.trackId !== targetTrackId),
        ...incomingActions,
      ]
    : [...project.actionAnnotations, ...nonDuplicateActions];
  return project;
}

function mergeCustomTrackFromImport(
  project: ProjectData,
  sourceTrack: CustomTrack,
  targetTrackId: string,
  mergeMode: ImportMergeMode,
) {
  project.customTracks = project.customTracks.map((track) => {
    if (track.id !== targetTrackId || track.trackType !== sourceTrack.trackType) {
      return track;
    }
    const incomingBlocks = sourceTrack.blocks.map((block) => ({
      ...block,
      id: `custom-block-${createRuntimeUuid()}`,
    }));
    const nonDuplicateBlocks = incomingBlocks.filter((block) =>
      !track.blocks.some((existing) => areCustomBlocksEquivalent(block, existing, track.trackType)));
    return {
      ...track,
      color: normalizeHexColor(track.color) ?? normalizeHexColor(sourceTrack.color) ?? getNextTrackColor(project.customTracks),
      typeOptions: mergeUniqueStrings(track.typeOptions, sourceTrack.typeOptions),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints || sourceTrack.snapToWaveformKeypoints),
      blocks: mergeMode === "replace"
        ? incomingBlocks
        : [...track.blocks, ...nonDuplicateBlocks],
    } as CustomTrack;
  });
  return project;
}

function mergeAttachedPointTrackFromImport(
  project: ProjectData,
  parentTrackId: string,
  sourceTrack: AttachedPointTrack,
  targetTrackId: string,
  mergeMode: ImportMergeMode,
) {
  updateAttachedPointTrackCollection(project, parentTrackId, (tracks) =>
    tracks.map((track) => {
      if (track.id !== targetTrackId) {
        return track;
      }
      const incomingPoints = sourceTrack.points.map((point) => ({
        ...point,
        id: `point-${createRuntimeUuid()}`,
      }));
      const nonDuplicatePoints = incomingPoints.filter((point) =>
        !track.points.some((existing) => areAttachedPointsEquivalent(point, existing)));
      return {
        ...track,
        typeOptions: mergeUniqueStrings(track.typeOptions, sourceTrack.typeOptions),
        snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints || sourceTrack.snapToWaveformKeypoints),
        snapToParentBoundaries: Boolean(track.snapToParentBoundaries || sourceTrack.snapToParentBoundaries),
        points: mergeMode === "replace"
          ? incomingPoints
          : [...track.points, ...nonDuplicatePoints],
      };
    }),
  );
  return project;
}

function updateAttachedPointTrackCollection(
  project: ProjectData,
  parentTrackId: string,
  updater: (tracks: AttachedPointTrack[]) => AttachedPointTrack[],
) {
  const builtinIndex = project.builtinTracks.findIndex((track) => track.id === parentTrackId);
  if (builtinIndex >= 0) {
    const nextTracks = updater(project.builtinTracks[builtinIndex].attachedPointTracks);
    project.builtinTracks[builtinIndex] = {
      ...project.builtinTracks[builtinIndex],
      attachedPointTracks: nextTracks,
    };
    return nextTracks[nextTracks.length - 1]?.id ?? "";
  }
  const customIndex = project.customTracks.findIndex((track) => track.id === parentTrackId);
  if (customIndex >= 0) {
    const nextTracks = updater(project.customTracks[customIndex].attachedPointTracks);
    project.customTracks[customIndex] = {
      ...project.customTracks[customIndex],
      attachedPointTracks: nextTracks,
    } as CustomTrack;
    return nextTracks[nextTracks.length - 1]?.id ?? "";
  }
  return "";
}

function findTopLevelTrackById(project: ProjectData, trackId: string) {
  return project.builtinTracks.find((track) => track.id === trackId) ??
    project.customTracks.find((track) => track.id === trackId) ??
    null;
}

function findTopLevelTrackByAttachedPointTrackId(project: ProjectData, trackId: string) {
  return project.builtinTracks.find((track) => track.attachedPointTracks.some((item) => item.id === trackId)) ??
    project.customTracks.find((track) => track.attachedPointTracks.some((item) => item.id === trackId)) ??
    null;
}

function findAttachedPointTrackInProject(
  project: ProjectData,
  parentTrackId: string,
  pointTrackId: string,
) {
  const parentTrack = findTopLevelTrackById(project, parentTrackId);
  return parentTrack?.attachedPointTracks.find((track) => track.id === pointTrackId) ?? null;
}

function mergeUniqueStrings(currentValues: string[], nextValues: string[]) {
  const result = [...currentValues];
  for (const value of nextValues) {
    if (!result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}

function normalizeNewTypeOption(value: string | null) {
  const normalizedValue = value?.trim() ?? "";
  return normalizedValue.length > 0 ? normalizedValue : null;
}

function appendUniqueTypeOption(options: string[], nextOption: string) {
  return options.includes(nextOption) ? options : [...options, nextOption];
}

function getBanyanRoleForSubtype(subtype: BanyanMark["subtype"]): BanyanMark["role"] {
  if (
    subtype === "mainBan" ||
    subtype === "headBan" ||
    subtype === "waistBan" ||
    subtype === "bottomBan" ||
    subtype === "zengBan" ||
    subtype === "waistZengBan"
  ) {
    return "ban";
  }
  if (
    subtype === "middleEye" ||
    subtype === "smallEye" ||
    subtype === "sideHeadTailEye" ||
    subtype === "sideMiddleEye"
  ) {
    return "yan";
  }
  return "auxiliary";
}

function areCharactersEquivalent(left: CharacterAnnotation, right: CharacterAnnotation) {
  return left.char === right.char &&
    timesClose(left.startTime, right.startTime) &&
    timesClose(left.endTime, right.endTime);
}

function areActionsEquivalent(left: ActionAnnotation, right: ActionAnnotation) {
  return left.label === right.label &&
    timesClose(left.startTime, right.startTime) &&
    timesClose(left.endTime, right.endTime);
}

function areCustomBlocksEquivalent(
  left: CustomTrack["blocks"][number],
  right: CustomTrack["blocks"][number],
  trackType: CustomTrackType,
) {
  if (trackType === "text") {
    return "text" in left && "text" in right &&
      left.type === right.type &&
      left.text === right.text &&
      timesClose(left.startTime, right.startTime) &&
      timesClose(left.endTime, right.endTime);
  }
  return left.type === right.type &&
    timesClose(left.startTime, right.startTime) &&
    timesClose(left.endTime, right.endTime);
}

function areAttachedPointsEquivalent(left: AttachedPointAnnotation, right: AttachedPointAnnotation) {
  return left.label === right.label && timesClose(left.time, right.time);
}

function timesClose(left: number, right: number) {
  return Math.abs(left - right) <= 0.001;
}

function resolveTimelineSelectionItem(
  project: ProjectData,
  item: TimelineSelectionItem,
): ResolvedClipboardSelectionItem | null {
  if (item.type === "character") {
    const annotation = project.characterAnnotations.find((candidate) => candidate.id === item.id);
    return annotation
      ? {
          type: "character",
          id: annotation.id,
          trackId: "character-track",
          lineId: annotation.lineId,
          char: annotation.char,
          tone: annotation.tone ?? null,
          startTime: annotation.startTime,
          endTime: annotation.endTime,
        }
      : null;
  }
  if (item.type === "action") {
    const annotation = project.actionAnnotations.find((candidate) => candidate.id === item.id);
    return annotation
      ? {
          type: "action",
          id: annotation.id,
          trackId: annotation.trackId,
          label: annotation.label,
          startTime: annotation.startTime,
          endTime: annotation.endTime,
        }
      : null;
  }
  if (item.type === "attached-point") {
    const location = locatePointTrack(project, item.trackId);
    const point = location?.pointTrack.points.find((candidate) => candidate.id === item.id);
    return point && location
      ? {
          type: "attached-point",
          id: point.id,
          trackId: item.trackId,
          parentTrackId: item.parentTrackId,
          label: point.label,
          startTime: point.time,
          endTime: point.time,
        }
      : null;
  }
  if (item.type === "banyan-mark") {
    const mark = project.banyanMarks.find((candidate) => candidate.id === item.id);
    return mark
      ? {
          ...mark,
          linkedGongcheSymbolIds: mark.linkedGongcheSymbolIds ? [...mark.linkedGongcheSymbolIds] : undefined,
          type: "banyan-mark",
          trackId: "banyan-track",
          startTime: mark.time,
          endTime: mark.time,
        }
      : null;
  }
  const block = findCustomBlock(project.customTracks, item.trackId, item.id);
  return block
    ? {
        type: "custom-block",
        id: block.id,
        trackId: block.trackId,
        trackType: block.trackType,
        typeValue: block.type,
        text: block.text,
        startTime: block.startTime,
        endTime: block.endTime,
      }
    : null;
}

function resolveTimelinePasteTarget(
  project: ProjectData,
  clipboard: TimelineClipboard,
  explicitTarget: TimelinePasteTarget | null,
  fallbackTime: number,
) {
  if (explicitTarget) {
    return explicitTarget;
  }
  const fallbackTrackId = clipboard.primaryTrackId ?? clipboard.sourceTrackIds[0] ?? null;
  if (!fallbackTrackId) {
    return null;
  }
  return {
    trackId: resolveExistingPasteTrackId(project, fallbackTrackId) ?? fallbackTrackId,
    time: fallbackTime,
  };
}

function resolveExistingPasteTrackId(project: ProjectData, trackId: string) {
  if (trackId === "banyan-track") {
    return "banyan-track";
  }
  if (trackId === "character-track") {
    return project.builtinTracks.some((track) => track.id === trackId) ? trackId : null;
  }
  if (project.builtinTracks.some((track) => track.id === trackId)) {
    return trackId;
  }
  if (project.customTracks.some((track) => track.id === trackId)) {
    return trackId;
  }
  return null;
}

function isCompatiblePasteTrack(
  project: ProjectData,
  item: TimelineClipboardItem,
  targetTrackId: string,
) {
  if (item.type === "character") {
    return targetTrackId === "character-track" &&
      project.builtinTracks.some((track) => track.id === "character-track");
  }
  if (item.type === "action") {
    return project.builtinTracks.some((track) => track.id === targetTrackId && track.type === "action");
  }
  if (item.type === "attached-point") {
    return Boolean(locatePointTrack(project, targetTrackId));
  }
  if (item.type === "banyan-mark") {
    return targetTrackId === "banyan-track";
  }
  const targetTrack = project.customTracks.find((track) => track.id === targetTrackId);
  return Boolean(targetTrack && targetTrack.trackType === item.trackType);
}

function buildPreparedPasteItems(
  project: ProjectData,
  clipboard: TimelineClipboard,
  target: TimelinePasteTarget,
): PreparedPasteItem[] {
  const remapAllToTargetTrack =
    clipboard.sourceTrackIds.length === 1 &&
    clipboard.items.every((item) => isCompatiblePasteTrack(project, item, target.trackId));

  return clipboard.items.reduce<PreparedPasteItem[]>((items, item) => {
    const targetTrackId = remapAllToTargetTrack ? target.trackId : item.sourceTrackId;
    if (!isCompatiblePasteTrack(project, item, targetTrackId)) {
      return items;
    }
    if (item.type === "banyan-mark") {
      items.push({
        type: "banyan-mark" as const,
        targetTrackId: "banyan-track" as const,
        time: Math.max(0, target.time + item.timeOffset),
        mark: {
          ...item.mark,
          linkedGongcheSymbolIds: item.mark.linkedGongcheSymbolIds
            ? [...item.mark.linkedGongcheSymbolIds]
            : undefined,
        },
      });
      return items;
    }
    if (item.type === "attached-point") {
      const pointTrackLocation = locatePointTrack(project, targetTrackId);
      items.push({
        type: "attached-point" as const,
        targetTrackId,
        parentTrackId: pointTrackLocation?.parentTrack.id ?? item.parentTrackId,
        time: Math.max(0, target.time + item.timeOffset),
        label: item.label,
      });
      return items;
    }
    const startTime = Math.max(0, target.time + item.startOffset);
    const duration = Math.max(MIN_CHARACTER_DURATION, item.endOffset - item.startOffset);
    const endTime = startTime + duration;
    if (item.type === "character") {
      items.push({
        type: "character" as const,
        targetTrackId: "character-track" as const,
        startTime,
        endTime,
        char: item.char,
        tone: item.tone ?? null,
        sourceLineId: item.sourceLineId,
      });
      return items;
    }
    if (item.type === "action") {
      items.push({
        type: "action" as const,
        targetTrackId,
        startTime,
        endTime,
        label: item.label,
      });
      return items;
    }
    items.push({
      type: "custom-block" as const,
      targetTrackId,
      trackType: item.trackType,
      startTime,
      endTime,
      blockType: item.blockType,
      text: item.text,
    });
    return items;
  }, []);
}

function detectPasteConflicts(project: ProjectData, preparedItems: PreparedPasteItem[]) {
  return preparedItems
    .map((item) => {
      const existingKeys = findConflictingKeysForPreparedItem(project, item);
      if (existingKeys.length === 0) {
        return null;
      }
      return {
        item,
        existingKeys,
        trackName: getTrackDisplayName(project, item.targetTrackId),
      };
    })
    .filter((item): item is PasteConflict => Boolean(item));
}

function findConflictingKeysForPreparedItem(project: ProjectData, item: PreparedPasteItem) {
  if (item.type === "character") {
    return project.characterAnnotations
      .filter((annotation) => rangesOverlap(annotation.startTime, annotation.endTime, item.startTime, item.endTime))
      .map((annotation) => `character:${annotation.id}`);
  }
  if (item.type === "action") {
    return project.actionAnnotations
      .filter((annotation) =>
        annotation.trackId === item.targetTrackId &&
        rangesOverlap(annotation.startTime, annotation.endTime, item.startTime, item.endTime),
      )
      .map((annotation) => `action:${annotation.id}`);
  }
  if (item.type === "attached-point") {
    const location = locatePointTrack(project, item.targetTrackId);
    return (location?.pointTrack.points ?? [])
      .filter((point) => Math.abs(point.time - item.time) <= POINT_PASTE_CONFLICT_EPSILON)
      .map((point) => `attached-point:${item.targetTrackId}:${point.id}`);
  }
  if (item.type === "banyan-mark") {
    return project.banyanMarks
      .filter((mark) => Math.abs(mark.time - item.time) <= POINT_PASTE_CONFLICT_EPSILON)
      .map((mark) => `banyan-mark:${mark.id}`);
  }
  const targetTrack = project.customTracks.find((track) => track.id === item.targetTrackId);
  return (targetTrack?.blocks ?? [])
    .filter((block) => rangesOverlap(block.startTime, block.endTime, item.startTime, item.endTime))
    .map((block) => `custom-block:${targetTrack?.id}:${block.id}`);
}

function getTrackDisplayName(project: ProjectData, trackId: string) {
  if (trackId === "banyan-track") {
    return "板眼轨";
  }
  return project.builtinTracks.find((track) => track.id === trackId)?.name ??
    project.customTracks.find((track) => track.id === trackId)?.name ??
    trackId;
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function findCustomBlock(
  customTracks: CustomTrack[],
  trackId: string,
  blockId: string,
): ResolvedCustomTrackBlock | null {
  const track = customTracks.find((item) => item.id === trackId);
  const block = track?.blocks.find((item) => item.id === blockId);
  if (!track || !block) {
    return null;
  }
  return {
    id: block.id,
    trackId: track.id,
    trackType: track.trackType,
    startTime: block.startTime,
    endTime: block.endTime,
    type: block.type,
    text: track.trackType === "text"
      ? getOptionalBlockText(block as unknown as { text?: string })
      : undefined,
  };
}

function getGongcheParentKey(parentTrackId: string, parentBlockId: string) {
  return `${parentTrackId}:${parentBlockId}`;
}

function findBanyanSectionAtTime(sections: BanyanSection[], time: number) {
  return sections.find((section) => time >= section.startTime && time <= section.endTime) ?? null;
}

function toCharacterGongcheParent(character: CharacterAnnotation): GongcheParentBlock {
  return {
    parentTrackId: "character-track",
    parentBlockId: character.id,
    label: character.char,
    startTime: character.startTime,
    endTime: character.endTime,
  };
}

function toCustomBlockGongcheParent(block: ResolvedCustomTrackBlock): GongcheParentBlock {
  return {
    parentTrackId: block.trackId,
    parentBlockId: block.id,
    label: block.text ?? block.type,
    startTime: block.startTime,
    endTime: block.endTime,
  };
}

function findGongcheParentBlock(
  project: ProjectData,
  parentTrackId: string,
  parentBlockId: string,
): GongcheParentBlock | null {
  if (parentTrackId === "character-track") {
    const character = project.characterAnnotations.find((item) => item.id === parentBlockId);
    return character ? toCharacterGongcheParent(character) : null;
  }
  const block = findCustomBlock(project.customTracks, parentTrackId, parentBlockId);
  return block?.trackType === "text" ? toCustomBlockGongcheParent(block) : null;
}

function findGongcheParentBlockAtTime(project: ProjectData, parentTrackId: string, time: number) {
  if (parentTrackId === "character-track") {
    const character = project.characterAnnotations.find((item) => time >= item.startTime && time <= item.endTime);
    return character ? toCharacterGongcheParent(character) : null;
  }
  const track = project.customTracks.find((item) => item.id === parentTrackId && item.trackType === "text");
  const block = track?.blocks.find((item) => time >= item.startTime && time <= item.endTime);
  return track && block
    ? toCustomBlockGongcheParent({
        id: block.id,
        trackId: track.id,
        trackType: track.trackType,
        startTime: block.startTime,
        endTime: block.endTime,
        type: block.type,
        text: "text" in block && typeof block.text === "string" ? block.text : undefined,
      })
    : null;
}

function getOrderedGongcheParentBlocks(project: ProjectData, parentTrackId: string): GongcheParentBlock[] {
  if (parentTrackId === "character-track") {
    return sortCharactersByTime(project.characterAnnotations).map(toCharacterGongcheParent);
  }
  const track = project.customTracks.find((item) => item.id === parentTrackId && item.trackType === "text");
  return track
    ? [...track.blocks]
        .sort((left, right) => left.startTime - right.startTime)
        .map((block) => toCustomBlockGongcheParent({
          id: block.id,
          trackId: track.id,
          trackType: track.trackType,
          startTime: block.startTime,
          endTime: block.endTime,
          type: block.type,
          text: "text" in block && typeof block.text === "string" ? block.text : undefined,
        }))
    : [];
}

function parseGongcheSourceText(sourceText: string): ParsedGongcheEntry[] {
  const entries: ParsedGongcheEntry[] = [];
  const pattern = /([^\s{}])\{([^{}]*)\}/gu;
  for (const match of sourceText.matchAll(pattern)) {
    const text = match[1];
    const content = match[2];
    if (!isPotentialLyricCharacter(text)) {
      continue;
    }
    const symbols = parseGongcheSymbolContent(content);
    if (symbols.length === 0) {
      continue;
    }
    entries.push({ text, symbols });
  }
  return entries;
}

function parseGongcheSymbolContent(content: string): ParsedGongcheEntry["symbols"] {
  const matches = Array.from(content.matchAll(/（[合四上尺工六五][+-]?）|[合四上尺工六五][+-]?/gu));
  return matches.map((match, index) => {
    const rawPitch = match[0];
    const startIndex = match.index ?? 0;
    const nextIndex = matches[index + 1]?.index ?? content.length;
    const rawText = content.slice(startIndex, nextIndex);
    const parenthesized = rawPitch.startsWith("（");
    const label = rawPitch.replace(/[（）]/g, "");
    return {
      label,
      notation: rawText.slice(rawPitch.length),
      rawText,
      parenthesized,
    };
  });
}

function distributeParsedGongcheSymbols(
  symbols: ParsedGongcheEntry["symbols"],
  startTime: number,
  endTime: number,
): GongcheSymbol[] {
  const safeSymbols = symbols.length > 0
    ? symbols
    : [{ label: "合", notation: "", rawText: "合", parenthesized: false }];
  const duration = Math.max(endTime - startTime, 0.001);
  const step = duration / safeSymbols.length;
  return safeSymbols.map((symbol, index) => ({
    id: `gongche-symbol-${createRuntimeUuid()}`,
    label: symbol.label,
    notation: symbol.notation,
    rawText: symbol.rawText,
    parenthesized: symbol.parenthesized,
    startTime: startTime + step * index,
    endTime: index === safeSymbols.length - 1 ? endTime : startTime + step * (index + 1),
    assetUrl: null,
  }));
}

function normalizeGongcheMatchText(text: string) {
  const variantMap: Record<string, string> = {
    來: "来",
    妳: "你",
    髙: "高",
    麽: "么",
    裠: "裙",
    眀: "明",
    𠁅: "处",
  };
  return Array.from(text.trim())
    .map((char) => variantMap[char] ?? char)
    .join("");
}

function isPotentialLyricCharacter(text: string) {
  return !/^[\x00-\x7F]$/u.test(text) && !/^[，。？！、；：「」『』（）《》【】]$/u.test(text);
}

function alignGongcheEntriesToParentBlocks(
  entries: ParsedGongcheEntry[],
  parentBlocks: GongcheParentBlock[],
) {
  const entryCount = entries.length;
  const parentCount = parentBlocks.length;
  const sourceSkipCost = 0.48;
  const parentSkipCost = 0.16;
  const mismatchCost = 0.58;
  const strongMatchCost = 0.2;
  const dp = Array.from({ length: entryCount + 1 }, () => Array(parentCount + 1).fill(0) as number[]);
  const back = Array.from({ length: entryCount + 1 }, () =>
    Array(parentCount + 1).fill(null) as Array<"match" | "skip-entry" | "skip-parent" | null>,
  );

  for (let entryIndex = 1; entryIndex <= entryCount; entryIndex += 1) {
    dp[entryIndex][0] = dp[entryIndex - 1][0] + sourceSkipCost;
    back[entryIndex][0] = "skip-entry";
  }
  for (let parentIndex = 1; parentIndex <= parentCount; parentIndex += 1) {
    dp[0][parentIndex] = dp[0][parentIndex - 1] + parentSkipCost;
    back[0][parentIndex] = "skip-parent";
  }

  for (let entryIndex = 1; entryIndex <= entryCount; entryIndex += 1) {
    for (let parentIndex = 1; parentIndex <= parentCount; parentIndex += 1) {
      const cost = getGongcheTextMatchCost(
        entries[entryIndex - 1].text,
        parentBlocks[parentIndex - 1].label,
        mismatchCost,
      );
      const candidates = [
        {
          op: "match" as const,
          score: dp[entryIndex - 1][parentIndex - 1] + cost,
        },
        {
          op: "skip-entry" as const,
          score: dp[entryIndex - 1][parentIndex] + sourceSkipCost,
        },
        {
          op: "skip-parent" as const,
          score: dp[entryIndex][parentIndex - 1] + parentSkipCost,
        },
      ];
      candidates.sort((left, right) => {
        if (Math.abs(left.score - right.score) > 0.000001) {
          return left.score - right.score;
        }
        const priority = { match: 0, "skip-parent": 1, "skip-entry": 2 };
        return priority[left.op] - priority[right.op];
      });
      dp[entryIndex][parentIndex] = candidates[0].score;
      back[entryIndex][parentIndex] = candidates[0].op;
    }
  }

  const rawPairs: Array<{ entryIndex: number; parentIndex: number; cost: number }> = [];
  let entryIndex = entryCount;
  let parentIndex = parentCount;
  while (entryIndex > 0 || parentIndex > 0) {
    const op = back[entryIndex]?.[parentIndex];
    if (op === "match") {
      const cost = getGongcheTextMatchCost(
        entries[entryIndex - 1].text,
        parentBlocks[parentIndex - 1].label,
        mismatchCost,
      );
      rawPairs.push({
        entryIndex: entryIndex - 1,
        parentIndex: parentIndex - 1,
        cost,
      });
      entryIndex -= 1;
      parentIndex -= 1;
    } else if (op === "skip-entry") {
      entryIndex -= 1;
    } else {
      parentIndex -= 1;
    }
  }

  return rawPairs
    .reverse()
    .filter((pair, index, pairs) =>
      pair.cost <= strongMatchCost || isContextualGongcheFuzzyMatch(pair, index, pairs, strongMatchCost),
    );
}

function getGongcheTextMatchCost(left: string, right: string, mismatchCost: number) {
  const normalizedLeft = normalizeGongcheMatchText(left);
  const normalizedRight = normalizeGongcheMatchText(right);
  if (!normalizedLeft || !normalizedRight) {
    return mismatchCost;
  }
  if (normalizedLeft === normalizedRight) {
    return left === right ? 0 : 0.04;
  }
  if (normalizedRight.includes(normalizedLeft) || normalizedLeft.includes(normalizedRight)) {
    return 0.14;
  }
  return mismatchCost;
}

function isContextualGongcheFuzzyMatch(
  pair: { entryIndex: number; parentIndex: number; cost: number },
  index: number,
  pairs: Array<{ entryIndex: number; parentIndex: number; cost: number }>,
  strongMatchCost: number,
) {
  const previousStrong = findNearbyStrongGongchePair(pair, pairs.slice(Math.max(0, index - 3), index), strongMatchCost, -1);
  const nextStrong = findNearbyStrongGongchePair(pair, pairs.slice(index + 1, index + 4), strongMatchCost, 1);
  return Boolean(previousStrong && nextStrong);
}

function findNearbyStrongGongchePair(
  pair: { entryIndex: number; parentIndex: number },
  candidates: Array<{ entryIndex: number; parentIndex: number; cost: number }>,
  strongMatchCost: number,
  direction: -1 | 1,
) {
  return candidates.some((candidate) =>
    candidate.cost <= strongMatchCost &&
    (candidate.entryIndex - pair.entryIndex) * direction > 0 &&
    (candidate.parentIndex - pair.parentIndex) * direction > 0,
  );
}

function normalizeGongcheBlockTiming(
  block: GongcheAnnotation,
  parentBlock: GongcheParentBlock | null,
): GongcheAnnotation {
  if (!parentBlock) {
    return {
      ...block,
      symbols: normalizeGongcheSymbols(block.symbols, block.startTime, block.endTime),
    };
  }
  const startTime = clampNumber(block.startTime, parentBlock.startTime, parentBlock.endTime);
  const endTime = clampNumber(
    Math.max(block.endTime, startTime + MIN_CHARACTER_DURATION),
    startTime + MIN_CHARACTER_DURATION,
    parentBlock.endTime,
  );
  return {
    ...block,
    startTime,
    endTime,
    symbols: normalizeGongcheSymbols(block.symbols, startTime, endTime),
  };
}

function normalizeGongcheSymbols(
  symbols: GongcheSymbol[],
  blockStartTime: number,
  blockEndTime: number,
): GongcheSymbol[] {
  const fallback: GongcheSymbol[] = [{
    id: `gongche-symbol-${createRuntimeUuid()}`,
    label: "合",
    notation: "",
    rawText: "合",
    parenthesized: false,
    startTime: blockStartTime,
    endTime: blockEndTime,
    assetUrl: null,
  }];
  const source = Array.isArray(symbols) && symbols.length > 0 ? symbols : fallback;
  const sorted = source
    .filter((symbol) => symbol && typeof symbol.id === "string")
    .map((symbol) => ({
      ...symbol,
      label: typeof symbol.label === "string" && symbol.label.trim() ? symbol.label.trim() : "合",
      notation: typeof symbol.notation === "string" ? symbol.notation : "",
      rawText: typeof symbol.rawText === "string" ? symbol.rawText : symbol.label,
      parenthesized: Boolean(symbol.parenthesized),
      startTime: clampNumber(symbol.startTime, blockStartTime, blockEndTime),
      endTime: clampNumber(symbol.endTime, blockStartTime, blockEndTime),
      assetUrl: symbol.assetUrl ?? null,
    }))
    .sort((left, right) => left.startTime - right.startTime);

  return sorted.map((symbol, index) => {
    const previousEnd = index === 0 ? blockStartTime : sorted[index - 1].endTime;
    const nextStart = index === sorted.length - 1 ? blockEndTime : sorted[index + 1].startTime;
    const startTime = index === 0 ? blockStartTime : Math.max(symbol.startTime, previousEnd);
    const endTime = index === sorted.length - 1
      ? blockEndTime
      : clampNumber(Math.max(symbol.endTime, startTime + 0.001), startTime + 0.001, nextStart);
    return {
      ...symbol,
      startTime,
      endTime,
    };
  });
}

function synchronizeGongcheWithChangedParents(
  project: ProjectData,
  previousParents: Map<string, GongcheParentBlock>,
): ProjectData {
  if (previousParents.size === 0 || !Array.isArray(project.gongcheAnnotations)) {
    return project;
  }
  return {
    ...project,
    gongcheAnnotations: project.gongcheAnnotations.map((block) => {
      const key = getGongcheParentKey(block.parentTrackId, block.parentBlockId);
      const previousParent = previousParents.get(key);
      if (!previousParent) {
        return block;
      }
      const nextParent = findGongcheParentBlock(project, block.parentTrackId, block.parentBlockId);
      if (!nextParent) {
        return block;
      }
      return mapGongcheBlockToParent(block, previousParent, nextParent);
    }),
  };
}

function mapGongcheBlockToParent(
  block: GongcheAnnotation,
  previousParent: GongcheParentBlock,
  nextParent: GongcheParentBlock,
): GongcheAnnotation {
  const previousDuration = Math.max(previousParent.endTime - previousParent.startTime, 0.001);
  const nextDuration = Math.max(nextParent.endTime - nextParent.startTime, MIN_CHARACTER_DURATION);
  const mapTime = (time: number) => {
    const ratio = clampNumber((time - previousParent.startTime) / previousDuration, 0, 1);
    return nextParent.startTime + ratio * nextDuration;
  };
  return normalizeGongcheBlockTiming({
    ...block,
    startTime: mapTime(block.startTime),
    endTime: mapTime(block.endTime),
    symbols: block.symbols.map((symbol) => ({
      ...symbol,
      startTime: mapTime(symbol.startTime),
      endTime: mapTime(symbol.endTime),
    })),
  }, nextParent);
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(value, max));
}

function getOptionalBlockText(block: { text?: string }) {
  return typeof block.text === "string" ? block.text : undefined;
}

function downloadBlob(content: string, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function trackSnapStatesEqual(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
) {
  return getTrackSnapStateSignature(left) === getTrackSnapStateSignature(right);
}

function getTrackSnapStateSignature(trackSnapState: Record<string, boolean>) {
  const cached = trackSnapSignatureCache.get(trackSnapState);
  if (cached) {
    return cached;
  }
  const signature = JSON.stringify(
    Object.keys(trackSnapState)
      .sort()
      .map((key) => [key, trackSnapState[key]]),
  );
  trackSnapSignatureCache.set(trackSnapState, signature);
  return signature;
}

function requiresUndoConfirmation(action: HistoryAction) {
  return action === "import-video" || action === "import-srt" || action === "import-project" || action === "merge-project";
}

// 快照边界 kind 是持久化语义；历史 action 只负责维持用户熟悉的撤销提示与本地操作说明。
function getSnapshotBoundaryHistoryAction(kind: ProjectSnapshotBoundaryKind): HistoryAction {
  if (kind === "import_srt") return "import-srt";
  if (kind === "import_project") return "import-project";
  if (kind === "merge_project") return "merge-project";
  if (kind === "repair_sentence_character_track") return "repair-sentence-character-track";
  return "edit";
}

function getUndoConfirmationMessage(action: HistoryAction) {
  if (action === "import-video") {
    return "确定要撤销导入视频吗？当前视频将从项目中移除。";
  }
  if (action === "import-srt") {
    return "确定要撤销导入句级字幕吗？当前导入的字幕与逐字结果将回退到上一步状态。";
  }
  if (action === "import-project") {
    return "确定要撤销导入项目吗？当前导入的轨道、标注和项目设置将回退到上一步状态。";
  }
  if (action === "merge-project") {
    return "确定要撤销整合导入吗？当前合并进来的轨道内容与标注将回退到上一步状态。";
  }
  return "确定要执行撤销吗？";
}

function isSingleHanCharacter(value: string) {
  return /^[\p{Script=Han}]$/u.test(value);
}

function getSplittableCharacters(value: string) {
  return Array.from(value);
}

function sortCharactersByTime(characters: CharacterAnnotation[]) {
  return [...characters].sort((left, right) =>
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id),
  );
}

function sortSubtitleLines(lines: SubtitleLine[]) {
  return [...lines].sort((left, right) =>
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id),
  );
}

function formatCharacterMergeEndpoint(character: CharacterAnnotation) {
  return `“${character.char}” ${formatSecondsToSrtTime(character.startTime)} - ${formatSecondsToSrtTime(character.endTime)}`;
}

function buildProjectWithMergedCharacterLine(
  project: ProjectData,
  rangeCharacters: CharacterAnnotation[],
  newLineId: string,
) {
  const normalizedRangeCharacters = sortCharactersByTime(rangeCharacters);
  if (normalizedRangeCharacters.length === 0) {
    return project;
  }

  const rangeCharacterIds = new Set(normalizedRangeCharacters.map((character) => character.id));
  const affectedLineIds = new Set(normalizedRangeCharacters.map((character) => character.lineId));
  const lineIdReassignments = new Map<string, string>();
  const replacementLines: SubtitleLine[] = [];
  const allCharactersByTime = sortCharactersByTime(project.characterAnnotations);

  for (const lineId of affectedLineIds) {
    const originalLineCharacters = allCharactersByTime.filter((character) => character.lineId === lineId);
    const originalIndexByCharacterId = new Map(
      originalLineCharacters.map((character, index) => [character.id, index]),
    );
    const remainingCharacters = originalLineCharacters.filter((character) => !rangeCharacterIds.has(character.id));
    const remainingSegments = splitCharactersByOriginalContinuity(remainingCharacters, originalIndexByCharacterId);

    remainingSegments.forEach((segment, segmentIndex) => {
      const targetLineId = segmentIndex === 0 ? lineId : `line-${createRuntimeUuid()}`;
      for (const character of segment) {
        lineIdReassignments.set(character.id, targetLineId);
      }
      replacementLines.push(buildSubtitleLineFromCharacters(
        targetLineId,
        segment,
        getClassificationForCharacterLines(project, segment),
      ));
    });
  }

  for (const character of normalizedRangeCharacters) {
    lineIdReassignments.set(character.id, newLineId);
  }

  const mergedLine = buildSubtitleLineFromCharacters(
    newLineId,
    normalizedRangeCharacters,
    getClassificationForCharacterLines(project, normalizedRangeCharacters),
  );
  return {
    ...project,
    subtitleLines: sortSubtitleLines([
      ...project.subtitleLines.filter((line) => !affectedLineIds.has(line.id)),
      ...replacementLines,
      mergedLine,
    ]),
    characterAnnotations: project.characterAnnotations.map((character) => {
      const nextLineId = lineIdReassignments.get(character.id);
      return nextLineId ? { ...character, lineId: nextLineId } : character;
    }),
  };
}

function mergeCharacterLineIntoAdjacentLine(
  project: ProjectData,
  lineId: string,
  direction: "previous" | "next",
) {
  const sortedLines = sortSubtitleLines(project.subtitleLines);
  const lineIndex = sortedLines.findIndex((line) => line.id === lineId);
  const adjacentLine = direction === "previous"
    ? sortedLines[lineIndex - 1]
    : sortedLines[lineIndex + 1];
  if (lineIndex < 0 || !adjacentLine) {
    return null;
  }

  const nextProject = syncSubtitleLine({
    ...project,
    subtitleLines: project.subtitleLines.filter((line) => line.id !== lineId),
    characterAnnotations: project.characterAnnotations.map((character) =>
      character.lineId === lineId ? { ...character, lineId: adjacentLine.id } : character,
    ),
  }, adjacentLine.id);

  return {
    project: nextProject,
    lineId: adjacentLine.id,
  };
}

function getMergedCharacterLineAdjacentAvailability(
  project: ProjectData,
  rangeCharacters: CharacterAnnotation[],
) {
  const previewLineId = "__merged-character-line-preview__";
  const previewLines = buildSubtitleLinesForMergedCharacterLinePreview(
    project,
    rangeCharacters,
    previewLineId,
  );
  const lineIndex = previewLines.findIndex((line) => line.id === previewLineId);
  return {
    previous: lineIndex > 0,
    next: lineIndex >= 0 && lineIndex < previewLines.length - 1,
  };
}

function buildSubtitleLinesForMergedCharacterLinePreview(
  project: ProjectData,
  rangeCharacters: CharacterAnnotation[],
  previewLineId: string,
) {
  const normalizedRangeCharacters = sortCharactersByTime(rangeCharacters);
  if (normalizedRangeCharacters.length === 0) {
    return sortSubtitleLines(project.subtitleLines);
  }

  const rangeCharacterIds = new Set(normalizedRangeCharacters.map((character) => character.id));
  const affectedLineIds = new Set(normalizedRangeCharacters.map((character) => character.lineId));
  const replacementLines: SubtitleLine[] = [];
  const allCharactersByTime = sortCharactersByTime(project.characterAnnotations);

  for (const lineId of affectedLineIds) {
    const originalLineCharacters = allCharactersByTime.filter((character) => character.lineId === lineId);
    const originalIndexByCharacterId = new Map(
      originalLineCharacters.map((character, index) => [character.id, index]),
    );
    const remainingCharacters = originalLineCharacters.filter((character) => !rangeCharacterIds.has(character.id));
    const remainingSegments = splitCharactersByOriginalContinuity(remainingCharacters, originalIndexByCharacterId);

    remainingSegments.forEach((segment, segmentIndex) => {
      replacementLines.push(buildSubtitleLineFromCharacters(
        `${lineId}:preview-segment-${segmentIndex}`,
        segment,
        getClassificationForCharacterLines(project, segment),
      ));
    });
  }

  return sortSubtitleLines([
    ...project.subtitleLines.filter((line) => !affectedLineIds.has(line.id)),
    ...replacementLines,
    buildSubtitleLineFromCharacters(
      previewLineId,
      normalizedRangeCharacters,
      getClassificationForCharacterLines(project, normalizedRangeCharacters),
    ),
  ]);
}

function splitCharactersByOriginalContinuity(
  characters: CharacterAnnotation[],
  originalIndexByCharacterId: Map<string, number>,
) {
  const segments: CharacterAnnotation[][] = [];
  for (const character of characters) {
    const previousSegment = segments[segments.length - 1];
    const previousCharacter = previousSegment?.[previousSegment.length - 1];
    const currentIndex = originalIndexByCharacterId.get(character.id) ?? -1;
    const previousIndex = previousCharacter
      ? originalIndexByCharacterId.get(previousCharacter.id) ?? -1
      : -1;
    if (!previousSegment || currentIndex !== previousIndex + 1) {
      segments.push([character]);
      continue;
    }
    previousSegment.push(character);
  }
  return segments;
}

function buildSubtitleLineFromCharacters(
  lineId: string,
  characters: CharacterAnnotation[],
  classification: Pick<SubtitleLine, "deliveryMode" | "roleType">,
): SubtitleLine {
  const sortedCharacters = sortCharactersByTime(characters);
  return {
    id: lineId,
    text: sortedCharacters.map((character) => character.char).join(""),
    startTime: sortedCharacters[0].startTime,
    endTime: sortedCharacters[sortedCharacters.length - 1].endTime,
    ...classification,
  };
}

// 合并跨句逐字块时，每个维度只有在所有来源句持有相同合法值时才保留；否则重新标注。
function getClassificationForCharacterLines(
  project: ProjectData,
  characters: CharacterAnnotation[],
): Pick<SubtitleLine, "deliveryMode" | "roleType"> {
  const sourceLineIds = new Set(characters.map((character) => character.lineId));
  const sourceLines = project.subtitleLines.filter((line) => sourceLineIds.has(line.id));
  const deliveryModes = new Set(sourceLines.map((line) => line.deliveryMode));
  const roleTypes = new Set(sourceLines.map((line) => line.roleType));
  const deliveryMode = sourceLines.length > 0 && deliveryModes.size === 1
    ? sourceLines[0].deliveryMode
    : null;
  const candidateRole = sourceLines.length > 0 && roleTypes.size === 1
    ? sourceLines[0].roleType
    : null;
  return {
    deliveryMode,
    roleType: candidateRole && project.sentenceAnnotationConfig.roleOptions.includes(candidateRole)
      ? candidateRole
      : null,
  };
}

function syncSubtitleLine(project: ProjectData, lineId: string) {
  const lineCharacters = sortCharactersByTime(
    project.characterAnnotations.filter((item) => item.lineId === lineId),
  );
  const existingLine = project.subtitleLines.find((line) => line.id === lineId);

  if (lineCharacters.length === 0) {
    return {
      ...project,
      subtitleLines: project.subtitleLines.filter((line) => line.id !== lineId),
    };
  }

  const nextLine: SubtitleLine = {
    id: lineId,
    text: lineCharacters.map((item) => item.char).join(""),
    startTime: lineCharacters[0].startTime,
    endTime: lineCharacters[lineCharacters.length - 1].endTime,
    // 逐字同步只更新句文本和边界，已有句级学术标注必须原样保留。
    deliveryMode: existingLine?.deliveryMode ?? null,
    roleType: existingLine?.roleType ?? null,
  };

  const nextLines = existingLine
    ? project.subtitleLines.map((line) => (line.id === lineId ? nextLine : line))
    : [...project.subtitleLines, nextLine];

  return {
    ...project,
    subtitleLines: sortSubtitleLines(nextLines),
  };
}

function syncSubtitleLines(project: ProjectData, lineIds: string[]) {
  return Array.from(new Set(lineIds)).reduce(
    (nextProject, lineId) => syncSubtitleLine(nextProject, lineId),
    project,
  );
}

function findCharacterCreationTarget(lines: SubtitleLine[], time: number) {
  const candidates = lines.flatMap((line) => {
    const results: Array<{ line: SubtitleLine; position: "start" | "end"; distance: number }> = [];
    const distanceFromEnd = time - line.endTime;
    if (distanceFromEnd >= 0 && distanceFromEnd <= CHARACTER_CREATE_ATTACH_WINDOW) {
      results.push({ line, position: "end", distance: distanceFromEnd });
    }
    const distanceFromStart = line.startTime - time;
    if (distanceFromStart >= 0 && distanceFromStart <= CHARACTER_CREATE_ATTACH_WINDOW) {
      results.push({ line, position: "start", distance: distanceFromStart });
    }
    return results;
  });

  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] ?? null;
}

function getCharacterCreationRange(
  line: SubtitleLine,
  position: "start" | "end",
  requestedRange: { startTime: number; endTime: number },
) {
  if (position === "end") {
    const startTime = Math.max(line.endTime, requestedRange.startTime);
    const endTime = Math.max(startTime + MIN_CHARACTER_DURATION, requestedRange.endTime);
    return {
      startTime,
      endTime,
    };
  }

  const endTime = Math.min(line.startTime, requestedRange.endTime);
  const startTime = Math.max(0, Math.min(requestedRange.startTime, endTime - MIN_CHARACTER_DURATION));
  return {
    startTime,
    endTime,
  };
}

function normalizeCharacterCreationRequest(startTime: number, explicitEndTime?: number) {
  const normalizedStart = Math.max(0, startTime);
  const normalizedEnd = explicitEndTime === undefined
    ? normalizedStart + DEFAULT_CHARACTER_DURATION
    : Math.max(normalizedStart + MIN_CHARACTER_DURATION, explicitEndTime);
  return {
    startTime: normalizedStart,
    endTime: normalizedEnd,
  };
}

function getDefaultTrackSnapEnabled(project: ProjectData) {
  return normalizeTrackSnapEnabledForProject(project);
}

function clampTime(time: number, maxDuration: number) {
  return Math.max(0, Math.min(time, maxDuration));
}

// 临时范围播放意图。
// - temporary-continuous-loop：P 在持久循环关闭时临时开启的持续循环，终点跳回起点，空格退出并继续普通播放。
// - play-range-once：Tab 单次范围播放，到终点暂停不跳回，结束后恢复进入前的持久循环设置。
// 持久循环（loopPlaybackEnabled）由用户主动开关，不在此 intent 内表达。
type RangePlaybackIntent =
  | {
      mode: "temporary-continuous-loop";
      rangeStart: number;
      rangeEnd: number;
    }
  | {
      mode: "play-range-once";
      restoreLoopEnabled: boolean;
      rangeStart: number;
      rangeEnd: number;
      playbackEnd: number;
    };

function doesRangePlaybackIntentMatch(
  intent: RangePlaybackIntent,
  range: { start: number; end: number },
) {
  return Math.abs(intent.rangeStart - range.start) <= 0.000001 &&
    Math.abs(intent.rangeEnd - range.end) <= 0.000001;
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  return ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName);
}

// 租约竞争优先展示服务端提供的持有者和失效时间；未知错误仍保留原始诊断，不从中文字符串猜状态。
function formatMutationLeaseError(error: unknown) {
  if (!(error instanceof PlatformApiError) || !error.details ||
    typeof error.details !== "object" || Array.isArray(error.details)) {
    return error instanceof Error ? error.message : "无法取得结构编辑锁，请稍后重试。";
  }
  const details = error.details as Record<string, unknown>;
  const holder = details.holder && typeof details.holder === "object" && !Array.isArray(details.holder)
    ? details.holder as Record<string, unknown>
    : null;
  const holderName = typeof holder?.displayName === "string" ? holder.displayName : null;
  const expiresAt = typeof details.expiresAt === "string" ? new Date(details.expiresAt) : null;
  const expiryLabel = expiresAt && Number.isFinite(expiresAt.getTime())
    ? expiresAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  return [
    error.message,
    holderName ? `当前持有者：${holderName}` : null,
    expiryLabel ? `预计失效：${expiryLabel}` : null,
  ].filter(Boolean).join("\n");
}

// 顶部只呈现短状态，不显示 token 或把租约误写成项目同步状态。
function getMutationLeaseStatusLabel(state: PlatformMutationLeaseViewState, hasValidToken: boolean) {
  if (state.status === "acquiring") return "正在取得结构编辑锁";
  if (state.status === "active") return "结构编辑锁";
  if (state.status === "error") return hasValidToken ? "结构锁续期重试中" : "结构编辑锁异常";
  return undefined;
}

function App() {
  return (
    <PlatformWorkspace
      renderEditor={(editorSession, localEditorSession, platformNavigation) => (
        <EditorWorkbench
          key={editorSession?.annotationFileId ?? localEditorSession?.id ?? "local-editor"}
          editorSession={editorSession}
          localEditorSession={localEditorSession}
          platformNavigation={platformNavigation}
        />
      )}
    />
  );
}

export default App;
