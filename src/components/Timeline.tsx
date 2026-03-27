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
  zoom: number;
  duration: number;
  focusRange: { start: number; end: number } | null;
  getProjectSnapshot: () => ProjectData;
  editingCharacterId: string | null;
  editingCharacterLocation: "timeline" | "split-panel" | null;
  editingCharacterValue: string;
  onZoomChange: (zoom: number) => void;
  onSeek: (time: number) => void;
  onPreviewFrame: (time: number | null) => void;
  onSelectItem: (item: SelectedItem) => void;
  onSelectTimelineItems: (items: TimelineSelectionItem[], primaryItem: SelectedItem) => void;
  onEditCharacterText: (id: string) => void;
  onEditingCharacterValueChange: (value: string) => void;
  onCommitCharacterTextEdit: (id: string) => void;
  onCancelCharacterTextEdit: () => void;
  onCreateCharacterAtTime: (time: number) => void;
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
      kind: "create-action";
      trackId: string;
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
const EDGE_HIT_SLOP_PX = 16;
const SELECTED_EDGE_HIT_SLOP_PX = 36;
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
  edge: "left" | "right" | "center";
} | null;

type EdgeHit = "left" | "right" | "center";

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
  zoom,
  duration,
  focusRange,
  getProjectSnapshot,
  editingCharacterId,
  editingCharacterLocation,
  editingCharacterValue,
  onZoomChange,
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
        activeDragState.kind !== "create-action" &&
        activeDragState.kind !== "select-box" &&
        Math.abs(deltaPixels) < DRAG_ACTIVATION_PX
      ) {
        return;
      }
      const deltaSeconds =
        "originX" in activeDragState
          ? (event.clientX - activeDragState.originX) / zoom
          : 0;
      if (activeDragState.kind === "create-action") {
        clearPreviewFrame();
        setDragState((prev) =>
          prev && prev.kind === "create-action"
            ? { ...prev, currentX: event.clientX }
            : prev,
        );
        return;
      }

      if (activeDragState.kind === "select-box") {
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

      if (activeDragState.kind === "move-selection") {
        const minStartTime = Math.min(...activeDragState.items.map((item) => item.startTime));
        const clampedDelta = Math.max(deltaSeconds, -minStartTime);
        scheduleDragUpdate({
          target: "selection",
          items: activeDragState.items.map((item) => ({
            ...item,
            startTime: item.startTime + clampedDelta,
            endTime: item.endTime + clampedDelta,
          })),
        });
        return;
      }

      if (isLineDrag(activeDragState)) {
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
          target: "character",
          id: activeDragState.id,
          changes: next,
        });
        updatePreviewFrame(activeDragState.kind, next);
        return;
      }

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
        target: "action",
        id: activeDragState.id,
        changes: next,
      });
      updatePreviewFrame(activeDragState.kind, next);
    };

    const handlePointerUp = () => {
      const activeDragState = dragStateRef.current;
      clearPreviewFrame();
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
      if (activeDragState.kind === "create-action" && scrollRef.current) {
        const left = Math.max(0, Math.min(activeDragState.originX, activeDragState.currentX) - activeDragState.laneLeft);
        const right = Math.max(0, Math.max(activeDragState.originX, activeDragState.currentX) - activeDragState.laneLeft);
        const startTime = snapTime(left / zoom, liveSnapPoints);
        const minDuration = Math.max(0.04, MIN_BLOCK_WIDTH_PX / Math.max(zoom, 1));
        const endTime = Math.max(startTime + minDuration, snapTime(right / zoom, liveSnapPoints));
        if (endTime - startTime >= minDuration) {
          onCreateAction(activeDragState.trackId, startTime, endTime);
        }
      } else if (activeDragState.kind === "select-box") {
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        const selectedItems = getItemsInSelectionRect(activeDragState);
        onSelectTimelineItems(selectedItems, selectedItems[0] ?? null);
      } else if (activeDragState.kind === "move-selection") {
        const minStartTime = Math.min(...activeDragState.items.map((item) => item.startTime));
        const clampedDelta = Math.max(
          (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          -minStartTime,
        );
        onBatchMoveCommit(
          activeDragState.items.map((item) => ({
            ...item,
            startTime: item.startTime + clampedDelta,
            endTime: item.endTime + clampedDelta,
          })),
        );
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
        const next = computeNextRange(
          activeDragState.originalStart,
          activeDragState.originalEnd,
          (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          activeDragState.kind,
          liveSnapPoints,
          zoom,
          true,
        );
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        onCharacterCommit(activeDragState.id, next);
      } else if (isActionDrag(activeDragState)) {
        const next = computeNextRange(
          activeDragState.originalStart,
          activeDragState.originalEnd,
          (lastPointerClientXRef.current - activeDragState.originX) / zoom,
          activeDragState.kind,
          liveSnapPoints,
          zoom,
          true,
        );
        suppressCanvasClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
        onActionCommit(activeDragState.id, next);
      }
      setDragState(null);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, zoom, snapPoints, characterAnnotations, actionAnnotations, selectedTimelineItems, onLineChange, onLineCommit, onCharacterChange, onCharacterCommit, onActionChange, onActionCommit, onBatchMoveChange, onBatchMoveCommit, onCreateAction, onPreviewFrame, onSelectTimelineItems]);

  const ticks = useMemo(() => {
    const step = zoom >= 160 ? 0.5 : zoom >= 100 ? 1 : 2;
    return Array.from({ length: Math.ceil(duration / step) + 1 }, (_, index) => index * step);
  }, [duration, zoom]);

  return (
    <section className="panel timeline-panel">
      <div className="panel-header">
        <div className="timeline-header-copy">
          <h2>多轨时间轴</h2>
          <span>点击空白跳转，双击创建，Command/Ctrl + 拖拽可新建动作片段</span>
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
                <span>{tick.toFixed(tick % 1 === 0 ? 0 : 1)}s</span>
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
              <div className="track-label">{track.name}</div>
              <div
                className="track-lane"
                onPointerDown={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (event.button !== 0 || target?.closest(".timeline-block")) {
                    return;
                  }
                  if (track.type === "action" && (event.metaKey || event.ctrlKey)) {
                    lastPointerClientXRef.current = event.clientX;
                    setDragState({
                      kind: "create-action",
                      trackId: track.id,
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
                {dragState?.kind === "create-action" && dragState.trackId === track.id && scrollRef.current ? (
                  <div
                    className="timeline-block draft action"
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
          );
          const hoverTarget = preferredHit ?? { id: annotation.id, type, edge: resolveEdge(event) };
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
          );
          const targetId = preferredHit?.id ?? annotation.id;
          const targetType = preferredHit?.type ?? type;
          const targetEdge = preferredHit?.edge ?? resolveEdge(event);
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
          const selectionKey = getTimelineSelectionKey(targetType, targetAnnotation.id);
          const shouldMoveSelection =
            targetEdge === "center" &&
            selectedTimelineItems.length > 1 &&
            selectedTimelineKeySet.has(selectionKey);
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
          const base = {
            id: targetAnnotation.id,
            originX: event.clientX,
            originalStart: targetAnnotation.startTime,
            originalEnd: targetAnnotation.endTime,
          };
          if (targetType === "character") {
            setDragState({
              kind:
                targetEdge === "left"
                  ? "resize-left-character"
                  : targetEdge === "right"
                    ? "resize-right-character"
                    : "move-character",
              ...base,
            });
          } else {
            setDragState({
              kind:
                targetEdge === "left"
                  ? "resize-left-action"
                  : targetEdge === "right"
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
    kind: Exclude<NonNullable<DragState>, { kind: "create-action" }>["kind"],
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

function resolveEdge(event: React.PointerEvent<HTMLDivElement>) {
  return resolveEdgeForElement(event.currentTarget, event.clientX);
}

function resolveEdgeForElement(element: HTMLElement, clientX: number): EdgeHit {
  const rect = element.getBoundingClientRect();
  const offset = clientX - rect.left;
  const threshold = element.classList.contains("selected")
    ? SELECTED_EDGE_HIT_SLOP_PX
    : EDGE_HIT_SLOP_PX;
  if (offset < threshold) {
    return "left";
  }
  if (rect.width - offset < threshold) {
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
      const edge = resolveEdgeForElement(element, clientX);
      const annotation = findAnnotationById(id, type, characterAnnotations, actionAnnotations);
      if (!annotation) {
        return null;
      }
      const distanceToEdge = Math.min(
        Math.abs(clientX - element.getBoundingClientRect().left),
        Math.abs(element.getBoundingClientRect().right - clientX),
      );
      const isSelected = selectedItem?.type === type && selectedItem.id === id;
      const edgePriority = edge === "center" ? 0 : 1000 - distanceToEdge;
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

function snapTime(time: number, snapPoints: number[]) {
  const nearest = snapPoints.find((point) => Math.abs(point - time) <= SNAP_SECONDS);
  return nearest ?? time;
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
  const maybeSnap = (time: number) => (shouldSnap ? snapTime(time, snapPoints) : time);
  if (String(kind).startsWith("move")) {
    const duration = originalEnd - originalStart;
    const startTime = maybeSnap(Math.max(0, originalStart + deltaSeconds));
    return { startTime, endTime: startTime + duration };
  }
  if (String(kind).includes("resize-left")) {
    const { startTime, endTime } = clampRange(
      maybeSnap(Math.max(0, originalStart + deltaSeconds)),
      originalEnd,
      minDuration,
    );
    return { startTime, endTime };
  }
  const { startTime, endTime } = clampRange(
    originalStart,
    maybeSnap(Math.max(originalStart + minDuration, originalEnd + deltaSeconds)),
    minDuration,
  );
  return { startTime, endTime };
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
  return dragState.kind.includes("action") && dragState.kind !== "create-action";
}

function getDraftStyle(
  dragState: Extract<NonNullable<DragState>, { kind: "create-action" }>,
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
