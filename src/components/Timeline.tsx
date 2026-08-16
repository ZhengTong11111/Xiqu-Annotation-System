import {
  Fragment,
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ActionAnnotation,
  AttachedPointAnnotation,
  BranchScope,
  BranchLane,
  BanyanMark,
  BanyanSection,
  BuiltinTrack,
  BuiltinTrackId,
  CharacterAnnotation,
  CustomTrack,
  GongcheAnnotation,
  GongcheSymbol,
  ProjectData,
  ResolvedCustomTrackBlock,
  SelectedItem,
  SpectrogramData,
  SpectrogramSettings,
  SubtitleLine,
  TimelineBatchMoveItem,
  TimelineSelectionItem,
  TrackDefinition,
  WaveformData,
} from "../types";
import { SpectrogramCanvas } from "./SpectrogramCanvas";
import { clampRange, getParentTrackIdFromGongcheTrackId } from "../utils/project";
import { getBranchLaneCount } from "../utils/trackBranching";
import { getSpectrogramFrequencyRange } from "../utils/spectrogram";
import { intersectTimedMediaRange } from "../utils/mediaAnalysisRange";
import { getBanyanMarkDisplayLabel, getBanyanSubtypeLabel } from "../utils/banyan";
import {
  getColorCssVariables,
  getCustomBlockDisplayColor,
  resolveCustomTrackColor,
} from "../utils/trackColors";
import { getCharacterToneLabel, isValidCharacterToneInfo } from "../utils/tone";
import type { RemoteTimelineActivityView } from "../platform/remoteTimelineActivityRegistry";

type TimelineProps = {
  editingBlockedReason?: string;
  subtitleLines: SubtitleLine[];
  builtinTracks: BuiltinTrack[];
  characterAnnotations: CharacterAnnotation[];
  gongcheAnnotations: GongcheAnnotation[];
  banyanSections: BanyanSection[];
  banyanMarks: BanyanMark[];
  banyanGridVisible: boolean;
  banyanTrackVisible: boolean;
  waveformVisible: boolean;
  actionAnnotations: ActionAnnotation[];
  customTracks: CustomTrack[];
  trackDefinitions: TrackDefinition[];
  missingBuiltinTracks: BuiltinTrack[];
  waveformData: WaveformData | null;
  isWaveformLoading: boolean;
  spectrogramData: SpectrogramData | null;
  isSpectrogramLoading: boolean;
  spectrogramSettings: SpectrogramSettings;
  currentTime: number;
  remoteActivities: RemoteTimelineActivityView[];
  pointerSourceId: string;
  onTransientPointerTimeChange: (sourceId: string, time: number | null) => void;
  loopPlaybackRange: { start: number; end: number } | null;
  loopPlaybackEnabled: boolean;
  confirmationRanges: TimelineConfirmationRange[];
  confirmationRangesVisible: boolean;
  isDetached?: boolean;
  selectedItem: SelectedItem;
  selectedTimelineItems: TimelineSelectionItem[];
  trackSnapEnabled: Record<string, boolean>;
  zoom: number;
  duration: number;
  focusRange: { start: number; end: number; requestId: number } | null;
  onFocusRangeHandled: () => void;
  getProjectSnapshot: () => ProjectData;
  editingCharacterId: string | null;
  editingCharacterLocation: "timeline" | "split-panel" | null;
  editingCharacterValue: string;
  editingCustomTextBlock: { trackId: string; id: string } | null;
  editingCustomTextValue: string;
  onZoomChange: (zoom: number) => void;
  onViewportTimeRangeChange?: (range: { startTime: number; endTime: number; zoom: number }) => void;
  onToggleTrackSnap: (trackId: string) => void;
  onLoopPlaybackRangeChange: (range: { start: number; end: number } | null) => void;
  onLoopPlaybackEnabledChange: (enabled: boolean) => void;
  onSelectConfirmationRange: (range: TimelineConfirmationRange) => void;
  onToggleDetached?: () => void;
  onSeek: (time: number) => void;
  onPreviewFrame: (time: number | null) => void;
  onSelectItem: (item: SelectedItem) => void;
  onCloseContextMenu: () => void;
  onSelectBuiltinTrack: (trackId: BuiltinTrackId) => void;
  onSelectTrack: (trackId: string) => void;
  onSelectAttachedPointTrack: (trackId: string, parentTrackId: string) => void;
  onMoveTrack: (trackId: string, direction: "up" | "down") => void;
  onReorderTrack: (trackId: string, insertionIndex: number) => void;
  onToggleAttachedPointTracks: (parentTrackId: string) => void;
  onDeleteBuiltinTrack: (trackId: BuiltinTrackId) => void;
  onDeleteCustomTrack: (trackId: string) => void;
  onSelectLineOverlay: (lineId: string) => void;
  onSelectTimelineItems: (items: TimelineSelectionItem[], primaryItem: SelectedItem) => void;
  onEditCharacterText: (id: string) => void;
  onEditCustomTextBlock: (trackId: string, id: string) => void;
  onEditingCharacterValueChange: (value: string) => void;
  onEditingCustomTextValueChange: (value: string) => void;
  onCommitCharacterTextEdit: (id: string) => void;
  onCommitCustomTextEdit: (trackId: string, id: string) => void;
  onCancelCharacterTextEdit: () => void;
  onCancelCustomTextEdit: () => void;
  onCreateCharacterAtTime: (time: number, endTime?: number) => void;
  onCreateActionAtTime: (trackId: string, startTime: number) => void;
  onCreateCustomBlock: (trackId: string, startTime: number, endTime?: number, branchScope?: BranchScope) => void;
  onCreateGongcheBlockAtTime: (parentTrackId: string, time: number) => void;
  onCreateAttachedPoint: (trackId: string, time: number) => void;
  onAddBuiltinTrack: (trackId: BuiltinTrackId) => void;
  onAddCustomTrack: (trackType: "text" | "action") => void;
  onUpdatePasteTarget: (trackId: string, time: number) => void;
  onOpenCharacterContextMenu: (id: string, time: number, x: number, y: number) => void;
  onOpenActionContextMenu: (id: string, time: number, x: number, y: number) => void;
  onOpenCustomBlockContextMenu: (trackId: string, id: string, time: number, x: number, y: number) => void;
  onOpenAttachedPointContextMenu: (trackId: string, parentTrackId: string, id: string, time: number, x: number, y: number) => void;
  onOpenGongcheBlockContextMenu: (id: string, time: number, x: number, y: number) => void;
  onOpenBanyanMarkContextMenu: (id: string, time: number, x: number, y: number) => void;
  onOpenLaneContextMenu: (trackId: string, time: number, x: number, y: number) => void;
  onLineChange: (id: string, changes: Pick<SubtitleLine, "startTime" | "endTime">) => void;
  onLineCommit: (id: string, changes: Pick<SubtitleLine, "startTime" | "endTime">) => void;
  onCharacterChange: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onCharacterCommit: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onActionChange: (id: string, changes: Partial<ActionAnnotation>) => void;
  onActionCommit: (id: string, changes: Partial<ActionAnnotation>) => void;
  onAttachedPointChange: (trackId: string, pointId: string, changes: Partial<AttachedPointAnnotation>) => void;
  onAttachedPointCommit: (trackId: string, pointId: string, changes: Partial<AttachedPointAnnotation>) => void;
  onGongcheBlockChange: (
    id: string,
    changes: Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">>,
  ) => void;
  onGongcheBlockCommit: (
    id: string,
    changes: Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">>,
  ) => void;
  onBanyanMarkChange: (id: string, changes: Partial<BanyanMark>) => void;
  onBanyanMarkCommit: (id: string, changes: Partial<BanyanMark>) => void;
  onCreateBanyanMark: (time: number) => void;
  onCustomBlockChange: (
    trackId: string,
    id: string,
    changes: { startTime?: number; endTime?: number; text?: string; type?: string },
  ) => void;
  onCustomBlockCommit: (
    trackId: string,
    id: string,
    changes: { startTime?: number; endTime?: number; text?: string; type?: string },
  ) => void;
  onBatchMoveChange: (items: TimelineBatchMoveItem[]) => void;
  onBatchMoveCommit: (items: TimelineBatchMoveItem[]) => void;
  onCreateAction: (trackId: string, startTime: number, endTime: number) => void;
};

// 确认栏只消费时间轴渲染字段，避免通用 Timeline 依赖平台 API 或治理权限模型。
export type TimelineConfirmationRange = {
  id: string;
  startTime: number;
  endTime: number;
  label: string;
  lane: number;
  lifecycle: "active" | "revoked";
  freshness: "current" | "stale";
};

type DragState =
  | {
      kind: "move-line";
      id: string;
      originX: number;
      originalStart: number;
      originalEnd: number;
    }
  | {
      kind: "move-character" | "resize-left-character" | "resize-right-character";
      id: string;
      originX: number;
      originalStart: number;
      originalEnd: number;
    }
  | {
      kind: "move-action" | "resize-left-action" | "resize-right-action";
      id: string;
      originX: number;
      originalStart: number;
      originalEnd: number;
    }
  | {
      kind: "move-point";
      id: string;
      trackId: string;
      parentTrackId: string;
      originX: number;
      originalTime: number;
    }
  | {
      kind: "move-banyan-mark";
      id: string;
      originX: number;
      originalTime: number;
      estimatedTime: number;
    }
  | {
      kind: "move-gongche";
      id: string;
      parentTrackId: string;
      parentBlockId: string;
      originX: number;
      originalStart: number;
      originalEnd: number;
      parentStart: number;
      parentEnd: number;
      originalSymbols: GongcheSymbol[];
    }
  | {
      kind: "move-gongche-boundary";
      id: string;
      boundaryIndex: number;
      originX: number;
      originalBoundaryTime: number;
      minTime: number;
      maxTime: number;
      originalSymbols: GongcheSymbol[];
    }
  | {
      kind: "move-selection";
      originX: number;
      items: TimelineBatchMoveItem[];
    }
  | {
      kind: "resize-linked";
      trackId: string;
      originX: number;
      boundaryTime: number;
      members: BoundaryGroupMember[];
    }
  | {
      kind: "create-track-item";
      trackId: string;
      trackType: "character" | "action" | "custom-text" | "custom-action";
      visualTrackId: string;
      branchScope?: BranchScope;
      originX: number;
      currentX: number;
      laneLeft: number;
    }
  | {
      kind: "select-box";
      originX: number;
      originY: number;
      currentX: number;
      currentY: number;
      originContentX: number;
      originContentY: number;
      currentContentX: number;
      currentContentY: number;
      shiftKey: boolean;
      additive: boolean;
    }
  | null;

const DEFAULT_TRACK_HEIGHT = 60;
const MIN_TRACK_HEIGHT = 42;
const MAX_TRACK_HEIGHT = 112;
const TRACK_HEIGHT_STEP = 4;
const TRACK_LABEL_WIDTH = 164;
const DEFAULT_WAVEFORM_TRACK_HEIGHT = DEFAULT_TRACK_HEIGHT;
const MIN_WAVEFORM_TRACK_HEIGHT = 44;
const MAX_WAVEFORM_TRACK_HEIGHT = 240;
const DEFAULT_SPECTROGRAM_TRACK_HEIGHT = 150;
const MIN_SPECTROGRAM_TRACK_HEIGHT = 72;
const MAX_SPECTROGRAM_TRACK_HEIGHT = 360;
const BANYAN_TRACK_HEIGHT = 46;
const SNAP_DISTANCE_PX = 4;
const SNAP_VISUAL_MATCH_PX = 1;
const REORDER_ACTIVATION_PX = 6;
const ZOOM_SETTLE_MS = 220;
const ZOOM_MIN = 5;
const ZOOM_MAX = 500;
const ZOOM_STEP = 5;
const DRAG_ACTIVATION_PX = 4;
const EDGE_HIT_SLOP_PX = 8;
const SELECTED_EDGE_HIT_SLOP_PX = 17;
const LINKED_EDGE_HIT_RATIO = 0.55;
const MIN_LINKED_EDGE_HIT_SLOP_PX = 4;
const PREVIEW_UPDATE_EPSILON = 1 / 60;
const SPECTROGRAM_ZOOM_PREVIEW_SETTLE_MS = 120;
const MIN_BLOCK_WIDTH_PX = 44;
// 逐字块内四声标签的宽度估算：用于判断块是否够宽/够高能放下标签。
// TONE_LABEL_CHAR_PX 是 10px 字号下每个 CJK 的近似宽度；
// TONE_LABEL_RESERVED_PX 是横向并排时的固定开销（字宽 + 间距 + 两侧留白）；
// TONE_LABEL_SIDE_PADDING 是上下两层时标签独占一行所需的两侧留白；
// TONE_LABEL_STACK_MIN_HEIGHT 是上下两层所需的最小块高（字行 + 间距 + 标签行）。
const TONE_LABEL_CHAR_PX = 10;
const TONE_LABEL_RESERVED_PX = 28;
const TONE_LABEL_SIDE_PADDING = 6;
const TONE_LABEL_STACK_MIN_HEIGHT = 30;
const MIN_WAVEFORM_VIEW_HEIGHT = 32;
const WAVEFORM_TRACK_VERTICAL_PADDING = 8;
const MIN_SPECTROGRAM_VIEW_HEIGHT = 48;
const SPECTROGRAM_TRACK_VERTICAL_PADDING = 10;
const WAVEFORM_MAX_WIDTH = 1800;
const WAVEFORM_MAX_BUCKETS = 960;
const WAVEFORM_MAX_SAMPLES_PER_BUCKET = 192;
const CLICK_SUPPRESS_MS = 120;
const FOCUS_SCROLL_DURATION_MS = 260;
const SNAP_RELEASE_DISTANCE_PX = 16;
const LOOP_RANGE_MIN_DURATION = 0.05;
const MIN_GONGCHE_DURATION = 0.04;
const SELECT_BOX_AUTOSCROLL_HORIZONTAL_EDGE_PX = 10;
const SELECT_BOX_AUTOSCROLL_VERTICAL_EDGE_PX = 10;
const SELECT_BOX_AUTOSCROLL_MAX_SPEED = 18;
const STACKED_TRACK_OVERLAP_TOLERANCE_SECONDS = 0.025;

type ZoomGestureState = {
  startZoom: number;
  anchorTime: number;
  viewportOffset: number;
};

type PendingZoomState = {
  nextZoom: number;
  anchorTime: number;
  viewportOffset: number;
};

type SliderZoomState = {
  anchorTime: number;
  viewportOffset: number;
};

type PendingDragUpdate =
  | {
      target: "line";
      id: string;
      changes: Pick<SubtitleLine, "startTime" | "endTime">;
    }
  | {
      target: "character";
      id: string;
      changes: Partial<CharacterAnnotation>;
    }
  | {
      target: "action";
      id: string;
      changes: Partial<ActionAnnotation>;
    }
  | {
      target: "attached-point";
      trackId: string;
      pointId: string;
      changes: Partial<AttachedPointAnnotation>;
    }
  | {
      target: "banyan-mark";
      id: string;
      changes: Partial<BanyanMark>;
    }
  | {
      target: "gongche";
      id: string;
      changes: Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">>;
    }
  | {
      target: "custom-block";
      trackId: string;
      id: string;
      changes: { startTime?: number; endTime?: number; text?: string; type?: string };
    }
  | {
      target: "selection";
      items: TimelineBatchMoveItem[];
    };

type HoveredBlockState =
  | {
      id: string;
      type: "character" | "action";
      edge: EdgeHit;
    }
  | {
      id: string;
      type: "custom-block";
      trackId: string;
      edge: EdgeHit;
    }
  | null;

type ActiveSnapIndicator = {
  trackId: string;
  time: number;
  edge: "left" | "right";
} | null;

type DragSnapLock = {
  point: number;
  edge: "left" | "right";
} | null;

type EdgeHit = "left" | "right" | "center" | "linked-left" | "linked-right";
type TimelineIntervalBlock = {
  id: string;
  startTime: number;
  endTime: number;
};
type TimelineLayoutBlock = CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock;

// 联合调整只描述“哪些块边界会一起被改动”，不要和可吸附参考点混为一谈。
// 调用方通过 linkedBoundaryCandidates 决定联合范围：
// - 分叉合并显示：传入父轨当前可见块，允许跨分叉联合拖动；
// - 分叉展开显示：传入当前子轨可见块，只在子轨内部联合拖动。
type BoundaryGroupMember = {
  item: TimelineBatchMoveItem;
  edge: "start" | "end";
};

type ResolvedAttachedPointTrack = {
  id: string;
  name: string;
  parentTrackId: string;
  parentTrackName: string;
  typeOptions: string[];
  points: AttachedPointAnnotation[];
};

type StackedTrackBlockDisplayLayout = {
  top: number;
  height: number;
};

type StackedTrackSizing = {
  rowHeight: number;
  rowGap: number;
  verticalPadding: number;
  trackHeight: number;
};

type StackedTrackLayout = {
  rowCount: number;
  trackHeight: number;
  blockDisplayLayouts: Map<string, StackedTrackBlockDisplayLayout>;
};

type StackedLayoutInput =
  | {
      mode: "standard";
      blocks: TimelineLayoutBlock[];
    }
  | {
      mode: "merged-branch";
      blocks: ResolvedCustomTrackBlock[];
      sourceTrack: CustomTrack;
    };

type BranchLayoutNode = {
  key: string;
  laneId: string | null;
  parent: BranchLayoutNode | null;
  children: BranchLayoutNode[];
  blocks: ResolvedCustomTrackBlock[];
};

type BranchBandMeasurement = {
  node: BranchLayoutNode;
  ownRowCount: number;
  subtreeRowCount: number;
  childMeasurements: BranchBandMeasurement[];
};

type BranchBandGeometry = {
  ownTop: number;
  subtreeTop: number;
  subtreeHeight: number;
  ownRowCount: number;
};

type TrackBlockMetrics = {
  top: number;
  height: number;
};

type LoopRangeSelectionState = {
  pointerId: number;
  originX: number;
  currentX: number;
};

type LoopRangeDragState =
  | {
      pointerId: number;
      mode: "move";
      originX: number;
      originalRange: { start: number; end: number };
    }
  | {
      pointerId: number;
      mode: "resize-start" | "resize-end";
      originX: number;
      originalRange: { start: number; end: number };
    };

