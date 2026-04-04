import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ActionAnnotation,
  AttachedPointAnnotation,
  BuiltinTrack,
  BuiltinTrackId,
  CharacterAnnotation,
  CustomTrack,
  ProjectData,
  ResolvedCustomTrackBlock,
  SelectedItem,
  SubtitleLine,
  TimelineBatchMoveItem,
  TimelineSelectionItem,
  TrackDefinition,
  WaveformData,
} from "../types";
import { clampRange } from "../utils/project";

type TimelineProps = {
  subtitleLines: SubtitleLine[];
  builtinTracks: BuiltinTrack[];
  characterAnnotations: CharacterAnnotation[];
  actionAnnotations: ActionAnnotation[];
  customTracks: CustomTrack[];
  trackDefinitions: TrackDefinition[];
  missingBuiltinTracks: BuiltinTrack[];
  waveformData: WaveformData | null;
  isWaveformLoading: boolean;
  currentTime: number;
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
  onToggleTrackSnap: (trackId: string) => void;
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
  onCreateCustomBlock: (trackId: string, startTime: number, endTime?: number) => void;
  onCreateAttachedPoint: (trackId: string, time: number) => void;
  onAddBuiltinTrack: (trackId: BuiltinTrackId) => void;
  onAddCustomTrack: (trackType: "text" | "action") => void;
  onUpdatePasteTarget: (trackId: string, time: number) => void;
  onOpenCharacterContextMenu: (id: string, time: number, x: number, y: number) => void;
  onOpenActionContextMenu: (id: string, time: number, x: number, y: number) => void;
  onOpenCustomBlockContextMenu: (trackId: string, id: string, time: number, x: number, y: number) => void;
  onOpenLaneContextMenu: (trackId: string, time: number, x: number, y: number) => void;
  onLineChange: (id: string, changes: Pick<SubtitleLine, "startTime" | "endTime">) => void;
  onLineCommit: (id: string, changes: Pick<SubtitleLine, "startTime" | "endTime">) => void;
  onCharacterChange: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onCharacterCommit: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onActionChange: (id: string, changes: Partial<ActionAnnotation>) => void;
  onActionCommit: (id: string, changes: Partial<ActionAnnotation>) => void;
  onAttachedPointChange: (trackId: string, pointId: string, changes: Partial<AttachedPointAnnotation>) => void;
  onAttachedPointCommit: (trackId: string, pointId: string, changes: Partial<AttachedPointAnnotation>) => void;
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
      kind: "move-selection";
      originX: number;
      items: TimelineBatchMoveItem[];
    }
  | {
      kind: "resize-linked";
      trackId: string;
      originX: number;
      boundaryTime: number;
      leftItem: TimelineBatchMoveItem;
      rightItem: TimelineBatchMoveItem;
    }
  | {
      kind: "create-track-item";
      trackId: string;
      trackType: "character" | "action" | "custom-text" | "custom-action";
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
const SNAP_DISTANCE_PX = 4;
const SNAP_VISUAL_MATCH_PX = 1;
const REORDER_ACTIVATION_PX = 6;
const ZOOM_SETTLE_MS = 220;
const ZOOM_MIN = 5;
const ZOOM_MAX = 100;
const ZOOM_STEP = 5;
const DRAG_ACTIVATION_PX = 4;
const EDGE_HIT_SLOP_PX = 8;
const SELECTED_EDGE_HIT_SLOP_PX = 17;
const LINKED_EDGE_HIT_RATIO = 0.55;
const MIN_LINKED_EDGE_HIT_SLOP_PX = 4;
const PREVIEW_UPDATE_EPSILON = 1 / 60;
const MIN_BLOCK_WIDTH_PX = 44;
const MIN_WAVEFORM_VIEW_HEIGHT = 32;
const WAVEFORM_TRACK_VERTICAL_PADDING = 8;
const WAVEFORM_MAX_WIDTH = 1800;
const WAVEFORM_MAX_BUCKETS = 960;
const WAVEFORM_MAX_SAMPLES_PER_BUCKET = 192;
const CLICK_SUPPRESS_MS = 120;
const FOCUS_SCROLL_DURATION_MS = 260;
const SNAP_RELEASE_DISTANCE_PX = 16;

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

type ResolvedAttachedPointTrack = {
  id: string;
  name: string;
  parentTrackId: string;
  parentTrackName: string;
  typeOptions: string[];
  points: AttachedPointAnnotation[];
};

export function Timeline({
  subtitleLines,
  builtinTracks,
  characterAnnotations,
  actionAnnotations,
  customTracks,
  trackDefinitions,
  missingBuiltinTracks,
  waveformData,
  isWaveformLoading,
  currentTime,
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
  onToggleTrackSnap,
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
  onCreateAttachedPoint,
  onAddBuiltinTrack,
  onAddCustomTrack,
  onUpdatePasteTarget,
  onOpenCharacterContextMenu,
  onOpenActionContextMenu,
  onOpenCustomBlockContextMenu,
  onOpenLaneContextMenu,
  onLineChange,
  onLineCommit,
  onCharacterChange,
  onCharacterCommit,
  onActionChange,
  onActionCommit,
  onAttachedPointChange,
  onAttachedPointCommit,
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
  const dragStateRef = useRef<DragState>(null);
  const lastPointerClientXRef = useRef(0);
  const pendingDragUpdateRef = useRef<PendingDragUpdate | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingPreviewTimeRef = useRef<number | null>(null);
  const previewTimeRef = useRef<number | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const rulerScrubPointerIdRef = useRef<number | null>(null);
  const pendingRulerSeekTimeRef = useRef<number | null>(null);
  const rulerSeekFrameRef = useRef<number | null>(null);
  const focusScrollFrameRef = useRef<number | null>(null);
  const focusScrollUntilRef = useRef(0);
  const dragSnapLockRef = useRef<DragSnapLock>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const suppressLineClickIdRef = useRef<string | null>(null);
  const suppressCanvasClickUntilRef = useRef(0);
  const draggedTrackIdRef = useRef<string | null>(null);
  const trackRowRefs = useRef(new Map<string, HTMLDivElement>());
  const previousTrackRowPositionsRef = useRef(new Map<string, number>());
  const previousTrackIdsRef = useRef<string[]>([]);
  const [dragState, setDragState] = useState<DragState>(null);
  const [hoveredBlock, setHoveredBlock] = useState<HoveredBlockState>(null);
  const [activeSnapIndicator, setActiveSnapIndicator] = useState<ActiveSnapIndicator>(null);
  const [previewGuideTime, setPreviewGuideTime] = useState<number | null>(null);
  const [trackHeight, setTrackHeight] = useState(DEFAULT_TRACK_HEIGHT);
  const [waveformTrackHeight, setWaveformTrackHeight] = useState(DEFAULT_WAVEFORM_TRACK_HEIGHT);
  const [waveformResizeDrag, setWaveformResizeDrag] = useState<{
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
  const timelineWidth = Math.max(TRACK_LABEL_WIDTH + duration * zoom, 1200);
  const trackBlockHeight = Math.round(clampValue(trackHeight - 22, 24, 54));
  const trackBlockTop = Math.round(Math.max(5, (trackHeight - trackBlockHeight) / 2));
  const compactTrackLabels = trackHeight <= 52;
  const waveformViewHeight = Math.max(
    MIN_WAVEFORM_VIEW_HEIGHT,
    waveformTrackHeight - WAVEFORM_TRACK_VERTICAL_PADDING * 2,
  );
  const sliderZoom = Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
  const customBlocks = useMemo(
    () => flattenCustomBlocks(customTracks),
    [customTracks],
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
    const visibleDuration = Math.max(visibleEndTime - visibleStartTime, 0.001);
    const renderWidth = Math.max(
      240,
      Math.min(Math.ceil(visibleDuration * zoom), Math.min(WAVEFORM_MAX_WIDTH, Math.ceil(laneViewportWidth))),
    );

    const points = buildWaveformEnvelope(
      waveformData,
      visibleStartTime,
      visibleEndTime,
      renderWidth,
      waveformViewHeight,
    );

    return {
      ...points,
      left: visibleStartTime * zoom,
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
  const selectedTimelineKeySet = useMemo(
    () => new Set(selectedTimelineItems.map((item) => getTimelineSelectionKey(item.type, item.id, item.type === "custom-block" || item.type === "attached-point" ? item.trackId : undefined))),
    [selectedTimelineItems],
  );
  const marqueePreviewItems = useMemo(
    () => (dragState?.kind === "select-box" ? getItemsInSelectionRect(dragState) : []),
    [dragState, characterAnnotations, actionAnnotations, customBlocks, viewportState],
  );
  const marqueePreviewKeySet = useMemo(
    () => new Set(marqueePreviewItems.map((item) => getTimelineSelectionKey(item.type, item.id, item.type === "custom-block" || item.type === "attached-point" ? item.trackId : undefined))),
    [marqueePreviewItems],
  );
  const playheadViewportOffset = useMemo(
    () => Math.max(0, Math.min(viewportState.width, getCanvasX(currentTime, zoom) - viewportState.scrollLeft)),
    [currentTime, viewportState, zoom],
  );
  const timelineCanvasStyle = useMemo(
    () =>
      ({
        width: timelineWidth,
        "--track-label-width": `${TRACK_LABEL_WIDTH}px`,
        "--track-height": `${trackHeight}px`,
        "--track-block-height": `${trackBlockHeight}px`,
        "--track-block-top": `${trackBlockTop}px`,
        "--waveform-track-height": `${waveformTrackHeight}px`,
      } as CSSProperties),
    [timelineWidth, trackBlockHeight, trackBlockTop, trackHeight, waveformTrackHeight],
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
    return () => {
      if (moveTrackHighlightTimerRef.current !== null) {
        window.clearTimeout(moveTrackHighlightTimerRef.current);
      }
      if (zoomFrameRef.current !== null) {
        cancelAnimationFrame(zoomFrameRef.current);
      }
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
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

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const updateViewport = () => {
      scrollFrameRef.current = null;
      setViewportState({
        scrollLeft: container.scrollLeft,
        width: container.clientWidth,
      });
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
      ...actionAnnotations.flatMap((item) => [item.startTime, item.endTime]),
      ...customBlocks.flatMap((item) => [item.startTime, item.endTime]),
      ...attachedPointTracks.flatMap((track) => track.points.map((point) => point.time)),
      currentTime,
    ];
  }, [subtitleLines, characterAnnotations, actionAnnotations, customBlocks, attachedPointTracks, currentTime]);

  function getLiveSnapPoints() {
    const liveProject = getProjectSnapshot();
    const liveCustomBlocks = flattenCustomBlocks(liveProject.customTracks);
    const liveAttachedPointTracks = flattenAttachedPointTracks(liveProject.builtinTracks, liveProject.customTracks);
    return [
      0,
      ...liveProject.subtitleLines.flatMap((line) => [line.startTime, line.endTime]),
      ...liveProject.characterAnnotations.flatMap((item) => [item.startTime, item.endTime]),
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
        getTimelineSelectionKey(item.type, item.id, item.type === "custom-block" ? item.trackId : undefined),
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
    container.scrollLeft = Math.max(
      0,
      Math.min(getCanvasX(time, zoom) - viewportOffset, maxScrollLeft),
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
        const dragPreview = getCreateTrackPreview(
          activeDragState,
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
            ? { ...prev, currentX: event.clientX }
            : prev,
        );
        return;
      }

      if (activeDragState.kind === "select-box") {
        setActiveSnapIndicator(null);
        setDragState((prev) =>
          prev && prev.kind === "select-box"
            ? {
                ...prev,
                currentX: event.clientX,
                currentY: event.clientY,
              }
            : prev,
        );
        return;
      }

      if (activeDragState.kind === "resize-linked") {
        const next = computeLinkedResizeRange(
          activeDragState,
          deltaSeconds,
          zoom,
          getTrackSnapPoints(activeDragState.trackId, [
            toTimelineSelectionItem(activeDragState.leftItem),
            toTimelineSelectionItem(activeDragState.rightItem),
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
          items: [next.leftItem, next.rightItem],
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
        scheduleDragUpdate({
          target: "attached-point",
          trackId: activeDragState.trackId,
          pointId: activeDragState.id,
          changes: {
            time: resolvedTime.time,
          },
        });
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

    const handlePointerUp = () => {
      const activeDragState = dragStateRef.current;
      const finalSnapLock = dragSnapLockRef.current;
      dragSnapLockRef.current = null;
      clearPreviewFrame();
      setActiveSnapIndicator(null);
      flushPendingDragUpdate();
      if (!activeDragState) {
        setDragState(null);
        return;
      }
      if (
        "originX" in activeDragState &&
        Math.abs(lastPointerClientXRef.current - activeDragState.originX) < DRAG_ACTIVATION_PX
      ) {
        setDragState(null);
        return;
      }
      const liveSnapPoints = getLiveSnapPoints();
      if (activeDragState.kind === "create-track-item" && scrollRef.current) {
        const left = Math.max(0, Math.min(activeDragState.originX, activeDragState.currentX) - activeDragState.laneLeft);
        const right = Math.max(0, Math.max(activeDragState.originX, activeDragState.currentX) - activeDragState.laneLeft);
        const createSnapPoints = getTrackSnapPoints(activeDragState.trackId);
        const startTime = trackSnapEnabled[activeDragState.trackId] ? snapTime(left / zoom, createSnapPoints, zoom) : left / zoom;
        const minDuration = Math.max(0.04, MIN_BLOCK_WIDTH_PX / Math.max(zoom, 1));
        const rawEndTime = right / zoom;
        const snappedEndTime = trackSnapEnabled[activeDragState.trackId]
          ? snapTime(rawEndTime, createSnapPoints, zoom)
          : rawEndTime;
        const endTime = Math.max(startTime + minDuration, snappedEndTime);
        if (endTime - startTime >= minDuration) {
          if (activeDragState.trackType === "character") {
            onCreateCharacterAtTime(startTime, endTime);
          } else if (
            activeDragState.trackType === "custom-text" ||
            activeDragState.trackType === "custom-action"
          ) {
            onCreateCustomBlock(activeDragState.trackId, startTime, endTime);
          } else {
            onCreateAction(activeDragState.trackId, startTime, endTime);
          }
        }
      } else if (activeDragState.kind === "select-box") {
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        const selectedItems = getItemsInSelectionRect(activeDragState);
        onSelectTimelineItems(selectedItems, selectedItems[0] ?? null);
      } else if (activeDragState.kind === "move-selection") {
        const minStartTime = Math.min(...activeDragState.items.map((item) => item.startTime));
        const selectionTrackId = getSelectionTrackId(activeDragState.items);
        const next = computeSelectionMoveRange(
          activeDragState.items,
          Math.max((lastPointerClientXRef.current - activeDragState.originX) / zoom, -minStartTime),
          selectionTrackId,
          zoom,
          true,
        );
        onBatchMoveCommit(
          next.items,
        );
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (activeDragState.kind === "move-point") {
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
              0,
              finalSnapLock,
            ).time
          : rawTime;
        onAttachedPointCommit(activeDragState.trackId, activeDragState.id, {
          time: finalTime,
        });
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (activeDragState.kind === "resize-linked") {
        const next = computeLinkedResizeRange(
          activeDragState,
          (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          zoom,
          getTrackSnapPoints(activeDragState.trackId, [
            toTimelineSelectionItem(activeDragState.leftItem),
            toTimelineSelectionItem(activeDragState.rightItem),
          ]),
          true,
          0,
        );
        onBatchMoveCommit([next.leftItem, next.rightItem]);
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (isLineDrag(activeDragState)) {
        const next = computeNextRange(
          activeDragState.originalStart,
          activeDragState.originalEnd,
          (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          0,
          activeDragState.kind,
          liveSnapPoints,
          zoom,
          true,
        );
        suppressLineClickIdRef.current = activeDragState.id;
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        onLineCommit(activeDragState.id, next);
      } else if (isCharacterDrag(activeDragState)) {
        const next = computeRangeWithTrackSnap({
          originalStart: activeDragState.originalStart,
          originalEnd: activeDragState.originalEnd,
          deltaSeconds: (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          pointerStepPx: 0,
          kind: activeDragState.kind,
          zoomLevel: zoom,
          trackId: "character-track",
          excludedItems: [{ type: "character", id: activeDragState.id }],
          shouldSnap: true,
        });
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        onCharacterCommit(activeDragState.id, {
          startTime: next.startTime,
          endTime: next.endTime,
        });
      } else if (isActionDrag(activeDragState)) {
        const actionAnnotation = actionAnnotations.find((item) => item.id === activeDragState.id);
        const customBlock = customBlocks.find((item) => item.id === activeDragState.id);
        const next = actionAnnotation || customBlock
          ? computeRangeWithTrackSnap({
              originalStart: activeDragState.originalStart,
              originalEnd: activeDragState.originalEnd,
              deltaSeconds: (lastPointerClientXRef.current - activeDragState.originX) / zoom,
              pointerStepPx: 0,
              kind: activeDragState.kind,
              zoomLevel: zoom,
              trackId: actionAnnotation?.trackId ?? customBlock?.trackId ?? "",
              excludedItems: [
                customBlock
                  ? { type: "custom-block", id: activeDragState.id, trackId: customBlock.trackId }
                  : { type: "action", id: activeDragState.id },
              ],
              shouldSnap: true,
            })
          : computeNextRange(
              activeDragState.originalStart,
              activeDragState.originalEnd,
              (lastPointerClientXRef.current - activeDragState.originX) / zoom,
              0,
              activeDragState.kind,
              liveSnapPoints,
              zoom,
              true,
            );
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        if (customBlock) {
          onCustomBlockCommit(customBlock.trackId, activeDragState.id, {
            startTime: next.startTime,
            endTime: next.endTime,
          });
        } else {
          onActionCommit(activeDragState.id, {
            startTime: next.startTime,
            endTime: next.endTime,
          });
        }
      }
      setDragState(null);
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
    <section className="panel timeline-panel">
      <div className="panel-header timeline-panel-header">
        <div className="timeline-header-copy">
          <h2>多轨时间轴</h2>
          <span>点击空白跳转，双击创建，Command/Ctrl + 拖拽可新建 block，自定义轨可在右侧属性面板配置</span>
        </div>
        <div className="timeline-header-actions">
          <div className="timeline-track-actions">
            {missingBuiltinTracks.map((track) => (
              <button key={track.id} type="button" onClick={() => onAddBuiltinTrack(track.id)}>
                {track.id === "character-track"
                  ? "+ 逐字轨"
                  : track.id === "hand-action"
                    ? "+ 手部轨"
                    : "+ 肢体轨"}
              </button>
            ))}
            <button type="button" onClick={() => onAddCustomTrack("text")}>
              + 文字轨
            </button>
            <button type="button" onClick={() => onAddCustomTrack("action")}>
              + 动作轨
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
        </div>
      </div>
      <div
        className="timeline-scroll"
        ref={scrollRef}
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

          <div className="timeline-top-deck">
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
                />
              ))}
            </div>

            <div className="timeline-track waveform-track" style={{ height: waveformTrackHeight }}>
              <div className="track-label waveform-label" style={{ minHeight: waveformTrackHeight }}>
                <div className="track-label-copy">
                  <strong>音频波形</strong>
                  <span>{isWaveformLoading ? "提取中..." : waveformData ? "窗口精细波形" : "暂无波形"}</span>
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
                    setWaveformResizeDrag({
                      startY: event.clientY,
                      startHeight: waveformTrackHeight,
                    });
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
            </div>
          </div>

          <div className="timeline-track-list">
            {trackDefinitions.map((track) => {
              const parentTrackMeta = parentTrackMap.get(track.id);
              const pointTrack = track.type === "attached-point" ? attachedPointTrackMap.get(track.id) : null;
              return (
              <div
                key={track.id}
                className={[
                  "timeline-track",
                  track.type === "attached-point" ? "timeline-track-attached-point" : "",
                  (track.isCustom || track.isBuiltin) && customTrackDropBeforeId === track.id ? "drop-target-before" : "",
                  (track.isCustom || track.isBuiltin) && customTrackDropAfterId === track.id ? "drop-target-after" : "",
                  draggedTrackId === track.id ? "drag-source" : "",
                ].join(" ")}
                style={{ height: track.type === "attached-point" ? Math.max(36, trackHeight - 14) : trackHeight }}
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
                      (selectedItem?.type === "attached-point-track" && selectedItem.id === track.id)
                    ) ? "selected" : "",
                    draggedTrackId === track.id ? "dragging" : "",
                    recentlyMovedTrackId === track.id ? "recently-moved" : "",
                  ].join(" ")}
                  style={
                    draggedTrackId === track.id &&
                      trackReorderDrag &&
                      Math.abs(trackReorderDrag.currentY - trackReorderDrag.startY) >= REORDER_ACTIVATION_PX
                      ? {
                          transform: `translateY(${trackReorderDrag.currentY - trackReorderDrag.startY}px)`,
                          zIndex: 8,
                        }
                      : undefined
                  }
                  onClick={() => {
                    if (track.isBuiltin) {
                      onSelectBuiltinTrack(track.id as BuiltinTrackId);
                    } else if (track.isCustom) {
                      onSelectTrack(track.id);
                    } else if (track.isAttachedPointTrack && track.parentTrackId) {
                      onSelectAttachedPointTrack(track.id, track.parentTrackId);
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
                      <strong>{track.name}</strong>
                      {!compactTrackLabels && track.isCustom ? (
                        <span>{track.type === "custom-text" ? "文字类自定义轨" : "动作类自定义轨"}</span>
                      ) : null}
                      {!compactTrackLabels && track.isBuiltin ? (
                        <span>{track.type === "character" ? "文字类内建轨" : "动作类内建轨"}</span>
                      ) : null}
                      {!compactTrackLabels && track.isAttachedPointTrack ? (
                        <span>{track.parentTrackName ? `附属于 ${track.parentTrackName}` : "附属打点轨"}</span>
                      ) : null}
                    </div>
                    <div className="track-label-footer">
                    {!track.isAttachedPointTrack ? (
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
                      <span className="track-attached-point-caption">附属打点轨</span>
                    )}
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
                    if (event.button !== 0 || target?.closest(".timeline-block, .timeline-point-marker")) {
                      return;
                    }
                    onCloseContextMenu();
                    if (event.metaKey || event.ctrlKey) {
                      if (track.type === "attached-point") {
                        return;
                      }
                      lastPointerClientXRef.current = event.clientX;
                      setDragState({
                        kind: "create-track-item",
                        trackId: track.id,
                        trackType: track.type,
                        originX: event.clientX,
                        currentX: event.clientX,
                        laneLeft: event.currentTarget.getBoundingClientRect().left,
                      });
                      return;
                    }
                    lastPointerClientXRef.current = event.clientX;
                    setDragState({
                      kind: "select-box",
                      originX: event.clientX,
                      originY: event.clientY,
                      currentX: event.clientX,
                      currentY: event.clientY,
                    });
                  }}
                  onClick={(event) => {
                    onCloseContextMenu();
                    if (performance.now() < suppressCanvasClickUntilRef.current) {
                      return;
                    }
                    const target = event.target as HTMLElement | null;
                    const laneTime = getLaneTime(event.currentTarget, event.clientX, zoom);
                    onUpdatePasteTarget(track.id, laneTime);
                    const creationSnapPoints = trackSnapEnabled[track.id]
                      ? [...snapPoints, ...getTrackSnapPoints(track.id)]
                      : [];
                    const snappedLaneTime = trackSnapEnabled[track.id]
                      ? snapTime(laneTime, creationSnapPoints, zoom)
                      : laneTime;
                    if (!target?.closest(".timeline-block, .timeline-point-marker") && event.detail === 2) {
                      if (track.type === "attached-point") {
                        onCreateAttachedPoint(track.id, snappedLaneTime);
                        return;
                      }
                      const startTime = snappedLaneTime;
                      if (track.type === "character") {
                        onCreateCharacterAtTime(startTime);
                        return;
                      }
                      if (track.type === "custom-text" || track.type === "custom-action") {
                        onCreateCustomBlock(track.id, startTime);
                        return;
                      }
                      onCreateActionAtTime(track.id, startTime);
                      return;
                    }
                    if (!target?.closest(".timeline-block, .timeline-point-marker") && selectedTimelineItems.length > 1) {
                      onSelectTimelineItems([], null);
                    }
                    onSeek(laneTime);
                  }}
                  onContextMenu={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (target?.closest(".timeline-block, .timeline-point-marker")) {
                      return;
                    }
                    event.preventDefault();
                    onCloseContextMenu();
                    const laneTime = getLaneTime(event.currentTarget, event.clientX, zoom);
                    onUpdatePasteTarget(track.id, laneTime);
                    onOpenLaneContextMenu(track.id, laneTime, event.clientX, event.clientY);
                  }}
                >
                  {track.type === "character"
                    ? characterAnnotations.map((annotation) => renderBlock(annotation, "character"))
                    : track.type === "action"
                      ? actionAnnotations
                          .filter((annotation) => annotation.trackId === track.id)
                          .map((annotation) => renderBlock(annotation, "action"))
                      : track.type === "attached-point"
                        ? pointTrack
                          ? pointTrack.points.map((point) => renderAttachedPoint(point, pointTrack))
                          : []
                      : customBlocks
                          .filter((annotation) => annotation.trackId === track.id)
                          .map((annotation) => renderBlock(annotation, "custom-block"))}
                  {dragState?.kind === "create-track-item" && dragState.trackId === track.id && scrollRef.current ? (
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
              style={getSelectionBoxStyle(dragState, scrollRef.current)}
            />
          ) : null}

          {activeSnapIndicator ? (
            <div
              className={`timeline-snap-guide ${activeSnapIndicator.edge}`}
              style={{ left: getCanvasX(activeSnapIndicator.time, zoom) }}
            />
          ) : null}

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
    </section>
  );

  function renderBlock(
    annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
    type: "character" | "action" | "custom-block",
  ) {
    const characterAnnotation = type === "character" ? annotation as CharacterAnnotation : null;
    const actionAnnotation = type === "action" ? annotation as ActionAnnotation : null;
    const customAnnotation = type === "custom-block" ? annotation as ResolvedCustomTrackBlock : null;
    const currentSelectionItem = customAnnotation
      ? { type: "custom-block" as const, id: annotation.id, trackId: customAnnotation.trackId }
      : characterAnnotation
        ? { type: "character" as const, id: annotation.id }
        : { type: "action" as const, id: annotation.id };
    const currentSelectedItem = customAnnotation
      ? { type: "custom-block" as const, id: annotation.id, trackId: customAnnotation.trackId }
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
    const zIndex = isSelected ? 4 : isActive ? 3 : 1;
    const hoveredEdge = hoveredBlock?.id === annotation.id &&
      hoveredBlock.type === type &&
      (!customAnnotation || (hoveredBlock.type === "custom-block" && hoveredBlock.trackId === customAnnotation.trackId))
      ? hoveredBlock.edge
      : null;

    return (
      <div
        key={annotation.id}
        data-block-id={annotation.id}
        data-block-type={type}
        data-block-track-id={customAnnotation?.trackId}
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
        ].join(" ")}
        style={{ left, width, top: trackBlockTop, height: trackBlockHeight, zIndex }}
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
          if (event.metaKey || event.ctrlKey) {
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
              .map((item) => {
                if (item.type === "attached-point") {
                  const livePointTrack = findResolvedAttachedPointTrack(liveProject, item.trackId);
                  const livePoint = livePointTrack?.points.find((candidate) => candidate.id === item.id);
                  return livePoint
                    ? {
                        type: "attached-point" as const,
                        id: item.id,
                        trackId: item.trackId,
                        parentTrackId: item.parentTrackId,
                        startTime: livePoint.time,
                        endTime: livePoint.time,
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
                return {
                  type: item.type,
                  id: item.id,
                  ...(item.type === "custom-block" ? { trackId: item.trackId } : {}),
                  startTime: liveSelectionAnnotation.startTime,
                  endTime: liveSelectionAnnotation.endTime,
                };
              })
              .filter((item): item is TimelineBatchMoveItem => item !== null);
            setDragState({
              kind: "move-selection",
              originX: event.clientX,
              items: selectionItems,
            });
            return;
          }
          const trackId = getTrackIdForAnnotation(targetAnnotation, targetType);
          const linkedPair = isLinkedEdgeHit(targetEdge) && trackSnapEnabled[trackId]
            ? findLinkedPair(
                targetAnnotation,
                targetType,
                targetEdge === "linked-left" ? "left" : "right",
                liveProject.characterAnnotations,
                liveProject.actionAnnotations,
                flattenCustomBlocks(liveProject.customTracks),
                zoom,
              )
            : null;
          if (linkedPair) {
            setDragState({
              kind: "resize-linked",
              trackId,
              originX: event.clientX,
              boundaryTime: linkedPair.leftItem.endTime,
              leftItem: linkedPair.leftItem,
              rightItem: linkedPair.rightItem,
            });
            setHoveredBlock(buildHoveredBlockState(targetAnnotation.id, targetType, targetEdge, trackId));
            onSelectItem(
              targetType === "custom-block"
                ? { type: "custom-block", trackId, id: targetAnnotation.id }
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
              ? { type: "custom-block", trackId, id: targetAnnotation.id }
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
          if (event.metaKey || event.ctrlKey) {
            const nextItems = toggleTimelineSelectionItem(currentSelectionItem);
            const lastItem = nextItems[nextItems.length - 1];
            const primaryItem = lastItem
              ? lastItem.type === "custom-block"
                ? {
                    type: "custom-block",
                    id: lastItem.id,
                    trackId: lastItem.trackId,
                  } as SelectedItem
                : lastItem.type === "attached-point"
                  ? {
                      type: "attached-point",
                      id: lastItem.id,
                      trackId: lastItem.trackId,
                      parentTrackId: lastItem.parentTrackId,
                    } as SelectedItem
                : {
                    type: lastItem.type,
                    id: lastItem.id,
                  } as SelectedItem
              : null;
            onSelectTimelineItems(nextItems, primaryItem);
            return;
          }
          onSelectItem(currentSelectedItem);
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
          <span>{label}</span>
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
    const isActive = Math.abs(currentTime - point.time) <= 0.05;
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
        style={{ left: point.time * zoom, zIndex }}
        data-point-id={point.id}
        data-point-track-id={pointTrack.id}
        data-point-parent-track-id={pointTrack.parentTrackId}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          event.stopPropagation();
          onCloseContextMenu();
          if (event.metaKey || event.ctrlKey) {
            return;
          }
          lastPointerClientXRef.current = event.clientX;
          const liveProject = getProjectSnapshot();
          const shouldMoveSelection =
            selectedTimelineItems.length > 1 &&
            selectedTimelineKeySet.has(selectionKey);
          if (shouldMoveSelection) {
            const selectionItems = selectedTimelineItems
              .map((item) => {
                if (item.type === "attached-point") {
                  const livePointTrack = findResolvedAttachedPointTrack(liveProject, item.trackId);
                  const livePoint = livePointTrack?.points.find((candidate) => candidate.id === item.id);
                  return livePoint
                    ? {
                        type: "attached-point" as const,
                        id: item.id,
                        trackId: item.trackId,
                        parentTrackId: item.parentTrackId,
                        startTime: livePoint.time,
                        endTime: livePoint.time,
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
                return {
                  type: item.type,
                  id: item.id,
                  ...(item.type === "custom-block" ? { trackId: item.trackId } : {}),
                  startTime: liveSelectionAnnotation.startTime,
                  endTime: liveSelectionAnnotation.endTime,
                };
              })
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
          if (event.metaKey || event.ctrlKey) {
            const nextItems = toggleTimelineSelectionItem(selectionItem);
            const lastItem = nextItems[nextItems.length - 1];
            const primaryItem = lastItem
              ? lastItem.type === "custom-block"
                ? { type: "custom-block", id: lastItem.id, trackId: lastItem.trackId } as SelectedItem
                : lastItem.type === "attached-point"
                  ? {
                      type: "attached-point",
                      id: lastItem.id,
                      trackId: lastItem.trackId,
                      parentTrackId: lastItem.parentTrackId,
                    } as SelectedItem
                  : { type: lastItem.type, id: lastItem.id } as SelectedItem
              : null;
            onSelectTimelineItems(nextItems, primaryItem);
            return;
          }
          onSelectItem({
            type: "attached-point",
            id: point.id,
            trackId: pointTrack.id,
            parentTrackId: pointTrack.parentTrackId,
          });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCloseContextMenu();
          onUpdatePasteTarget(pointTrack.id, point.time);
          onSelectItem({
            type: "attached-point",
            id: point.id,
            trackId: pointTrack.id,
            parentTrackId: pointTrack.parentTrackId,
          });
        }}
        title={`${pointTrack.name} · ${point.label}`}
      >
        <span className="timeline-point-stem" />
        <span className="timeline-point-dot" />
        <span className="timeline-point-chip">{point.label}</span>
      </button>
    );
  }

  function queueZoom(nextZoom: number, anchorTime?: number, viewportOffset?: number) {
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
    sliderZoomRef.current = {
      anchorTime: currentTimeRef.current,
      viewportOffset: getViewportOffsetForTime(container, currentTimeRef.current, zoomRef.current),
    };
    zoomInteractionUntilRef.current = Number.POSITIVE_INFINITY;
  }

  function finishSliderZoom() {
    sliderZoomRef.current = null;
    zoomInteractionUntilRef.current = Date.now() + ZOOM_SETTLE_MS;
  }

  function scheduleDragUpdate(update: PendingDragUpdate) {
    pendingDragUpdateRef.current = update;
    if (dragFrameRef.current !== null) {
      return;
    }
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      flushPendingDragUpdate();
    });
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
      item.type === "custom-block" || item.type === "attached-point" ? item.trackId : undefined,
    );
    if (selectedTimelineKeySet.has(itemKey)) {
      return selectedTimelineItems.filter((selectedItem) =>
        getTimelineSelectionKey(
          selectedItem.type,
          selectedItem.id,
          selectedItem.type === "custom-block" || selectedItem.type === "attached-point" ? selectedItem.trackId : undefined,
        ) !== itemKey
      );
    }
    return [...selectedTimelineItems, item];
  }

  function getItemsInSelectionRect(
    selectionDragState: Extract<NonNullable<DragState>, { kind: "select-box" }>,
  ) {
    const selectionRect = getClientSelectionRect(selectionDragState);
    if (!selectionRect) {
      return [];
    }

    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(".timeline-block[data-block-id][data-block-type], .timeline-point-marker[data-point-id][data-point-track-id]"),
    );

    return candidates
      .flatMap((element) => {
        const bounds = element.getBoundingClientRect();
        if (!rectsIntersect(selectionRect, bounds)) {
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
        const id = element.dataset.blockId;
        const type = element.dataset.blockType;
        const trackId = element.dataset.blockTrackId;
        if (!id || (type !== "character" && type !== "action" && type !== "custom-block")) {
          return [];
        }
        return [
          type === "custom-block"
            ? { id, type, trackId: trackId ?? "" }
            : { id, type },
        ] as TimelineSelectionItem[];
      })
      .sort((left, right) => {
        const leftStartTime = left.type === "attached-point"
          ? attachedPointTrackMap.get(left.trackId)?.points.find((point) => point.id === left.id)?.time ?? 0
          : findAnnotationById(
              left.id,
              left.type,
              characterAnnotations,
              actionAnnotations,
              customBlocks,
              left.type === "custom-block" ? left.trackId : undefined,
            )?.startTime ?? 0;
        const rightStartTime = right.type === "attached-point"
          ? attachedPointTrackMap.get(right.trackId)?.points.find((point) => point.id === right.id)?.time ?? 0
          : findAnnotationById(
              right.id,
              right.type,
              characterAnnotations,
              actionAnnotations,
              customBlocks,
              right.type === "custom-block" ? right.trackId : undefined,
            )?.startTime ?? 0;
        return leftStartTime - rightStartTime || left.id.localeCompare(right.id);
      });
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
): EdgeHit {
  const rect = element.getBoundingClientRect();
  const offset = clientX - rect.left;
  const edgeHitSlop = getEdgeHitSlop(element);
  const linkedEdgeHitSlop = getLinkedEdgeHitSlop(element);
  const rightOffset = rect.width - offset;

  if (offset < edgeHitSlop) {
    const linkedPair = hasLinkedPairForEdge(
      annotation,
      type,
      "left",
      characterAnnotations,
      actionAnnotations,
      customBlocks,
      trackSnapEnabled,
      zoom,
    );
    if (linkedPair && offset <= linkedEdgeHitSlop) {
      return "linked-left";
    }
    return "left";
  }
  if (rightOffset < edgeHitSlop) {
    const linkedPair = hasLinkedPairForEdge(
      annotation,
      type,
      "right",
      characterAnnotations,
      actionAnnotations,
      customBlocks,
      trackSnapEnabled,
      zoom,
    );
    if (linkedPair && rightOffset <= linkedEdgeHitSlop) {
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

function hasLinkedPairForEdge(
  annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
  type: "character" | "action" | "custom-block",
  edge: "left" | "right",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
  trackSnapEnabled: Record<string, boolean>,
  zoom: number,
) {
  const trackId = getTrackIdForAnnotation(annotation, type);
  if (!trackSnapEnabled[trackId]) {
    return null;
  }
  return findLinkedPair(annotation, type, edge, characterAnnotations, actionAnnotations, customBlocks, zoom);
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

function findLinkedPair(
  annotation: CharacterAnnotation | ActionAnnotation | ResolvedCustomTrackBlock,
  type: "character" | "action" | "custom-block",
  edge: "left" | "right",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  customBlocks: ResolvedCustomTrackBlock[],
  zoom: number,
) {
  const items = type === "character"
    ? sortCharactersByTimeLocal(characterAnnotations)
    : type === "custom-block"
      ? sortCustomBlocksByTimeLocal(
          customBlocks.filter((item) => item.trackId === (annotation as ResolvedCustomTrackBlock).trackId),
        )
    : sortActionsByTimeLocal(
        actionAnnotations.filter((item) => item.trackId === (annotation as ActionAnnotation).trackId),
      );
  const index = items.findIndex((item) => item.id === annotation.id);
  if (index === -1) {
    return null;
  }
  if (edge === "right") {
    const rightNeighbor = items[index + 1];
    if (
      !rightNeighbor ||
      Math.abs(annotation.endTime - rightNeighbor.startTime) > getSnapToleranceSeconds(zoom)
    ) {
      return null;
    }
    return {
      leftItem: toBatchMoveItem(annotation, type),
      rightItem: toBatchMoveItem(rightNeighbor, type),
    };
  }
  const leftNeighbor = items[index - 1];
  if (
    !leftNeighbor ||
    Math.abs(leftNeighbor.endTime - annotation.startTime) > getSnapToleranceSeconds(zoom)
  ) {
    return null;
  }
  return {
    leftItem: toBatchMoveItem(leftNeighbor, type),
    rightItem: toBatchMoveItem(annotation, type),
  };
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
  const minBoundary = dragState.leftItem.startTime + minDuration;
  const maxBoundary = dragState.rightItem.endTime - minDuration;
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
    leftItem: {
      ...dragState.leftItem,
      endTime: snappedBoundary,
    },
    rightItem: {
      ...dragState.rightItem,
      startTime: snappedBoundary,
    },
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

function sortCharactersByTimeLocal(characters: CharacterAnnotation[]) {
  return [...characters].sort((left, right) =>
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id),
  );
}

function sortActionsByTimeLocal(actions: ActionAnnotation[]) {
  return [...actions].sort((left, right) =>
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id),
  );
}

function sortCustomBlocksByTimeLocal(blocks: ResolvedCustomTrackBlock[]) {
  return [...blocks].sort((left, right) =>
    left.startTime - right.startTime ||
    left.endTime - right.endTime ||
    left.id.localeCompare(right.id),
  );
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
  container: HTMLDivElement,
) {
  const bounds = container.getBoundingClientRect();
  const left = Math.min(dragState.originX, dragState.currentX) - bounds.left + container.scrollLeft;
  const top = Math.min(dragState.originY, dragState.currentY) - bounds.top + container.scrollTop;
  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.abs(dragState.currentX - dragState.originX),
    height: Math.abs(dragState.currentY - dragState.originY),
  };
}

function getClientSelectionRect(
  dragState: Extract<NonNullable<DragState>, { kind: "select-box" }>,
) {
  return {
    left: Math.min(dragState.originX, dragState.currentX),
    right: Math.max(dragState.originX, dragState.currentX),
    top: Math.min(dragState.originY, dragState.currentY),
    bottom: Math.max(dragState.originY, dragState.currentY),
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
  return actionAnnotations.find((actionItem) => actionItem.id === item.id)?.trackId ??
    customBlocks.find((block) => block.id === item.id)?.trackId ??
    null;
}

function getTimelineSelectionKey(
  type: "character" | "action" | "custom-block" | "attached-point",
  id: string,
  trackId?: string,
) {
  return type === "custom-block" || type === "attached-point"
    ? `${type}:${trackId ?? ""}:${id}`
    : `${type}:${id}`;
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
  const sampleStart = Math.max(0, Math.floor(startTime * waveformData.sampleRate));
  const sampleEnd = Math.min(
    waveformData.samples.length,
    Math.max(sampleStart + 1, Math.ceil(endTime * waveformData.sampleRate)),
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
