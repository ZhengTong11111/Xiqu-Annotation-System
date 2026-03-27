import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ActionAnnotation,
  CharacterAnnotation,
  ProjectData,
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
  characterAnnotations: CharacterAnnotation[];
  actionAnnotations: ActionAnnotation[];
  trackDefinitions: TrackDefinition[];
  waveformData: WaveformData | null;
  isWaveformLoading: boolean;
  currentTime: number;
  selectedItem: SelectedItem;
  selectedTimelineItems: TimelineSelectionItem[];
  trackSnapEnabled: Record<string, boolean>;
  zoom: number;
  duration: number;
  focusRange: { start: number; end: number } | null;
  getProjectSnapshot: () => ProjectData;
  editingCharacterId: string | null;
  editingCharacterLocation: "timeline" | "split-panel" | null;
  editingCharacterValue: string;
  onZoomChange: (zoom: number) => void;
  onToggleTrackSnap: (trackId: string) => void;
  onSeek: (time: number) => void;
  onPreviewFrame: (time: number | null) => void;
  onSelectItem: (item: SelectedItem) => void;
  onSelectTimelineItems: (items: TimelineSelectionItem[], primaryItem: SelectedItem) => void;
  onEditCharacterText: (id: string) => void;
  onEditingCharacterValueChange: (value: string) => void;
  onCommitCharacterTextEdit: (id: string) => void;
  onCancelCharacterTextEdit: () => void;
  onCreateCharacterAtTime: (time: number, endTime?: number) => void;
  onCreateActionAtTime: (trackId: string, startTime: number) => void;
  onOpenCharacterContextMenu: (id: string, x: number, y: number) => void;
  onLineChange: (id: string, changes: Pick<SubtitleLine, "startTime" | "endTime">) => void;
  onLineCommit: (id: string, changes: Pick<SubtitleLine, "startTime" | "endTime">) => void;
  onCharacterChange: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onCharacterCommit: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onActionChange: (id: string, changes: Partial<ActionAnnotation>) => void;
  onActionCommit: (id: string, changes: Partial<ActionAnnotation>) => void;
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
      trackType: "character" | "action";
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

const TRACK_HEIGHT = 72;
const TRACK_LABEL_WIDTH = 150;
const SNAP_SECONDS = 0.05;
const ZOOM_SETTLE_MS = 220;
const DRAG_ACTIVATION_PX = 4;
const EDGE_HIT_SLOP_PX = 8;
const SELECTED_EDGE_HIT_SLOP_PX = 17;
const LINKED_EDGE_HIT_RATIO = 0.55;
const MIN_LINKED_EDGE_HIT_SLOP_PX = 4;
const PREVIEW_UPDATE_EPSILON = 1 / 60;
const MIN_BLOCK_WIDTH_PX = 44;
const WAVEFORM_VIEW_HEIGHT = 56;
const WAVEFORM_MAX_WIDTH = 1800;
const CLICK_SUPPRESS_MS = 120;

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
      target: "selection";
      items: TimelineBatchMoveItem[];
    };

type HoveredBlockState = {
  id: string;
  type: "character" | "action";
  edge: EdgeHit;
} | null;

type ActiveSnapIndicator = {
  trackId: string;
  time: number;
  edge: "left" | "right";
} | null;

type EdgeHit = "left" | "right" | "center" | "linked-left" | "linked-right";