export function Timeline({
  editingBlockedReason,
  subtitleLines,
  builtinTracks,
  characterAnnotations,
  gongcheAnnotations,
  banyanSections,
  banyanMarks,
  banyanGridVisible,
  banyanTrackVisible,
  waveformVisible,
  actionAnnotations,
  customTracks,
  trackDefinitions,
  missingBuiltinTracks,
  waveformData,
  isWaveformLoading,
  spectrogramData,
  isSpectrogramLoading,
  spectrogramSettings,
  currentTime,
  remoteActivities,
  pointerSourceId,
  onTransientPointerTimeChange,
  loopPlaybackRange,
  loopPlaybackEnabled,
  confirmationRanges,
  confirmationRangesVisible,
  isDetached = false,
  selectedItem,
  selectedTimelineItems,
  trackSnapEnabled,
  zoom,
  duration,
  focusRange,
  onFocusRangeHandled,
  getProjectSnapshot,
  editingCharacterId,
  editingCharacterLocation,
  editingCharacterValue,
  editingCustomTextBlock,
  editingCustomTextValue,
  onZoomChange,
  onViewportTimeRangeChange,
  onToggleTrackSnap,
  onLoopPlaybackRangeChange,
  onLoopPlaybackEnabledChange,
  onSelectConfirmationRange,
  onToggleDetached,
  onSeek,
  onPreviewFrame,
  onSelectItem,
  onCloseContextMenu,
  onSelectBuiltinTrack,
  onSelectTrack,
  onSelectAttachedPointTrack,
  onMoveTrack,
  onReorderTrack,
  onToggleAttachedPointTracks,
  onDeleteBuiltinTrack,
  onDeleteCustomTrack,
  onSelectLineOverlay,
  onSelectTimelineItems,
  onEditCharacterText,
  onEditCustomTextBlock,
  onEditingCharacterValueChange,
  onEditingCustomTextValueChange,
  onCommitCharacterTextEdit,
  onCommitCustomTextEdit,
  onCancelCharacterTextEdit,
  onCancelCustomTextEdit,
  onCreateCharacterAtTime,
  onCreateActionAtTime,
  onCreateCustomBlock,
  onCreateGongcheBlockAtTime,
  onCreateAttachedPoint,
  onAddBuiltinTrack,
  onAddCustomTrack,
  onUpdatePasteTarget,
  onOpenCharacterContextMenu,
  onOpenActionContextMenu,
  onOpenCustomBlockContextMenu,
  onOpenAttachedPointContextMenu,
  onOpenGongcheBlockContextMenu,
  onOpenBanyanMarkContextMenu,
  onOpenLaneContextMenu,
  onLineChange,
  onLineCommit,
  onCharacterChange,
  onCharacterCommit,
  onActionChange,
  onActionCommit,
  onAttachedPointChange,
  onAttachedPointCommit,
  onGongcheBlockChange,
  onGongcheBlockCommit,
  onBanyanMarkChange,
  onBanyanMarkCommit,
  onCreateBanyanMark,
  onCustomBlockChange,
  onCustomBlockCommit,
  onBatchMoveChange,
  onBatchMoveCommit,
  onCreateAction,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomAnchorRef = useRef<{ time: number; viewportOffset: number } | null>(null);
  const zoomGestureRef = useRef<ZoomGestureState | null>(null);
  const zoomRef = useRef(zoom);
  const currentTimeRef = useRef(currentTime);
  const zoomInteractionUntilRef = useRef(0);
  const pendingZoomRef = useRef<PendingZoomState | null>(null);
  const sliderZoomRef = useRef<SliderZoomState | null>(null);
  const zoomFrameRef = useRef<number | null>(null);
  const zoomPreviewTimerRef = useRef<number | null>(null);
  const dragStateRef = useRef<DragState>(null);
  const lastPointerClientXRef = useRef(0);
  const lastPointerStepPxRef = useRef(0);
  const pendingDragUpdateRef = useRef<PendingDragUpdate | null>(null);
  const lastResolvedDragUpdateRef = useRef<PendingDragUpdate | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const selectBoxAutoScrollFrameRef = useRef<number | null>(null);
  const selectBoxPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const pendingPreviewTimeRef = useRef<number | null>(null);
  const previewTimeRef = useRef<number | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const rulerScrubPointerIdRef = useRef<number | null>(null);
  const loopRangeSelectionRef = useRef<LoopRangeSelectionState | null>(null);
  const loopRangeDragRef = useRef<LoopRangeDragState | null>(null);
  const pendingRulerSeekTimeRef = useRef<number | null>(null);
  const rulerSeekFrameRef = useRef<number | null>(null);
  const focusScrollFrameRef = useRef<number | null>(null);
  const focusScrollUntilRef = useRef(0);
  const dragSnapLockRef = useRef<DragSnapLock>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const suppressLineClickIdRef = useRef<string | null>(null);
  const suppressCanvasClickUntilRef = useRef(0);
  const suppressLoopRangeClickUntilRef = useRef(0);
  const draggedTrackIdRef = useRef<string | null>(null);
  const trackRowRefs = useRef(new Map<string, HTMLDivElement>());
  const previousTrackRowPositionsRef = useRef(new Map<string, number>());
  const previousTrackIdsRef = useRef<string[]>([]);
  const [dragState, setDragState] = useState<DragState>(null);
  const [hoveredBlock, setHoveredBlock] = useState<HoveredBlockState>(null);
  const [activeSnapIndicator, setActiveSnapIndicator] = useState<ActiveSnapIndicator>(null);
  const [previewGuideTime, setPreviewGuideTime] = useState<number | null>(null);
  const transientPointerFrameRef = useRef<number | null>(null);
  const pendingTransientPointerTimeRef = useRef<number | null>(null);
  const [draggedPointPreview, setDraggedPointPreview] = useState<{
    id: string;
    trackId: string;
    time: number;
  } | null>(null);
  const [loopRangeDraft, setLoopRangeDraft] = useState<{ start: number; end: number } | null>(null);
  const [loopRangePressed, setLoopRangePressed] = useState(false);
  const [trackHeight, setTrackHeight] = useState(DEFAULT_TRACK_HEIGHT);
  const [waveformTrackHeight, setWaveformTrackHeight] = useState(DEFAULT_WAVEFORM_TRACK_HEIGHT);
  const [waveformResizeDrag, setWaveformResizeDrag] = useState<{
    startY: number;
    startHeight: number;
  } | null>(null);
  const [spectrogramInteractionPreview, setSpectrogramInteractionPreview] = useState(false);
  const [spectrogramTrackHeight, setSpectrogramTrackHeight] = useState(DEFAULT_SPECTROGRAM_TRACK_HEIGHT);
  const [spectrogramResizeDrag, setSpectrogramResizeDrag] = useState<{
    startY: number;
    startHeight: number;
  } | null>(null);
  const [viewportState, setViewportState] = useState({ scrollLeft: 0, width: 0 });
  const [draggedTrackId, setDraggedTrackId] = useState<string | null>(null);
  const [trackDropInsertionIndex, setTrackDropInsertionIndex] = useState<number | null>(null);
  const [recentlyMovedTrackId, setRecentlyMovedTrackId] = useState<string | null>(null);
  const [trackReorderDrag, setTrackReorderDrag] = useState<{
    trackId: string;
    startY: number;
    currentY: number;
  } | null>(null);
  const moveTrackHighlightTimerRef = useRef<number | null>(null);
  const selectionAnchorRef = useRef<TimelineSelectionItem | null>(selectedTimelineItems[0] ?? null);

  // Timeline 只上报时间语义；网络节流由 collaboration runtime 统一负责。
  const queueTransientPointerTime = useCallback((time: number | null) => {
    pendingTransientPointerTimeRef.current = time;
    if (transientPointerFrameRef.current !== null) return;
    transientPointerFrameRef.current = requestAnimationFrame(() => {
      transientPointerFrameRef.current = null;
      onTransientPointerTimeChange(pointerSourceId, pendingTransientPointerTimeRef.current);
    });
  }, [onTransientPointerTimeChange, pointerSourceId]);

  useEffect(() => () => {
    if (transientPointerFrameRef.current !== null) {
      cancelAnimationFrame(transientPointerFrameRef.current);
      transientPointerFrameRef.current = null;
    }
    onTransientPointerTimeChange(pointerSourceId, null);
  }, [onTransientPointerTimeChange, pointerSourceId]);
  const timelineWidth = Math.max(TRACK_LABEL_WIDTH + duration * zoom, 1200);
  // 确认栏按重叠层数自适应高度；无记录时仍保留一条紧凑栏，供平台用户识别该治理层。
  const confirmationLaneCount = confirmationRangesVisible
    ? Math.max(1, ...confirmationRanges.map((range) => range.lane + 1))
    : 0;
  const confirmationLaneHeight = confirmationLaneCount > 0
    ? confirmationLaneCount * 18 + 4
    : 0;
  const defaultTrackBlockMetrics = getTrackBlockMetrics(trackHeight);
  const trackBlockHeight = defaultTrackBlockMetrics.height;
  const trackBlockTop = defaultTrackBlockMetrics.top;
  const compactTrackLabels = trackHeight <= 52;
  const compactAttachedPointMeta = trackHeight <= 64;
  const waveformViewHeight = Math.max(
    MIN_WAVEFORM_VIEW_HEIGHT,
    waveformTrackHeight - WAVEFORM_TRACK_VERTICAL_PADDING * 2,
  );
  const spectrogramViewHeight = Math.max(
    MIN_SPECTROGRAM_VIEW_HEIGHT,
    spectrogramTrackHeight - SPECTROGRAM_TRACK_VERTICAL_PADDING * 2,
  );
  const spectrogramFrequencyRange = getSpectrogramFrequencyRange(spectrogramSettings);
  const isWaveformTrackSelected = selectedItem?.type === "waveform-track";
  const isSpectrogramTrackSelected = selectedItem?.type === "spectrogram-track";
  const sliderZoom = Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
  const customBlocks = useMemo(
    () => flattenCustomBlocks(customTracks),
    [customTracks],
  );
  const customTrackMap = useMemo(
    () => new Map(customTracks.map((track, index) => [track.id, { track, index }])),
    [customTracks],
  );
  const trackDefinitionMap = useMemo(
    () => new Map(trackDefinitions.map((track) => [track.id, track])),
    [trackDefinitions],
  );
  const trackBlockLayouts = useMemo(
    () => buildTrackBlockLayouts(
      trackDefinitions,
      customTracks,
      characterAnnotations,
      actionAnnotations,
      customBlocks,
      trackHeight,
    ),
    [trackDefinitions, customTracks, characterAnnotations, actionAnnotations, customBlocks, trackHeight],
  );
  const attachedPointTracks = useMemo(
    () => flattenAttachedPointTracks(builtinTracks, customTracks),
    [builtinTracks, customTracks],
  );
  const attachedPointTrackMap = useMemo(
    () => new Map(attachedPointTracks.map((track) => [track.id, track])),
    [attachedPointTracks],
  );
  const parentTrackMap = useMemo(
    () =>
      new Map(
        [...builtinTracks, ...customTracks].map((track) => [
          track.id,
          {
            attachedPointTrackCount: track.attachedPointTracks?.length ?? 0,
            attachedPointTracksExpanded: Boolean(track.attachedPointTracksExpanded),
          },
        ]),
      ),
    [builtinTracks, customTracks],
  );
  const activeTrackDefinitions = useMemo(
    () => trackDefinitions.filter((track) => track.isCustom || track.isBuiltin),
    [trackDefinitions],
  );
  const activeTrackOrderMap = useMemo(
    () => new Map(activeTrackDefinitions.map((track, index) => [track.id, index])),
    [activeTrackDefinitions],
  );
  const timelineTrackOrderMap = useMemo(
    () => new Map(trackDefinitions.map((track, index) => [track.id, index])),
    [trackDefinitions],
  );
  const activeTrackIds = useMemo(
    () => activeTrackDefinitions.map((track) => track.id),
    [activeTrackDefinitions],
  );
  const remainingActiveTrackIds = useMemo(
    () => activeTrackIds.filter((trackId) => trackId !== draggedTrackId),
    [activeTrackIds, draggedTrackId],
  );
  const customTrackDropBeforeId = trackDropInsertionIndex !== null &&
    trackDropInsertionIndex < remainingActiveTrackIds.length
    ? remainingActiveTrackIds[trackDropInsertionIndex]
    : null;
  const customTrackDropAfterId = trackDropInsertionIndex !== null &&
    trackDropInsertionIndex === remainingActiveTrackIds.length &&
    remainingActiveTrackIds.length > 0
    ? remainingActiveTrackIds[remainingActiveTrackIds.length - 1]
    : null;
  const waveformDetail = useMemo(() => {
    if (!waveformData || waveformData.samples.length === 0) {
      return null;
    }

    const laneViewportStart = Math.max(0, viewportState.scrollLeft - TRACK_LABEL_WIDTH);
    const laneViewportWidth = Math.max(
      240,
      viewportState.width - Math.max(TRACK_LABEL_WIDTH - viewportState.scrollLeft, 0),
    );
    const visibleStartTime = Math.max(0, laneViewportStart / zoom);
    const visibleEndTime = Math.min(duration, (laneViewportStart + laneViewportWidth) / zoom);
    // 平台瓦片可能带正负分析音频偏移；只绘制真实数据交集，不能把首尾采样夹取到空白时间。
    const dataRange = intersectTimedMediaRange(
      visibleStartTime,
      visibleEndTime,
      waveformData.timeOffset ?? 0,
      waveformData.duration,
    );
    if (!dataRange) return null;
    const visibleDuration = dataRange.endTime - dataRange.startTime;
    const renderWidth = Math.max(
      240,
      Math.min(Math.ceil(visibleDuration * zoom), Math.min(WAVEFORM_MAX_WIDTH, Math.ceil(laneViewportWidth))),
    );

    const points = buildWaveformEnvelope(
      waveformData,
      dataRange.startTime,
      dataRange.endTime,
      renderWidth,
      waveformViewHeight,
    );

    return {
      ...points,
      left: dataRange.startTime * zoom,
      width: Math.max(visibleDuration * zoom, 1),
    };
  }, [duration, viewportState, waveformData, waveformViewHeight, zoom]);
  const visibleWaveformKeypoints = useMemo(() => {
    if (!waveformData?.keypoints?.length) {
      return [];
    }
    const laneViewportStart = Math.max(0, viewportState.scrollLeft - TRACK_LABEL_WIDTH);
    const laneViewportWidth = Math.max(
      240,
      viewportState.width - Math.max(TRACK_LABEL_WIDTH - viewportState.scrollLeft, 0),
    );
    const visibleStartTime = Math.max(0, laneViewportStart / zoom);
    const visibleEndTime = Math.min(duration, (laneViewportStart + laneViewportWidth) / zoom);
    return waveformData.keypoints.filter((time) => time >= visibleStartTime && time <= visibleEndTime);
  }, [duration, viewportState.scrollLeft, viewportState.width, waveformData, zoom]);
  const spectrogramViewport = useMemo(() => {
    const laneViewportStart = Math.max(0, viewportState.scrollLeft - TRACK_LABEL_WIDTH);
    const laneViewportWidth = Math.max(
      240,
      viewportState.width - Math.max(TRACK_LABEL_WIDTH - viewportState.scrollLeft, 0),
    );
    const visibleStartTime = Math.max(0, laneViewportStart / zoom);
    const visibleEndTime = Math.min(duration, (laneViewportStart + laneViewportWidth) / zoom);
    const visibleDuration = Math.max(visibleEndTime - visibleStartTime, 0.001);
    const overscanDuration = Math.max(1, visibleDuration * 0.55);
    const tileDuration = Math.max(1, visibleDuration * 0.55);
    const renderStartTime = Math.max(
      0,
      Math.floor(Math.max(0, visibleStartTime - overscanDuration) / tileDuration) * tileDuration,
    );
    const renderEndTime = Math.min(
      duration,
      Math.ceil((visibleEndTime + overscanDuration) / tileDuration) * tileDuration,
    );
    const renderDuration = Math.max(renderEndTime - renderStartTime, 0.001);
    return {
      startTime: renderStartTime,
      endTime: renderEndTime,
      activeStartTime: visibleStartTime,
      activeEndTime: visibleEndTime,
      left: renderStartTime * zoom,
      width: Math.max(renderDuration * zoom, 1),
    };
  }, [duration, viewportState.scrollLeft, viewportState.width, zoom]);
  useEffect(() => {
    onViewportTimeRangeChange?.({
      startTime: spectrogramViewport.activeStartTime,
      endTime: spectrogramViewport.activeEndTime,
      zoom,
    });
  }, [onViewportTimeRangeChange, spectrogramViewport.activeEndTime, spectrogramViewport.activeStartTime, zoom]);
  const selectedTimelineKeySet = useMemo(
    () => new Set(selectedTimelineItems.map((item) => getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item)))),
    [selectedTimelineItems],
  );
  useEffect(() => {
    const anchor = selectionAnchorRef.current;
    if (
      anchor &&
      selectedTimelineKeySet.has(getTimelineSelectionKey(anchor.type, anchor.id, getSelectionItemTrackId(anchor)))
    ) {
      return;
    }
    selectionAnchorRef.current = selectedTimelineItems[selectedTimelineItems.length - 1] ?? null;
  }, [selectedTimelineItems, selectedTimelineKeySet]);
  const marqueePreviewItems = useMemo(
    () => (dragState?.kind === "select-box" ? getItemsForSelectionDrag(dragState) : []),
    [
      dragState,
      characterAnnotations,
      actionAnnotations,
      customBlocks,
      attachedPointTracks,
      banyanMarks,
      viewportState,
      selectedTimelineItems,
      timelineTrackOrderMap,
    ],
  );
  const marqueePreviewKeySet = useMemo(
    () => new Set(marqueePreviewItems.map((item) => getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item)))),
    [marqueePreviewItems],
  );
  const displayedLoopPlaybackRange = loopRangeDraft ?? loopPlaybackRange;
  const visibleBanyanMarks = useMemo(() => {
    if (!banyanMarks.length || (!banyanGridVisible && !banyanTrackVisible)) {
      return [];
    }
    const laneViewportStart = Math.max(0, viewportState.scrollLeft - TRACK_LABEL_WIDTH);
    const laneViewportWidth = Math.max(
      240,
      viewportState.width - Math.max(TRACK_LABEL_WIDTH - viewportState.scrollLeft, 0),
    );
    const visibleStartTime = Math.max(0, laneViewportStart / zoom - 1);
    const visibleEndTime = Math.min(duration, (laneViewportStart + laneViewportWidth) / zoom + 1);
    return banyanMarks.filter((mark) => mark.time >= visibleStartTime && mark.time <= visibleEndTime);
  }, [banyanGridVisible, banyanMarks, banyanTrackVisible, duration, viewportState.scrollLeft, viewportState.width, zoom]);
  const playheadViewportOffset = useMemo(
    () => Math.max(0, Math.min(viewportState.width, getCanvasX(currentTime, zoom) - viewportState.scrollLeft)),
    [currentTime, viewportState, zoom],
  );

  function startWaveformResize(clientY: number) {
    setWaveformResizeDrag({
      startY: clientY,
      startHeight: waveformTrackHeight,
    });
  }

  function startSpectrogramResize(clientY: number) {
    setSpectrogramResizeDrag({
      startY: clientY,
      startHeight: spectrogramTrackHeight,
    });
  }

  function markSpectrogramZoomPreview(settleDelay = SPECTROGRAM_ZOOM_PREVIEW_SETTLE_MS) {
    setSpectrogramInteractionPreview(true);
    if (zoomPreviewTimerRef.current !== null) {
      window.clearTimeout(zoomPreviewTimerRef.current);
      zoomPreviewTimerRef.current = null;
    }
    if (!Number.isFinite(settleDelay)) {
      return;
    }
    zoomPreviewTimerRef.current = window.setTimeout(() => {
      zoomPreviewTimerRef.current = null;
      setSpectrogramInteractionPreview(false);
    }, settleDelay);
  }

  const timelineCanvasStyle = useMemo(
    () =>
      ({
        width: timelineWidth,
        "--track-label-width": `${TRACK_LABEL_WIDTH}px`,
        "--track-height": `${trackHeight}px`,
        "--track-block-height": `${trackBlockHeight}px`,
        "--track-block-top": `${trackBlockTop}px`,
        "--waveform-track-height": `${waveformTrackHeight}px`,
        "--confirmation-lane-height": `${confirmationLaneHeight}px`,
      } as CSSProperties),
    [
      confirmationLaneHeight,
      timelineWidth,
      trackBlockHeight,
      trackBlockTop,
      trackHeight,
      waveformTrackHeight,
    ],
  );

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  useEffect(() => {
    if (dragState?.kind !== "select-box") {
      stopSelectBoxAutoScroll();
      return;
    }

    const tick = () => {
      selectBoxAutoScrollFrameRef.current = null;
      const activeDragState = dragStateRef.current;
      const pointer = selectBoxPointerRef.current;
      const container = scrollRef.current;
      if (!pointer || !container || activeDragState?.kind !== "select-box") {
        return;
      }

      const interactionBounds = getSelectBoxInteractionBounds(container);
      const deltaX = getSelectBoxAutoScrollDelta(
        pointer.clientX,
        interactionBounds.left,
        interactionBounds.right,
        SELECT_BOX_AUTOSCROLL_HORIZONTAL_EDGE_PX,
      );
      const deltaY = getSelectBoxAutoScrollDelta(
        pointer.clientY,
        interactionBounds.top,
        interactionBounds.bottom,
        SELECT_BOX_AUTOSCROLL_VERTICAL_EDGE_PX,
      );
      const previousScrollLeft = container.scrollLeft;
      const previousScrollTop = container.scrollTop;

      if (deltaX !== 0 || deltaY !== 0) {
        container.scrollLeft += deltaX;
        container.scrollTop += deltaY;
      }

      if (
        previousScrollLeft !== container.scrollLeft ||
        previousScrollTop !== container.scrollTop
      ) {
        updateSelectBoxDrag(pointer.clientX, pointer.clientY);
      }

      selectBoxAutoScrollFrameRef.current = requestAnimationFrame(tick);
    };

    selectBoxAutoScrollFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (selectBoxAutoScrollFrameRef.current !== null) {
        cancelAnimationFrame(selectBoxAutoScrollFrameRef.current);
        selectBoxAutoScrollFrameRef.current = null;
      }
    };
  }, [dragState?.kind]);

  useEffect(() => {
    return () => {
      if (moveTrackHighlightTimerRef.current !== null) {
        window.clearTimeout(moveTrackHighlightTimerRef.current);
      }
      if (zoomFrameRef.current !== null) {
        cancelAnimationFrame(zoomFrameRef.current);
      }
      if (zoomPreviewTimerRef.current !== null) {
        window.clearTimeout(zoomPreviewTimerRef.current);
      }
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
      }
      if (selectBoxAutoScrollFrameRef.current !== null) {
        cancelAnimationFrame(selectBoxAutoScrollFrameRef.current);
      }
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
      }
      if (rulerSeekFrameRef.current !== null) {
        cancelAnimationFrame(rulerSeekFrameRef.current);
      }
      if (focusScrollFrameRef.current !== null) {
        cancelAnimationFrame(focusScrollFrameRef.current);
      }
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!waveformResizeDrag) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const deltaY = event.clientY - waveformResizeDrag.startY;
      setWaveformTrackHeight(
        clampValue(
          waveformResizeDrag.startHeight + deltaY,
          MIN_WAVEFORM_TRACK_HEIGHT,
          MAX_WAVEFORM_TRACK_HEIGHT,
        ),
      );
    };

    const handlePointerUp = () => {
      setWaveformResizeDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [waveformResizeDrag]);

  useEffect(() => {
    if (!spectrogramResizeDrag) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const deltaY = event.clientY - spectrogramResizeDrag.startY;
      setSpectrogramTrackHeight(
        clampValue(
          spectrogramResizeDrag.startHeight + deltaY,
          MIN_SPECTROGRAM_TRACK_HEIGHT,
          MAX_SPECTROGRAM_TRACK_HEIGHT,
        ),
      );
    };

    const handlePointerUp = () => {
      setSpectrogramResizeDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [spectrogramResizeDrag]);

  useEffect(() => {
    if (!trackReorderDrag) {
      return;
    }

    const getDropInsertionIndex = (clientY: number) => {
      const remainingTrackIds = activeTrackIds.filter((trackId) => trackId !== trackReorderDrag.trackId);
      if (remainingTrackIds.length === 0) {
        return null;
      }
      for (let index = 0; index < remainingTrackIds.length; index += 1) {
        const trackId = remainingTrackIds[index];
        const element = trackRowRefs.current.get(trackId);
        if (!element) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        if (clientY < centerY) {
          return index;
        }
      }
      return remainingTrackIds.length;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const nextCurrentY = event.clientY;
      const isActive = Math.abs(nextCurrentY - trackReorderDrag.startY) >= REORDER_ACTIVATION_PX;
      setTrackReorderDrag((current) =>
        current
          ? {
              ...current,
              currentY: nextCurrentY,
            }
          : current,
      );
      setTrackDropInsertionIndex(isActive ? getDropInsertionIndex(nextCurrentY) : null);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const isActive = Math.abs(event.clientY - trackReorderDrag.startY) >= REORDER_ACTIVATION_PX;
      const insertionIndex = isActive ? getDropInsertionIndex(event.clientY) : null;
      const originalIndex = activeTrackIds.indexOf(trackReorderDrag.trackId);
      if (insertionIndex !== null && insertionIndex !== originalIndex) {
        onReorderTrack(trackReorderDrag.trackId, insertionIndex);
        flashMovedTrack(trackReorderDrag.trackId);
      }
      draggedTrackIdRef.current = null;
      setDraggedTrackId(null);
      setTrackDropInsertionIndex(null);
      setTrackReorderDrag(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [activeTrackIds, onReorderTrack, trackReorderDrag]);

  useLayoutEffect(() => {
    const currentTrackIds = activeTrackIds;
    const previousTrackIds = previousTrackIdsRef.current;
    const hasSameTrackSet = previousTrackIds.length === currentTrackIds.length &&
      previousTrackIds.every((id) => currentTrackIds.includes(id)) &&
      currentTrackIds.every((id) => previousTrackIds.includes(id));
    const orderChanged = hasSameTrackSet &&
      previousTrackIds.some((id, index) => currentTrackIds[index] !== id);
    const nextPositions = new Map<string, number>();
    for (const track of activeTrackDefinitions) {
      const element = trackRowRefs.current.get(track.id);
      if (!element) {
        continue;
      }
      const top = element.offsetTop;
      nextPositions.set(track.id, top);
      const previousTop = previousTrackRowPositionsRef.current.get(track.id);
      if (previousTop === undefined) {
        continue;
      }
      const delta = previousTop - top;
      if (!orderChanged || Math.abs(delta) < 1) {
        continue;
      }
      element.animate(
        [
          { transform: `translateY(${delta}px)` },
          { transform: "translateY(0)" },
        ],
        {
          duration: 220,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        },
      );
    }
    previousTrackRowPositionsRef.current = nextPositions;
    previousTrackIdsRef.current = currentTrackIds;
  }, [activeTrackDefinitions, activeTrackIds]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const updateViewport = () => {
      scrollFrameRef.current = null;
      const nextScrollLeft = container.scrollLeft;
      const nextWidth = container.clientWidth;
      setViewportState((current) =>
        current.scrollLeft === nextScrollLeft && current.width === nextWidth
          ? current
          : {
              scrollLeft: nextScrollLeft,
              width: nextWidth,
            },
      );
    };

    const scheduleViewportUpdate = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }
      scrollFrameRef.current = requestAnimationFrame(updateViewport);
    };

    updateViewport();
    container.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
    window.addEventListener("resize", scheduleViewportUpdate);

    return () => {
      container.removeEventListener("scroll", scheduleViewportUpdate);
      window.removeEventListener("resize", scheduleViewportUpdate);
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  const snapPoints = useMemo(() => {
    return [
      0,
      ...subtitleLines.flatMap((line) => [line.startTime, line.endTime]),
      ...characterAnnotations.flatMap((item) => [item.startTime, item.endTime]),
      ...gongcheAnnotations.flatMap((item) => [item.startTime, item.endTime]),
      ...actionAnnotations.flatMap((item) => [item.startTime, item.endTime]),
      ...customBlocks.flatMap((item) => [item.startTime, item.endTime]),
      ...attachedPointTracks.flatMap((track) => track.points.map((point) => point.time)),
      currentTime,
    ];
  }, [subtitleLines, characterAnnotations, gongcheAnnotations, actionAnnotations, customBlocks, attachedPointTracks, currentTime]);

  function getLiveSnapPoints() {
    const liveProject = getProjectSnapshot();
    const liveCustomBlocks = flattenCustomBlocks(liveProject.customTracks);
    const liveAttachedPointTracks = flattenAttachedPointTracks(liveProject.builtinTracks, liveProject.customTracks);
    return [
      0,
      ...liveProject.subtitleLines.flatMap((line) => [line.startTime, line.endTime]),
      ...liveProject.characterAnnotations.flatMap((item) => [item.startTime, item.endTime]),
      ...(liveProject.gongcheAnnotations ?? []).flatMap((item) => [item.startTime, item.endTime]),
      ...liveProject.actionAnnotations.flatMap((item) => [item.startTime, item.endTime]),
      ...liveCustomBlocks.flatMap((item) => [item.startTime, item.endTime]),
      ...liveAttachedPointTracks.flatMap((track) => track.points.map((point) => point.time)),
      currentTimeRef.current,
    ];
  }

  function getTrackSnapPoints(
    trackId: string,
    excludedItems: TimelineSelectionItem[] = [],
  ) {
    if (!trackSnapEnabled[trackId]) {
      return [];
    }
    const excludedKeySet = new Set(
      excludedItems.map((item) =>
        getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item)),
      ),
    );
    const liveProject = getProjectSnapshot();
    const waveformKeypoints = shouldTrackSnapToWaveformKeypoints(liveProject, trackId, waveformData)
      ? waveformData?.keypoints ?? []
      : [];
    if (trackId === "character-track") {
      return [
        ...liveProject.characterAnnotations.flatMap((item) =>
          excludedKeySet.has(getTimelineSelectionKey("character", item.id))
            ? []
            : [item.startTime, item.endTime],
        ),
        ...waveformKeypoints,
      ];
    }
    const attachedPointTrack = findResolvedAttachedPointTrack(liveProject, trackId);
    if (attachedPointTrack) {
      const parentTrackSnapPoints = attachedPointTrack.snapToParentBoundaries
        ? getParentTrackBoundarySnapPoints(liveProject, trackId)
        : [];
      return [
        ...parentTrackSnapPoints,
        ...waveformKeypoints,
      ];
    }
    const gongcheParentTrackId = getParentTrackIdFromGongcheTrackId(trackId);
    if (gongcheParentTrackId) {
      return [
        ...getTextParentBoundarySnapPoints(liveProject, gongcheParentTrackId),
        ...(liveProject.gongcheAnnotations ?? [])
          .filter((item) => item.parentTrackId === gongcheParentTrackId)
          .flatMap((item) => [item.startTime, item.endTime, ...item.symbols.flatMap((symbol) => [symbol.startTime, symbol.endTime])]),
      ];
    }
    const customTrack = liveProject.customTracks.find((track) => track.id === trackId);
    if (customTrack) {
      return [
        ...customTrack.blocks.flatMap((item) =>
          excludedKeySet.has(getTimelineSelectionKey("custom-block", item.id, trackId))
            ? []
            : [item.startTime, item.endTime],
        ),
        ...waveformKeypoints,
      ];
    }
    return [
      ...liveProject.actionAnnotations.flatMap((item) =>
        item.trackId === trackId && !excludedKeySet.has(getTimelineSelectionKey("action", item.id))
          ? [item.startTime, item.endTime]
          : [],
      ),
      ...waveformKeypoints,
    ];
  }

  function computeRangeWithTrackSnap(params: {
    originalStart: number;
    originalEnd: number;
    deltaSeconds: number;
    pointerStepPx?: number;
    kind: Exclude<NonNullable<DragState>, { kind: "create-track-item" | "select-box" }>["kind"];
    zoomLevel: number;
    trackId: string;
    excludedItems?: TimelineSelectionItem[];
    shouldSnap: boolean;
    snapLock?: DragSnapLock;
  }) {
    const {
      originalStart,
      originalEnd,
      deltaSeconds,
      pointerStepPx = 0,
      kind,
      zoomLevel,
      trackId,
      excludedItems = [],
      shouldSnap,
      snapLock,
    } = params;
    const snapPoints = shouldSnap ? getTrackSnapPoints(trackId, excludedItems) : [];
    return computeNextRange(
      originalStart,
      originalEnd,
      deltaSeconds,
      pointerStepPx,
      kind,
      snapPoints,
      zoomLevel,
      shouldSnap,
      snapLock,
    );
  }

  function getSelectionTrackId(items: TimelineBatchMoveItem[]) {
    if (items.length === 0) {
      return null;
    }
    const resolvedFirstTrackId = getTrackIdForSelectionItem(items[0], actionAnnotations, customBlocks);
    if (!resolvedFirstTrackId) {
      return null;
    }
    for (const item of items.slice(1)) {
      const trackId = getTrackIdForSelectionItem(item, actionAnnotations, customBlocks);
      if (trackId !== resolvedFirstTrackId) {
        return null;
      }
    }
    return resolvedFirstTrackId;
  }

  function flashMovedTrack(trackId: string) {
    setRecentlyMovedTrackId(trackId);
    if (moveTrackHighlightTimerRef.current !== null) {
      window.clearTimeout(moveTrackHighlightTimerRef.current);
    }
    moveTrackHighlightTimerRef.current = window.setTimeout(() => {
      setRecentlyMovedTrackId((current) => (current === trackId ? null : current));
      moveTrackHighlightTimerRef.current = null;
    }, 360);
  }

  function startTrackReorder(trackId: string, clientY: number) {
    draggedTrackIdRef.current = trackId;
    setDraggedTrackId(trackId);
    setTrackReorderDrag({
      trackId,
      startY: clientY,
      currentY: clientY,
    });
    setTrackDropInsertionIndex(null);
  }

  function computeSelectionMoveRange(
    items: TimelineBatchMoveItem[],
    deltaSeconds: number,
    trackId: string | null,
    zoomLevel: number,
    shouldSnap: boolean,
    pointerStepPx = 0,
    snapLock?: DragSnapLock,
  ) {
    const originalStart = Math.min(...items.map((item) => item.startTime));
    const originalEnd = Math.max(...items.map((item) => item.endTime));
    const nextRange = trackId
      ? computeRangeWithTrackSnap({
          originalStart,
          originalEnd,
          deltaSeconds,
          pointerStepPx,
          kind: "move-selection",
          zoomLevel,
          trackId,
          excludedItems: items.map((item) =>
            item.type === "custom-block"
              ? { type: "custom-block", id: item.id, trackId: item.trackId }
              : item.type === "attached-point"
                ? { type: "attached-point", id: item.id, trackId: item.trackId, parentTrackId: item.parentTrackId }
              : item.type === "banyan-mark"
                ? { type: "banyan-mark", id: item.id }
              : { type: item.type, id: item.id },
          ),
          shouldSnap,
          snapLock,
        })
      : computeNextRange(
          originalStart,
          originalEnd,
          deltaSeconds,
          pointerStepPx,
          "move-selection",
          [],
          zoomLevel,
          false,
          snapLock,
        );
    const appliedDelta = nextRange.startTime - originalStart;
    return {
      items: items.map((item) => ({
        ...item,
        startTime: item.startTime + appliedDelta,
        endTime: item.endTime + appliedDelta,
      })),
      snappedTo: nextRange.snappedTo,
    };
  }

  function getTimelineContentPoint(clientX: number, clientY: number) {
    const container = scrollRef.current;
    if (!container) {
      return {
        x: clientX,
        y: clientY,
      };
    }
    const bounds = container.getBoundingClientRect();
    const interactionBounds = getSelectBoxInteractionBounds(container);
    const clampedClientX = clampValue(clientX, interactionBounds.left, interactionBounds.right);
    const clampedClientY = clampValue(clientY, interactionBounds.top, interactionBounds.bottom);
    return {
      x: clampedClientX - bounds.left + container.scrollLeft,
      y: clampedClientY - bounds.top + container.scrollTop,
    };
  }

  function updateSelectBoxDrag(clientX: number, clientY: number) {
    const point = getTimelineContentPoint(clientX, clientY);
    selectBoxPointerRef.current = { clientX, clientY };
    setDragState((prev) =>
      prev && prev.kind === "select-box"
        ? {
            ...prev,
            currentX: clientX,
            currentY: clientY,
            currentContentX: point.x,
            currentContentY: point.y,
          }
        : prev,
    );
  }

  function startSelectBoxDrag(
    clientX: number,
    clientY: number,
    options: { shiftKey?: boolean; additive?: boolean } = {},
  ) {
    const point = getTimelineContentPoint(clientX, clientY);
    selectBoxPointerRef.current = { clientX, clientY };
    setDragState({
      kind: "select-box",
      originX: clientX,
      originY: clientY,
      currentX: clientX,
      currentY: clientY,
      originContentX: point.x,
      originContentY: point.y,
      currentContentX: point.x,
      currentContentY: point.y,
      shiftKey: Boolean(options.shiftKey),
      additive: Boolean(options.additive),
    });
  }

  function getSelectBoxInteractionBounds(container: HTMLDivElement) {
    const bounds = container.getBoundingClientRect();
    const topDeck = container.querySelector<HTMLElement>(".timeline-top-deck");
    const topDeckBounds = topDeck?.getBoundingClientRect() ?? null;
    const hasScrolledVertically = container.scrollTop > 0.5;
    const fixedTopBoundary = topDeckBounds
      ? clampValue(topDeckBounds.bottom, bounds.top, bounds.bottom)
      : bounds.top;
    const highestUsableTopBoundary = Math.max(
      bounds.top,
      bounds.bottom - SELECT_BOX_AUTOSCROLL_VERTICAL_EDGE_PX,
    );
    return {
      left: Math.min(bounds.right, bounds.left + TRACK_LABEL_WIDTH),
      right: bounds.right,
      top: hasScrolledVertically
        ? Math.min(fixedTopBoundary, highestUsableTopBoundary)
        : bounds.top,
      bottom: bounds.bottom,
    };
  }

  function getSelectBoxAutoScrollDelta(
    clientPosition: number,
    start: number,
    end: number,
    edgeSize: number,
  ) {
    if (clientPosition < start + edgeSize) {
      const distance = Math.max(0, start + edgeSize - clientPosition);
      return -Math.min(
        SELECT_BOX_AUTOSCROLL_MAX_SPEED,
        Math.ceil((distance / edgeSize) * SELECT_BOX_AUTOSCROLL_MAX_SPEED),
      );
    }
    if (clientPosition > end - edgeSize) {
      const distance = Math.max(0, clientPosition - (end - edgeSize));
      return Math.min(
        SELECT_BOX_AUTOSCROLL_MAX_SPEED,
        Math.ceil((distance / edgeSize) * SELECT_BOX_AUTOSCROLL_MAX_SPEED),
      );
    }
    return 0;
  }

  function stopSelectBoxAutoScroll() {
    selectBoxPointerRef.current = null;
    if (selectBoxAutoScrollFrameRef.current !== null) {
      cancelAnimationFrame(selectBoxAutoScrollFrameRef.current);
      selectBoxAutoScrollFrameRef.current = null;
    }
  }

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const handleGestureStart = (event: Event) => {
      const gestureEvent = event as Event & { clientX?: number };
      const bounds = container.getBoundingClientRect();
      const viewportOffset =
        gestureEvent.clientX !== undefined
          ? gestureEvent.clientX - bounds.left
          : container.clientWidth / 2;
      zoomGestureRef.current = {
        startZoom: zoomRef.current,
        anchorTime: getCanvasTimeFromViewportOffset(container, viewportOffset, zoomRef.current),
        viewportOffset,
      };
      event.preventDefault();
    };

    const handleGestureChange = (event: Event) => {
      const gestureEvent = event as Event & { scale?: number };
      if (!zoomGestureRef.current || gestureEvent.scale === undefined) {
        return;
      }
      event.preventDefault();
      const nextZoom = clampZoom(zoomGestureRef.current.startZoom * gestureEvent.scale);
      queueZoom(nextZoom, zoomGestureRef.current.anchorTime, zoomGestureRef.current.viewportOffset);
    };

    const handleGestureEnd = () => {
      zoomGestureRef.current = null;
    };

    container.addEventListener("gesturestart", handleGestureStart, { passive: false });
    container.addEventListener("gesturechange", handleGestureChange, { passive: false });
    container.addEventListener("gestureend", handleGestureEnd);
    return () => {
      container.removeEventListener("gesturestart", handleGestureStart);
      container.removeEventListener("gesturechange", handleGestureChange);
      container.removeEventListener("gestureend", handleGestureEnd);
    };
  }, [zoom]);

  useLayoutEffect(() => {
    if (!scrollRef.current || !zoomAnchorRef.current) {
      return;
    }
    const container = scrollRef.current;
    const { time, viewportOffset } = zoomAnchorRef.current;
    const maxScrollLeft = Math.max(timelineWidth - container.clientWidth, 0);
    const nextScrollLeft = Math.max(
      0,
      Math.min(getCanvasX(time, zoom) - viewportOffset, maxScrollLeft),
    );
    container.scrollLeft = nextScrollLeft;
    setViewportState((current) =>
      current.scrollLeft === nextScrollLeft && current.width === container.clientWidth
        ? current
        : {
            scrollLeft: nextScrollLeft,
            width: container.clientWidth,
          },
    );
    zoomAnchorRef.current = null;
  }, [zoom, timelineWidth]);

  useEffect(() => {
    if (!focusRange || !scrollRef.current) {
      return;
    }
    if (dragStateRef.current) {
      return;
    }
    const container = scrollRef.current;
    const maxScrollLeft = Math.max(timelineWidth - container.clientWidth, 0);
    const targetLeft = Math.max(0, Math.min(getCanvasX(focusRange.start, zoom) - 120, maxScrollLeft));
    const startLeft = container.scrollLeft;
    const delta = targetLeft - startLeft;
    onFocusRangeHandled();

    if (Math.abs(delta) < 1) {
      return;
    }

    if (focusScrollFrameRef.current !== null) {
      cancelAnimationFrame(focusScrollFrameRef.current);
      focusScrollFrameRef.current = null;
    }

    focusScrollUntilRef.current = Date.now() + FOCUS_SCROLL_DURATION_MS + 40;
    const animationStart = performance.now();

    const animateScroll = (now: number) => {
      const elapsed = now - animationStart;
      const progress = Math.min(elapsed / FOCUS_SCROLL_DURATION_MS, 1);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      container.scrollLeft = startLeft + delta * easedProgress;

      if (progress < 1) {
        focusScrollFrameRef.current = requestAnimationFrame(animateScroll);
        return;
      }

      container.scrollLeft = targetLeft;
      focusScrollFrameRef.current = null;
    };

    focusScrollFrameRef.current = requestAnimationFrame(animateScroll);
  }, [focusRange, onFocusRangeHandled, timelineWidth, zoom]);

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    if (Date.now() < Math.max(zoomInteractionUntilRef.current, focusScrollUntilRef.current)) {
      return;
    }
    const container = scrollRef.current;
    const playheadX = getCanvasX(currentTime, zoom);
    const visibleStart = container.scrollLeft;
    const visibleEnd = visibleStart + container.clientWidth;
    if (playheadX < visibleStart || playheadX > visibleEnd - 60) {
      container.scrollTo({ left: Math.max(playheadX - container.clientWidth / 2, 0) });
    }
  }, [currentTime, zoom]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const activeDragState = dragStateRef.current;
      if (!activeDragState || !scrollRef.current) {
        return;
      }
      const previousPointerClientX = lastPointerClientXRef.current || event.clientX;
      lastPointerClientXRef.current = event.clientX;
      const pointerStepPx = Math.abs(event.clientX - previousPointerClientX);
      lastPointerStepPxRef.current = pointerStepPx;
      const deltaPixels =
        "originX" in activeDragState
          ? event.clientX - activeDragState.originX
          : 0;
      const liveSnapPoints = getLiveSnapPoints();
      if (
        activeDragState.kind !== "create-track-item" &&
        activeDragState.kind !== "resize-linked" &&
        activeDragState.kind !== "select-box" &&
        Math.abs(deltaPixels) < DRAG_ACTIVATION_PX
      ) {
        return;
      }
      const deltaSeconds =
        "originX" in activeDragState
          ? (event.clientX - activeDragState.originX) / zoom
          : 0;
      if (activeDragState.kind === "create-track-item") {
        // 创建拖拽必须用本次 pointermove 的坐标来计算预览和吸附。
        // 旧逻辑先用上一帧 currentX 计算，再更新 currentX，在低缩放/触摸板下会让反馈慢一帧。
        const currentCreateDragState = { ...activeDragState, currentX: event.clientX };
        const dragPreview = getCreateTrackPreview(
          currentCreateDragState,
          zoom,
          trackSnapEnabled[activeDragState.trackId]
            ? getTrackSnapPoints(activeDragState.trackId)
            : [],
          trackSnapEnabled[activeDragState.trackId],
          pointerStepPx,
          dragSnapLockRef.current,
        );
        setActiveSnapIndicator(
          dragPreview.snappedTo
            ? { trackId: activeDragState.trackId, ...dragPreview.snappedTo }
            : null,
        );
        dragSnapLockRef.current = toDragSnapLock(dragPreview.snappedTo);
        queuePreviewFrame(dragPreview.previewTime);
        setDragState((prev) =>
          prev && prev.kind === "create-track-item"
            ? currentCreateDragState
            : prev,
        );
        return;
      }

      if (activeDragState.kind === "select-box") {
        setActiveSnapIndicator(null);
        updateSelectBoxDrag(event.clientX, event.clientY);
        return;
      }

      if (activeDragState.kind === "resize-linked") {
        const next = computeLinkedResizeRange(
          activeDragState,
          deltaSeconds,
          zoom,
          getTrackSnapPoints(activeDragState.trackId, [
            ...activeDragState.members.map((member) => toTimelineSelectionItem(member.item)),
          ]),
          true,
          pointerStepPx,
          dragSnapLockRef.current,
        );
        setActiveSnapIndicator(
          next.snappedTo ? { trackId: activeDragState.trackId, ...next.snappedTo } : null,
        );
        dragSnapLockRef.current = toDragSnapLock(next.snappedTo);
        scheduleDragUpdate({
          target: "selection",
          items: next.items,
        });
        queuePreviewFrame(next.boundaryTime);
        return;
      }

      if (activeDragState.kind === "move-selection") {
        const minStartTime = Math.min(...activeDragState.items.map((item) => item.startTime));
        const selectionTrackId = getSelectionTrackId(activeDragState.items);
        const trackRange = computeSelectionMoveRange(
          activeDragState.items,
          Math.max(deltaSeconds, -minStartTime),
          selectionTrackId,
          zoom,
          true,
          pointerStepPx,
          dragSnapLockRef.current,
        );
        setActiveSnapIndicator(
          trackRange.snappedTo && selectionTrackId
            ? { trackId: selectionTrackId, ...trackRange.snappedTo }
            : null,
        );
        dragSnapLockRef.current = toDragSnapLock(trackRange.snappedTo);
        scheduleDragUpdate({
          target: "selection",
          items: trackRange.items,
        });
        return;
      }

      if (activeDragState.kind === "move-point") {
        const pointSnapPoints = trackSnapEnabled[activeDragState.trackId]
          ? getTrackSnapPoints(activeDragState.trackId)
          : [];
        const rawTime = Math.max(0, activeDragState.originalTime + deltaSeconds);
        const resolvedTime = trackSnapEnabled[activeDragState.trackId]
          ? resolveSnappedEdgeTime(
              rawTime,
              "left",
              pointSnapPoints,
              zoom,
              pointerStepPx,
              dragSnapLockRef.current,
            )
          : { time: rawTime, snappedTo: null };
        setActiveSnapIndicator(
          resolvedTime.snappedTo
            ? { trackId: activeDragState.trackId, ...resolvedTime.snappedTo }
            : null,
        );
        dragSnapLockRef.current = toDragSnapLock(
          resolvedTime.snappedTo,
        );
        setDraggedPointPreview({
          id: activeDragState.id,
          trackId: activeDragState.trackId,
          time: resolvedTime.time,
        });
        scheduleDragUpdate({
          target: "attached-point",
          trackId: activeDragState.trackId,
          pointId: activeDragState.id,
          changes: {
            time: resolvedTime.time,
          },
        });
        queuePreviewFrame(resolvedTime.time);
        return;
      }

      if (activeDragState.kind === "move-banyan-mark") {
        const nextTime = Math.max(0, activeDragState.originalTime + deltaSeconds);
        setActiveSnapIndicator(null);
        dragSnapLockRef.current = null;
        scheduleDragUpdate({
          target: "banyan-mark",
          id: activeDragState.id,
          changes: {
            time: nextTime,
            confidence: "manual",
            manualOffset: nextTime - activeDragState.estimatedTime,
          },
        });
        queuePreviewFrame(nextTime);
        return;
      }

      if (activeDragState.kind === "move-gongche") {
        const next = computeMovedGongcheBlock(activeDragState, deltaSeconds);
        setActiveSnapIndicator(null);
        dragSnapLockRef.current = null;
        scheduleDragUpdate({
          target: "gongche",
          id: activeDragState.id,
          changes: next,
        });
        queuePreviewFrame(next.startTime ?? activeDragState.originalStart);
        return;
      }

      if (activeDragState.kind === "move-gongche-boundary") {
        const next = computeMovedGongcheBoundary(activeDragState, deltaSeconds);
        setActiveSnapIndicator(null);
        dragSnapLockRef.current = null;
        scheduleDragUpdate({
          target: "gongche",
          id: activeDragState.id,
          changes: next,
        });
        queuePreviewFrame(next.symbols?.[activeDragState.boundaryIndex]?.endTime ?? activeDragState.originalBoundaryTime);
        return;
      }

      if (isLineDrag(activeDragState)) {
        dragSnapLockRef.current = null;
        setActiveSnapIndicator(null);
        const next = computeNextRange(
          activeDragState.originalStart,
          activeDragState.originalEnd,
          deltaSeconds,
          0,
          activeDragState.kind,
          liveSnapPoints,
          zoom,
          false,
          null,
        );
        scheduleDragUpdate({
          target: "line",
          id: activeDragState.id,
          changes: next,
        });
        return;
      }

      if (isCharacterDrag(activeDragState)) {
        const trackId = "character-track";
        const next = computeRangeWithTrackSnap({
          originalStart: activeDragState.originalStart,
          originalEnd: activeDragState.originalEnd,
          deltaSeconds,
          pointerStepPx,
          kind: activeDragState.kind,
          zoomLevel: zoom,
          trackId,
          excludedItems: [{ type: "character", id: activeDragState.id }],
          shouldSnap: true,
          snapLock: dragSnapLockRef.current,
        });
        setActiveSnapIndicator(
          next.snappedTo ? { trackId, ...next.snappedTo } : null,
        );
        dragSnapLockRef.current = toDragSnapLock(next.snappedTo);
        scheduleDragUpdate({
          target: "character",
          id: activeDragState.id,
          changes: {
            startTime: next.startTime,
            endTime: next.endTime,
          },
        });
        updatePreviewFrame(activeDragState.kind, next);
        return;
      }

      const actionAnnotation = actionAnnotations.find((item) => item.id === activeDragState.id);
      const customBlock = customBlocks.find((item) => item.id === activeDragState.id);
      const trackId = actionAnnotation?.trackId ?? customBlock?.trackId ?? null;
      const next = trackId
        ? computeRangeWithTrackSnap({
            originalStart: activeDragState.originalStart,
            originalEnd: activeDragState.originalEnd,
            deltaSeconds,
            pointerStepPx,
            kind: activeDragState.kind,
            zoomLevel: zoom,
            trackId,
            excludedItems: [
              customBlock
                ? { type: "custom-block", id: activeDragState.id, trackId: customBlock.trackId }
                : { type: "action", id: activeDragState.id },
            ],
            shouldSnap: true,
            snapLock: dragSnapLockRef.current,
          })
        : computeNextRange(
          activeDragState.originalStart,
          activeDragState.originalEnd,
          deltaSeconds,
          pointerStepPx,
          activeDragState.kind,
          liveSnapPoints,
          zoom,
          false,
          null,
        );
      setActiveSnapIndicator(
        next.snappedTo && trackId ? { trackId, ...next.snappedTo } : null,
      );
      dragSnapLockRef.current = toDragSnapLock(next.snappedTo);
      scheduleDragUpdate(
        customBlock
          ? {
              target: "custom-block",
              trackId: customBlock.trackId,
              id: activeDragState.id,
              changes: {
                startTime: next.startTime,
                endTime: next.endTime,
              },
            }
          : {
              target: "action",
              id: activeDragState.id,
              changes: {
                startTime: next.startTime,
                endTime: next.endTime,
              },
            },
      );
      updatePreviewFrame(activeDragState.kind, next);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const activeDragState = dragStateRef.current;
      const finalSnapLock = dragSnapLockRef.current;
      dragSnapLockRef.current = null;
      stopSelectBoxAutoScroll();
      clearPreviewFrame();
      setActiveSnapIndicator(null);
      flushPendingDragUpdate();
      if (!activeDragState) {
        lastResolvedDragUpdateRef.current = null;
        lastPointerStepPxRef.current = 0;
        setDragState(null);
        return;
      }
      const finalPointerClientX =
        "originX" in activeDragState ? event.clientX : lastPointerClientXRef.current;
      const finalPointerStepPx =
        "originX" in activeDragState
          ? Math.abs(finalPointerClientX - (lastPointerClientXRef.current || finalPointerClientX))
          : lastPointerStepPxRef.current;
      if (
        "originX" in activeDragState &&
        Math.abs(finalPointerClientX - activeDragState.originX) < DRAG_ACTIVATION_PX
      ) {
        lastResolvedDragUpdateRef.current = null;
        lastPointerStepPxRef.current = 0;
        setDragState(null);
        return;
      }
      const resolvedDragUpdate = lastResolvedDragUpdateRef.current;
      // 主路径：提交拖动过程中最后一次已经展示出来的结果。
      // fallback 重新计算只用于没有 pointermove 预览结果的边界情况，且必须沿用最后的 snapLock/pointerStep。
      const liveSnapPoints = getLiveSnapPoints();
      if (activeDragState.kind === "create-track-item" && scrollRef.current) {
        // pointerup 可能带来最后一段位移，但不一定再触发 pointermove。
        // 提交时使用最终事件坐标，避免“预览到了、松手没创建”的触摸板边界问题。
        const left = Math.max(0, Math.min(activeDragState.originX, finalPointerClientX) - activeDragState.laneLeft);
        const right = Math.max(0, Math.max(activeDragState.originX, finalPointerClientX) - activeDragState.laneLeft);
        const createSnapPoints = getTrackSnapPoints(activeDragState.trackId);
        const startTime = trackSnapEnabled[activeDragState.trackId]
          ? snapTime(left / zoom, createSnapPoints, zoom, finalPointerStepPx, finalSnapLock, "left")
          : left / zoom;
        const minDuration = Math.max(0.04, MIN_BLOCK_WIDTH_PX / Math.max(zoom, 1));
        const rawEndTime = right / zoom;
        const snappedEndTime = trackSnapEnabled[activeDragState.trackId]
          ? snapTime(rawEndTime, createSnapPoints, zoom, finalPointerStepPx, finalSnapLock, "right")
          : rawEndTime;
        const endTime = Math.max(startTime + minDuration, snappedEndTime);
        // endTime 已经被强制不短于 minDuration；这里不要再用浮点减法二次判断，
        // 否则在 11px/s 等特定倍率下可能因为 1e-15 级误差吞掉合法创建。
        if (activeDragState.trackType === "character") {
          onCreateCharacterAtTime(startTime, endTime);
        } else if (
          activeDragState.trackType === "custom-text" ||
          activeDragState.trackType === "custom-action"
        ) {
          onCreateCustomBlock(activeDragState.trackId, startTime, endTime, activeDragState.branchScope);
        } else {
          onCreateAction(activeDragState.trackId, startTime, endTime);
        }
      } else if (activeDragState.kind === "select-box") {
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        const selectedItems = getItemsForSelectionDrag(activeDragState);
        if (activeDragState.shiftKey) {
          selectionAnchorRef.current = selectedItems[0] ?? null;
        } else {
          selectionAnchorRef.current = selectedItems[selectedItems.length - 1] ?? null;
        }
        const primaryItem = selectedItems[selectedItems.length - 1] ?? selectedItems[0] ?? null;
        onSelectTimelineItems(selectedItems, primaryItem ? toSelectedItem(primaryItem) : null);
      } else if (activeDragState.kind === "move-selection") {
        if (resolvedDragUpdate?.target === "selection") {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else {
          const minStartTime = Math.min(...activeDragState.items.map((item) => item.startTime));
          const selectionTrackId = getSelectionTrackId(activeDragState.items);
          const next = computeSelectionMoveRange(
            activeDragState.items,
            Math.max((lastPointerClientXRef.current - activeDragState.originX) / zoom, -minStartTime),
            selectionTrackId,
            zoom,
            true,
            lastPointerStepPxRef.current,
            finalSnapLock,
          );
          onBatchMoveCommit(
            next.items,
          );
        }
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (activeDragState.kind === "move-point") {
        if (resolvedDragUpdate?.target === "attached-point") {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else {
          const finalPointSnapPoints = trackSnapEnabled[activeDragState.trackId]
            ? getTrackSnapPoints(activeDragState.trackId)
            : [];
          const rawTime = Math.max(
            0,
            activeDragState.originalTime + (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          );
          const finalTime = trackSnapEnabled[activeDragState.trackId]
            ? resolveSnappedEdgeTime(
                rawTime,
                "left",
                finalPointSnapPoints,
                zoom,
                lastPointerStepPxRef.current,
                finalSnapLock,
              ).time
            : rawTime;
          onAttachedPointCommit(activeDragState.trackId, activeDragState.id, {
            time: finalTime,
          });
        }
        setDraggedPointPreview(null);
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (activeDragState.kind === "move-banyan-mark") {
        if (resolvedDragUpdate?.target === "banyan-mark") {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else {
          const finalTime = Math.max(
            0,
            activeDragState.originalTime + (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          );
          onBanyanMarkCommit(activeDragState.id, {
            time: finalTime,
            confidence: "manual",
            manualOffset: finalTime - activeDragState.estimatedTime,
          });
        }
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (activeDragState.kind === "move-gongche") {
        if (resolvedDragUpdate?.target === "gongche") {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else {
          const next = computeMovedGongcheBlock(
            activeDragState,
            (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          );
          onGongcheBlockCommit(activeDragState.id, next);
        }
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (activeDragState.kind === "move-gongche-boundary") {
        if (resolvedDragUpdate?.target === "gongche") {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else {
          const next = computeMovedGongcheBoundary(
            activeDragState,
            (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          );
          onGongcheBlockCommit(activeDragState.id, next);
        }
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (activeDragState.kind === "resize-linked") {
        if (resolvedDragUpdate?.target === "selection") {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else {
          const next = computeLinkedResizeRange(
            activeDragState,
            (lastPointerClientXRef.current - activeDragState.originX) / zoom,
            zoom,
            getTrackSnapPoints(activeDragState.trackId, [
              ...activeDragState.members.map((member) => toTimelineSelectionItem(member.item)),
            ]),
            true,
            lastPointerStepPxRef.current,
            finalSnapLock,
          );
          onBatchMoveCommit(next.items);
        }
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (isLineDrag(activeDragState)) {
        const next = resolvedDragUpdate?.target === "line"
          ? null
          : computeNextRange(
              activeDragState.originalStart,
              activeDragState.originalEnd,
              (lastPointerClientXRef.current - activeDragState.originX) / zoom,
              lastPointerStepPxRef.current,
              activeDragState.kind,
              liveSnapPoints,
              zoom,
              false,
              null,
            );
        suppressLineClickIdRef.current = activeDragState.id;
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        if (resolvedDragUpdate?.target === "line") {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else if (next) {
          onLineCommit(activeDragState.id, next);
        }
      } else if (isCharacterDrag(activeDragState)) {
        const next = resolvedDragUpdate?.target === "character"
          ? null
          : computeRangeWithTrackSnap({
              originalStart: activeDragState.originalStart,
              originalEnd: activeDragState.originalEnd,
              deltaSeconds: (lastPointerClientXRef.current - activeDragState.originX) / zoom,
              pointerStepPx: lastPointerStepPxRef.current,
              kind: activeDragState.kind,
              zoomLevel: zoom,
              trackId: "character-track",
              excludedItems: [{ type: "character", id: activeDragState.id }],
              shouldSnap: true,
              snapLock: finalSnapLock,
            });
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        if (resolvedDragUpdate?.target === "character") {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else if (next) {
          onCharacterCommit(activeDragState.id, {
            startTime: next.startTime,
            endTime: next.endTime,
          });
        }
      } else if (isActionDrag(activeDragState)) {
        const actionAnnotation = actionAnnotations.find((item) => item.id === activeDragState.id);
        const customBlock = customBlocks.find((item) => item.id === activeDragState.id);
        const canUseResolvedActionUpdate =
          (actionAnnotation && resolvedDragUpdate?.target === "action") ||
          (customBlock && resolvedDragUpdate?.target === "custom-block");
        const next = canUseResolvedActionUpdate
          ? null
          : actionAnnotation || customBlock
          ? computeRangeWithTrackSnap({
              originalStart: activeDragState.originalStart,
              originalEnd: activeDragState.originalEnd,
              deltaSeconds: (lastPointerClientXRef.current - activeDragState.originX) / zoom,
              pointerStepPx: lastPointerStepPxRef.current,
              kind: activeDragState.kind,
              zoomLevel: zoom,
              trackId: actionAnnotation?.trackId ?? customBlock?.trackId ?? "",
              excludedItems: [
                customBlock
                  ? { type: "custom-block", id: activeDragState.id, trackId: customBlock.trackId }
                  : { type: "action", id: activeDragState.id },
              ],
              shouldSnap: true,
              snapLock: finalSnapLock,
            })
          : computeNextRange(
              activeDragState.originalStart,
              activeDragState.originalEnd,
              (lastPointerClientXRef.current - activeDragState.originX) / zoom,
              lastPointerStepPxRef.current,
              activeDragState.kind,
              liveSnapPoints,
              zoom,
              true,
              finalSnapLock,
            );
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        if (canUseResolvedActionUpdate && resolvedDragUpdate) {
          commitResolvedDragUpdate(resolvedDragUpdate);
        } else if (customBlock && next) {
          onCustomBlockCommit(customBlock.trackId, activeDragState.id, {
            startTime: next.startTime,
            endTime: next.endTime,
          });
        } else if (next) {
          onActionCommit(activeDragState.id, {
            startTime: next.startTime,
            endTime: next.endTime,
          });
        }
      }
      lastResolvedDragUpdateRef.current = null;
      lastPointerStepPxRef.current = 0;
      setDragState(null);
      setDraggedPointPreview(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [
    dragState,
    zoom,
    snapPoints,
    characterAnnotations,
    actionAnnotations,
    customBlocks,
    selectedTimelineItems,
    onLineChange,
    onLineCommit,
    onCharacterChange,
    onCharacterCommit,
    onActionChange,
    onActionCommit,
    onGongcheBlockChange,
    onGongcheBlockCommit,
    onBanyanMarkChange,
    onBanyanMarkCommit,
    onCustomBlockChange,
    onCustomBlockCommit,
    onBatchMoveChange,
    onBatchMoveCommit,
    onCreateAction,
    onCreateCharacterAtTime,
    onCreateCustomBlock,
    onPreviewFrame,
    onSelectTimelineItems,
  ]);

  const ticks = useMemo(() => {
    const step = zoom >= 70 ? 0.5 : zoom >= 35 ? 1 : zoom >= 15 ? 2 : 5;
    return Array.from({ length: Math.ceil(duration / step) + 1 }, (_, index) => index * step);
  }, [duration, zoom]);

  return (
    <section className="panel timeline-panel" aria-busy={Boolean(editingBlockedReason)}>
      <div className="panel-header timeline-panel-header">
        <div className="timeline-header-copy">
          <h2>多轨时间轴</h2>
          <span>点击空白跳转，双击创建，Command/Ctrl + 拖拽可新建 block，自定义轨可在右侧属性面板配置</span>
        </div>
        <div className="timeline-header-actions">
          <div className="timeline-track-actions">
            {missingBuiltinTracks.map((track) => (
              <button key={track.id} type="button" disabled={Boolean(editingBlockedReason)} onClick={() => onAddBuiltinTrack(track.id)}>
                + 逐字轨
              </button>
            ))}
            <button type="button" disabled={Boolean(editingBlockedReason)} onClick={() => onAddCustomTrack("text")}>
              + 文字轨
            </button>
            <button type="button" disabled={Boolean(editingBlockedReason)} onClick={() => onAddCustomTrack("action")}>
              + 动作轨
            </button>
            <button type="button" onClick={() => onSelectItem({ type: "banyan-track" })}>
              板眼
            </button>
          </div>
          <div className="timeline-zoom-controls">
            <button type="button" onClick={() => handleZoomStep(-ZOOM_STEP)}>
              -
            </button>
            <label className="zoom-control timeline-zoom-control">
              <span>缩放</span>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_STEP}
                value={sliderZoom}
                onPointerDown={startSliderZoom}
                onPointerUp={finishSliderZoom}
                onPointerCancel={finishSliderZoom}
                onBlur={finishSliderZoom}
                onChange={(event) => handleZoomSliderChange(Number(event.target.value))}
              />
              <strong>{Math.round(zoom)}px/s</strong>
            </label>
            <button type="button" onClick={() => handleZoomStep(ZOOM_STEP)}>
              +
            </button>
          </div>
          <label className="zoom-control timeline-zoom-control timeline-height-control">
            <span>纵向</span>
            <input
              type="range"
              min={MIN_TRACK_HEIGHT}
              max={MAX_TRACK_HEIGHT}
              step={TRACK_HEIGHT_STEP}
              value={trackHeight}
              onChange={(event) => setTrackHeight(Number(event.target.value))}
            />
            <strong>{trackHeight}px</strong>
          </label>
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
      <div className="timeline-scroll-shell">
        {editingBlockedReason ? (
          <div className="timeline-edit-gate" role="status">
            <span>{editingBlockedReason}</span>
          </div>
        ) : null}
        <div
          className="timeline-scroll"
          ref={scrollRef}
        onPointerMove={(event) => {
          const container = scrollRef.current;
          if (!container) return;
          const viewportOffset = event.clientX - container.getBoundingClientRect().left;
          if (viewportOffset < TRACK_LABEL_WIDTH) {
            queueTransientPointerTime(null);
            return;
          }
          queueTransientPointerTime(Math.min(
            duration,
            getCanvasTimeFromViewportOffset(container, viewportOffset, zoom),
          ));
        }}
        onPointerLeave={() => queueTransientPointerTime(null)}
        onPointerCancel={() => queueTransientPointerTime(null)}
        onWheel={(event) => {
          const isPinchZoom = event.ctrlKey && !event.metaKey;
          const isModifierZoom = event.altKey && !event.metaKey && !event.ctrlKey;
          if (!isPinchZoom && !isModifierZoom) {
            return;
          }
          event.preventDefault();
          handleZoomAroundPointer(event);
        }}
        >
          <div className="timeline-canvas" style={timelineCanvasStyle}>
          <div
            className="timeline-ruler"
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              event.preventDefault();
              rulerScrubPointerIdRef.current = event.pointerId;
              event.currentTarget.setPointerCapture(event.pointerId);
              queueRulerSeek(getRulerScrubTime(event.clientX));
            }}
            onPointerMove={(event) => {
              if (rulerScrubPointerIdRef.current !== event.pointerId) {
                return;
              }
              event.preventDefault();
              queueRulerSeek(getRulerScrubTime(event.clientX));
            }}
            onPointerUp={(event) => {
              if (rulerScrubPointerIdRef.current !== event.pointerId) {
                return;
              }
              event.preventDefault();
              rulerScrubPointerIdRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              flushPendingRulerSeek();
            }}
            onPointerCancel={(event) => {
              if (rulerScrubPointerIdRef.current !== event.pointerId) {
                return;
              }
              rulerScrubPointerIdRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              pendingRulerSeekTimeRef.current = null;
              if (rulerSeekFrameRef.current !== null) {
                cancelAnimationFrame(rulerSeekFrameRef.current);
                rulerSeekFrameRef.current = null;
              }
            }}
          >
            {ticks.map((tick) => (
              <div
                key={tick}
                className="tick"
                style={{ left: getCanvasX(tick, zoom) }}
              >
                <span>{formatTimelineTickLabel(tick)}</span>
              </div>
            ))}
          </div>

          <div
            className="timeline-loop-lane"
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              if ((event.target as HTMLElement | null)?.closest(".timeline-loop-range-chip")) {
                return;
              }
              event.preventDefault();
              loopRangeSelectionRef.current = {
                pointerId: event.pointerId,
                originX: event.clientX,
                currentX: event.clientX,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
              const time = getRulerScrubTime(event.clientX);
              setLoopRangeDraft({ start: time, end: time });
            }}
            onPointerMove={(event) => {
              const currentSelection = loopRangeSelectionRef.current;
              if (!currentSelection || currentSelection.pointerId !== event.pointerId) {
                return;
              }
              event.preventDefault();
              currentSelection.currentX = event.clientX;
              setLoopRangeDraft(getLoopRangeFromClientXs(currentSelection.originX, currentSelection.currentX));
            }}
            onPointerUp={(event) => {
              const currentSelection = loopRangeSelectionRef.current;
              if (!currentSelection || currentSelection.pointerId !== event.pointerId) {
                return;
              }
              event.preventDefault();
              loopRangeSelectionRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              const nextRange = getLoopRangeFromClientXs(currentSelection.originX, currentSelection.currentX);
              setLoopRangeDraft(null);
              if (!nextRange || nextRange.end - nextRange.start < LOOP_RANGE_MIN_DURATION) {
                return;
              }
              onLoopPlaybackRangeChange(nextRange);
            }}
            onPointerCancel={(event) => {
              const currentSelection = loopRangeSelectionRef.current;
              if (!currentSelection || currentSelection.pointerId !== event.pointerId) {
                return;
              }
              loopRangeSelectionRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              setLoopRangeDraft(null);
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              loopRangeSelectionRef.current = null;
              setLoopRangeDraft(null);
              onLoopPlaybackRangeChange(null);
            }}
          >
            {displayedLoopPlaybackRange ? (
              <div
                className={[
                  "timeline-loop-range-chip",
                  loopPlaybackEnabled ? "active" : "",
                  loopRangePressed ? "pressed" : "",
                ].join(" ")}
                style={{
                  left: getCanvasX(displayedLoopPlaybackRange.start, zoom),
                  width: Math.max(
                    (displayedLoopPlaybackRange.end - displayedLoopPlaybackRange.start) * zoom,
                    4,
                  ),
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  const target = event.target as HTMLElement | null;
                  const mode = target?.closest(".timeline-loop-range-handle.start")
                    ? "resize-start"
                    : target?.closest(".timeline-loop-range-handle.end")
                      ? "resize-end"
                      : "move";
                  loopRangeDragRef.current = {
                    pointerId: event.pointerId,
                    mode,
                    originX: event.clientX,
                    originalRange: displayedLoopPlaybackRange,
                  };
                  setLoopRangePressed(true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const currentDrag = loopRangeDragRef.current;
                  if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
                    return;
                  }
                  event.preventDefault();
                  const nextRange = currentDrag.mode === "move"
                    ? getMovedLoopRange(currentDrag.originalRange, currentDrag.originX, event.clientX)
                    : getResizedLoopRange(currentDrag.originalRange, currentDrag.mode, event.clientX);
                  setLoopRangeDraft(nextRange);
                }}
                onPointerUp={(event) => {
                  const currentDrag = loopRangeDragRef.current;
                  if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  const movedDistance = Math.abs(event.clientX - currentDrag.originX);
                  loopRangeDragRef.current = null;
                  setLoopRangePressed(false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  const nextRange = currentDrag.mode === "move"
                    ? getMovedLoopRange(currentDrag.originalRange, currentDrag.originX, event.clientX)
                    : getResizedLoopRange(currentDrag.originalRange, currentDrag.mode, event.clientX);
                  setLoopRangeDraft(null);
                  if (movedDistance < DRAG_ACTIVATION_PX && currentDrag.mode === "move") {
                    suppressLoopRangeClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
                    onLoopPlaybackEnabledChange(!loopPlaybackEnabled);
                    return;
                  }
                  onLoopPlaybackRangeChange(nextRange);
                }}
                onPointerCancel={(event) => {
                  const currentDrag = loopRangeDragRef.current;
                  if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
                    return;
                  }
                  loopRangeDragRef.current = null;
                  setLoopRangePressed(false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  setLoopRangeDraft(null);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (performance.now() < suppressLoopRangeClickUntilRef.current) {
                    return;
                  }
                  onLoopPlaybackEnabledChange(!loopPlaybackEnabled);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                title={loopPlaybackEnabled ? "点击关闭循环播放，拖动可移动/调整循环范围" : "点击开启循环播放，拖动可移动/调整循环范围"}
              >
                <span className="timeline-loop-range-handle start" />
                <span className="timeline-loop-range-fill" />
                <span className="timeline-loop-range-handle end" />
              </div>
            ) : null}
          </div>

          {confirmationRangesVisible ? (
            <div
              className="timeline-confirmation-lane"
              style={{ height: confirmationLaneHeight }}
            >
              <span className="timeline-confirmation-lane-label">确认范围</span>
              {confirmationRanges.map((range) => (
                <button
                  key={range.id}
                  type="button"
                  className={[
                    "timeline-confirmation-chip",
                    range.lifecycle,
                    range.freshness,
                  ].join(" ")}
                  style={{
                    left: getCanvasX(range.startTime, zoom),
                    top: range.lane * 18 + 2,
                    width: Math.max((range.endTime - range.startTime) * zoom, 4),
                  }}
                  title={`${range.label} · ${range.startTime.toFixed(3)}-${range.endTime.toFixed(3)} 秒`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectConfirmationRange(range);
                  }}
                >
                  <span>{range.label}</span>
                </button>
              ))}
            </div>
          ) : null}

          {renderBanyanGridLines()}

          <div className="timeline-top-deck">
            {renderBanyanGridLines("timeline-banyan-grid-lines-floating")}
            <div className="line-focus-layer">
              {subtitleLines.map((line) => (
                <button
                  key={line.id}
                  className={[
                    "line-overlay",
                    selectedItem?.type === "line" && selectedItem.id === line.id ? "selected" : "",
                  ].join(" ")}
                  style={{
                    left: getCanvasX(line.startTime, zoom),
                    width: Math.max((line.endTime - line.startTime) * zoom, 4),
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) {
                      return;
                    }
                    event.stopPropagation();
                    lastPointerClientXRef.current = event.clientX;
                    setDragState({
                      kind: "move-line",
                      id: line.id,
                      originX: event.clientX,
                      originalStart: line.startTime,
                      originalEnd: line.endTime,
                    });
                  }}
                  onClick={() => {
                    if (suppressLineClickIdRef.current === line.id) {
                      suppressLineClickIdRef.current = null;
                      return;
                    }
                    onSelectLineOverlay(line.id);
                  }}
                  title={line.text}
                >
                  <span className="line-overlay-text">{line.text}</span>
                </button>
              ))}
            </div>

            {banyanTrackVisible ? (
              <div className="timeline-track banyan-track" style={{ height: BANYAN_TRACK_HEIGHT }}>
                <div
                  className={[
                    "track-label",
                    "track-label-custom",
                    "banyan-label",
                    selectedItem?.type === "banyan-track" ? "selected" : "",
                  ].join(" ")}
                  style={{ minHeight: BANYAN_TRACK_HEIGHT }}
                  onClick={() => onSelectItem({ type: "banyan-track" })}
                >
                  <div className="track-label-copy">
                    <strong>板眼</strong>
                    <span>{banyanMarks.length > 0 ? `${banyanMarks.length} 点 · ${banyanSections.length} 段` : "未生成"}</span>
                  </div>
                </div>
                <div
                  className="track-lane banyan-lane"
                  style={{ minHeight: BANYAN_TRACK_HEIGHT }}
                  onPointerDown={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (event.button !== 0 || target?.closest(".timeline-banyan-mark")) {
                      return;
                    }
                    onCloseContextMenu();
                    lastPointerClientXRef.current = event.clientX;
                    startSelectBoxDrag(event.clientX, event.clientY, {
                      shiftKey: event.shiftKey,
                      additive: event.metaKey || event.ctrlKey,
                    });
                  }}
                  onClick={(event) => {
                    const laneTime = getLaneTime(event.currentTarget, event.clientX, zoom);
                    onUpdatePasteTarget("banyan-track", laneTime);
                    if ((event.target as HTMLElement | null)?.closest(".timeline-banyan-mark")) {
                      return;
                    }
                    if (event.detail === 2) {
                      onCreateBanyanMark(laneTime);
                      return;
                    }
                    onSelectItem({ type: "banyan-track" });
                    onSeek(laneTime);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const laneTime = getLaneTime(event.currentTarget, event.clientX, zoom);
                    onUpdatePasteTarget("banyan-track", laneTime);
                    onOpenLaneContextMenu("banyan-track", laneTime, event.clientX, event.clientY);
                  }}
                >
                  {visibleBanyanMarks.map((mark) => renderBanyanMark(mark))}
                </div>
              </div>
            ) : null}

            {waveformVisible ? (
              <div className="timeline-track waveform-track" style={{ height: waveformTrackHeight }}>
                <div
                  className={[
                    "track-label",
                    "track-label-custom",
                    "waveform-label",
                    isWaveformTrackSelected ? "selected" : "",
                  ].join(" ")}
                  style={{ minHeight: waveformTrackHeight }}
                  onClick={() => onSelectItem({ type: "waveform-track" })}
                >
                  <div className="track-label-copy">
                    <strong>音频波形</strong>
                    <span>
                      {isWaveformLoading
                        ? "提取中..."
                        : waveformData
                          ? spectrogramSettings.visible
                            ? "波形 + 频谱设置"
                            : "波形设置"
                          : "暂无波形"}
                    </span>
                  </div>
                  <div
                    className={[
                      "waveform-track-resize-handle",
                      waveformResizeDrag ? "active" : "",
                    ].join(" ")}
                    onPointerDown={(event) => {
                      if (event.button !== 0) {
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      startWaveformResize(event.clientY);
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setWaveformResizeDrag(null);
                      setWaveformTrackHeight(DEFAULT_WAVEFORM_TRACK_HEIGHT);
                    }}
                    title="拖动调整波形轨高度，双击恢复默认高度"
                  >
                    <span className="waveform-track-resize-grip" />
                  </div>
                </div>
                <div
                  className="track-lane waveform-lane"
                  style={{ minHeight: waveformTrackHeight }}
                  onClick={(event) => {
                    onSelectItem({ type: "waveform-track" });
                    onSeek(getLaneTime(event.currentTarget, event.clientX, zoom));
                  }}
                >
                  {visibleWaveformKeypoints.map((time) => (
                    <div
                      key={`waveform-keypoint-${time}`}
                      className="waveform-keypoint-guide"
                      style={{ left: time * zoom }}
                    />
                  ))}
                  {waveformDetail ? (
                    <svg
                      className="waveform-detail-svg"
                      viewBox={`0 0 ${waveformDetail.viewWidth} ${waveformViewHeight}`}
                      preserveAspectRatio="none"
                      style={{
                        left: waveformDetail.left,
                        width: waveformDetail.width,
                        top: (waveformTrackHeight - waveformViewHeight) / 2,
                        height: waveformViewHeight,
                      }}
                    >
                      <path className="waveform-area" d={waveformDetail.areaPath} />
                      <path className="waveform-center-line" d={waveformDetail.centerLinePath} />
                    </svg>
                  ) : (
                    <div className="waveform-empty">
                      {isWaveformLoading ? "正在从视频中提取音频波形..." : "当前视频暂无可显示的音频波形"}
                    </div>
                  )}
                </div>
                <div
                  className={[
                    "waveform-track-bottom-resize-handle",
                    waveformResizeDrag ? "active" : "",
                  ].join(" ")}
                  onPointerDown={(event) => {
                    if (event.button !== 0) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    startWaveformResize(event.clientY);
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setWaveformResizeDrag(null);
                    setWaveformTrackHeight(DEFAULT_WAVEFORM_TRACK_HEIGHT);
                  }}
                  title="拖动调整波形轨高度，双击恢复默认高度"
                >
                  <span className="waveform-track-resize-grip" />
                </div>
              </div>
            ) : null}

            {spectrogramSettings.visible ? (
              <div className="timeline-track spectrogram-track" style={{ height: spectrogramTrackHeight }}>
                <div
                  className={[
                    "track-label",
                    "track-label-custom",
                    "spectrogram-label",
                    isSpectrogramTrackSelected ? "selected" : "",
                  ].join(" ")}
                  style={{ minHeight: spectrogramTrackHeight }}
                  onClick={() => onSelectItem({ type: "spectrogram-track" })}
                >
                  <div className="track-label-copy">
                    <strong>人声频谱图</strong>
                    <span>
                      {isSpectrogramLoading
                        ? "STFT 计算中..."
                        : spectrogramData
                          ? `${spectrogramSettings.frequencyScale} · ${spectrogramFrequencyRange.minFrequency}-${spectrogramFrequencyRange.maxFrequency} Hz`
                          : "暂无频谱"}
                    </span>
                  </div>
                  <div
                    className={[
                      "waveform-track-resize-handle",
                      spectrogramResizeDrag ? "active" : "",
                    ].join(" ")}
                    onPointerDown={(event) => {
                      if (event.button !== 0) {
                        return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      startSpectrogramResize(event.clientY);
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSpectrogramResizeDrag(null);
                      setSpectrogramTrackHeight(DEFAULT_SPECTROGRAM_TRACK_HEIGHT);
                    }}
                    title="拖动调整频谱图高度，双击恢复默认高度"
                  >
                    <span className="waveform-track-resize-grip" />
                  </div>
                </div>
                <div
                  className="track-lane spectrogram-lane"
                  style={{ minHeight: spectrogramTrackHeight }}
                  onClick={(event) => {
                    onSelectItem({ type: "spectrogram-track" });
                    onSeek(getLaneTime(event.currentTarget, event.clientX, zoom));
                  }}
                >
                  {spectrogramData ? (
                    <SpectrogramCanvas
                      data={spectrogramData}
                      frequencyScale={spectrogramSettings.frequencyScale}
                      minFrequency={spectrogramFrequencyRange.minFrequency}
                      maxFrequency={spectrogramFrequencyRange.maxFrequency}
                      visibleStartTime={spectrogramViewport.startTime}
                      visibleEndTime={spectrogramViewport.endTime}
                      activeVisibleStartTime={spectrogramViewport.activeStartTime}
                      activeVisibleEndTime={spectrogramViewport.activeEndTime}
                      left={spectrogramViewport.left}
                      width={spectrogramViewport.width}
                      height={spectrogramViewHeight}
                      showPitchContour={spectrogramSettings.showPitchContour}
                      interactionPreview={spectrogramInteractionPreview}
                    />
                  ) : (
                    <div className="spectrogram-empty">
                      {isSpectrogramLoading
                        ? "正在使用 n_fft=4096 / hop=480 / Hann 计算 dB 频谱..."
                        : "开启视频音频后可显示人声频谱图"}
                    </div>
                  )}
                </div>
                <div
                  className={[
                    "waveform-track-bottom-resize-handle",
                    spectrogramResizeDrag ? "active" : "",
                  ].join(" ")}
                  onPointerDown={(event) => {
                    if (event.button !== 0) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    startSpectrogramResize(event.clientY);
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSpectrogramResizeDrag(null);
                    setSpectrogramTrackHeight(DEFAULT_SPECTROGRAM_TRACK_HEIGHT);
                  }}
                  title="拖动调整频谱图高度，双击恢复默认高度"
                >
                  <span className="waveform-track-resize-grip" />
                </div>
              </div>
            ) : null}
          </div>

          <div className="timeline-track-list">
            {trackDefinitions.map((track) => {
              const parentTrackMeta = parentTrackMap.get(track.id);
              const pointTrack = track.type === "attached-point" ? attachedPointTrackMap.get(track.id) : null;
              const gongcheParentTrackId = track.type === "gongche-attached" ? track.parentTrackId ?? "" : "";
              const customBlockCreationTarget = getCustomBlockCreationTarget(track);
              const stackedTrackLayout = trackBlockLayouts.get(track.id);
              const baseTrackHeight = getTimelineTrackBaseHeight(track, trackHeight);
              const trackActualHeight = stackedTrackLayout
                ? Math.max(baseTrackHeight, stackedTrackLayout.trackHeight)
                : baseTrackHeight;
              // 派生子轨比普通轨矮，块的位置必须按当前可见轨道高度重新计算。
              const trackBlockMetrics = getTrackBlockMetrics(trackActualHeight);
              const actionBlocksForTrack = track.type === "action"
                ? actionAnnotations.filter((annotation) => annotation.trackId === track.id)
                : [];
              const customBlocksForTrack =
                track.type === "custom-text" || track.type === "custom-action" || track.type === "branch-lane"
                  ? customBlocks.filter((annotation) => isCustomBlockVisibleOnTrack(annotation, track))
                  : [];
              const trackColor = track.isCustom
                ? (() => {
                    const info = customTrackMap.get(track.id);
                    return info ? resolveCustomTrackColor(info.track, info.index) : track.color;
                  })()
                : track.isBranchLaneTrack
                  ? track.color
                  : undefined;
              const trackColorVariables = trackColor ? getColorCssVariables(trackColor) : {};
              // 联合边界候选跟随“当前显示方式”：
              // 合并显示的父轨会传入父轨所有可见块，允许跨分叉联合拖动；
              // 展开显示的分叉子轨只传入本子轨可见块，避免误改兄弟子轨。
              return (
              <div
                key={track.id}
                className={[
                  "timeline-track",
                  track.type === "attached-point" ? "timeline-track-attached-point" : "",
                  track.type === "gongche-attached" ? "timeline-track-gongche" : "",
                  track.type === "branch-lane" ? "timeline-track-branch-lane" : "",
                  (track.isCustom || track.isBuiltin) && customTrackDropBeforeId === track.id ? "drop-target-before" : "",
                  (track.isCustom || track.isBuiltin) && customTrackDropAfterId === track.id ? "drop-target-after" : "",
                  draggedTrackId === track.id ? "drag-source" : "",
                ].join(" ")}
                style={{ height: trackActualHeight }}
                ref={(node) => {
                  if (!track.isCustom && !track.isBuiltin) {
                    return;
                  }
                  if (node) {
                    trackRowRefs.current.set(track.id, node);
                  } else {
                    trackRowRefs.current.delete(track.id);
                  }
                }}
              >
                <div
                  className={[
                    "track-label",
                    track.isCustom || track.isBuiltin ? "track-label-custom" : "",
                    compactTrackLabels ? "compact" : "",
                    (
                      ((selectedItem?.type === "custom-track" || selectedItem?.type === "builtin-track") && selectedItem.id === track.id) ||
                      (selectedItem?.type === "attached-point-track" && selectedItem.id === track.id) ||
                      (selectedItem?.type === "gongche-track" && selectedItem.parentTrackId === track.parentTrackId) ||
                      (track.isBranchLaneTrack && selectedItem?.type === "custom-track" && selectedItem.id === track.parentTrackId)
                    ) ? "selected" : "",
                    draggedTrackId === track.id ? "dragging" : "",
                    recentlyMovedTrackId === track.id ? "recently-moved" : "",
                  ].join(" ")}
                  style={{
                    ...(track.isBranchLaneTrack
                      ? { "--branch-depth": track.branchDepth ?? 0 } as CSSProperties
                      : {}),
                    ...trackColorVariables,
                    ...(draggedTrackId === track.id &&
                      trackReorderDrag &&
                      Math.abs(trackReorderDrag.currentY - trackReorderDrag.startY) >= REORDER_ACTIVATION_PX
                      ? {
                          transform: `translateY(${trackReorderDrag.currentY - trackReorderDrag.startY}px)`,
                          zIndex: 8,
                        }
                      : {}),
                  }}
                  onClick={() => {
                    if (track.isBuiltin) {
                      onSelectBuiltinTrack(track.id as BuiltinTrackId);
                    } else if (track.isCustom) {
                      onSelectTrack(track.id);
                    } else if (track.isBranchLaneTrack && track.parentTrackId) {
                      onSelectTrack(track.parentTrackId);
                    } else if (track.isAttachedPointTrack && track.parentTrackId) {
                      onSelectAttachedPointTrack(track.id, track.parentTrackId);
                    } else if (track.isGongcheTrack && track.parentTrackId) {
                      onSelectItem({ type: "gongche-track", parentTrackId: track.parentTrackId });
                    }
                  }}
                  onPointerDown={(event) => {
                    if (!track.isCustom && !track.isBuiltin) {
                      return;
                    }
                    if (event.button !== 0) {
                      return;
                    }
                    const target = event.target as HTMLElement | null;
                    if (target?.closest(".track-snap-toggle, .track-label-tools, button, input")) {
                      return;
                    }
                    event.stopPropagation();
                    event.preventDefault();
                    startTrackReorder(track.id, event.clientY);
                  }}
                >
                  <div className="track-label-copy">
                    <div
                      className={[
                        "track-label-main",
                        track.isCustom || track.isBuiltin ? "track-label-drag-surface" : "",
                      ].join(" ")}
                      onPointerDown={(event) => {
                        if (!track.isCustom && !track.isBuiltin) {
                          return;
                        }
                        const target = event.target as HTMLElement | null;
                        if (target?.closest(".track-snap-toggle, .track-label-tools, button, input")) {
                          return;
                        }
                        event.stopPropagation();
                        event.preventDefault();
                        startTrackReorder(track.id, event.clientY);
                      }}
                    >
                      <div className="track-label-title-row">
                        {trackColor ? <span className="track-label-color-dot" aria-hidden="true" /> : null}
                        <strong>{track.name}</strong>
                      </div>
                      {!compactTrackLabels && track.isCustom ? (
                        <span className="track-label-meta">
                          {track.type === "custom-text" ? "文字类自定义轨" : "动作类自定义轨"}
                          {track.branching?.enabled
                            ? ` · 分叉${track.branching.displayMode === "expanded" ? "展开" : "合并"}${
                              getBranchLaneCount(track.branching.lanes) > 0
                                ? ` ${getBranchLaneCount(track.branching.lanes)}`
                                : ""
                            }`
                            : ""}
                        </span>
                      ) : null}
                      {!compactTrackLabels && track.isBuiltin ? (
                        <span className="track-label-meta">
                          {track.type === "character" ? "文字类内建轨" : "动作类内建轨"}
                        </span>
                      ) : null}
                      {!compactAttachedPointMeta && track.isAttachedPointTrack ? (
                        <span className="track-label-meta">
                          {track.parentTrackName ? `附属于 ${track.parentTrackName}` : "附属打点轨"}
                        </span>
                      ) : null}
                      {!compactAttachedPointMeta && track.isGongcheTrack ? (
                        <span className="track-label-meta">
                          {track.parentTrackName ? `附属于 ${track.parentTrackName}` : "附属文字轨"}
                        </span>
                      ) : null}
                      {!compactAttachedPointMeta && track.isBranchLaneTrack ? (
                        <span
                          className="track-branch-lane-meta"
                          style={{ "--branch-depth": track.branchDepth ?? 0 } as CSSProperties}
                        >
                          {track.parentTrackName ? `分叉 · ${track.parentTrackName}` : "分叉子轨"}
                        </span>
                      ) : null}
                    </div>
                    <div className="track-label-footer">
                      <div className="track-label-footer-left">
                        {!track.isAttachedPointTrack && !track.isGongcheTrack && !track.isBranchLaneTrack ? (
                          <label className="track-snap-toggle" onClick={(event) => event.stopPropagation()}>
                            <input
                              type="checkbox"
                              draggable={false}
                              checked={Boolean(trackSnapEnabled[track.id])}
                              onChange={() => onToggleTrackSnap(track.id)}
                            />
                            <span>吸附</span>
                          </label>
                        ) : (
                          <span className="track-attached-point-caption">
                            {track.isBranchLaneTrack ? "分叉子轨" : track.isGongcheTrack ? "工尺谱" : "附属打点轨"}
                          </span>
                        )}
                      </div>
                      {track.isCustom || track.isBuiltin ? (
                        <div
                          className="track-label-tools"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {(parentTrackMeta?.attachedPointTrackCount ?? 0) > 0 ? (
                            <button
                              type="button"
                              className="track-label-tool-button"
                              onClick={() => onToggleAttachedPointTracks(track.id)}
                              title={parentTrackMeta?.attachedPointTracksExpanded ? "隐藏附属打点轨" : "展开附属打点轨"}
                            >
                              {parentTrackMeta?.attachedPointTracksExpanded ? "点−" : `点${parentTrackMeta?.attachedPointTrackCount ?? ""}`}
                            </button>
                          ) : null}
                          {track.isCustom ? (
                            <>
                              <div
                                className="track-label-tool-button track-label-drag-handle"
                                title="拖动调整轨道顺序"
                              >
                                ⋮⋮
                              </div>
                              <button
                                type="button"
                                className="track-label-tool-button"
                                onClick={() => {
                                  onMoveTrack(track.id, "up");
                                  flashMovedTrack(track.id);
                                }}
                                disabled={(activeTrackOrderMap.get(track.id) ?? 0) <= 0}
                                title="上移轨道"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="track-label-tool-button"
                                onClick={() => {
                                  onMoveTrack(track.id, "down");
                                  flashMovedTrack(track.id);
                                }}
                                disabled={(activeTrackOrderMap.get(track.id) ?? 0) >= activeTrackDefinitions.length - 1}
                                title="下移轨道"
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                className="track-label-tool-button track-label-delete-button"
                                onClick={() => onDeleteCustomTrack(track.id)}
                                title="删除轨道"
                              >
                                删
                              </button>
                            </>
                          ) : null}
                          {track.isBuiltin ? (
                            <>
                              <button
                                type="button"
                                className="track-label-tool-button"
                                onClick={() => {
                                  onMoveTrack(track.id, "up");
                                  flashMovedTrack(track.id);
                                }}
                                disabled={(activeTrackOrderMap.get(track.id) ?? 0) <= 0}
                                title="上移轨道"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="track-label-tool-button"
                                onClick={() => {
                                  onMoveTrack(track.id, "down");
                                  flashMovedTrack(track.id);
                                }}
                                disabled={(activeTrackOrderMap.get(track.id) ?? 0) >= activeTrackDefinitions.length - 1}
                                title="下移轨道"
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                className="track-label-tool-button track-label-delete-button"
                                onClick={() => onDeleteBuiltinTrack(track.id as BuiltinTrackId)}
                                title="删除轨道"
                              >
                                删
                              </button>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div
                  className="track-lane"
                  onPointerDown={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (event.button !== 0 || target?.closest(".timeline-block, .timeline-point-marker, .timeline-gongche-block")) {
                      return;
                    }
                    onCloseContextMenu();
                    if (event.metaKey || event.ctrlKey) {
                      if (track.type === "attached-point" || track.type === "gongche-attached") {
                        return;
                      }
                      if (!customBlockCreationTarget && track.type === "branch-lane") {
                        return;
                      }
                      const creationTrackType = customBlockCreationTarget?.trackType ??
                        (track.type === "character" ||
                          track.type === "action" ||
                          track.type === "custom-text" ||
                          track.type === "custom-action"
                          ? track.type
                          : null);
                      if (!creationTrackType) {
                        return;
                      }
                      lastPointerClientXRef.current = event.clientX;
                      setDragState({
                        kind: "create-track-item",
                        trackId: customBlockCreationTarget?.trackId ?? track.id,
                        trackType: creationTrackType,
                        visualTrackId: track.id,
                        branchScope: customBlockCreationTarget?.branchScope,
                        originX: event.clientX,
                        currentX: event.clientX,
                        laneLeft: event.currentTarget.getBoundingClientRect().left,
                      });
                      return;
                    }
                    lastPointerClientXRef.current = event.clientX;
                    startSelectBoxDrag(event.clientX, event.clientY, {
                      shiftKey: event.shiftKey,
                      additive: event.metaKey || event.ctrlKey,
                    });
                  }}
                  onClick={(event) => {
                    onCloseContextMenu();
                    if (performance.now() < suppressCanvasClickUntilRef.current) {
                      return;
                    }
                    const target = event.target as HTMLElement | null;
                    const laneTime = getLaneTime(event.currentTarget, event.clientX, zoom);
                    const snapTrackId = customBlockCreationTarget?.trackId ?? track.id;
                    onUpdatePasteTarget(snapTrackId, laneTime);
                    const creationSnapPoints = trackSnapEnabled[snapTrackId]
                      ? [...snapPoints, ...getTrackSnapPoints(snapTrackId)]
                      : [];
                    const snappedLaneTime = trackSnapEnabled[snapTrackId]
                      ? snapTime(laneTime, creationSnapPoints, zoom)
                      : laneTime;
                    if (!target?.closest(".timeline-block, .timeline-point-marker, .timeline-gongche-block") && event.detail === 2) {
                      if (track.type === "attached-point") {
                        onCreateAttachedPoint(track.id, snappedLaneTime);
                        return;
                      }
                      if (track.type === "gongche-attached" && gongcheParentTrackId) {
                        onCreateGongcheBlockAtTime(gongcheParentTrackId, snappedLaneTime);
                        return;
                      }
                      const startTime = snappedLaneTime;
                      if (track.type === "character") {
                        onCreateCharacterAtTime(startTime);
                        return;
                      }
                      if (customBlockCreationTarget) {
                        onCreateCustomBlock(
                          customBlockCreationTarget.trackId,
                          startTime,
                          undefined,
                          customBlockCreationTarget.branchScope,
                        );
                        return;
                      }
                      onCreateActionAtTime(track.id, startTime);
                      return;
                    }
                    if (!target?.closest(".timeline-block, .timeline-point-marker, .timeline-gongche-block") && selectedTimelineItems.length > 1) {
                      onSelectTimelineItems([], null);
                    }
                    onSeek(laneTime);
                  }}
                  onContextMenu={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (target?.closest(".timeline-block, .timeline-point-marker, .timeline-gongche-block")) {
                      return;
                    }
                    event.preventDefault();
                    onCloseContextMenu();
                    const laneTime = getLaneTime(event.currentTarget, event.clientX, zoom);
                    onUpdatePasteTarget(customBlockCreationTarget?.trackId ?? track.id, laneTime);
                    onOpenLaneContextMenu(track.id, laneTime, event.clientX, event.clientY);
                  }}
                >
                  {track.type === "character"
                    ? characterAnnotations.map((annotation) => renderBlock(annotation, "character", {
                        displayLayout: stackedTrackLayout?.blockDisplayLayouts.get(annotation.id),
                        trackBlockMetrics,
                        visualTrackId: track.id,
                        linkedBoundaryCandidates: characterAnnotations,
                      }))
                    : track.type === "action"
                      ? actionBlocksForTrack
                          .map((annotation) => renderBlock(annotation, "action", {
                            displayLayout: stackedTrackLayout?.blockDisplayLayouts.get(annotation.id),
                            trackBlockMetrics,
                            visualTrackId: track.id,
                            linkedBoundaryCandidates: actionBlocksForTrack,
                          }))
                      : track.type === "attached-point"
                        ? pointTrack
                          ? pointTrack.points.map((point) => renderAttachedPoint(point, pointTrack))
                          : []
                      : track.type === "gongche-attached"
                        ? gongcheAnnotations
                            .filter((annotation) => annotation.parentTrackId === gongcheParentTrackId)
                            .map((annotation) => renderGongcheBlock(annotation))
                      : customBlocksForTrack
                          .map((annotation) =>
                            renderBlock(annotation, "custom-block", {
                              displayLayout: stackedTrackLayout?.blockDisplayLayouts.get(annotation.id),
                              trackBlockMetrics,
                              visualTrackId: track.id,
                              linkedBoundaryCandidates: customBlocksForTrack,
                            })
                          )}
                  {dragState?.kind === "create-track-item" && dragState.visualTrackId === track.id && scrollRef.current ? (
                    <div
                      className={`timeline-block draft ${
                        dragState.trackType === "character" || dragState.trackType === "custom-text"
                          ? "character"
                          : "action"
                      }`}
                      style={getDraftStyle(dragState)}
                    />
                  ) : null}
                </div>
              </div>
              );
            })}
          </div>

          {dragState?.kind === "select-box" && scrollRef.current ? (
            <div
              className="timeline-selection-box"
              style={getSelectionBoxStyle(dragState)}
            />
          ) : null}

          {activeSnapIndicator ? (
            <div
              className={`timeline-snap-guide ${activeSnapIndicator.edge}`}
              style={{ left: getCanvasX(activeSnapIndicator.time, zoom) }}
            />
          ) : null}

          {displayedLoopPlaybackRange && (loopPlaybackEnabled || loopRangeDraft !== null) ? (
            <div
              className={`timeline-loop-range-overlay ${loopPlaybackEnabled ? "active" : ""}`}
              style={{
                left: getCanvasX(displayedLoopPlaybackRange.start, zoom),
                width: Math.max(
                  (displayedLoopPlaybackRange.end - displayedLoopPlaybackRange.start) * zoom,
                  4,
                ),
              }}
            />
          ) : null}

          {/* 远端提示只读叠加；三类元素都使用 Timeline 的同一时间坐标，不参与任何命中或编辑。 */}
          {remoteActivities.map((remoteActivity, index) => {
            const { playhead, pointer, selection } = remoteActivity.activity;
            return (
              <Fragment key={remoteActivity.userId}>
                {remoteActivity.showSelection && selection ? (
                  <div
                    className="remote-selection-range"
                    style={{
                      left: getCanvasX(selection.start, zoom),
                      width: Math.max(2, (selection.end - selection.start) * zoom),
                      "--remote-activity-color": remoteActivity.color,
                      "--remote-activity-label-row": index % 4,
                    } as CSSProperties}
                    aria-hidden="true"
                  >
                    <span>{remoteActivity.displayName} · {selection.itemCount} 项 · {selection.laneCount} 轨</span>
                  </div>
                ) : null}
                {pointer ? (
                  <div
                    className="remote-pointer-guide"
                    style={{
                      left: getCanvasX(pointer.time, zoom),
                      "--remote-activity-color": remoteActivity.color,
                      "--remote-activity-label-row": index % 4,
                    } as CSSProperties}
                    aria-hidden="true"
                  >
                    <span>{remoteActivity.displayName}</span>
                  </div>
                ) : null}
                {playhead ? (
                  <div
                    className={`remote-playhead ${playhead.playing ? "playing" : "paused"}`}
                    style={{
                      left: getCanvasX(playhead.time, zoom),
                      "--remote-playhead-color": remoteActivity.color,
                      "--remote-playhead-label-row": index % 4,
                    } as CSSProperties}
                    aria-hidden="true"
                  >
                    <span>{remoteActivity.displayName}</span>
                  </div>
                ) : null}
              </Fragment>
            );
          })}

          {previewGuideTime !== null ? (
            <div
              className="timeline-preview-guide"
              style={{ left: getCanvasX(previewGuideTime, zoom) }}
            />
          ) : null}

          {playheadViewportOffset > 0 && playheadViewportOffset < TRACK_LABEL_WIDTH ? (
            <div
              className="playhead playhead-sticky-overlay"
              style={{ left: viewportState.scrollLeft + playheadViewportOffset }}
            />
          ) : null}

          <div className="playhead" style={{ left: getCanvasX(currentTime, zoom) }} />
          </div>
        </div>
      </div>
    </section>
  );

  function renderBlock(
    annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
    type: "character" | "action" | "custom-block",
    options: {
      displayLayout?: StackedTrackBlockDisplayLayout;
      trackBlockMetrics?: TrackBlockMetrics;
      visualTrackId?: string;
      linkedBoundaryCandidates?: Array<CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock>;
    } = {},
  ) {
    const characterAnnotation = type === "character" ? annotation as CharacterAnnotation : null;
    const actionAnnotation = type === "action" ? annotation as ActionAnnotation : null;
    const customAnnotation = type === "custom-block" ? annotation as ResolvedCustomTrackBlock : null;
    const visualTrack = options.visualTrackId ? trackDefinitionMap.get(options.visualTrackId) : undefined;
    const branchLaneId = visualTrack?.type === "branch-lane" ? visualTrack.branchLaneId : undefined;
    const currentSelectionItem = customAnnotation
      ? {
          type: "custom-block" as const,
          id: annotation.id,
          trackId: customAnnotation.trackId,
          branchLaneId,
        }
      : characterAnnotation
        ? { type: "character" as const, id: annotation.id }
        : { type: "action" as const, id: annotation.id };
    const currentSelectedItem = customAnnotation
      ? {
          type: "custom-block" as const,
          id: annotation.id,
          trackId: customAnnotation.trackId,
          branchLaneId,
        }
      : characterAnnotation
        ? { type: "character" as const, id: annotation.id }
        : { type: "action" as const, id: annotation.id };
    const selectionKey = getTimelineSelectionKey(
      type,
      annotation.id,
      customAnnotation?.trackId,
    );
    const isSelected =
      selectedTimelineKeySet.has(selectionKey) || marqueePreviewKeySet.has(selectionKey);
    const isPartOfMultiSelection = selectedTimelineKeySet.has(selectionKey) && selectedTimelineItems.length > 1;
    const isActive = currentTime >= annotation.startTime && currentTime <= annotation.endTime;
    const isEditing = type === "character" &&
      editingCharacterId === annotation.id &&
      editingCharacterLocation === "timeline";
    const isEditingCustomText = customAnnotation?.trackType === "text" &&
      editingCustomTextBlock?.id === annotation.id &&
      editingCustomTextBlock.trackId === customAnnotation.trackId;
    const left = annotation.startTime * zoom;
    const width = Math.max((annotation.endTime - annotation.startTime) * zoom, 8);
    const label = characterAnnotation
      ? characterAnnotation.char
      : customAnnotation
        ? customAnnotation.trackType === "text"
          ? customAnnotation.text ?? ""
          : customAnnotation.type
        : actionAnnotation?.label ?? "";
    const blockTop = options.displayLayout
      ? options.displayLayout.top
      : options.trackBlockMetrics?.top ?? trackBlockTop;
    const blockHeight = options.displayLayout
      ? options.displayLayout.height
      : options.trackBlockMetrics?.height ?? trackBlockHeight;
    // 四声仅内建逐字轨有。优先横向并排；横向放不下但纵向够且标签自身能放进块宽，
    // 则上下两层；都不行则只靠加粗表达“有四声”。
    const toneInfo = characterAnnotation?.tone ?? null;
    const hasTone = Boolean(toneInfo) && isValidCharacterToneInfo(toneInfo);
    const toneLabel = hasTone ? getCharacterToneLabel(toneInfo) : null;
    const showToneInline = toneLabel !== null && !isEditing &&
      width >= TONE_LABEL_RESERVED_PX + toneLabel.length * TONE_LABEL_CHAR_PX;
    const showToneStacked = toneLabel !== null && !isEditing && !showToneInline &&
      blockHeight >= TONE_LABEL_STACK_MIN_HEIGHT &&
      width >= toneLabel.length * TONE_LABEL_CHAR_PX + TONE_LABEL_SIDE_PADDING;
    const showToneLabel = showToneInline || showToneStacked;
    const zIndex = isSelected ? 4 : isActive ? 3 : 1;
    const hoveredEdge = hoveredBlock?.id === annotation.id &&
      hoveredBlock.type === type &&
      (!customAnnotation || (hoveredBlock.type === "custom-block" && hoveredBlock.trackId === customAnnotation.trackId))
      ? hoveredBlock.edge
      : null;
    const customTrackInfo = customAnnotation ? customTrackMap.get(customAnnotation.trackId) : null;
    const customColorVariables = customAnnotation && customTrackInfo
      ? getColorCssVariables(
          getCustomBlockDisplayColor(
            customTrackInfo.track,
            customAnnotation,
            visualTrack,
            customTrackInfo.index,
          ),
        )
      : {};

    return (
      <div
        key={annotation.id}
        data-block-id={annotation.id}
        data-block-type={type}
        data-block-track-id={customAnnotation?.trackId}
        data-block-visual-track-id={options.visualTrackId}
        className={[
          "timeline-block",
          type === "character" || customAnnotation?.trackType === "text"
            ? "character"
            : "action",
          customAnnotation ? `custom-${customAnnotation.trackType}` : "",
          isSelected ? "selected" : "",
          isActive ? "active" : "",
          hoveredEdge === "center" ? "hover-move" : "",
          hoveredEdge === "left" ? "hover-resize-left" : "",
          hoveredEdge === "right" ? "hover-resize-right" : "",
          hoveredEdge === "linked-left" ? "hover-linked-left" : "",
          hoveredEdge === "linked-right" ? "hover-linked-right" : "",
          options.displayLayout ? "stacked-track-block" : "",
          customAnnotation?.branchScope?.mode === "lanes" && customAnnotation.branchScope.laneIds.length > 1
            ? "shared-branch-block"
            : "",
          hasTone ? "has-tone" : "",
          showToneInline ? "tone-inline" : "",
          showToneStacked ? "tone-stacked" : "",
        ].join(" ")}
        style={{ left, width, top: blockTop, height: blockHeight, zIndex, ...customColorVariables }}
        onPointerMove={(event) => {
          const preferredHit = resolvePreferredBlockHit(
            event.clientX,
            event.clientY,
            annotation.id,
            type,
            characterAnnotations,
            actionAnnotations,
            customBlocks,
            selectedItem,
            trackSnapEnabled,
            zoom,
            customAnnotation?.trackId,
            options.visualTrackId,
            options.linkedBoundaryCandidates,
          );
          const hoverTarget = (preferredHit ?? buildHoveredBlockState(
            annotation.id,
            type,
            isPartOfMultiSelection
              ? "center"
              : resolveEdgeForElement(
                  event.currentTarget,
                  event.clientX,
                  annotation,
                  type,
                  characterAnnotations,
                  actionAnnotations,
                  customBlocks,
                  trackSnapEnabled,
                  zoom,
                  options.visualTrackId,
                  options.linkedBoundaryCandidates,
                ),
            customAnnotation?.trackId,
          )) as Exclude<HoveredBlockState, null>;
          setHoveredBlock((prev) =>
            prev?.id === hoverTarget.id &&
            prev.type === hoverTarget.type &&
            getHoveredBlockTrackId(prev) === getHoveredBlockTrackId(hoverTarget) &&
            prev.edge === hoverTarget.edge
              ? prev
              : hoverTarget,
          );
        }}
        onPointerLeave={() => {
          setHoveredBlock((prev) =>
            prev?.id === annotation.id &&
            prev.type === type &&
            (!customAnnotation || (prev.type === "custom-block" && prev.trackId === customAnnotation.trackId))
              ? null
              : prev,
          );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          onCloseContextMenu();
          event.stopPropagation();
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            return;
          }
          const preferredHit = resolvePreferredBlockHit(
            event.clientX,
            event.clientY,
            annotation.id,
            type,
            characterAnnotations,
            actionAnnotations,
            customBlocks,
            selectedItem,
            trackSnapEnabled,
            zoom,
            customAnnotation?.trackId,
            options.visualTrackId,
            options.linkedBoundaryCandidates,
          );
          const displayedHoverHit =
            hoveredBlock?.id === annotation.id &&
            hoveredBlock.type === type &&
            (!customAnnotation || (hoveredBlock.type === "custom-block" && hoveredBlock.trackId === customAnnotation.trackId))
              ? hoveredBlock
              : null;
          const interactionHit = displayedHoverHit ?? preferredHit;
          const targetId = interactionHit?.id ?? annotation.id;
          const targetType = interactionHit?.type ?? type;
          const targetTrackId = interactionHit?.type === "custom-block"
            ? interactionHit.trackId
            : customAnnotation
              ? customAnnotation.trackId
              : undefined;
          const targetSelectionKey = getTimelineSelectionKey(targetType, targetId, targetTrackId);
          const targetEdge =
            selectedTimelineItems.length > 1 && selectedTimelineKeySet.has(targetSelectionKey)
              ? "center"
              : interactionHit?.edge ?? resolveEdgeForElement(
                  event.currentTarget,
                  event.clientX,
                  annotation,
                  type,
                  characterAnnotations,
                  actionAnnotations,
                  customBlocks,
                  trackSnapEnabled,
                  zoom,
                  options.visualTrackId,
                  options.linkedBoundaryCandidates,
                );
          const liveProject = getProjectSnapshot();
          const targetAnnotation = findAnnotationById(
            targetId,
            targetType,
            liveProject.characterAnnotations,
            liveProject.actionAnnotations,
            flattenCustomBlocks(liveProject.customTracks),
            targetTrackId,
          );
          if (!targetAnnotation) {
            return;
          }
          if (isEditing || isEditingCustomText) {
            return;
          }
          lastPointerClientXRef.current = event.clientX;
          const shouldMoveSelection =
            targetEdge === "center" &&
            selectedTimelineItems.length > 1 &&
            selectedTimelineKeySet.has(targetSelectionKey);
          if (shouldMoveSelection) {
            const selectionItems = selectedTimelineItems
              .map((item) => resolveLiveBatchMoveItem(item, liveProject))
              .filter((item): item is TimelineBatchMoveItem => item !== null);
            setDragState({
              kind: "move-selection",
              originX: event.clientX,
              items: selectionItems,
            });
            return;
          }
          const trackId = getTrackIdForAnnotation(targetAnnotation, targetType);
          const boundaryGroup = isLinkedEdgeHit(targetEdge) && trackSnapEnabled[trackId]
            ? findBoundaryGroup(
                targetAnnotation,
                targetType,
                targetEdge === "linked-left" ? "left" : "right",
                liveProject.characterAnnotations,
                liveProject.actionAnnotations,
                flattenCustomBlocks(liveProject.customTracks),
                zoom,
                options.visualTrackId,
                options.linkedBoundaryCandidates,
              )
            : null;
          if (boundaryGroup) {
            setDragState({
              kind: "resize-linked",
              trackId,
              originX: event.clientX,
              boundaryTime: boundaryGroup.time,
              members: boundaryGroup.members,
            });
            setHoveredBlock(buildHoveredBlockState(targetAnnotation.id, targetType, targetEdge, trackId));
            onSelectItem(
              targetType === "custom-block"
                ? { type: "custom-block", trackId, id: targetAnnotation.id, branchLaneId }
                : { type: targetType, id: targetAnnotation.id },
            );
            return;
          }
          const base = {
            id: targetAnnotation.id,
            originX: event.clientX,
            originalStart: targetAnnotation.startTime,
            originalEnd: targetAnnotation.endTime,
          };
          if (targetType === "character") {
            setDragState({
              kind:
                getPhysicalEdge(targetEdge) === "left"
                  ? "resize-left-character"
                  : getPhysicalEdge(targetEdge) === "right"
                    ? "resize-right-character"
                    : "move-character",
              ...base,
            });
          } else {
            setDragState({
              kind:
                getPhysicalEdge(targetEdge) === "left"
                  ? "resize-left-action"
                  : getPhysicalEdge(targetEdge) === "right"
                    ? "resize-right-action"
                    : "move-action",
              ...base,
            });
          }
          setHoveredBlock(buildHoveredBlockState(targetAnnotation.id, targetType, targetEdge, trackId));
          onSelectItem(
            targetType === "custom-block"
              ? { type: "custom-block", trackId, id: targetAnnotation.id, branchLaneId }
              : { type: targetType, id: targetAnnotation.id },
          );
        }}
        onClick={(event) => {
          event.stopPropagation();
          onCloseContextMenu();
          if (performance.now() < suppressCanvasClickUntilRef.current) {
            return;
          }
          onUpdatePasteTarget(
            customAnnotation?.trackId ??
              (type === "character" ? "character-track" : (annotation as ActionAnnotation).trackId),
            annotation.startTime,
          );
          handleTimelineSelectionClick(currentSelectionItem, event);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onCloseContextMenu();
          if (type === "character") {
            onEditCharacterText(annotation.id);
          }
          if (customAnnotation?.trackType === "text") {
            onEditCustomTextBlock(customAnnotation.trackId, annotation.id);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          const relativeX = Math.max(
            0,
            Math.min(event.clientX - event.currentTarget.getBoundingClientRect().left, event.currentTarget.getBoundingClientRect().width),
          );
          const contextTime =
            annotation.startTime +
            ((annotation.endTime - annotation.startTime) * relativeX) /
              Math.max(event.currentTarget.getBoundingClientRect().width, 1);
          onUpdatePasteTarget(
            customAnnotation?.trackId ??
              (type === "character" ? "character-track" : (annotation as ActionAnnotation).trackId),
            contextTime,
          );
          const preserveSelection =
            selectedTimelineItems.length > 1 && selectedTimelineKeySet.has(selectionKey);
          if (!preserveSelection) {
            onSelectItem(currentSelectedItem);
          }
          if (type === "character") {
            onOpenCharacterContextMenu(annotation.id, contextTime, event.clientX, event.clientY);
            return;
          }
          if (customAnnotation) {
            onOpenCustomBlockContextMenu(customAnnotation.trackId, annotation.id, contextTime, event.clientX, event.clientY);
            return;
          }
          onOpenActionContextMenu(annotation.id, contextTime, event.clientX, event.clientY);
        }}
      >
        <div className="resize-handle left" />
        {isEditing ? (
          <input
            className="timeline-block-input"
            value={editingCharacterValue}
            autoFocus
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onChange={(event) => onEditingCharacterValueChange(event.target.value)}
            onBlur={() => onCommitCharacterTextEdit(annotation.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitCharacterTextEdit(annotation.id);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelCharacterTextEdit();
              }
            }}
          />
        ) : isEditingCustomText ? (
          <input
            className="timeline-block-input"
            value={editingCustomTextValue}
            autoFocus
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onChange={(event) => onEditingCustomTextValueChange(event.target.value)}
            onBlur={() => onCommitCustomTextEdit(customAnnotation?.trackId ?? "", annotation.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitCustomTextEdit(customAnnotation?.trackId ?? "", annotation.id);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelCustomTextEdit();
              }
            }}
          />
        ) : (
          <>
            <span className="timeline-block-text">{label}</span>
            {showToneLabel ? <span className="timeline-block-tone">{toneLabel}</span> : null}
          </>
        )}
        <div className="resize-handle right" />
      </div>
    );
  }

  function renderAttachedPoint(point: AttachedPointAnnotation, pointTrack: ResolvedAttachedPointTrack) {
    const selectionItem: TimelineSelectionItem = {
      type: "attached-point",
      id: point.id,
      trackId: pointTrack.id,
      parentTrackId: pointTrack.parentTrackId,
    };
    const selectionKey = getTimelineSelectionKey(selectionItem.type, selectionItem.id, selectionItem.trackId);
    const isSelected = selectedTimelineKeySet.has(selectionKey) || marqueePreviewKeySet.has(selectionKey);
    const isPartOfMultiSelection = selectedTimelineKeySet.has(selectionKey) && selectedTimelineItems.length > 1;
    const visualTime =
      draggedPointPreview?.id === point.id && draggedPointPreview.trackId === pointTrack.id
        ? draggedPointPreview.time
        : point.time;
    const isActive = Math.abs(currentTime - visualTime) <= 0.05;
    const zIndex = isSelected ? 8 : isActive ? 6 : 4;

    return (
      <button
        key={point.id}
        type="button"
        className={[
          "timeline-point-marker",
          isSelected ? "selected" : "",
          isPartOfMultiSelection ? "multi-selected" : "",
          isActive ? "active" : "",
        ].join(" ")}
        style={{ left: visualTime * zoom, zIndex }}
        data-point-id={point.id}
        data-point-track-id={pointTrack.id}
        data-point-parent-track-id={pointTrack.parentTrackId}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.stopPropagation();
          onCloseContextMenu();
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            return;
          }
          lastPointerClientXRef.current = event.clientX;
          const liveProject = getProjectSnapshot();
          const shouldMoveSelection =
            selectedTimelineItems.length > 1 &&
            selectedTimelineKeySet.has(selectionKey);
          if (shouldMoveSelection) {
            const selectionItems = selectedTimelineItems
              .map((item) => resolveLiveBatchMoveItem(item, liveProject))
              .filter((item): item is TimelineBatchMoveItem => item !== null);
            setDragState({
              kind: "move-selection",
              originX: event.clientX,
              items: selectionItems,
            });
            return;
          }
          setDragState({
            kind: "move-point",
            id: point.id,
            trackId: pointTrack.id,
            parentTrackId: pointTrack.parentTrackId,
            originX: event.clientX,
            originalTime: point.time,
          });
          onSelectItem({
            type: "attached-point",
            id: point.id,
            trackId: pointTrack.id,
            parentTrackId: pointTrack.parentTrackId,
          });
        }}
        onClick={(event) => {
          event.stopPropagation();
          onCloseContextMenu();
          if (performance.now() < suppressCanvasClickUntilRef.current) {
            return;
          }
          handleTimelineSelectionClick(selectionItem, event);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          onUpdatePasteTarget(pointTrack.id, point.time);
          const preserveSelection =
            selectedTimelineItems.length > 1 && selectedTimelineKeySet.has(selectionKey);
          if (!preserveSelection) {
            onSelectItem({
              type: "attached-point",
              id: point.id,
              trackId: pointTrack.id,
              parentTrackId: pointTrack.parentTrackId,
            });
          }
          onOpenAttachedPointContextMenu(
            pointTrack.id,
            pointTrack.parentTrackId,
            point.id,
            point.time,
            event.clientX,
            event.clientY,
          );
        }}
        title={`${pointTrack.name} · ${point.label}`}
      >
        <span className="timeline-point-stem" />
        <span className="timeline-point-dot" />
        <span className="timeline-point-chip">{point.label}</span>
      </button>
    );
  }

  function renderBanyanGridLines(extraClassName = "") {
    if (!banyanGridVisible || visibleBanyanMarks.length === 0) {
      return null;
    }
    return (
      <div className={["timeline-banyan-grid-lines", extraClassName].filter(Boolean).join(" ")} aria-hidden="true">
        {visibleBanyanMarks.map((mark) => (
          <span
            key={`banyan-grid-${mark.id}`}
            className={[
              "timeline-banyan-grid-line",
              mark.role === "ban" ? "ban" : "yan",
              mark.subtype === "zengBan" ? "zeng" : "",
              mark.confidence === "manual" ? "manual" : "",
              mark.orphaned ? "orphaned" : "",
            ].join(" ")}
            style={{ left: getCanvasX(mark.time, zoom) }}
          />
        ))}
      </div>
    );
  }

  function renderBanyanMark(mark: BanyanMark) {
    const selectionItem: TimelineSelectionItem = {
      type: "banyan-mark",
      id: mark.id,
    };
    const selectionKey = getTimelineSelectionKey(selectionItem.type, selectionItem.id);
    const isSelected =
      selectedTimelineKeySet.has(selectionKey) ||
      marqueePreviewKeySet.has(selectionKey) ||
      (selectedItem?.type === "banyan-mark" && selectedItem.id === mark.id);
    const isPartOfMultiSelection = selectedTimelineKeySet.has(selectionKey) && selectedTimelineItems.length > 1;
    const isActive = Math.abs(currentTime - mark.time) <= 0.05;
    return (
      <button
        key={mark.id}
        type="button"
        className={[
          "timeline-banyan-mark",
          mark.role === "ban" ? "ban" : "yan",
          mark.subtype === "zengBan" ? "zeng" : "",
          mark.confidence === "manual" ? "manual" : "",
          mark.orphaned ? "orphaned" : "",
          isSelected ? "selected" : "",
          isPartOfMultiSelection ? "multi-selected" : "",
          isActive ? "active" : "",
        ].join(" ")}
        style={{ left: mark.time * zoom }}
        data-banyan-mark-id={mark.id}
        title={`${getBanyanSubtypeLabel(mark.subtype)} ${mark.time.toFixed(3)}s`}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          if (event.metaKey || event.ctrlKey || event.shiftKey) {
            return;
          }
          const liveProject = getProjectSnapshot();
          const shouldMoveSelection =
            selectedTimelineItems.length > 1 &&
            selectedTimelineKeySet.has(selectionKey);
          if (shouldMoveSelection) {
            const selectionItems = selectedTimelineItems
              .map((item) => resolveLiveBatchMoveItem(item, liveProject))
              .filter((item): item is TimelineBatchMoveItem => item !== null);
            setDragState({
              kind: "move-selection",
              originX: event.clientX,
              items: selectionItems,
            });
            return;
          }
          lastPointerClientXRef.current = event.clientX;
          setDragState({
            kind: "move-banyan-mark",
            id: mark.id,
            originX: event.clientX,
            originalTime: mark.time,
            estimatedTime: mark.estimatedTime,
          });
          onSelectItem({ type: "banyan-mark", id: mark.id });
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          if (performance.now() < suppressCanvasClickUntilRef.current) {
            return;
          }
          onUpdatePasteTarget("banyan-track", mark.time);
          handleTimelineSelectionClick(selectionItem, event);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          onUpdatePasteTarget("banyan-track", mark.time);
          const preserveSelection =
            selectedTimelineItems.length > 1 && selectedTimelineKeySet.has(selectionKey);
          if (!preserveSelection) {
            onSelectItem({ type: "banyan-mark", id: mark.id });
          }
          onOpenBanyanMarkContextMenu(mark.id, mark.time, event.clientX, event.clientY);
        }}
      >
        <span className="timeline-banyan-stem" />
        <span className="timeline-banyan-dot" />
        <span className="timeline-banyan-chip">{getBanyanMarkDisplayLabel(mark)}</span>
      </button>
    );
  }

  function renderGongcheBlock(annotation: GongcheAnnotation) {
    const parentBlock = findTimelineGongcheParentBlock(
      annotation.parentTrackId,
      annotation.parentBlockId,
      characterAnnotations,
      customBlocks,
    );
    if (!parentBlock) {
      return null;
    }
    const isSelected = selectedItem?.type === "gongche-block" && selectedItem.id === annotation.id;
    const isActive = currentTime >= annotation.startTime && currentTime <= annotation.endTime;
    const left = annotation.startTime * zoom;
    const width = Math.max((annotation.endTime - annotation.startTime) * zoom, 10);
    const displaySymbols = annotation.symbols.length > 0
      ? annotation.symbols
      : [{
          id: `${annotation.id}-empty`,
          label: "工",
          startTime: annotation.startTime,
          endTime: annotation.endTime,
          assetUrl: null,
        }];

    return (
      <button
        key={annotation.id}
        type="button"
        className={[
          "timeline-gongche-block",
          isSelected ? "selected" : "",
          isActive ? "active" : "",
        ].join(" ")}
        style={{ left, width }}
        title={`工尺谱：${displaySymbols.map((symbol) => symbol.label).join(" ")}`}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          if (event.metaKey || event.ctrlKey) {
            return;
          }
          lastPointerClientXRef.current = event.clientX;
          setDragState({
            kind: "move-gongche",
            id: annotation.id,
            parentTrackId: annotation.parentTrackId,
            parentBlockId: annotation.parentBlockId,
            originX: event.clientX,
            originalStart: annotation.startTime,
            originalEnd: annotation.endTime,
            parentStart: parentBlock.startTime,
            parentEnd: parentBlock.endTime,
            originalSymbols: annotation.symbols.map((symbol) => ({ ...symbol })),
          });
          onSelectItem({ type: "gongche-block", id: annotation.id });
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          if (performance.now() < suppressCanvasClickUntilRef.current) {
            return;
          }
          onUpdatePasteTarget(getGongcheTrackIdForParent(annotation.parentTrackId), annotation.startTime);
          onSelectItem({ type: "gongche-block", id: annotation.id });
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          onSelectItem({ type: "gongche-block", id: annotation.id });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          onUpdatePasteTarget(getGongcheTrackIdForParent(annotation.parentTrackId), annotation.startTime);
          onSelectItem({ type: "gongche-block", id: annotation.id });
          onOpenGongcheBlockContextMenu(annotation.id, annotation.startTime, event.clientX, event.clientY);
        }}
      >
        <span className="timeline-gongche-line" />
        <span className="timeline-gongche-symbols">
          {displaySymbols.map((symbol) => (
            <span
              key={symbol.id}
              className="timeline-gongche-symbol"
              style={{
                left: `${((symbol.startTime - annotation.startTime) / Math.max(annotation.endTime - annotation.startTime, 0.001)) * 100}%`,
                width: `${((symbol.endTime - symbol.startTime) / Math.max(annotation.endTime - annotation.startTime, 0.001)) * 100}%`,
              }}
            >
              {symbol.label}
            </span>
          ))}
        </span>
        {annotation.symbols.slice(0, -1).map((symbol, index) => {
          const position = ((symbol.endTime - annotation.startTime) /
            Math.max(annotation.endTime - annotation.startTime, 0.001)) * 100;
          return (
            <span
              key={`boundary-${symbol.id}`}
              className="timeline-gongche-boundary"
              style={{ left: `${position}%` }}
              title="拖动调整工尺符号分界"
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                onCloseContextMenu();
                lastPointerClientXRef.current = event.clientX;
                const previousSymbol = annotation.symbols[index - 1];
                const nextSymbol = annotation.symbols[index + 1];
                setDragState({
                  kind: "move-gongche-boundary",
                  id: annotation.id,
                  boundaryIndex: index,
                  originX: event.clientX,
                  originalBoundaryTime: symbol.endTime,
                  minTime: previousSymbol ? previousSymbol.endTime + MIN_GONGCHE_DURATION : annotation.startTime + MIN_GONGCHE_DURATION,
                  maxTime: nextSymbol ? nextSymbol.endTime - MIN_GONGCHE_DURATION : annotation.endTime - MIN_GONGCHE_DURATION,
                  originalSymbols: annotation.symbols.map((item) => ({ ...item })),
                });
                onSelectItem({ type: "gongche-block", id: annotation.id });
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelectItem({ type: "gongche-block", id: annotation.id });
              }}
            />
          );
        })}
      </button>
    );
  }

  function queueZoom(nextZoom: number, anchorTime?: number, viewportOffset?: number) {
    markSpectrogramZoomPreview();
    const container = scrollRef.current;
    if (!container) {
      const safeZoom = clampZoom(nextZoom);
      zoomRef.current = safeZoom;
      onZoomChange(safeZoom);
      return;
    }
    const safeZoom = clampZoom(nextZoom);
    const resolvedAnchorTime = anchorTime ?? currentTimeRef.current;
    const resolvedViewportOffset =
      viewportOffset ?? getViewportOffsetForTime(container, resolvedAnchorTime, zoomRef.current);
    pendingZoomRef.current = {
      nextZoom: safeZoom,
      anchorTime: resolvedAnchorTime,
      viewportOffset: resolvedViewportOffset,
    };
    zoomInteractionUntilRef.current = Date.now() + ZOOM_SETTLE_MS;
    if (zoomFrameRef.current !== null) {
      return;
    }
    zoomFrameRef.current = requestAnimationFrame(() => {
      zoomFrameRef.current = null;
      const pendingZoom = pendingZoomRef.current;
      if (!pendingZoom) {
        return;
      }
      pendingZoomRef.current = null;
      zoomAnchorRef.current = {
        time: pendingZoom.anchorTime,
        viewportOffset: pendingZoom.viewportOffset,
      };
      if (pendingZoom.nextZoom !== zoomRef.current) {
        zoomRef.current = pendingZoom.nextZoom;
        onZoomChange(pendingZoom.nextZoom);
      }
      zoomInteractionUntilRef.current = Date.now() + ZOOM_SETTLE_MS;
    });
  }

  function handleZoomStep(delta: number) {
    const nextZoom = clampZoom(Math.round((zoomRef.current + delta) / ZOOM_STEP) * ZOOM_STEP);
    queueZoom(nextZoom, currentTimeRef.current);
  }

  function handleZoomSliderChange(nextZoom: number) {
    const snappedZoom = clampZoom(Math.round(nextZoom / ZOOM_STEP) * ZOOM_STEP);
    const lockedAnchor = sliderZoomRef.current;
    queueZoom(
      snappedZoom,
      lockedAnchor?.anchorTime ?? currentTimeRef.current,
      lockedAnchor?.viewportOffset,
    );
  }

  function getEffectiveZoomViewportState(container: HTMLDivElement) {
    const pendingZoom = pendingZoomRef.current;
    if (!pendingZoom) {
      const scheduledAnchor = zoomAnchorRef.current;
      if (scheduledAnchor) {
        const nextTimelineWidth = Math.max(TRACK_LABEL_WIDTH + duration * zoomRef.current, 1200);
        const maxScrollLeft = Math.max(nextTimelineWidth - container.clientWidth, 0);
        return {
          zoom: zoomRef.current,
          scrollLeft: Math.max(
            0,
            Math.min(getCanvasX(scheduledAnchor.time, zoomRef.current) - scheduledAnchor.viewportOffset, maxScrollLeft),
          ),
        };
      }
      return {
        zoom: zoomRef.current,
        scrollLeft: container.scrollLeft,
      };
    }

    const nextTimelineWidth = Math.max(TRACK_LABEL_WIDTH + duration * pendingZoom.nextZoom, 1200);
    const maxScrollLeft = Math.max(nextTimelineWidth - container.clientWidth, 0);

    return {
      zoom: pendingZoom.nextZoom,
      scrollLeft: Math.max(
        0,
        Math.min(getCanvasX(pendingZoom.anchorTime, pendingZoom.nextZoom) - pendingZoom.viewportOffset, maxScrollLeft),
      ),
    };
  }

  function handleZoomAroundPointer(event: React.WheelEvent<HTMLDivElement>) {
    const container = event.currentTarget;
    const pointerOffset = event.clientX - container.getBoundingClientRect().left;
    const { zoom: effectiveZoom, scrollLeft: effectiveScrollLeft } = getEffectiveZoomViewportState(container);
    zoomInteractionUntilRef.current = Date.now() + ZOOM_SETTLE_MS;
    queueZoom(
      clampZoom(effectiveZoom * Math.exp(-event.deltaY * 0.0025)),
      getCanvasTimeFromViewportOffset(container, pointerOffset, effectiveZoom, effectiveScrollLeft),
      pointerOffset,
    );
  }

  function startSliderZoom() {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    markSpectrogramZoomPreview(Number.POSITIVE_INFINITY);
    sliderZoomRef.current = {
      anchorTime: currentTimeRef.current,
      viewportOffset: getViewportOffsetForTime(container, currentTimeRef.current, zoomRef.current),
    };
    zoomInteractionUntilRef.current = Number.POSITIVE_INFINITY;
  }

  function finishSliderZoom() {
    sliderZoomRef.current = null;
    zoomInteractionUntilRef.current = Date.now() + ZOOM_SETTLE_MS;
    markSpectrogramZoomPreview();
  }

  function scheduleDragUpdate(update: PendingDragUpdate) {
    // 拖动预览和松手提交必须共享同一个 resolved 结果。
    // 触摸板会让 pointerStepPx 波动，如果松手时重新计算，可能出现“预览吸附、提交脱开”。
    lastResolvedDragUpdateRef.current = update;
    pendingDragUpdateRef.current = update;
    if (dragFrameRef.current !== null) {
      return;
    }
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      flushPendingDragUpdate();
    });
  }

  function commitResolvedDragUpdate(update: PendingDragUpdate) {
    if (update.target === "line") {
      onLineCommit(update.id, update.changes as Pick<SubtitleLine, "startTime" | "endTime">);
      return;
    }
    if (update.target === "character") {
      onCharacterCommit(update.id, update.changes);
      return;
    }
    if (update.target === "attached-point") {
      onAttachedPointCommit(update.trackId, update.pointId, update.changes);
      return;
    }
    if (update.target === "banyan-mark") {
      onBanyanMarkCommit(update.id, update.changes);
      return;
    }
    if (update.target === "gongche") {
      onGongcheBlockCommit(update.id, update.changes);
      return;
    }
    if (update.target === "selection") {
      onBatchMoveCommit(update.items);
      return;
    }
    if (update.target === "custom-block") {
      onCustomBlockCommit(update.trackId, update.id, update.changes);
      return;
    }
    onActionCommit(update.id, update.changes);
  }

  function flushPendingDragUpdate() {
    const pendingDragUpdate = pendingDragUpdateRef.current;
    if (!pendingDragUpdate) {
      return;
    }
    pendingDragUpdateRef.current = null;
    if (pendingDragUpdate.target === "line") {
      onLineChange(pendingDragUpdate.id, pendingDragUpdate.changes);
      return;
    }
    if (pendingDragUpdate.target === "character") {
      onCharacterChange(pendingDragUpdate.id, pendingDragUpdate.changes);
      return;
    }
    if (pendingDragUpdate.target === "attached-point") {
      onAttachedPointChange(pendingDragUpdate.trackId, pendingDragUpdate.pointId, pendingDragUpdate.changes);
      return;
    }
    if (pendingDragUpdate.target === "banyan-mark") {
      onBanyanMarkChange(pendingDragUpdate.id, pendingDragUpdate.changes);
      return;
    }
    if (pendingDragUpdate.target === "gongche") {
      onGongcheBlockChange(pendingDragUpdate.id, pendingDragUpdate.changes);
      return;
    }
    if (pendingDragUpdate.target === "selection") {
      onBatchMoveChange(pendingDragUpdate.items);
      return;
    }
    if (pendingDragUpdate.target === "custom-block") {
      onCustomBlockChange(pendingDragUpdate.trackId, pendingDragUpdate.id, pendingDragUpdate.changes);
      return;
    }
    onActionChange(pendingDragUpdate.id, pendingDragUpdate.changes);
  }

  function toggleTimelineSelectionItem(item: TimelineSelectionItem) {
    const itemKey = getTimelineSelectionKey(
      item.type,
      item.id,
      getSelectionItemTrackId(item),
    );
    if (selectedTimelineKeySet.has(itemKey)) {
      return selectedTimelineItems.filter((selectedItem) =>
        getTimelineSelectionKey(
          selectedItem.type,
          selectedItem.id,
          getSelectionItemTrackId(selectedItem),
        ) !== itemKey
      );
    }
    return [...selectedTimelineItems, item];
  }

  function toSelectedItem(item: TimelineSelectionItem): SelectedItem {
    if (item.type === "custom-block") {
      return {
        type: "custom-block",
        id: item.id,
        trackId: item.trackId,
        branchLaneId: item.branchLaneId,
      };
    }
    if (item.type === "attached-point") {
      return {
        type: "attached-point",
        id: item.id,
        trackId: item.trackId,
        parentTrackId: item.parentTrackId,
      };
    }
    return { type: item.type, id: item.id };
  }

  function isSameTimelineSelectionItem(left: TimelineSelectionItem | null, right: TimelineSelectionItem | null) {
    if (!left || !right) {
      return false;
    }
    return getTimelineSelectionKey(left.type, left.id, getSelectionItemTrackId(left)) ===
      getTimelineSelectionKey(right.type, right.id, getSelectionItemTrackId(right));
  }

  function mergeTimelineSelectionItems(
    existingItems: TimelineSelectionItem[],
    incomingItems: TimelineSelectionItem[],
  ) {
    if (existingItems.length === 0) {
      return incomingItems;
    }
    if (incomingItems.length === 0) {
      return existingItems;
    }
    const targetKeySet = new Set(
      [...existingItems, ...incomingItems].map((item) =>
        getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item)),
      ),
    );
    const orderedItems = getSelectableTimelineItems().filter((item) =>
      targetKeySet.has(getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item))),
    );
    const orderedKeySet = new Set(
      orderedItems.map((item) => getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item))),
    );
    const staleItems = [...existingItems, ...incomingItems].filter((item) =>
      !orderedKeySet.has(getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item))),
    );
    return [...orderedItems, ...staleItems];
  }

  function handleTimelineSelectionClick(
    item: TimelineSelectionItem,
    event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) {
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const anchorItem = selectionAnchorRef.current ?? item;
      const rangeItems = getTimelineSelectionRange(anchorItem, item);
      const nextItems = additive
        ? mergeTimelineSelectionItems(selectedTimelineItems, rangeItems)
        : rangeItems;
      if (!selectionAnchorRef.current) {
        selectionAnchorRef.current = item;
      }
      onSelectTimelineItems(nextItems, toSelectedItem(item));
      return;
    }

    if (additive) {
      const nextItems = toggleTimelineSelectionItem(item);
      const itemIsSelected = nextItems.some((selectedItem) => isSameTimelineSelectionItem(selectedItem, item));
      if (itemIsSelected) {
        selectionAnchorRef.current = item;
      } else if (isSameTimelineSelectionItem(selectionAnchorRef.current, item)) {
        selectionAnchorRef.current = nextItems[nextItems.length - 1] ?? null;
      }
      const primaryItem = nextItems[nextItems.length - 1] ?? null;
      onSelectTimelineItems(nextItems, primaryItem ? toSelectedItem(primaryItem) : null);
      return;
    }

    selectionAnchorRef.current = item;
    onSelectItem(toSelectedItem(item));
  }

  function getItemsForSelectionDrag(
    selectionDragState: Extract<NonNullable<DragState>, { kind: "select-box" }>,
  ) {
    const rectItems = getItemsInSelectionRect(selectionDragState);
    const nextItems = selectionDragState.shiftKey
      ? getTimelineSelectionRangeFromSelectionDrag(rectItems, selectionDragState)
      : rectItems;
    return selectionDragState.additive
      ? mergeTimelineSelectionItems(selectedTimelineItems, nextItems)
      : nextItems;
  }

  function getTimelineSelectionRangeFromSelectionDrag(
    endpointItems: TimelineSelectionItem[],
    selectionDragState: Extract<NonNullable<DragState>, { kind: "select-box" }>,
  ) {
    if (endpointItems.length === 0) {
      return [];
    }
    const endpointLaneIds = new Set(endpointItems.map((item) => getSelectionItemLaneId(item)));
    const sortedEndpointItems = [...endpointItems].sort(compareTimelineSelectionItems);
    if (endpointLaneIds.size > 1) {
      const selectionRect = getContentSelectionRect(selectionDragState);
      const minLaneIndex = Math.min(...endpointItems.map((item) => getSelectionItemTrackSortIndex(item)));
      const maxLaneIndex = Math.max(...endpointItems.map((item) => getSelectionItemTrackSortIndex(item)));
      const minTime = Math.max(0, (selectionRect.left - TRACK_LABEL_WIDTH) / zoom);
      const maxTime = Math.max(minTime, (selectionRect.right - TRACK_LABEL_WIDTH) / zoom);
      return getMultiTrackSelectionRangeWithinBounds(minLaneIndex, maxLaneIndex, minTime, maxTime);
    }
    const anchorItem = sortedEndpointItems[0];
    const targetItem = sortedEndpointItems[sortedEndpointItems.length - 1];
    return getTimelineSelectionRange(anchorItem, targetItem);
  }

  function getTimelineSelectionRange(anchorItem: TimelineSelectionItem, targetItem: TimelineSelectionItem) {
    return getSelectionItemLaneId(anchorItem) === getSelectionItemLaneId(targetItem)
      ? getTrackLocalSelectionRange(anchorItem, targetItem)
      : getMultiTrackSelectionRange(anchorItem, targetItem);
  }

  function getTrackLocalSelectionRange(anchorItem: TimelineSelectionItem, targetItem: TimelineSelectionItem) {
    const laneId = getSelectionItemLaneId(anchorItem);
    const orderedItems = getSelectableTimelineItems().filter((item) => getSelectionItemLaneId(item) === laneId);
    const anchorKey = getTimelineSelectionKey(anchorItem.type, anchorItem.id, getSelectionItemTrackId(anchorItem));
    const targetKey = getTimelineSelectionKey(targetItem.type, targetItem.id, getSelectionItemTrackId(targetItem));
    const anchorIndex = orderedItems.findIndex((item) =>
      getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item)) === anchorKey,
    );
    const targetIndex = orderedItems.findIndex((item) =>
      getTimelineSelectionKey(item.type, item.id, getSelectionItemTrackId(item)) === targetKey,
    );
    if (anchorIndex < 0 || targetIndex < 0) {
      return [targetItem];
    }
    const startIndex = Math.min(anchorIndex, targetIndex);
    const endIndex = Math.max(anchorIndex, targetIndex);
    return orderedItems.slice(startIndex, endIndex + 1);
  }

  function getMultiTrackSelectionRange(anchorItem: TimelineSelectionItem, targetItem: TimelineSelectionItem) {
    return getMultiTrackSelectionRangeForItems([anchorItem, targetItem]);
  }

  function getMultiTrackSelectionRangeForItems(endpointItems: TimelineSelectionItem[]) {
    const laneIndexes = endpointItems.map((item) => getSelectionItemTrackSortIndex(item));
    const timeRanges = endpointItems.map((item) => getSelectionItemTimeRange(item));
    const minLaneIndex = Math.min(...laneIndexes);
    const maxLaneIndex = Math.max(...laneIndexes);
    const minTime = Math.min(...timeRanges.map((range) => range.start));
    const maxTime = Math.max(...timeRanges.map((range) => range.end));
    return getMultiTrackSelectionRangeWithinBounds(minLaneIndex, maxLaneIndex, minTime, maxTime);
  }

  function getMultiTrackSelectionRangeWithinBounds(
    minLaneIndex: number,
    maxLaneIndex: number,
    minTime: number,
    maxTime: number,
  ) {
    return getSelectableTimelineItems().filter((item) => {
      const laneIndex = getSelectionItemTrackSortIndex(item);
      const timeRange = getSelectionItemTimeRange(item);
      return laneIndex >= minLaneIndex &&
        laneIndex <= maxLaneIndex &&
        timeRange.end >= minTime &&
        timeRange.start <= maxTime;
    });
  }

  function getSelectableTimelineItems() {
    const items: TimelineSelectionItem[] = [
      ...characterAnnotations.map((annotation) => ({
        type: "character" as const,
        id: annotation.id,
      })),
      ...actionAnnotations.map((annotation) => ({
        type: "action" as const,
        id: annotation.id,
      })),
      ...customBlocks.map((annotation) => ({
        type: "custom-block" as const,
        id: annotation.id,
        trackId: annotation.trackId,
      })),
      ...attachedPointTracks.flatMap((track) =>
        track.points.map((point) => ({
          type: "attached-point" as const,
          id: point.id,
          trackId: track.id,
          parentTrackId: track.parentTrackId,
        })),
      ),
      ...banyanMarks.map((mark) => ({
        type: "banyan-mark" as const,
        id: mark.id,
      })),
    ];
    return items.sort(compareTimelineSelectionItems);
  }

  function getItemsInSelectionRect(
    selectionDragState: Extract<NonNullable<DragState>, { kind: "select-box" }>,
  ) {
    const container = scrollRef.current;
    const selectionRect = container ? getContentSelectionRect(selectionDragState) : null;
    if (!selectionRect || !container) {
      return [];
    }
    const containerBounds = container.getBoundingClientRect();

    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".timeline-block[data-block-id][data-block-type], .timeline-point-marker[data-point-id][data-point-track-id], .timeline-banyan-mark[data-banyan-mark-id]",
      ),
    );

    return candidates
      .flatMap((element) => {
        const bounds = element.getBoundingClientRect();
        const contentBounds = {
          left: bounds.left - containerBounds.left + container.scrollLeft,
          right: bounds.right - containerBounds.left + container.scrollLeft,
          top: bounds.top - containerBounds.top + container.scrollTop,
          bottom: bounds.bottom - containerBounds.top + container.scrollTop,
        };
        if (!rectsIntersect(selectionRect, contentBounds)) {
          return [];
        }
        if (element.classList.contains("timeline-point-marker")) {
          const id = element.dataset.pointId;
          const trackId = element.dataset.pointTrackId;
          const parentTrackId = element.dataset.pointParentTrackId;
          if (!id || !trackId || !parentTrackId) {
            return [];
          }
          return [{
            id,
            type: "attached-point" as const,
            trackId,
            parentTrackId,
          }];
        }
        if (element.classList.contains("timeline-banyan-mark")) {
          const id = element.dataset.banyanMarkId;
          return id
            ? [{
                id,
                type: "banyan-mark" as const,
              }]
            : [];
        }
        const id = element.dataset.blockId;
        const type = element.dataset.blockType;
        const trackId = element.dataset.blockTrackId;
        const visualTrackId = element.dataset.blockVisualTrackId;
        const branchLaneId = visualTrackId
          ? trackDefinitionMap.get(visualTrackId)?.branchLaneId
          : undefined;
        if (!id || (type !== "character" && type !== "action" && type !== "custom-block")) {
          return [];
        }
        return [
          type === "custom-block"
            ? { id, type, trackId: trackId ?? "", branchLaneId }
            : { id, type },
        ] as TimelineSelectionItem[];
      })
      .sort(compareTimelineSelectionItems);
  }

  function getSelectionItemStartTime(item: TimelineSelectionItem) {
    if (item.type === "attached-point") {
      return attachedPointTrackMap.get(item.trackId)?.points.find((point) => point.id === item.id)?.time ?? 0;
    }
    if (item.type === "banyan-mark") {
      return banyanMarks.find((mark) => mark.id === item.id)?.time ?? 0;
    }
    return findAnnotationById(
      item.id,
      item.type,
      characterAnnotations,
      actionAnnotations,
      customBlocks,
      item.type === "custom-block" ? item.trackId : undefined,
    )?.startTime ?? 0;
  }

  function getSelectionItemEndTime(item: TimelineSelectionItem) {
    if (item.type === "attached-point") {
      return attachedPointTrackMap.get(item.trackId)?.points.find((point) => point.id === item.id)?.time ?? 0;
    }
    if (item.type === "banyan-mark") {
      return banyanMarks.find((mark) => mark.id === item.id)?.time ?? 0;
    }
    return findAnnotationById(
      item.id,
      item.type,
      characterAnnotations,
      actionAnnotations,
      customBlocks,
      item.type === "custom-block" ? item.trackId : undefined,
    )?.endTime ?? getSelectionItemStartTime(item);
  }

  function getSelectionItemTimeRange(item: TimelineSelectionItem) {
    return {
      start: getSelectionItemStartTime(item),
      end: getSelectionItemEndTime(item),
    };
  }

  function getSelectionItemLaneId(item: TimelineSelectionItem) {
    if (item.type === "character") {
      return "character-track";
    }
    if (item.type === "banyan-mark") {
      return "banyan-track";
    }
    if (item.type === "attached-point" || item.type === "custom-block") {
      return item.trackId;
    }
    return actionAnnotations.find((annotation) => annotation.id === item.id)?.trackId ?? "unknown-action-track";
  }

  function getSelectionItemTrackSortIndex(item: TimelineSelectionItem) {
    if (item.type === "character") {
      return timelineTrackOrderMap.get("character-track") ?? 0;
    }
    if (item.type === "banyan-mark") {
      return -1;
    }
    if (item.type === "attached-point") {
      return timelineTrackOrderMap.get(item.trackId) ??
        timelineTrackOrderMap.get(item.parentTrackId) ??
        activeTrackOrderMap.get(item.parentTrackId) ??
        Number.MAX_SAFE_INTEGER;
    }
    if (item.type === "custom-block") {
      return timelineTrackOrderMap.get(item.trackId) ??
        activeTrackOrderMap.get(item.trackId) ??
        Number.MAX_SAFE_INTEGER;
    }
    const actionTrackId = actionAnnotations.find((annotation) => annotation.id === item.id)?.trackId;
    return actionTrackId
      ? timelineTrackOrderMap.get(actionTrackId) ?? activeTrackOrderMap.get(actionTrackId) ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
  }

  function compareTimelineSelectionItems(left: TimelineSelectionItem, right: TimelineSelectionItem) {
    const leftStartTime = getSelectionItemStartTime(left);
    const rightStartTime = getSelectionItemStartTime(right);
    const leftEndTime = getSelectionItemEndTime(left);
    const rightEndTime = getSelectionItemEndTime(right);
    const leftTrackIndex = getSelectionItemTrackSortIndex(left);
    const rightTrackIndex = getSelectionItemTrackSortIndex(right);
    return leftStartTime - rightStartTime ||
      leftEndTime - rightEndTime ||
      leftTrackIndex - rightTrackIndex ||
      getTimelineSelectionKey(left.type, left.id, getSelectionItemTrackId(left)).localeCompare(
        getTimelineSelectionKey(right.type, right.id, getSelectionItemTrackId(right)),
      );
  }

  function resolveLiveBatchMoveItem(
    item: TimelineSelectionItem,
    liveProject: ProjectData,
  ): TimelineBatchMoveItem | null {
    if (item.type === "attached-point") {
      const livePointTrack = findResolvedAttachedPointTrack(liveProject, item.trackId);
      const livePoint = livePointTrack?.points.find((candidate) => candidate.id === item.id);
      return livePoint
        ? {
            type: "attached-point",
            id: item.id,
            trackId: item.trackId,
            parentTrackId: item.parentTrackId,
            startTime: livePoint.time,
            endTime: livePoint.time,
          }
        : null;
    }
    if (item.type === "banyan-mark") {
      const liveMark = liveProject.banyanMarks.find((candidate) => candidate.id === item.id);
      return liveMark
        ? {
            type: "banyan-mark",
            id: item.id,
            startTime: liveMark.time,
            endTime: liveMark.time,
          }
        : null;
    }
    const liveSelectionAnnotation = findAnnotationById(
      item.id,
      item.type,
      liveProject.characterAnnotations,
      liveProject.actionAnnotations,
      flattenCustomBlocks(liveProject.customTracks),
      item.type === "custom-block" ? item.trackId : undefined,
    );
    if (!liveSelectionAnnotation) {
      return null;
    }
    if (item.type === "custom-block") {
      return {
        type: "custom-block",
        id: item.id,
        trackId: item.trackId,
        startTime: liveSelectionAnnotation.startTime,
        endTime: liveSelectionAnnotation.endTime,
      };
    }
    return {
      type: item.type,
      id: item.id,
      startTime: liveSelectionAnnotation.startTime,
      endTime: liveSelectionAnnotation.endTime,
    };
  }

  function queuePreviewFrame(time: number | null) {
    const normalizedTime = time === null ? null : Math.max(0, time);
    const currentPreviewTime = previewTimeRef.current;
    if (
      normalizedTime === currentPreviewTime ||
      (normalizedTime !== null &&
        currentPreviewTime !== null &&
        Math.abs(normalizedTime - currentPreviewTime) < PREVIEW_UPDATE_EPSILON)
    ) {
      return;
    }
    pendingPreviewTimeRef.current = normalizedTime;
    setPreviewGuideTime(normalizedTime);
    if (previewFrameRef.current !== null) {
      return;
    }
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = null;
      const nextPreviewTime = pendingPreviewTimeRef.current;
      pendingPreviewTimeRef.current = null;
      if (
        nextPreviewTime === previewTimeRef.current ||
        (nextPreviewTime !== null &&
          previewTimeRef.current !== null &&
          Math.abs(nextPreviewTime - previewTimeRef.current) < PREVIEW_UPDATE_EPSILON)
      ) {
        return;
      }
      previewTimeRef.current = nextPreviewTime;
      setPreviewGuideTime(nextPreviewTime);
      onPreviewFrame(nextPreviewTime);
    });
  }

  function clearPreviewFrame() {
    pendingPreviewTimeRef.current = null;
    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    if (previewTimeRef.current !== null) {
      previewTimeRef.current = null;
      setPreviewGuideTime(null);
      onPreviewFrame(null);
    }
    setPreviewGuideTime(null);
  }

  function updatePreviewFrame(
    kind: Exclude<NonNullable<DragState>, { kind: "create-track-item" }>["kind"],
    range: { startTime: number; endTime: number },
  ) {
    if (String(kind).includes("resize-left")) {
      queuePreviewFrame(range.startTime);
      return;
    }
    if (String(kind).includes("resize-right")) {
      queuePreviewFrame(range.endTime);
      return;
    }
    clearPreviewFrame();
  }

  function getRulerScrubTime(clientX: number) {
    const container = scrollRef.current;
    if (!container) {
      return currentTimeRef.current;
    }
    const bounds = container.getBoundingClientRect();
    return getCanvasTimeFromViewportOffset(
      container,
      Math.max(0, Math.min(clientX - bounds.left, container.clientWidth)),
      zoomRef.current,
    );
  }

  function getLoopRangeFromClientXs(startClientX: number, endClientX: number) {
    const startTime = getRulerScrubTime(startClientX);
    const endTime = getRulerScrubTime(endClientX);
    return {
      start: Math.max(0, Math.min(startTime, endTime)),
      end: Math.min(duration, Math.max(startTime, endTime)),
    };
  }

  function getLoopRangeDeltaSeconds(originClientX: number, currentClientX: number) {
    return getRulerScrubTime(currentClientX) - getRulerScrubTime(originClientX);
  }

  function getMovedLoopRange(
    originalRange: { start: number; end: number },
    originClientX: number,
    currentClientX: number,
  ) {
    const deltaSeconds = getLoopRangeDeltaSeconds(originClientX, currentClientX);
    const rangeDuration = originalRange.end - originalRange.start;
    const maxStart = Math.max(0, duration - rangeDuration);
    const nextStart = Math.max(0, Math.min(originalRange.start + deltaSeconds, maxStart));
    return {
      start: nextStart,
      end: Math.min(duration, nextStart + rangeDuration),
    };
  }

  function getResizedLoopRange(
    originalRange: { start: number; end: number },
    mode: "resize-start" | "resize-end",
    currentClientX: number,
  ) {
    const pointerTime = getRulerScrubTime(currentClientX);
    if (mode === "resize-start") {
      return {
        start: Math.max(0, Math.min(pointerTime, originalRange.end - LOOP_RANGE_MIN_DURATION)),
        end: originalRange.end,
      };
    }
    return {
      start: originalRange.start,
      end: Math.min(duration, Math.max(pointerTime, originalRange.start + LOOP_RANGE_MIN_DURATION)),
    };
  }

  function flushPendingRulerSeek() {
    if (pendingRulerSeekTimeRef.current === null) {
      return;
    }
    const nextTime = pendingRulerSeekTimeRef.current;
    pendingRulerSeekTimeRef.current = null;
    onSeek(nextTime);
  }

  function queueRulerSeek(time: number) {
    pendingRulerSeekTimeRef.current = time;
    if (rulerSeekFrameRef.current !== null) {
      return;
    }
    rulerSeekFrameRef.current = requestAnimationFrame(() => {
      rulerSeekFrameRef.current = null;
      flushPendingRulerSeek();
    });
  }
}