export function Timeline({
  subtitleLines,
  characterAnnotations,
  actionAnnotations,
  trackDefinitions,
  waveformData,
  isWaveformLoading,
  currentTime,
  selectedItem,
  selectedTimelineItems,
  trackSnapEnabled,
  zoom,
  duration,
  focusRange,
  getProjectSnapshot,
  editingCharacterId,
  editingCharacterLocation,
  editingCharacterValue,
  onZoomChange,
  onToggleTrackSnap,
  onSeek,
  onPreviewFrame,
  onSelectItem,
  onSelectTimelineItems,
  onEditCharacterText,
  onEditingCharacterValueChange,
  onCommitCharacterTextEdit,
  onCancelCharacterTextEdit,
  onCreateCharacterAtTime,
  onCreateActionAtTime,
  onOpenCharacterContextMenu,
  onLineChange,
  onLineCommit,
  onCharacterChange,
  onCharacterCommit,
  onActionChange,
  onActionCommit,
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
  const scrollFrameRef = useRef<number | null>(null);
  const suppressLineClickIdRef = useRef<string | null>(null);
  const suppressCanvasClickUntilRef = useRef(0);
  const [dragState, setDragState] = useState<DragState>(null);
  const [hoveredBlock, setHoveredBlock] = useState<HoveredBlockState>(null);
  const [activeSnapIndicator, setActiveSnapIndicator] = useState<ActiveSnapIndicator>(null);
  const [viewportState, setViewportState] = useState({ scrollLeft: 0, width: 0 });
  const timelineWidth = Math.max(TRACK_LABEL_WIDTH + duration * zoom, 1200);
  const sliderZoom = Math.round(zoom / 10) * 10;
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
      WAVEFORM_VIEW_HEIGHT,
    );

    return {
      ...points,
      left: visibleStartTime * zoom,
      width: Math.max(visibleDuration * zoom, 1),
    };
  }, [duration, viewportState, waveformData, zoom]);
  const selectedTimelineKeySet = useMemo(
    () => new Set(selectedTimelineItems.map((item) => getTimelineSelectionKey(item.type, item.id))),
    [selectedTimelineItems],
  );
  const marqueePreviewItems = useMemo(
    () => (dragState?.kind === "select-box" ? getItemsInSelectionRect(dragState) : []),
    [dragState, characterAnnotations, actionAnnotations, viewportState],
  );
  const marqueePreviewKeySet = useMemo(
    () => new Set(marqueePreviewItems.map((item) => getTimelineSelectionKey(item.type, item.id))),
    [marqueePreviewItems],
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
      if (zoomFrameRef.current !== null) {
        cancelAnimationFrame(zoomFrameRef.current);
      }
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
      }
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
      }
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

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
      currentTime,
    ];
  }, [subtitleLines, characterAnnotations, actionAnnotations, currentTime]);

  function getLiveSnapPoints() {
    const liveProject = getProjectSnapshot();
    return [
      0,
      ...liveProject.subtitleLines.flatMap((line) => [line.startTime, line.endTime]),
      ...liveProject.characterAnnotations.flatMap((item) => [item.startTime, item.endTime]),
      ...liveProject.actionAnnotations.flatMap((item) => [item.startTime, item.endTime]),
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
    const excludedKeySet = new Set(excludedItems.map((item) => getTimelineSelectionKey(item.type, item.id)));
    const liveProject = getProjectSnapshot();
    if (trackId === "character-track") {
      return liveProject.characterAnnotations.flatMap((item) =>
        excludedKeySet.has(getTimelineSelectionKey("character", item.id))
          ? []
          : [item.startTime, item.endTime],
      );
    }
    return liveProject.actionAnnotations.flatMap((item) =>
      item.trackId === trackId && !excludedKeySet.has(getTimelineSelectionKey("action", item.id))
        ? [item.startTime, item.endTime]
        : [],
    );
  }

  function computeRangeWithTrackSnap(params: {
    originalStart: number;
    originalEnd: number;
    deltaSeconds: number;
    kind: Exclude<NonNullable<DragState>, { kind: "create-track-item" | "select-box" }>["kind"];
    zoomLevel: number;
    trackId: string;
    excludedItems?: TimelineSelectionItem[];
    shouldSnap: boolean;
  }) {
    const {
      originalStart,
      originalEnd,
      deltaSeconds,
      kind,
      zoomLevel,
      trackId,
      excludedItems = [],
      shouldSnap,
    } = params;
    const snapPoints = shouldSnap ? getTrackSnapPoints(trackId, excludedItems) : [];
    return computeNextRange(
      originalStart,
      originalEnd,
      deltaSeconds,
      kind,
      snapPoints,
      zoomLevel,
      shouldSnap,
    );
  }

  function getSelectionTrackId(items: TimelineBatchMoveItem[]) {
    if (items.length === 0) {
      return null;
    }
    const resolvedFirstTrackId = items[0].type === "character"
      ? "character-track"
      : actionAnnotations.find((item) => item.id === items[0].id)?.trackId ?? null;
    if (!resolvedFirstTrackId) {
      return null;
    }
    for (const item of items.slice(1)) {
      const trackId = item.type === "character"
        ? "character-track"
        : actionAnnotations.find((actionItem) => actionItem.id === item.id)?.trackId ?? null;
      if (trackId !== resolvedFirstTrackId) {
        return null;
      }
    }
    return resolvedFirstTrackId;
  }

  function computeSelectionMoveRange(
    items: TimelineBatchMoveItem[],
    deltaSeconds: number,
    trackId: string | null,
    zoomLevel: number,
    shouldSnap: boolean,
  ) {
    const originalStart = Math.min(...items.map((item) => item.startTime));
    const originalEnd = Math.max(...items.map((item) => item.endTime));
    const nextRange = trackId
      ? computeRangeWithTrackSnap({
          originalStart,
          originalEnd,
          deltaSeconds,
          kind: "move-selection",
          zoomLevel,
          trackId,
          excludedItems: items.map((item) => ({ type: item.type, id: item.id })),
          shouldSnap,
        })
      : computeNextRange(
          originalStart,
          originalEnd,
          deltaSeconds,
          "move-selection",
          [],
          zoomLevel,
          false,
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
    const left = Math.max(0, getCanvasX(focusRange.start, zoom) - 120);
    scrollRef.current.scrollTo({ left, behavior: "smooth" });
  }, [focusRange]);

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    if (Date.now() < zoomInteractionUntilRef.current) {
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
      lastPointerClientXRef.current = event.clientX;
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
        clearPreviewFrame();
        setActiveSnapIndicator(null);
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
            { type: activeDragState.leftItem.type, id: activeDragState.leftItem.id },
            { type: activeDragState.rightItem.type, id: activeDragState.rightItem.id },
          ]),
          true,
        );
        setActiveSnapIndicator(
          next.snappedTo ? { trackId: activeDragState.trackId, ...next.snappedTo } : null,
        );
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
        );
        setActiveSnapIndicator(
          trackRange.snappedTo && selectionTrackId
            ? { trackId: selectionTrackId, ...trackRange.snappedTo }
            : null,
        );
        scheduleDragUpdate({
          target: "selection",
          items: trackRange.items,
        });
        return;
      }

      if (isLineDrag(activeDragState)) {
        setActiveSnapIndicator(null);
        const next = computeNextRange(
          activeDragState.originalStart,
          activeDragState.originalEnd,
          deltaSeconds,
          activeDragState.kind,
          liveSnapPoints,
          zoom,
          false,
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
          kind: activeDragState.kind,
          zoomLevel: zoom,
          trackId,
          excludedItems: [{ type: "character", id: activeDragState.id }],
          shouldSnap: true,
        });
        setActiveSnapIndicator(
          next.snappedTo ? { trackId, ...next.snappedTo } : null,
        );
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
      const trackId = actionAnnotation?.trackId ?? null;
      const next = trackId
        ? computeRangeWithTrackSnap({
            originalStart: activeDragState.originalStart,
            originalEnd: activeDragState.originalEnd,
            deltaSeconds,
            kind: activeDragState.kind,
            zoomLevel: zoom,
            trackId,
            excludedItems: [{ type: "action", id: activeDragState.id }],
            shouldSnap: true,
          })
        : computeNextRange(
          activeDragState.originalStart,
          activeDragState.originalEnd,
          deltaSeconds,
          activeDragState.kind,
          liveSnapPoints,
          zoom,
          false,
        );
      setActiveSnapIndicator(
        next.snappedTo && trackId ? { trackId, ...next.snappedTo } : null,
      );
      scheduleDragUpdate({
        target: "action",
        id: activeDragState.id,
        changes: {
          startTime: next.startTime,
          endTime: next.endTime,
        },
      });
      updatePreviewFrame(activeDragState.kind, next);
    };

    const handlePointerUp = () => {
      const activeDragState = dragStateRef.current;
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
        const startTime = trackSnapEnabled[activeDragState.trackId] ? snapTime(left / zoom, createSnapPoints) : left / zoom;
        const minDuration = Math.max(0.04, MIN_BLOCK_WIDTH_PX / Math.max(zoom, 1));
        const rawEndTime = right / zoom;
        const snappedEndTime = trackSnapEnabled[activeDragState.trackId]
          ? snapTime(rawEndTime, createSnapPoints)
          : rawEndTime;
        const endTime = Math.max(startTime + minDuration, snappedEndTime);
        if (endTime - startTime >= minDuration) {
          if (activeDragState.trackType === "character") {
            onCreateCharacterAtTime(startTime, endTime);
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
      } else if (activeDragState.kind === "resize-linked") {
        const next = computeLinkedResizeRange(
          activeDragState,
          (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          zoom,
          getTrackSnapPoints(activeDragState.trackId, [
            { type: activeDragState.leftItem.type, id: activeDragState.leftItem.id },
            { type: activeDragState.rightItem.type, id: activeDragState.rightItem.id },
          ]),
          true,
        );
        onBatchMoveCommit([next.leftItem, next.rightItem]);
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      } else if (isLineDrag(activeDragState)) {
        const next = computeNextRange(
          activeDragState.originalStart,
          activeDragState.originalEnd,
          (lastPointerClientXRef.current - activeDragState.originX) / zoom,
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
        const next = actionAnnotation
          ? computeRangeWithTrackSnap({
              originalStart: activeDragState.originalStart,
              originalEnd: activeDragState.originalEnd,
              deltaSeconds: (lastPointerClientXRef.current - activeDragState.originX) / zoom,
              kind: activeDragState.kind,
              zoomLevel: zoom,
              trackId: actionAnnotation.trackId,
              excludedItems: [{ type: "action", id: activeDragState.id }],
              shouldSnap: true,
            })
          : computeNextRange(
              activeDragState.originalStart,
              activeDragState.originalEnd,
              (lastPointerClientXRef.current - activeDragState.originX) / zoom,
              activeDragState.kind,
              liveSnapPoints,
              zoom,
              true,
            );
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        onActionCommit(activeDragState.id, {
          startTime: next.startTime,
          endTime: next.endTime,
        });
      }
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, zoom, snapPoints, characterAnnotations, actionAnnotations, selectedTimelineItems, onLineChange, onLineCommit, onCharacterChange, onCharacterCommit, onActionChange, onActionCommit, onBatchMoveChange, onBatchMoveCommit, onCreateAction, onCreateCharacterAtTime, onPreviewFrame, onSelectTimelineItems]);

  const ticks = useMemo(() => {
    const step = zoom >= 160 ? 0.5 : zoom >= 100 ? 1 : 2;
    return Array.from({ length: Math.ceil(duration / step) + 1 }, (_, index) => index * step);
  }, [duration, zoom]);

  return (
    <section className="panel timeline-panel">
      <div className="panel-header">
        <div className="timeline-header-copy">
          <h2>多轨时间轴</h2>
          <span>点击空白跳转，双击创建，Command/Ctrl + 拖拽可新建字块或动作片段</span>
        </div>
        <div className="timeline-zoom-controls">
          <button type="button" onClick={() => handleZoomStep(-20)}>
            -
          </button>
          <label className="zoom-control timeline-zoom-control">
            <span>缩放</span>
            <input
              type="range"
              min={40}
              max={240}
              step={10}
              value={sliderZoom}
              onPointerDown={startSliderZoom}
              onPointerUp={finishSliderZoom}
              onPointerCancel={finishSliderZoom}
              onBlur={finishSliderZoom}
              onChange={(event) => handleZoomSliderChange(Number(event.target.value))}
            />
            <strong>{Math.round(zoom)}px/s</strong>
          </label>
          <button type="button" onClick={() => handleZoomStep(20)}>
            +
          </button>
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
        <div className="timeline-canvas" style={{ width: timelineWidth }}>
          <div className="timeline-ruler">
            {ticks.map((tick) => (
              <div
                key={tick}
                className="tick"
                style={{ left: getCanvasX(tick, zoom) }}
                onClick={() => onSeek(tick)}
              >
                <span>{formatTimelineTickLabel(tick)}</span>
              </div>
            ))}
          </div>

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
                  onSelectItem({ type: "line", id: line.id });
                  onSeek(line.startTime);
                }}
                title={line.text}
              />
            ))}
          </div>

          <div className="timeline-track waveform-track" style={{ height: TRACK_HEIGHT }}>
            <div className="track-label waveform-label">
              <div className="track-label-copy">
                <strong>音频波形</strong>
                <span>{isWaveformLoading ? "提取中..." : waveformData ? "窗口精细波形" : "暂无波形"}</span>
              </div>
            </div>
            <div
              className="track-lane waveform-lane"
              onClick={(event) => {
                onSeek(getLaneTime(event.currentTarget, event.clientX, zoom));
              }}
            >
              {waveformDetail ? (
                <svg
                  className="waveform-detail-svg"
                  viewBox={`0 0 ${waveformDetail.viewWidth} ${WAVEFORM_VIEW_HEIGHT}`}
                  preserveAspectRatio="none"
                  style={{
                    left: waveformDetail.left,
                    width: waveformDetail.width,
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

          {trackDefinitions.map((track) => (
            <div
              key={track.id}
              className="timeline-track"
              style={{ height: TRACK_HEIGHT }}
            >
              <div className="track-label">
                <div className="track-label-copy">
                  <strong>{track.name}</strong>
                  <label className="track-snap-toggle" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={Boolean(trackSnapEnabled[track.id])}
                      onChange={() => onToggleTrackSnap(track.id)}
                    />
                    <span>吸附</span>
                  </label>
                </div>
              </div>
              <div
                className="track-lane"
                onPointerDown={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (event.button !== 0 || target?.closest(".timeline-block")) {
                    return;
                  }
                  if (event.metaKey || event.ctrlKey) {
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
                  if (performance.now() < suppressCanvasClickUntilRef.current) {
                    return;
                  }
                  const target = event.target as HTMLElement | null;
                  const laneTime = getLaneTime(event.currentTarget, event.clientX, zoom);
                  if (!target?.closest(".timeline-block") && event.detail === 2) {
                    const startTime = snapTime(laneTime, snapPoints);
                    if (track.type === "character") {
                      onCreateCharacterAtTime(startTime);
                      return;
                    }
                    onCreateActionAtTime(track.id, startTime);
                    return;
                  }
                  if (!target?.closest(".timeline-block") && selectedTimelineItems.length > 1) {
                    onSelectTimelineItems([], null);
                  }
                  onSeek(laneTime);
                }}
              >
                {track.type === "character"
                  ? characterAnnotations.map((annotation) => renderBlock(annotation, "character"))
                  : actionAnnotations
                      .filter((annotation) => annotation.trackId === track.id)
                      .map((annotation) => renderBlock(annotation, "action"))}
                {dragState?.kind === "create-track-item" && dragState.trackId === track.id && scrollRef.current ? (
                  <div
                    className={`timeline-block draft ${dragState.trackType === "character" ? "character" : "action"}`}
                    style={getDraftStyle(dragState)}
                  />
                ) : null}
              </div>
            </div>
          ))}

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

          <div className="playhead" style={{ left: getCanvasX(currentTime, zoom) }} />
        </div>
      </div>
    </section>
  );

  function renderBlock(
    annotation: CharacterAnnotation | ActionAnnotation,
    type: "character" | "action",
  ) {
    const selectionKey = getTimelineSelectionKey(type, annotation.id);
    const isSelected =
      selectedTimelineKeySet.has(selectionKey) || marqueePreviewKeySet.has(selectionKey);
    const isPartOfMultiSelection = selectedTimelineKeySet.has(selectionKey) && selectedTimelineItems.length > 1;
    const isActive = currentTime >= annotation.startTime && currentTime <= annotation.endTime;
    const isEditing = type === "character" &&
      editingCharacterId === annotation.id &&
      editingCharacterLocation === "timeline";
    const left = annotation.startTime * zoom;
    const width = Math.max((annotation.endTime - annotation.startTime) * zoom, 8);
    const label = "char" in annotation ? annotation.char : annotation.label;
    const zIndex = isSelected ? 4 : isActive ? 3 : 1;
    const hoveredEdge = hoveredBlock?.id === annotation.id && hoveredBlock.type === type
      ? hoveredBlock.edge
      : null;

    return (
      <div
        key={annotation.id}
        data-block-id={annotation.id}
        data-block-type={type}
        className={[
          "timeline-block",
          type,
          isSelected ? "selected" : "",
          isActive ? "active" : "",
          hoveredEdge === "center" ? "hover-move" : "",
          hoveredEdge === "left" ? "hover-resize-left" : "",
          hoveredEdge === "right" ? "hover-resize-right" : "",
          hoveredEdge === "linked-left" ? "hover-linked-left" : "",
          hoveredEdge === "linked-right" ? "hover-linked-right" : "",
        ].join(" ")}
        style={{ left, width, zIndex }}
        onPointerMove={(event) => {
          const preferredHit = resolvePreferredBlockHit(
            event.clientX,
            event.clientY,
            annotation.id,
            type,
            characterAnnotations,
            actionAnnotations,
            selectedItem,
            trackSnapEnabled,
          );
          const hoverTarget = preferredHit ?? {
            id: annotation.id,
            type,
            edge: isPartOfMultiSelection
              ? "center"
              : resolveEdgeForElement(
                  event.currentTarget,
                  event.clientX,
                  annotation,
                  type,
                  characterAnnotations,
                  actionAnnotations,
                  trackSnapEnabled,
                ),
          };
          setHoveredBlock((prev) =>
            prev?.id === hoverTarget.id && prev.type === hoverTarget.type && prev.edge === hoverTarget.edge
              ? prev
              : hoverTarget,
          );
        }}
        onPointerLeave={() => {
          setHoveredBlock((prev) =>
            prev?.id === annotation.id && prev.type === type ? null : prev,
          );
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
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
            selectedItem,
            trackSnapEnabled,
          );
          const targetId = preferredHit?.id ?? annotation.id;
          const targetType = preferredHit?.type ?? type;
          const targetSelectionKey = getTimelineSelectionKey(targetType, targetId);
          const targetEdge =
            selectedTimelineItems.length > 1 && selectedTimelineKeySet.has(targetSelectionKey)
              ? "center"
              : preferredHit?.edge ?? resolveEdgeForElement(
                  event.currentTarget,
                  event.clientX,
                  annotation,
                  type,
                  characterAnnotations,
                  actionAnnotations,
                  trackSnapEnabled,
                );
          const liveProject = getProjectSnapshot();
          const targetAnnotation = findAnnotationById(
            targetId,
            targetType,
            liveProject.characterAnnotations,
            liveProject.actionAnnotations,
          );
          if (!targetAnnotation) {
            return;
          }
          if (isEditing) {
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
                const liveSelectionAnnotation = findAnnotationById(
                  item.id,
                  item.type,
                  liveProject.characterAnnotations,
                  liveProject.actionAnnotations,
                );
                if (!liveSelectionAnnotation) {
                  return null;
                }
                return {
                  type: item.type,
                  id: item.id,
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
          const trackId = targetType === "character"
            ? "character-track"
            : (targetAnnotation as ActionAnnotation).trackId;
          const linkedPair = isLinkedEdgeHit(targetEdge) && trackSnapEnabled[trackId]
            ? findLinkedPair(
                targetAnnotation,
                targetType,
                targetEdge === "linked-left" ? "left" : "right",
                liveProject.characterAnnotations,
                liveProject.actionAnnotations,
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
            setHoveredBlock({ id: targetAnnotation.id, type: targetType, edge: targetEdge });
            onSelectItem({ type: targetType, id: targetAnnotation.id });
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
          setHoveredBlock({ id: targetAnnotation.id, type: targetType, edge: targetEdge });
          onSelectItem({ type: targetType, id: targetAnnotation.id });
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (performance.now() < suppressCanvasClickUntilRef.current) {
            return;
          }
          if (event.metaKey || event.ctrlKey) {
            const nextItems = toggleTimelineSelectionItem({ type, id: annotation.id });
            const primaryItem = nextItems.length > 0
              ? {
                  type: nextItems[nextItems.length - 1].type,
                  id: nextItems[nextItems.length - 1].id,
                } as SelectedItem
              : null;
            onSelectTimelineItems(nextItems, primaryItem);
            return;
          }
          onSelectItem({ type, id: annotation.id });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (type === "character") {
            onEditCharacterText(annotation.id);
          }
        }}
        onContextMenu={(event) => {
          if (type !== "character") {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onSelectItem({ type: "character", id: annotation.id });
          onOpenCharacterContextMenu(annotation.id, event.clientX, event.clientY);
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
        ) : (
          <span>{label}</span>
        )}
        <div className="resize-handle right" />
      </div>
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
    const nextZoom = clampZoom(Math.round((zoomRef.current + delta) / 10) * 10);
    queueZoom(nextZoom, currentTimeRef.current);
  }

  function handleZoomSliderChange(nextZoom: number) {
    const snappedZoom = clampZoom(Math.round(nextZoom / 10) * 10);
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
    if (pendingDragUpdate.target === "selection") {
      onBatchMoveChange(pendingDragUpdate.items);
      return;
    }
    onActionChange(pendingDragUpdate.id, pendingDragUpdate.changes);
  }

  function toggleTimelineSelectionItem(item: TimelineSelectionItem) {
    const itemKey = getTimelineSelectionKey(item.type, item.id);
    if (selectedTimelineKeySet.has(itemKey)) {
      return selectedTimelineItems.filter((selectedItem) =>
        getTimelineSelectionKey(selectedItem.type, selectedItem.id) !== itemKey
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
      document.querySelectorAll<HTMLElement>(".timeline-block[data-block-id][data-block-type]"),
    );

    return candidates
      .flatMap((element) => {
        const id = element.dataset.blockId;
        const type = element.dataset.blockType;
        if (!id || (type !== "character" && type !== "action")) {
          return [];
        }
        const bounds = element.getBoundingClientRect();
        if (!rectsIntersect(selectionRect, bounds)) {
          return [];
        }
        return [{ id, type }] as TimelineSelectionItem[];
      })
      .sort((left, right) => {
        const leftAnnotation = findAnnotationById(
          left.id,
          left.type,
          characterAnnotations,
          actionAnnotations,
        );
        const rightAnnotation = findAnnotationById(
          right.id,
          right.type,
          characterAnnotations,
          actionAnnotations,
        );
        if (!leftAnnotation || !rightAnnotation) {
          return left.id.localeCompare(right.id);
        }
        return leftAnnotation.startTime - rightAnnotation.startTime ||
          leftAnnotation.endTime - rightAnnotation.endTime ||
          left.id.localeCompare(right.id);
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
      onPreviewFrame(null);
    }
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
  annotation: CharacterAnnotation | ActionAnnotation,
  type: "character" | "action",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  trackSnapEnabled: Record<string, boolean>,
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
      trackSnapEnabled,
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
      trackSnapEnabled,
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
  fallbackType: "character" | "action",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  selectedItem: SelectedItem,
  trackSnapEnabled: Record<string, boolean>,
): HoveredBlockState {
  if (typeof document === "undefined") {
    return { id: fallbackId, type: fallbackType, edge: "center" };
  }
  const elements = document.elementsFromPoint(clientX, clientY);
  const candidates = elements
    .filter((element): element is HTMLElement => element instanceof HTMLElement && element.classList.contains("timeline-block"))
    .map((element, stackIndex) => {
      const id = element.dataset.blockId;
      const type = element.dataset.blockType as "character" | "action" | undefined;
      if (!id || !type) {
        return null;
      }
      const annotation = findAnnotationById(id, type, characterAnnotations, actionAnnotations);
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
        trackSnapEnabled,
      );
      const rect = element.getBoundingClientRect();
      const physicalEdge = getPhysicalEdge(edge);
      const distanceToEdge = physicalEdge === "left"
        ? Math.abs(clientX - rect.left)
        : physicalEdge === "right"
          ? Math.abs(rect.right - clientX)
          : Math.min(Math.abs(clientX - rect.left), Math.abs(rect.right - clientX));
      const isSelected = selectedItem?.type === type && selectedItem.id === id;
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
        edge,
        score: edgePriority + selectedPriority + stackPriority,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

  if (candidates.length === 0) {
    return { id: fallbackId, type: fallbackType, edge: "center" };
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];
  return { id: best.id, type: best.type, edge: best.edge };
}

function hasLinkedPairForEdge(
  annotation: CharacterAnnotation | ActionAnnotation,
  type: "character" | "action",
  edge: "left" | "right",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
  trackSnapEnabled: Record<string, boolean>,
) {
  const trackId = type === "character" ? "character-track" : (annotation as ActionAnnotation).trackId;
  if (!trackSnapEnabled[trackId]) {
    return null;
  }
  return findLinkedPair(annotation, type, edge, characterAnnotations, actionAnnotations);
}

function findAnnotationById(
  id: string,
  type: "character" | "action",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
) {
  return type === "character"
    ? characterAnnotations.find((annotation) => annotation.id === id)
    : actionAnnotations.find((annotation) => annotation.id === id);
}

function findLinkedPair(
  annotation: CharacterAnnotation | ActionAnnotation,
  type: "character" | "action",
  edge: "left" | "right",
  characterAnnotations: CharacterAnnotation[],
  actionAnnotations: ActionAnnotation[],
) {
  const items = type === "character"
    ? sortCharactersByTimeLocal(characterAnnotations)
    : sortActionsByTimeLocal(
        actionAnnotations.filter((item) => item.trackId === (annotation as ActionAnnotation).trackId),
      );
  const index = items.findIndex((item) => item.id === annotation.id);
  if (index === -1) {
    return null;
  }
  if (edge === "right") {
    const rightNeighbor = items[index + 1];
    if (!rightNeighbor || Math.abs(annotation.endTime - rightNeighbor.startTime) > SNAP_SECONDS) {
      return null;
    }
    return {
      leftItem: toBatchMoveItem(annotation, type),
      rightItem: toBatchMoveItem(rightNeighbor, type),
    };
  }
  const leftNeighbor = items[index - 1];
  if (!leftNeighbor || Math.abs(leftNeighbor.endTime - annotation.startTime) > SNAP_SECONDS) {
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
) {
  const minDuration = Math.max(0.04, MIN_BLOCK_WIDTH_PX / Math.max(zoom, 1));
  const rawBoundary = dragState.boundaryTime + deltaSeconds;
  const minBoundary = dragState.leftItem.startTime + minDuration;
  const maxBoundary = dragState.rightItem.endTime - minDuration;
  const clampedBoundary = Math.max(minBoundary, Math.min(maxBoundary, rawBoundary));
  const snapPoint = shouldSnap
    ? findNearestSnapPoint(clampedBoundary, snapPoints)
    : null;
  const snappedBoundary = snapPoint
    ? Math.max(minBoundary, Math.min(maxBoundary, snapPoint.point))
    : clampedBoundary;
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
    snappedTo: snapPoint ? { time: snappedBoundary, edge: "right" as const } : null,
  };
}

function toBatchMoveItem(
  annotation: CharacterAnnotation | ActionAnnotation,
  type: "character" | "action",
): TimelineBatchMoveItem {
  return {
    type,
    id: annotation.id,
    startTime: annotation.startTime,
    endTime: annotation.endTime,
  };
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

function snapTime(time: number, snapPoints: number[]) {
  return findNearestSnapPoint(time, snapPoints)?.point ?? time;
}

function computeNextRange(
  originalStart: number,
  originalEnd: number,
  deltaSeconds: number,
  kind: DragState extends infer T ? T extends { kind: infer K } ? K : never : never,
  snapPoints: number[],
  zoom: number,
  shouldSnap = true,
) {
  const minDuration = Math.max(0.04, MIN_BLOCK_WIDTH_PX / Math.max(zoom, 1));
  if (String(kind).startsWith("move")) {
    const duration = originalEnd - originalStart;
    const rawStart = Math.max(0, originalStart + deltaSeconds);
    const rawEnd = rawStart + duration;
    if (!shouldSnap) {
      return { startTime: rawStart, endTime: rawEnd, snappedTo: null };
    }
    const leftSnap = findNearestSnapPoint(rawStart, snapPoints);
    const rightSnap = findNearestSnapPoint(rawEnd, snapPoints);
    const bestSnap = chooseBetterSnap(leftSnap, rightSnap);
    if (!bestSnap) {
      return { startTime: rawStart, endTime: rawEnd, snappedTo: null };
    }
    if (bestSnap.edge === "left") {
      return {
        startTime: bestSnap.point,
        endTime: bestSnap.point + duration,
        snappedTo: { time: bestSnap.point, edge: "left" as const },
      };
    }
    if (bestSnap.point - duration < 0) {
      return { startTime: rawStart, endTime: rawEnd, snappedTo: null };
    }
    return {
      startTime: bestSnap.point - duration,
      endTime: bestSnap.point,
      snappedTo: { time: bestSnap.point, edge: "right" as const },
    };
  }
  if (String(kind).includes("resize-left")) {
    const { startTime, endTime } = clampRange(
      shouldSnap ? snapTime(Math.max(0, originalStart + deltaSeconds), snapPoints) : Math.max(0, originalStart + deltaSeconds),
      originalEnd,
      minDuration,
    );
    const snappedTo = shouldSnap ? findNearestSnapPoint(startTime, snapPoints) : null;
    return {
      startTime,
      endTime,
      snappedTo: snappedTo ? { time: snappedTo.point, edge: "left" as const } : null,
    };
  }
  const { startTime, endTime } = clampRange(
    originalStart,
    shouldSnap
      ? snapTime(Math.max(originalStart + minDuration, originalEnd + deltaSeconds), snapPoints)
      : Math.max(originalStart + minDuration, originalEnd + deltaSeconds),
    minDuration,
  );
  const snappedTo = shouldSnap ? findNearestSnapPoint(endTime, snapPoints) : null;
  return {
    startTime,
    endTime,
    snappedTo: snappedTo ? { time: snappedTo.point, edge: "right" as const } : null,
  };
}

function findNearestSnapPoint(time: number, snapPoints: number[]) {
  let best: { point: number; distance: number } | null = null;
  for (const point of snapPoints) {
    const distance = Math.abs(point - time);
    if (distance > SNAP_SECONDS) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { point, distance };
    }
  }
  return best;
}

function chooseBetterSnap(
  leftSnap: { point: number; distance: number } | null,
  rightSnap: { point: number; distance: number } | null,
) {
  if (leftSnap && rightSnap) {
    return leftSnap.distance <= rightSnap.distance
      ? { ...leftSnap, edge: "left" as const }
      : { ...rightSnap, edge: "right" as const };
  }
  if (leftSnap) {
    return { ...leftSnap, edge: "left" as const };
  }
  if (rightSnap) {
    return { ...rightSnap, edge: "right" as const };
  }
  return null;
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

function getSelectionBoxStyle(
  dragState: Extract<NonNullable<DragState>, { kind: "select-box" }>,
  container: HTMLDivElement,
) {
  const bounds = container.getBoundingClientRect();
  const left = Math.min(dragState.originX, dragState.currentX) - bounds.left + container.scrollLeft;
  const top = Math.min(dragState.originY, dragState.currentY) - bounds.top;
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

function getTimelineSelectionKey(type: "character" | "action", id: string) {
  return `${type}:${id}`;
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
  return Math.max(40, Math.min(240, zoom));
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
  const bucketCount = Math.max(64, viewWidth);
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
    for (let cursor = rangeStart; cursor < safeRangeEnd; cursor += 1) {
      const value = waveformData.samples[cursor] ?? 0;
      const absValue = Math.abs(value);
      if (absValue > peak) {
        peak = absValue;
      }
      rmsSum += value * value;
    }
    const sampleCount = safeRangeEnd - rangeStart;
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