function getEdgeHitSlop(element: HTMLElement) {
  return element.classList.contains("selected")
    ? SELECTED_EDGE_HIT_SLOP_PX
    : EDGE_HIT_SLOP_PX;
}

function getLinkedEdgeHitSlop(element: HTMLElement) {
  const edgeHitSlop = getEdgeHitSlop(element);
  return Math.max(
    MIN_LINKED_EDGE_HIT_SLOP_PX,
    Math.min(edgeHitSlop - 1, Math.round(edgeHitSlop * LINKED_EDGE_HIT_RATIO)),
  );
}

function getPhysicalEdge(edge: EdgeHit): "left" | "right" | "center" {
  if (edge === "linked-left") {
    return "left";
  }
  if (edge === "linked-right") {
    return "right";
  }
  return edge;
}

function isLinkedEdgeHit(edge: EdgeHit) {
  return edge === "linked-left" || edge === "linked-right";
}

function resolveEdgeForElement(
  element: HTMLElement,
  clientX: number,
  annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
  type: "character" | "action" | "custom-block",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
  trackSnapEnabled: Record<string, boolean>,
  zoom: number,
  visualTrackId?: string,
  linkedBoundaryCandidates?: Array<CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock>,
): EdgeHit {
  const rect = element.getBoundingClientRect();
  const offset = clientX - rect.left;
  const edgeHitSlop = getEdgeHitSlop(element);
  const linkedEdgeHitSlop = getLinkedEdgeHitSlop(element);
  const rightOffset = rect.width - offset;

  if (offset < edgeHitSlop) {
    const boundaryGroup = findBoundaryGroupForEdge(
      annotation,
      type,
      "left",
      characterAnnotations,
      actionAnnotations,
      customBlocks,
      trackSnapEnabled,
      zoom,
      visualTrackId,
      linkedBoundaryCandidates,
    );
    if (boundaryGroup && offset <= linkedEdgeHitSlop) {
      return "linked-left";
    }
    return "left";
  }
  if (rightOffset < edgeHitSlop) {
    const boundaryGroup = findBoundaryGroupForEdge(
      annotation,
      type,
      "right",
      characterAnnotations,
      actionAnnotations,
      customBlocks,
      trackSnapEnabled,
      zoom,
      visualTrackId,
      linkedBoundaryCandidates,
    );
    if (boundaryGroup && rightOffset <= linkedEdgeHitSlop) {
      return "linked-right";
    }
    return "right";
  }
  return "center";
}

function resolvePreferredBlockHit(
  clientX: number,
  clientY: number,
  fallbackId: string,
  fallbackType: "character" | "action" | "custom-block",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
  selectedItem: SelectedItem,
  trackSnapEnabled: Record<string, boolean>,
  zoom: number,
  fallbackTrackId?: string,
  fallbackVisualTrackId?: string,
  fallbackBoundaryBlocks?: Array<CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock>,
): HoveredBlockState {
  if (typeof document === "undefined") {
    return fallbackType === "custom-block"
      ? { id: fallbackId, type: fallbackType, trackId: fallbackTrackId ?? "", edge: "center" }
      : { id: fallbackId, type: fallbackType, edge: "center" };
  }
  const elements = document.elementsFromPoint(clientX, clientY);
  const candidates = elements
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element.classList.contains("timeline-block"))
    .map((element, stackIndex) => {
      const id = element.dataset.blockId;
      const type = element.dataset.blockType as "character" | "action" | "custom-block" | undefined;
      const trackId = element.dataset.blockTrackId;
      const visualTrackId = element.dataset.blockVisualTrackId ?? fallbackVisualTrackId;
      if (!id || !type) {
        return null;
      }
      const annotation = findAnnotationById(
        id,
        type,
        characterAnnotations,
        actionAnnotations,
        customBlocks,
        type === "custom-block" ? trackId : undefined,
      );
      if (!annotation) {
        return null;
      }
      const edge = resolveEdgeForElement(
        element,
        clientX,
        annotation,
        type,
        characterAnnotations,
        actionAnnotations,
        customBlocks,
        trackSnapEnabled,
        zoom,
        visualTrackId,
        visualTrackId === fallbackVisualTrackId ? fallbackBoundaryBlocks : undefined,
      );
      const rect = element.getBoundingClientRect();
      const physicalEdge = getPhysicalEdge(edge);
      const distanceToEdge = physicalEdge === "left"
        ? Math.abs(clientX - rect.left)
        : physicalEdge === "right"
          ? Math.abs(rect.right - clientX)
          : Math.min(Math.abs(clientX - rect.left), Math.abs(rect.right - clientX));
      const isSelected = type === "custom-block"
        ? selectedItem?.type === "custom-block" &&
          selectedItem.id === id &&
          selectedItem.trackId === trackId
        : selectedItem?.type === type && selectedItem.id === id;
      const edgePriority = edge === "center"
        ? 0
        : isLinkedEdgeHit(edge)
          ? 1200 - distanceToEdge
          : 900 - distanceToEdge;
      const selectedPriority = isSelected ? 200 : 0;
      const stackPriority = Math.max(0, 50 - stackIndex);
      return {
        id,
        type,
        ...(type === "custom-block" ? { trackId: trackId ?? "" } : {}),
        edge,
        score: edgePriority + selectedPriority + stackPriority,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  if (candidates.length === 0) {
    return buildHoveredBlockState(fallbackId, fallbackType, "center", fallbackTrackId);
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  return buildHoveredBlockState(
    best.id,
    best.type,
    best.edge,
    "trackId" in best ? best.trackId : undefined,
  );
}

function findBoundaryGroupForEdge(
  annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
  type: "character" | "action" | "custom-block",
  edge: "left" | "right",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
  trackSnapEnabled: Record<string, boolean>,
  zoom: number,
  visualTrackId?: string,
  linkedBoundaryCandidates?: Array<CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock>,
) {
  const trackId = getTrackIdForAnnotation(annotation, type);
  if (!trackSnapEnabled[trackId]) {
    return null;
  }
  return findBoundaryGroup(
    annotation,
    type,
    edge,
    characterAnnotations,
    actionAnnotations,
    customBlocks,
    zoom,
    visualTrackId,
    linkedBoundaryCandidates,
  );
}

function findAnnotationById(
  id: string,
  type: "character" | "action" | "custom-block",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
  trackId?: string,
) {
  if (type === "character") {
    return characterAnnotations.find((annotation) => annotation.id === id);
  }
  if (type === "action") {
    return actionAnnotations.find((annotation) => annotation.id === id);
  }
  return customBlocks.find((annotation) =>
    annotation.id === id && (trackId === undefined || annotation.trackId === trackId),
  );
}

function findBoundaryGroup(
  annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
  type: "character" | "action" | "custom-block",
  edge: "left" | "right",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
  zoom: number,
  _visualTrackId?: string,
  linkedBoundaryCandidates?: Array<CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock>,
) {
  const boundaryTime = edge === "right" ? annotation.endTime : annotation.startTime;
  const tolerance = getSnapToleranceSeconds(zoom);
  // 吸附参考点和联合编辑范围是两套规则：吸附点可以来自父轨/同级轨，
  // 但这里只在 linkedBoundaryCandidates 指定的候选集合内形成“会一起被修改”的边界组。
  const candidates = linkedBoundaryCandidates ?? getDefaultLinkedBoundaryCandidates(
    annotation,
    type,
    characterAnnotations,
    actionAnnotations,
    customBlocks,
  );
  const members = collectLinkedBoundaryGroupMembers(candidates, type, boundaryTime, tolerance);
  const currentMemberEdge = edge === "right" ? "end" : "start";
  const containsCurrentBoundary = members.some((member) =>
    member.item.id === annotation.id &&
    member.item.type === type &&
    member.edge === currentMemberEdge
  );
  if (!containsCurrentBoundary || members.length < 2) {
    return null;
  }
  return {
    time: boundaryTime,
    members,
  };
}

function getDefaultLinkedBoundaryCandidates(
  annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
  type: "character" | "action" | "custom-block",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
) {
  if (type === "character") {
    return characterAnnotations;
  }
  if (type === "custom-block") {
    return customBlocks.filter((item) => item.trackId === (annotation as ResolvedCustomTrackBlock).trackId);
  }
  return actionAnnotations.filter((item) => item.trackId === (annotation as ActionAnnotation).trackId);
}

function collectLinkedBoundaryGroupMembers(
  candidates: Array<CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock>,
  type: "character" | "action" | "custom-block",
  boundaryTime: number,
  tolerance: number,
) {
  const members: BoundaryGroupMember[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const item = toBatchMoveItem(candidate, type);
    const trackId = getSelectionItemTrackId(item);
    const startKey = `${item.type}:${item.id}:${trackId}:start`;
    if (Math.abs(candidate.startTime - boundaryTime) <= tolerance && !seen.has(startKey)) {
      seen.add(startKey);
      members.push({ item, edge: "start" });
    }
    const endKey = `${item.type}:${item.id}:${trackId}:end`;
    if (Math.abs(candidate.endTime - boundaryTime) <= tolerance && !seen.has(endKey)) {
      seen.add(endKey);
      members.push({ item, edge: "end" });
    }
  }
  return members;
}

function computeLinkedResizeRange(
  dragState: Extract<NonNullable<DragState>, { kind: "resize-linked" }>,
  deltaSeconds: number,
  zoom: number,
  snapPoints: number[],
  shouldSnap: boolean,
  pointerStepPx = 0,
  snapLock: DragSnapLock = null,
) {
  const minDuration = Math.max(0.04, MIN_BLOCK_WIDTH_PX / Math.max(zoom, 1));
  const rawBoundary = dragState.boundaryTime + deltaSeconds;
  // 一个边界组可能包含多个 end 和多个 start；新边界必须同时满足所有成员的最小块宽。
  const minBoundary = Math.max(
    0,
    ...dragState.members
      .filter((member) => member.edge === "end")
      .map((member) => member.item.startTime + minDuration),
  );
  const maxBoundary = Math.min(
    Number.POSITIVE_INFINITY,
    ...dragState.members
      .filter((member) => member.edge === "start")
      .map((member) => member.item.endTime - minDuration),
  );
  const clampedBoundary = Math.max(minBoundary, Math.min(maxBoundary, rawBoundary));
  const resolvedBoundary = shouldSnap
    ? resolveSnappedEdgeTime(
        clampedBoundary,
        "right",
        snapPoints,
        zoom,
        pointerStepPx,
        snapLock,
      )
    : { time: clampedBoundary, snappedTo: null };
  const snappedBoundary = Math.max(
    minBoundary,
    Math.min(maxBoundary, resolvedBoundary.time),
  );
  return {
    items: dragState.members.map((member) => ({
      ...member.item,
      ...(member.edge === "start"
        ? { startTime: snappedBoundary }
        : { endTime: snappedBoundary }),
    })),
    boundaryTime: snappedBoundary,
    snappedTo:
      resolvedBoundary.snappedTo &&
      isWithinSnapVisualTolerance(
        snappedBoundary,
        resolvedBoundary.snappedTo.time,
        zoom,
      )
        ? resolvedBoundary.snappedTo
        : null,
  };
}

function toBatchMoveItem(
  annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
  type: "character" | "action" | "custom-block",
): TimelineBatchMoveItem {
  return type === "custom-block"
    ? {
        type,
        id: annotation.id,
        trackId: (annotation as ResolvedCustomTrackBlock).trackId,
        startTime: annotation.startTime,
        endTime: annotation.endTime,
      }
    : {
        type,
        id: annotation.id,
        startTime: annotation.startTime,
        endTime: annotation.endTime,
      };
}

function toTimelineSelectionItem(
  item: TimelineSelectionItem | TimelineBatchMoveItem,
): TimelineSelectionItem {
  return item.type === "custom-block"
    ? { type: "custom-block", id: item.id, trackId: item.trackId }
    : item.type === "attached-point"
      ? { type: "attached-point", id: item.id, trackId: item.trackId, parentTrackId: item.parentTrackId }
    : { type: item.type, id: item.id };
}

function snapTime(
  time: number,
  snapPoints: number[],
  zoom: number,
  pointerStepPx = 0,
  snapLock: DragSnapLock = null,
  edge: "left" | "right" = "left",
) {
  return getEdgeSnapCandidate(time, edge, snapPoints, zoom, pointerStepPx, snapLock)?.point ?? time;
}

function resolveSnappedEdgeTime(
  time: number,
  edge: "left" | "right",
  snapPoints: number[],
  zoom: number,
  pointerStepPx = 0,
  snapLock: DragSnapLock = null,
) {
  const candidate = getEdgeSnapCandidate(
    time,
    edge,
    snapPoints,
    zoom,
    pointerStepPx,
    snapLock,
  );
  return {
    time: candidate?.point ?? time,
    snappedTo: candidate
      ? { time: candidate.point, edge }
      : null,
  };
}

function computeNextRange(
  originalStart: number,
  originalEnd: number,
  deltaSeconds: number,
  pointerStepPx: number,
  kind: DragState extends infer T ? T extends { kind: infer K } ? K : never : never,
  snapPoints: number[],
  zoom: number,
  shouldSnap = true,
  snapLock: DragSnapLock = null,
) {
  const minDuration = Math.max(0.04, MIN_BLOCK_WIDTH_PX / Math.max(zoom, 1));
  if (String(kind).startsWith("move")) {
    const duration = originalEnd - originalStart;
    const rawStart = Math.max(0, originalStart + deltaSeconds);
    const rawEnd = rawStart + duration;
    if (!shouldSnap) {
      return { startTime: rawStart, endTime: rawEnd, snappedTo: null };
    }
    const leftSnap = getEdgeSnapCandidate(rawStart, "left", snapPoints, zoom, pointerStepPx, snapLock);
    const rightSnap = getEdgeSnapCandidate(rawEnd, "right", snapPoints, zoom, pointerStepPx, snapLock);
    const snapCandidates = getOrderedSnapCandidates(leftSnap, rightSnap);
    if (snapCandidates.length === 0) {
      return { startTime: rawStart, endTime: rawEnd, snappedTo: null };
    }
    for (const snapCandidate of snapCandidates) {
      if (snapCandidate.edge === "left") {
        return {
          startTime: snapCandidate.point,
          endTime: snapCandidate.point + duration,
          snappedTo: { time: snapCandidate.point, edge: "left" as const },
        };
      }
      if (snapCandidate.point - duration < 0) {
        continue;
      }
      return {
        startTime: snapCandidate.point - duration,
        endTime: snapCandidate.point,
        snappedTo: { time: snapCandidate.point, edge: "right" as const },
      };
    }
    return { startTime: rawStart, endTime: rawEnd, snappedTo: null };
  }
  if (String(kind).includes("resize-left")) {
    const rawStart = Math.max(0, originalStart + deltaSeconds);
    const snappedStart = shouldSnap
      ? resolveSnappedEdgeTime(rawStart, "left", snapPoints, zoom, pointerStepPx, snapLock)
      : { time: rawStart, snappedTo: null };
    const { startTime, endTime } = clampRange(
      snappedStart.time,
      originalEnd,
      minDuration,
    );
    return {
      startTime,
      endTime,
      snappedTo:
        snappedStart.snappedTo &&
        isWithinSnapVisualTolerance(
          startTime,
          snappedStart.snappedTo.time,
          zoom,
        )
          ? snappedStart.snappedTo
          : null,
    };
  }
  const rawEnd = Math.max(originalStart + minDuration, originalEnd + deltaSeconds);
  const snappedEnd = shouldSnap
    ? resolveSnappedEdgeTime(rawEnd, "right", snapPoints, zoom, pointerStepPx, snapLock)
    : { time: rawEnd, snappedTo: null };
  const { startTime, endTime } = clampRange(
    originalStart,
    snappedEnd.time,
    minDuration,
  );
  return {
    startTime,
    endTime,
    snappedTo:
      snappedEnd.snappedTo &&
      isWithinSnapVisualTolerance(
        endTime,
        snappedEnd.snappedTo.time,
        zoom,
      )
        ? snappedEnd.snappedTo
        : null,
  };
}

function isWithinSnapVisualTolerance(leftTime: number, rightTime: number, zoom: number) {
  return Math.abs(leftTime - rightTime) * Math.max(zoom, 1) <= SNAP_VISUAL_MATCH_PX;
}

function findNearestSnapPoint(time: number, snapPoints: number[], zoom: number, pointerStepPx: number) {
  let best: { point: number; distance: number } | null = null;
  const snapToleranceSeconds = getSnapToleranceSeconds(zoom, pointerStepPx);
  for (const point of snapPoints) {
    const distance = Math.abs(point - time);
    if (distance > snapToleranceSeconds) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { point, distance };
    }
  }
  return best;
}

function getSnapToleranceSeconds(zoom: number, pointerStepPx = 0) {
  return getEffectiveSnapDistancePx(pointerStepPx) / Math.max(zoom, 1);
}

function getSnapReleaseToleranceSeconds(zoom: number, pointerStepPx = 0) {
  return Math.max(SNAP_RELEASE_DISTANCE_PX, getEffectiveSnapDistancePx(pointerStepPx)) / Math.max(zoom, 1);
}

function getEffectiveSnapDistancePx(pointerStepPx: number) {
  return Math.max(SNAP_DISTANCE_PX, Math.min(pointerStepPx, SNAP_RELEASE_DISTANCE_PX));
}

function toDragSnapLock(
  snappedTo: { time: number; edge: "left" | "right" } | null,
): DragSnapLock {
  return snappedTo ? { point: snappedTo.time, edge: snappedTo.edge } : null;
}

function getEdgeSnapCandidate<T extends "left" | "right">(
  time: number,
  edge: T,
  snapPoints: number[],
  zoom: number,
  pointerStepPx: number,
  snapLock: DragSnapLock,
) {
  if (
    snapLock &&
    snapLock.edge === edge &&
    Math.abs(time - snapLock.point) <= getSnapReleaseToleranceSeconds(zoom, pointerStepPx)
  ) {
    return {
      point: snapLock.point,
      distance: Math.abs(time - snapLock.point),
      edge,
      locked: true as const,
    };
  }

  const nearestSnap = findNearestSnapPoint(time, snapPoints, zoom, pointerStepPx);
  if (!nearestSnap) {
    return null;
  }

  return {
    ...nearestSnap,
    edge,
    locked: false as const,
  };
}

function getOrderedSnapCandidates(
  leftSnap: { point: number; distance: number; edge: "left"; locked: boolean } | null,
  rightSnap: { point: number; distance: number; edge: "right"; locked: boolean } | null,
) {
  if (leftSnap && rightSnap) {
    if (leftSnap.locked !== rightSnap.locked) {
      return leftSnap.locked ? [leftSnap, rightSnap] : [rightSnap, leftSnap];
    }
    return leftSnap.distance <= rightSnap.distance
      ? [leftSnap, rightSnap]
      : [rightSnap, leftSnap];
  }
  if (leftSnap) {
    return [leftSnap];
  }
  if (rightSnap) {
    return [rightSnap];
  }
  return [];
}

function isCharacterDrag(
  dragState: Exclude<DragState, null>,
): dragState is Extract<
  NonNullable<DragState>,
  { kind: "move-character" | "resize-left-character" | "resize-right-character" }
> {
  return dragState.kind.includes("character");
}

function isLineDrag(
  dragState: Exclude<DragState, null>,
): dragState is Extract<
  NonNullable<DragState>,
  { kind: "move-line" }
> {
  return dragState.kind === "move-line";
}

function isActionDrag(
  dragState: Exclude<DragState, null>,
): dragState is Extract<
  NonNullable<DragState>,
  { kind: "move-action" | "resize-left-action" | "resize-right-action" }
> {
  return dragState.kind.includes("action") && dragState.kind !== "create-track-item";
}

function computeMovedGongcheBlock(
  dragState: Extract<NonNullable<DragState>, { kind: "move-gongche" }>,
  deltaSeconds: number,
): Partial<Pick<GongcheAnnotation, "startTime" | "endTime" | "symbols">> {
  const duration = Math.max(dragState.originalEnd - dragState.originalStart, MIN_GONGCHE_DURATION);
  const minStart = dragState.parentStart;
  const maxStart = Math.max(dragState.parentStart, dragState.parentEnd - duration);
  const nextStart = clampValue(dragState.originalStart + deltaSeconds, minStart, maxStart);
  const appliedDelta = nextStart - dragState.originalStart;
  return {
    startTime: nextStart,
    endTime: nextStart + duration,
    symbols: dragState.originalSymbols.map((symbol) => ({
      ...symbol,
      startTime: symbol.startTime + appliedDelta,
      endTime: symbol.endTime + appliedDelta,
    })),
  };
}

function computeMovedGongcheBoundary(
  dragState: Extract<NonNullable<DragState>, { kind: "move-gongche-boundary" }>,
  deltaSeconds: number,
): Partial<Pick<GongcheAnnotation, "symbols">> {
  const nextBoundaryTime = clampValue(
    dragState.originalBoundaryTime + deltaSeconds,
    dragState.minTime,
    dragState.maxTime,
  );
  return {
    symbols: dragState.originalSymbols.map((symbol, index) => {
      if (index === dragState.boundaryIndex) {
        return {
          ...symbol,
          endTime: nextBoundaryTime,
        };
      }
      if (index === dragState.boundaryIndex + 1) {
        return {
          ...symbol,
          startTime: nextBoundaryTime,
        };
      }
      return symbol;
    }),
  };
}

function getDraftStyle(
  dragState: Extract<NonNullable<DragState>, { kind: "create-track-item" }>,
) {
  const leftPx = Math.min(
    Math.max(0, dragState.originX - dragState.laneLeft),
    Math.max(0, dragState.currentX - dragState.laneLeft),
  );
  const rightPx = Math.max(
    Math.max(0, dragState.originX - dragState.laneLeft),
    Math.max(0, dragState.currentX - dragState.laneLeft),
  );
  return {
    left: leftPx,
    width: Math.max(rightPx - leftPx, 6),
  };
}

function getCreateTrackPreview(
  dragState: Extract<NonNullable<DragState>, { kind: "create-track-item" }>,
  zoom: number,
  snapPoints: number[],
  shouldSnap: boolean,
  pointerStepPx = 0,
  snapLock: DragSnapLock = null,
) {
  const previewRawTime = Math.max(0, (dragState.currentX - dragState.laneLeft) / zoom);
  const activeEdge: "left" | "right" = previewRawTime <= Math.max(0, (dragState.originX - dragState.laneLeft) / zoom)
    ? "left"
    : "right";
  const snappedPoint = shouldSnap
    ? getEdgeSnapCandidate(previewRawTime, activeEdge, snapPoints, zoom, pointerStepPx, snapLock)
    : null;
  const previewTime = snappedPoint?.point ?? previewRawTime;
  return {
    previewTime,
    snappedTo: snappedPoint
      ? {
          time: snappedPoint.point,
          edge: activeEdge,
        }
      : null,
  };
}

function getSelectionBoxStyle(
  dragState: Extract<NonNullable<DragState>, { kind: "select-box" }>,
) {
  const left = Math.min(dragState.originContentX, dragState.currentContentX);
  const top = Math.min(dragState.originContentY, dragState.currentContentY);
  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.abs(dragState.currentContentX - dragState.originContentX),
    height: Math.abs(dragState.currentContentY - dragState.originContentY),
  };
}

function getContentSelectionRect(
  dragState: Extract<NonNullable<DragState>, { kind: "select-box" }>,
) {
  return {
    left: Math.min(dragState.originContentX, dragState.currentContentX),
    right: Math.max(dragState.originContentX, dragState.currentContentX),
    top: Math.min(dragState.originContentY, dragState.currentContentY),
    bottom: Math.max(dragState.originContentY, dragState.currentContentY),
  };
}

function rectsIntersect(
  leftRect: { left: number; right: number; top: number; bottom: number },
  rightRect: { left: number; right: number; top: number; bottom: number },
) {
  return (
    leftRect.left <= rightRect.right &&
    leftRect.right >= rightRect.left &&
    leftRect.top <= rightRect.bottom &&
    leftRect.bottom >= rightRect.top
  );
}

function getHoveredBlockTrackId(block: HoveredBlockState) {
  return block?.type === "custom-block" ? block.trackId : undefined;
}

function buildHoveredBlockState(
  id: string,
  type: "character" | "action" | "custom-block",
  edge: EdgeHit,
  trackId?: string,
): HoveredBlockState {
  return type === "custom-block"
    ? { id, type, trackId: trackId ?? "", edge }
    : { id, type, edge };
}

function getTrackBlockMetrics(trackHeight: number): TrackBlockMetrics {
  const height = Math.round(clampValue(trackHeight - 22, 24, 54));
  return {
    top: Math.round(Math.max(5, (trackHeight - height) / 2)),
    height,
  };
}

function getTimelineTrackBaseHeight(track: TrackDefinition, trackHeight: number) {
  return track.type === "attached-point" || track.type === "gongche-attached" || track.type === "branch-lane"
    ? Math.max(36, trackHeight - 14)
    : trackHeight;
}

function buildTrackBlockLayouts(
  trackDefinitions: TrackDefinition[],
  customTracks: CustomTrack[],
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
  baseTrackHeightSetting: number,
): Map<string, StackedTrackLayout> {
  const customTrackMap = new Map(customTracks.map((track) => [track.id, track]));
  const layouts = new Map<string, StackedTrackLayout>();

  for (const track of trackDefinitions) {
    const baseTrackHeight = getTimelineTrackBaseHeight(track, baseTrackHeightSetting);
    const layoutInput = getStackedLayoutInputForTrack(
      track,
      customTrackMap,
      characterAnnotations,
      actionAnnotations,
      customBlocks,
    );
    if (!layoutInput) {
      continue;
    }
    if (layoutInput.mode === "standard" && layoutInput.blocks.length <= 1) {
      continue;
    }
    const layout = layoutInput.mode === "merged-branch"
      ? layoutMergedBranchTrackBlocks(layoutInput.blocks, layoutInput.sourceTrack, baseTrackHeight)
      : layoutSingleBandTrackBlocks(layoutInput.blocks, baseTrackHeight);
    if (layout.rowCount <= 1) {
      continue;
    }
    layouts.set(track.id, layout);
  }

  return layouts;
}

function getStackedLayoutInputForTrack(
  track: TrackDefinition,
  customTrackMap: Map<string, CustomTrack>,
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
): StackedLayoutInput | null {
  if (track.type === "character") {
    return {
      mode: "standard",
      blocks: characterAnnotations,
    };
  }
  if (track.type === "action") {
    return {
      mode: "standard",
      blocks: actionAnnotations.filter((annotation) => annotation.trackId === track.id),
    };
  }
  if (track.type !== "custom-text" && track.type !== "custom-action" && track.type !== "branch-lane") {
    return null;
  }

  const visibleBlocks = customBlocks.filter((block) => isCustomBlockVisibleOnTrack(block, track));
  const sourceTrackId = track.type === "branch-lane" ? track.parentTrackId : track.id;
  const sourceTrack = sourceTrackId ? customTrackMap.get(sourceTrackId) : undefined;
  const isMergedBranchParent = Boolean(
    track.isCustom &&
      sourceTrack?.branching?.enabled &&
      sourceTrack.branching.displayMode === "merged",
  );

  if (isMergedBranchParent && sourceTrack?.branching) {
    return {
      mode: "merged-branch",
      blocks: visibleBlocks,
      sourceTrack,
    };
  }

  return {
    mode: "standard",
    blocks: visibleBlocks,
  };
}

function layoutSingleBandTrackBlocks(
  blocks: TimelineLayoutBlock[],
  baseTrackHeight: number,
): StackedTrackLayout {
  const rowAssignments = layoutBlocksIntoRows(blocks);
  const normalizedRowCount = Math.max(1, rowAssignments.rowCount);
  const sizing = getStackedTrackSizing(normalizedRowCount, baseTrackHeight);
  const blockDisplayLayouts = new Map<string, StackedTrackBlockDisplayLayout>();
  const bandHeight = getStackedRowsHeight(normalizedRowCount, sizing);

  // 普通轨道没有父/子分叉语义，但仍然可以复用合并分叉轨道的“按重叠组铺满”逻辑：
  // 有冲突的时间段在整条 band 内错层；没有冲突的时间段则铺满整条 band。
  for (const group of buildBlockOverlapGroups(blocks)) {
    appendBlockGroupDisplayLayouts(
      group,
      sizing.verticalPadding,
      bandHeight,
      sizing,
      blockDisplayLayouts,
    );
  }

  return {
    rowCount: normalizedRowCount,
    trackHeight: sizing.trackHeight,
    blockDisplayLayouts,
  };
}

function layoutMergedBranchTrackBlocks(
  blocks: ResolvedCustomTrackBlock[],
  track: CustomTrack,
  baseTrackHeight: number,
): StackedTrackLayout {
  const { root, laneNodeMap } = buildBranchLayoutTree(track.branching?.lanes ?? []);
  assignBlocksToBranchLayoutTree(blocks, root, laneNodeMap);
  return layoutMergedBranchTrackDisplayLayouts(root, baseTrackHeight);
}

function buildBranchLayoutTree(lanes: BranchLane[]) {
  const root = createBranchLayoutNode("__root__", null, null);
  const laneNodeMap = new Map<string, BranchLayoutNode>();

  const appendChildren = (parent: BranchLayoutNode, items: BranchLane[]) => {
    for (const lane of items) {
      const node = createBranchLayoutNode(lane.id, lane.id, parent);
      parent.children.push(node);
      laneNodeMap.set(lane.id, node);
      appendChildren(node, lane.children ?? []);
    }
  };

  appendChildren(root, lanes);
  return { root, laneNodeMap };
}

function createBranchLayoutNode(
  key: string,
  laneId: string | null,
  parent: BranchLayoutNode | null,
): BranchLayoutNode {
  return {
    key,
    laneId,
    parent,
    children: [],
    blocks: [],
  };
}

function assignBlocksToBranchLayoutTree(
  blocks: ResolvedCustomTrackBlock[],
  root: BranchLayoutNode,
  laneNodeMap: Map<string, BranchLayoutNode>,
) {
  for (const block of blocks) {
    const targetNode = getBranchLayoutNodeForBlock(block, root, laneNodeMap);
    targetNode.blocks.push(block);
  }
}

function getBranchLayoutNodeForBlock(
  block: ResolvedCustomTrackBlock,
  root: BranchLayoutNode,
  laneNodeMap: Map<string, BranchLayoutNode>,
) {
  if (!block.branchScope || block.branchScope.mode === "root" || block.branchScope.laneIds.length === 0) {
    return root;
  }
  const laneNodes = block.branchScope.laneIds
    .map((laneId) => laneNodeMap.get(laneId))
    .filter((node): node is BranchLayoutNode => Boolean(node));
  if (laneNodes.length === 0) {
    return root;
  }
  if (laneNodes.length === 1) {
    return laneNodes[0];
  }
  // 多分叉共有块放到最近公共父节点，而不是塞进第一条分叉，语义更接近“共有动作/共有文本”。
  return getNearestCommonBranchAncestor(laneNodes) ?? root;
}

function getNearestCommonBranchAncestor(nodes: BranchLayoutNode[]) {
  const paths = nodes.map(getBranchNodePath);
  const shortestPathLength = Math.min(...paths.map((path) => path.length));
  let commonNode: BranchLayoutNode | null = null;
  for (let index = 0; index < shortestPathLength; index += 1) {
    const candidate = paths[0][index];
    if (paths.every((path) => path[index] === candidate)) {
      commonNode = candidate;
    } else {
      break;
    }
  }
  return commonNode;
}

function getBranchNodePath(node: BranchLayoutNode) {
  const path: BranchLayoutNode[] = [];
  let current: BranchLayoutNode | null = node;
  while (current) {
    path.unshift(current);
    current = current.parent;
  }
  return path;
}

function layoutMergedBranchTrackDisplayLayouts(
  root: BranchLayoutNode,
  baseTrackHeight: number,
): StackedTrackLayout {
  const measurement = measureBranchBand(root);
  if (!measurement) {
    const sizing = getStackedTrackSizing(1, baseTrackHeight);
    return {
      rowCount: 1,
      trackHeight: sizing.trackHeight,
      blockDisplayLayouts: new Map(),
    };
  }

  const sizing = getStackedTrackSizing(measurement.subtreeRowCount, baseTrackHeight);
  const geometryMap = new Map<string, BranchBandGeometry>();
  assignBranchBandGeometry(measurement, sizing.verticalPadding, sizing, geometryMap);
  const descendantBlockMap = buildDescendantBranchBlockMap(root);
  const blockDisplayLayouts = new Map<string, StackedTrackBlockDisplayLayout>();
  appendBranchBlockDisplayLayouts(root, geometryMap, sizing, descendantBlockMap, blockDisplayLayouts);

  return {
    rowCount: measurement.subtreeRowCount,
    trackHeight: sizing.trackHeight,
    blockDisplayLayouts,
  };
}

function measureBranchBand(
  node: BranchLayoutNode,
): BranchBandMeasurement | null {
  const childMeasurements = node.children
    .map(measureBranchBand)
    .filter((measurement): measurement is BranchBandMeasurement => Boolean(measurement));
  const ownRowCount = layoutBlocksIntoRows(node.blocks).rowCount;
  const hasOwnBlocks = node.blocks.length > 0;
  const hasChildContent = childMeasurements.length > 0;

  if (!hasOwnBlocks && !hasChildContent) {
    return null;
  }

  // 合并显示虽然只有一条物理轨道，但必须保留“父轨 / 子分叉”的语义层。
  // 因此只要某个分叉节点下有内容，就给这个节点保留自己的 band；
  // 这样子分叉不会因为父层暂时没块而上浮占用父层位置。
  const reservedOwnRows = Math.max(1, ownRowCount);
  return {
    node,
    ownRowCount: reservedOwnRows,
    subtreeRowCount: reservedOwnRows +
      childMeasurements.reduce((total, child) => total + child.subtreeRowCount, 0),
    childMeasurements,
  };
}

function assignBranchBandGeometry(
  measurement: BranchBandMeasurement,
  top: number,
  sizing: StackedTrackSizing,
  geometryMap: Map<string, BranchBandGeometry>,
) {
  const ownHeight = getStackedRowsHeight(measurement.ownRowCount, sizing);
  let cursor = top + ownHeight + (
    measurement.childMeasurements.length > 0 ? sizing.rowGap : 0
  );

  for (const child of measurement.childMeasurements) {
    assignBranchBandGeometry(child, cursor, sizing, geometryMap);
    cursor += getStackedRowsHeight(child.subtreeRowCount, sizing) + sizing.rowGap;
  }

  const subtreeHeight = getStackedRowsHeight(measurement.subtreeRowCount, sizing);
  geometryMap.set(measurement.node.key, {
    ownTop: top,
    subtreeTop: top,
    subtreeHeight,
    ownRowCount: measurement.ownRowCount,
  });
}

function appendBranchBlockDisplayLayouts(
  node: BranchLayoutNode,
  geometryMap: Map<string, BranchBandGeometry>,
  sizing: StackedTrackSizing,
  descendantBlockMap: Map<string, ResolvedCustomTrackBlock[]>,
  blockDisplayLayouts: Map<string, StackedTrackBlockDisplayLayout>,
) {
  const geometry = geometryMap.get(node.key);
  if (!geometry) {
    return;
  }
  const ownRowAssignments = layoutBlocksIntoRows(node.blocks);
  const ownRowSlots = splitStackedRows(geometry.ownTop, geometry.ownRowCount, sizing);
  const overlapGroups = buildBlockOverlapGroups(node.blocks);

  for (const group of overlapGroups) {
    const canFillSubtree = canBlockGroupFillBranchSubtree(group, node, descendantBlockMap);

    if (canFillSubtree) {
      appendBlockGroupDisplayLayouts(
        group,
        geometry.subtreeTop,
        geometry.subtreeHeight,
        sizing,
        blockDisplayLayouts,
      );
      continue;
    }

    for (const block of group) {
      // 铺满必须以“父层重叠组”为单位决定，不能逐块决定。
      // 否则一个大块因子分叉回到父层，旁边与它重叠的小块却铺满子树，
      // 就会出现上下高度策略混用后的视觉穿插。
      const slot = ownRowSlots[ownRowAssignments.blockRows.get(block.id) ?? 0] ?? ownRowSlots[0];
      blockDisplayLayouts.set(block.id, {
        top: slot.top,
        height: slot.height,
      });
    }
  }

  node.children.forEach((child) => {
    appendBranchBlockDisplayLayouts(child, geometryMap, sizing, descendantBlockMap, blockDisplayLayouts);
  });
}

function buildBlockOverlapGroups<T extends TimelineIntervalBlock>(blocks: T[]) {
  const sortedBlocks = [...blocks].sort((left, right) =>
    left.startTime === right.startTime
      ? left.endTime - right.endTime
      : left.startTime - right.startTime
  );
  const groups: T[][] = [];
  let currentGroup: T[] = [];
  let currentGroupEnd = Number.NEGATIVE_INFINITY;

  for (const block of sortedBlocks) {
    if (currentGroup.length === 0 || block.startTime < currentGroupEnd - STACKED_TRACK_OVERLAP_TOLERANCE_SECONDS) {
      currentGroup.push(block);
      currentGroupEnd = Math.max(currentGroupEnd, block.endTime);
      continue;
    }
    groups.push(currentGroup);
    currentGroup = [block];
    currentGroupEnd = block.endTime;
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  return groups;
}

function appendBlockGroupDisplayLayouts<T extends TimelineIntervalBlock>(
  group: T[],
  top: number,
  height: number,
  sizing: StackedTrackSizing,
  blockDisplayLayouts: Map<string, StackedTrackBlockDisplayLayout>,
) {
  // 同一个重叠组内部才需要分行；不同重叠组互不压缩，
  // 这样普通轨道也能像合并分叉轨道一样，在非冲突段恢复铺满高度。
  const groupRowAssignments = layoutBlocksIntoRows(group);
  const groupSlots = splitRowsAcrossBand(
    top,
    height,
    groupRowAssignments.rowCount,
    sizing,
  );

  for (const block of group) {
    const slot = groupSlots[groupRowAssignments.blockRows.get(block.id) ?? 0] ?? groupSlots[0];
    blockDisplayLayouts.set(block.id, {
      top: slot.top,
      height: slot.height,
    });
  }
}

function canBlockGroupFillBranchSubtree(
  blocks: ResolvedCustomTrackBlock[],
  node: BranchLayoutNode,
  descendantBlockMap: Map<string, ResolvedCustomTrackBlock[]>,
) {
  if (node.children.length === 0) {
    return true;
  }

  // 父层铺满要以重叠组为单位：只要组内任意块和子分叉有时间重叠，
  // 整组都回到父层自己的 band，避免同一组块混用不同高度策略。
  return !blocks.some((block) =>
    (descendantBlockMap.get(node.key) ?? []).some((descendantBlock) =>
      areTimelineIntervalsOverlapping(block, descendantBlock)
    )
  );
}

function buildDescendantBranchBlockMap(root: BranchLayoutNode) {
  const descendantBlockMap = new Map<string, ResolvedCustomTrackBlock[]>();

  const collect = (node: BranchLayoutNode): ResolvedCustomTrackBlock[] => {
    const descendants: ResolvedCustomTrackBlock[] = [];
    for (const child of node.children) {
      descendants.push(...child.blocks, ...collect(child));
    }
    descendantBlockMap.set(node.key, descendants);
    return descendants;
  };

  collect(root);
  return descendantBlockMap;
}

function splitStackedRows(top: number, rowCount: number, sizing: StackedTrackSizing) {
  return Array.from({ length: Math.max(1, rowCount) }, (_, rowIndex) => ({
    top: top + rowIndex * (sizing.rowHeight + sizing.rowGap),
    height: sizing.rowHeight,
  }));
}

function splitRowsAcrossBand(
  top: number,
  height: number,
  rowCount: number,
  sizing: StackedTrackSizing,
) {
  const normalizedRowCount = Math.max(1, rowCount);
  const gap = normalizedRowCount > 1
    ? Math.min(sizing.rowGap, height / Math.max(normalizedRowCount * 5, 1))
    : 0;
  const rowHeight = Math.max(
    1,
    (height - gap * Math.max(0, normalizedRowCount - 1)) / normalizedRowCount,
  );

  // 在一个可用 band 内铺满时，仍要尊重该时间段自身的重叠错层：
  // 如果同一重叠组有多行冲突，就把整个 band 高度按这些行均分。
  return Array.from({ length: normalizedRowCount }, (_, rowIndex) => ({
    top: top + rowIndex * (rowHeight + gap),
    height: rowHeight,
  }));
}

function getStackedRowsHeight(rowCount: number, sizing: StackedTrackSizing) {
  return Math.max(1, rowCount) * sizing.rowHeight +
    Math.max(0, rowCount - 1) * sizing.rowGap;
}

function layoutBlocksIntoRows<T extends TimelineIntervalBlock>(blocks: T[]) {
  const sortedBlocks = [...blocks].sort((left, right) =>
    left.startTime === right.startTime
      ? left.endTime - right.endTime
      : left.startTime - right.startTime
  );
  const rowIntervals: Array<Array<{ startTime: number; endTime: number }>> = [];
  const blockRows = new Map<string, number>();

  for (const block of sortedBlocks) {
    // 这里按真实时间重叠分行。首尾相接和 0.025 秒以内的导入误差仍视为同一行可容纳。
    let rowIndex = rowIntervals.findIndex((intervals) =>
      intervals.every((interval) => !areTimelineIntervalsOverlapping(block, interval))
    );
    if (rowIndex < 0) {
      rowIndex = rowIntervals.length;
      rowIntervals.push([]);
    }
    rowIntervals[rowIndex].push({ startTime: block.startTime, endTime: block.endTime });
    blockRows.set(block.id, rowIndex);
  }

  return {
    rowCount: rowIntervals.length,
    blockRows,
  };
}

function areTimelineIntervalsOverlapping(
  left: { startTime: number; endTime: number },
  right: { startTime: number; endTime: number },
) {
  return left.startTime < right.endTime - STACKED_TRACK_OVERLAP_TOLERANCE_SECONDS &&
    left.endTime > right.startTime + STACKED_TRACK_OVERLAP_TOLERANCE_SECONDS;
}

function getStackedTrackSizing(rowCount: number, baseTrackHeight: number): StackedTrackSizing {
  const normalizedRowCount = Math.max(1, rowCount);
  const verticalPadding = Math.round(clampValue(baseTrackHeight * 0.1, 4, 10));
  const rowGap = normalizedRowCount > 1
    ? Math.round(clampValue(baseTrackHeight * 0.06, 3, 7))
    : 0;
  const availableRowHeight = (
    baseTrackHeight -
    verticalPadding * 2 -
    rowGap * Math.max(0, normalizedRowCount - 1)
  ) / normalizedRowCount;
  const minRowHeight = Math.round(clampValue(baseTrackHeight * 0.34, 16, 24));
  // 堆叠轨道既要响应“纵向”缩放，又不能在层数多时把块压到不可读。
  // 因此优先把行放进当前基础高度；放不下时用随缩放变化的最小行高撑开轨道。
  const rowHeight = Math.max(minRowHeight, availableRowHeight);
  const trackHeight = Math.max(
    baseTrackHeight,
    verticalPadding * 2 +
      normalizedRowCount * rowHeight +
      Math.max(0, normalizedRowCount - 1) * rowGap,
  );

  return {
    rowHeight,
    rowGap,
    verticalPadding,
    trackHeight,
  };
}

function isCustomBlockVisibleOnTrack(
  block: ResolvedCustomTrackBlock,
  track: TrackDefinition,
) {
  if (track.type === "branch-lane") {
    return Boolean(
      track.parentTrackId &&
      track.branchLaneId &&
      block.trackId === track.parentTrackId &&
      block.branchScope?.mode === "lanes" &&
      block.branchScope.laneIds.includes(track.branchLaneId),
    );
  }
  if (track.type !== "custom-text" && track.type !== "custom-action") {
    return false;
  }
  if (block.trackId !== track.id) {
    return false;
  }
  if (track.branching?.enabled && track.branching.displayMode === "expanded") {
    // 展开后父轨只保留未细分/全轨块，分叉块交给派生子轨显示。
    return !block.branchScope || block.branchScope.mode === "root";
  }
  return true;
}

function getCustomBlockCreationTarget(track: TrackDefinition): {
  trackId: string;
  trackType: "custom-text" | "custom-action";
  branchScope?: BranchScope;
} | null {
  if (track.type === "custom-text" || track.type === "custom-action") {
    return {
      trackId: track.id,
      trackType: track.type,
    };
  }
  if (!track.isBranchLaneTrack || !track.parentTrackId || !track.branchLaneId || !track.branchTrackType) {
    return null;
  }
  return {
    trackId: track.parentTrackId,
    trackType: track.branchTrackType === "text" ? "custom-text" : "custom-action",
    // 分叉子轨是显示层；新建块仍保存到父轨，只在 branchScope 上记录归属。
    branchScope: {
      mode: "lanes",
      laneIds: [track.branchLaneId],
    },
  };
}

function flattenCustomBlocks(customTracks: CustomTrack[]): ResolvedCustomTrackBlock[] {
  return customTracks.flatMap((track) =>
    track.blocks.map((block) => ({
      id: block.id,
      trackId: track.id,
      trackType: track.trackType,
      startTime: block.startTime,
      endTime: block.endTime,
      type: block.type,
      text: "text" in block ? block.text : undefined,
      branchScope: block.branchScope,
      branchGroupId: block.branchGroupId,
      branchParentBlockId: block.branchParentBlockId,
    })),
  );
}

function flattenAttachedPointTracks(
  builtinTracks: BuiltinTrack[],
  customTracks: CustomTrack[],
): ResolvedAttachedPointTrack[] {
  return [...builtinTracks, ...customTracks].flatMap((track) =>
    (track.attachedPointTracks ?? []).map((pointTrack) => ({
      id: pointTrack.id,
      name: pointTrack.name,
      parentTrackId: track.id,
      parentTrackName: track.name,
      typeOptions: pointTrack.typeOptions,
      points: pointTrack.points,
    })),
  );
}

function findTimelineGongcheParentBlock(
  parentTrackId: string,
  parentBlockId: string,
  characterAnnotations: CharacterAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
) {
  if (parentTrackId === "character-track") {
    const character = characterAnnotations.find((item) => item.id === parentBlockId);
    return character
      ? {
          startTime: character.startTime,
          endTime: character.endTime,
          label: character.char,
        }
      : null;
  }
  const block = customBlocks.find((item) =>
    item.trackId === parentTrackId &&
    item.id === parentBlockId &&
    item.trackType === "text",
  );
  return block
    ? {
        startTime: block.startTime,
        endTime: block.endTime,
        label: block.text ?? block.type,
      }
    : null;
}

function getTextParentBoundarySnapPoints(project: ProjectData, parentTrackId: string) {
  if (parentTrackId === "character-track") {
    return project.characterAnnotations.flatMap((item) => [item.startTime, item.endTime]);
  }
  const customTrack = project.customTracks.find((track) => track.id === parentTrackId && track.trackType === "text");
  return customTrack?.blocks.flatMap((item) => [item.startTime, item.endTime]) ?? [];
}

function getGongcheTrackIdForParent(parentTrackId: string) {
  return `gongche:${parentTrackId}`;
}

function findResolvedAttachedPointTrack(project: ProjectData, trackId: string) {
  for (const track of [...project.builtinTracks, ...project.customTracks]) {
    const attachedPointTrack = (track.attachedPointTracks ?? []).find((item) => item.id === trackId);
    if (attachedPointTrack) {
      return attachedPointTrack;
    }
  }
  return null;
}

function getParentTrackBoundarySnapPoints(project: ProjectData, attachedPointTrackId: string) {
  for (const builtinTrack of project.builtinTracks) {
    if ((builtinTrack.attachedPointTracks ?? []).some((item) => item.id === attachedPointTrackId)) {
      if (builtinTrack.id === "character-track") {
        return project.characterAnnotations.flatMap((item) => [item.startTime, item.endTime]);
      }
      return project.actionAnnotations
        .filter((item) => item.trackId === builtinTrack.id)
        .flatMap((item) => [item.startTime, item.endTime]);
    }
  }

  for (const customTrack of project.customTracks) {
    if ((customTrack.attachedPointTracks ?? []).some((item) => item.id === attachedPointTrackId)) {
      return customTrack.blocks.flatMap((item) => [item.startTime, item.endTime]);
    }
  }

  return [];
}

function shouldTrackSnapToWaveformKeypoints(
  project: ProjectData,
  trackId: string,
  waveformData: WaveformData | null,
) {
  if (!waveformData?.keypoints?.length) {
    return false;
  }
  const builtinTrack = project.builtinTracks.find((track) => track.id === trackId);
  if (builtinTrack) {
    return Boolean(builtinTrack.snapToWaveformKeypoints);
  }
  const customTrack = project.customTracks.find((track) => track.id === trackId);
  if (customTrack) {
    return Boolean(customTrack.snapToWaveformKeypoints);
  }
  return Boolean(findResolvedAttachedPointTrack(project, trackId)?.snapToWaveformKeypoints);
}

function getTrackIdForAnnotation(
  annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
  type: "character" | "action" | "custom-block",
) {
  if (type === "character") {
    return "character-track";
  }
  if (type === "custom-block") {
    return (annotation as ResolvedCustomTrackBlock).trackId;
  }
  return (annotation as ActionAnnotation).trackId;
}

function getTrackIdForSelectionItem(
  item: TimelineSelectionItem | TimelineBatchMoveItem,
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
) {
  if (item.type === "character") {
    return "character-track";
  }
  if (item.type === "attached-point") {
    return item.trackId;
  }
  if (item.type === "custom-block") {
    return item.trackId;
  }
  if (item.type === "banyan-mark") {
    return "banyan-track";
  }
  return actionAnnotations.find((actionItem) => actionItem.id === item.id)?.trackId ??
    customBlocks.find((block) => block.id === item.id)?.trackId ??
    null;
}

function getTimelineSelectionKey(
  type: "character" | "action" | "custom-block" | "attached-point" | "banyan-mark",
  id: string,
  trackId?: string,
) {
  return type === "custom-block" || type === "attached-point"
    ? `${type}:${trackId ?? ""}:${id}`
    : `${type}:${id}`;
}

function getSelectionItemTrackId(item: TimelineSelectionItem | TimelineBatchMoveItem) {
  return item.type === "custom-block" || item.type === "attached-point"
    ? item.trackId
    : undefined;
}

function getCanvasX(time: number, zoom: number) {
  return TRACK_LABEL_WIDTH + time * zoom;
}

function getCanvasTimeFromViewportOffset(
  container: HTMLElement,
  viewportOffset: number,
  zoom: number,
  scrollLeft = container.scrollLeft,
) {
  const offsetX = viewportOffset + scrollLeft;
  return Math.max(0, offsetX - TRACK_LABEL_WIDTH) / zoom;
}

function getViewportOffsetForTime(container: HTMLElement, time: number, zoom: number) {
  const canvasX = getCanvasX(time, zoom);
  return Math.max(0, Math.min(container.clientWidth, canvasX - container.scrollLeft));
}

function getLaneX(container: HTMLElement, clientX: number) {
  const bounds = container.getBoundingClientRect();
  return Math.max(0, clientX - bounds.left + container.scrollLeft);
}

function getLaneTime(container: HTMLElement, clientX: number, zoom: number) {
  return getLaneX(container, clientX) / zoom;
}

function clampZoom(zoom: number) {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
}

function clampValue(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatTimelineTickLabel(seconds: number) {
  const roundedSeconds = Math.round(seconds * 10) / 10;
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const secondsValue = roundedSeconds % 60;
  const secondLabel = Number.isInteger(secondsValue)
    ? String(secondsValue)
    : secondsValue.toFixed(1).replace(/\.0$/, "");

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${secondLabel.padStart(2, "0")}`;
  }
  if (minutes > 0) {
    return `${minutes}:${secondLabel.padStart(2, "0")}`;
  }
  return secondLabel;
}

function buildWaveformEnvelope(
  waveformData: WaveformData,
  startTime: number,
  endTime: number,
  viewWidth: number,
  viewHeight: number,
) {
  const timeOffset = waveformData.timeOffset ?? 0;
  const sampleStart = Math.max(
    0,
    Math.floor((startTime - timeOffset) * waveformData.sampleRate),
  );
  const sampleEnd = Math.min(
    waveformData.samples.length,
    Math.max(
      sampleStart + 1,
      Math.ceil((endTime - timeOffset) * waveformData.sampleRate),
    ),
  );
  const visibleLength = Math.max(sampleEnd - sampleStart, 1);
  const bucketCount = Math.max(64, Math.min(WAVEFORM_MAX_BUCKETS, Math.ceil(viewWidth)));
  const centerY = viewHeight / 2;
  const maxAmplitudeHeight = Math.max(8, centerY - 5);
  const topPoints: string[] = [];
  const bottomPoints: string[] = [];

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const rangeStart = sampleStart + Math.floor((bucketIndex / bucketCount) * visibleLength);
    const rangeEnd = sampleStart + Math.floor(((bucketIndex + 1) / bucketCount) * visibleLength);
    let peak = 0;
    let rmsSum = 0;
    const safeRangeEnd = Math.max(rangeStart + 1, rangeEnd);
    const rangeLength = Math.max(safeRangeEnd - rangeStart, 1);
    const sampleStep = Math.max(1, Math.ceil(rangeLength / WAVEFORM_MAX_SAMPLES_PER_BUCKET));
    for (let cursor = rangeStart; cursor < safeRangeEnd; cursor += sampleStep) {
      const value = waveformData.samples[cursor] ?? 0;
      const absValue = Math.abs(value);
      if (absValue > peak) {
        peak = absValue;
      }
      rmsSum += value * value;
    }
    const sampleCount = Math.max(1, Math.ceil(rangeLength / sampleStep));
    const rms = Math.sqrt(rmsSum / sampleCount);
    const amplitude = Math.min(1, peak * 0.72 + rms * 0.9);
    const x = bucketCount === 1 ? 0 : (bucketIndex / (bucketCount - 1)) * viewWidth;
    const halfHeight = Math.max(1, amplitude * maxAmplitudeHeight);
    topPoints.push(`${x.toFixed(2)} ${(centerY - halfHeight).toFixed(2)}`);
    bottomPoints.push(`${x.toFixed(2)} ${(centerY + halfHeight).toFixed(2)}`);
  }

  const areaPath = [
    `M ${topPoints[0]}`,
    ...topPoints.slice(1).map((point) => `L ${point}`),
    ...bottomPoints.slice().reverse().map((point) => `L ${point}`),
    "Z",
  ].join(" ");

  const centerLinePath = `M 0 ${centerY.toFixed(2)} L ${viewWidth.toFixed(2)} ${centerY.toFixed(2)}`;

  return {
    areaPath,
    centerLinePath,
    viewWidth,
  };
}
