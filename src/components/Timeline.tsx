import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ActionAnnotation,
  CharacterAnnotation,
  SelectedItem,
  SubtitleLine,
  TrackDefinition,
} from "../types";
import { clampRange } from "../utils/project";

type TimelineProps = {
  subtitleLines: SubtitleLine[];
  characterAnnotations: CharacterAnnotation[];
  actionAnnotations: ActionAnnotation[];
  trackDefinitions: TrackDefinition[];
  currentTime: number;
  selectedItem: SelectedItem;
  zoom: number;
  duration: number;
  focusRange: { start: number; end: number } | null;
  onZoomChange: (zoom: number) => void;
  onSeek: (time: number) => void;
  onSelectItem: (item: SelectedItem) => void;
  onCharacterChange: (id: string, changes: Partial<CharacterAnnotation>) => void;
  onActionChange: (id: string, changes: Partial<ActionAnnotation>) => void;
  onCreateAction: (trackId: string, startTime: number, endTime: number) => void;
};

type DragState =
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
      kind: "create-action";
      trackId: string;
      originX: number;
      currentX: number;
    }
  | null;

const TRACK_HEIGHT = 72;
const TRACK_LABEL_WIDTH = 150;
const SNAP_SECONDS = 0.05;
const ZOOM_SETTLE_MS = 220;

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

export function Timeline({
  subtitleLines,
  characterAnnotations,
  actionAnnotations,
  trackDefinitions,
  currentTime,
  selectedItem,
  zoom,
  duration,
  focusRange,
  onZoomChange,
  onSeek,
  onSelectItem,
  onCharacterChange,
  onActionChange,
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
  const [dragState, setDragState] = useState<DragState>(null);
  const timelineWidth = Math.max(TRACK_LABEL_WIDTH + duration * zoom, 1200);
  const sliderZoom = Math.round(zoom / 10) * 10;

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    return () => {
      if (zoomFrameRef.current !== null) {
        cancelAnimationFrame(zoomFrameRef.current);
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
      if (!scrollRef.current) {
        return;
      }
      const deltaSeconds = (event.clientX - dragState.originX) / zoom;
      if (dragState.kind === "create-action") {
        setDragState((prev) =>
          prev && prev.kind === "create-action"
            ? { ...prev, currentX: event.clientX }
            : prev,
        );
        return;
      }

      if (dragState.kind.includes("character")) {
        const next = computeNextRange(
          dragState.originalStart,
          dragState.originalEnd,
          deltaSeconds,
          dragState.kind,
          snapPoints,
        );
        onCharacterChange(dragState.id, next);
        return;
      }

      const next = computeNextRange(
        dragState.originalStart,
        dragState.originalEnd,
        deltaSeconds,
        dragState.kind,
        snapPoints,
      );
      onActionChange(dragState.id, next);
    };

    const handlePointerUp = () => {
      if (dragState.kind === "create-action" && scrollRef.current) {
        const bounds = scrollRef.current.getBoundingClientRect();
        const left = Math.min(dragState.originX, dragState.currentX) - bounds.left + scrollRef.current.scrollLeft;
        const right = Math.max(dragState.originX, dragState.currentX) - bounds.left + scrollRef.current.scrollLeft;
        const startTime = snapTime(left / zoom, snapPoints);
        const endTime = snapTime(right / zoom, snapPoints);
        if (endTime - startTime >= 0.04) {
          onCreateAction(dragState.trackId, startTime, endTime);
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
  }, [dragState, zoom, snapPoints, onCharacterChange, onActionChange, onCreateAction]);

  const ticks = useMemo(() => {
    const step = zoom >= 160 ? 0.5 : zoom >= 100 ? 1 : 2;
    return Array.from({ length: Math.ceil(duration / step) + 1 }, (_, index) => index * step);
  }, [duration, zoom]);

  return (
    <section className="panel timeline-panel">
      <div className="panel-header">
        <div className="timeline-header-copy">
          <h2>多轨时间轴</h2>
          <span>点击空白跳转，拖拽片段创建或调整边界</span>
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
                onClick={() => {
                  onSelectItem({ type: "line", id: line.id });
                  onSeek(line.startTime);
                }}
                title={line.text}
              />
            ))}
          </div>

          {trackDefinitions.map((track) => (
            <div
              key={track.id}
              className="timeline-track"
              style={{ height: TRACK_HEIGHT }}
              onDoubleClick={(event) => {
                if (track.type !== "action") {
                  return;
                }
                const startTime = snapTime(getLaneTime(event.currentTarget, event.clientX, zoom), snapPoints);
                onCreateAction(track.id, startTime, Math.min(startTime + 0.8, duration));
              }}
              onPointerDown={(event) => {
                if (track.type !== "action" || event.target !== event.currentTarget || !scrollRef.current) {
                  return;
                }
                setDragState({
                  kind: "create-action",
                  trackId: track.id,
                  originX: event.clientX,
                  currentX: event.clientX,
                });
              }}
            >
              <div className="track-label">{track.name}</div>
              <div
                className="track-lane"
                onClick={(event) => {
                  onSeek(getLaneTime(event.currentTarget, event.clientX, zoom));
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
                    style={getDraftStyle(dragState, scrollRef.current, zoom)}
                  />
                ) : null}
              </div>
            </div>
          ))}

          <div className="playhead" style={{ left: getCanvasX(currentTime, zoom) }} />
        </div>
      </div>
    </section>
  );

  function renderBlock(
    annotation: CharacterAnnotation | ActionAnnotation,
    type: "character" | "action",
  ) {
    const isSelected = selectedItem?.type === type && selectedItem.id === annotation.id;
    const isActive = currentTime >= annotation.startTime && currentTime <= annotation.endTime;
    const left = annotation.startTime * zoom;
    const width = Math.max((annotation.endTime - annotation.startTime) * zoom, 8);
    const label = "char" in annotation ? annotation.char : annotation.label;

    return (
      <div
        key={annotation.id}
        className={[
          "timeline-block",
          type,
          isSelected ? "selected" : "",
          isActive ? "active" : "",
        ].join(" ")}
        style={{ left, width }}
        onPointerDown={(event) => {
          event.stopPropagation();
          const base = {
            id: annotation.id,
            originX: event.clientX,
            originalStart: annotation.startTime,
            originalEnd: annotation.endTime,
          };
          const edge = resolveEdge(event);
          if (type === "character") {
            setDragState({
              kind:
                edge === "left"
                  ? "resize-left-character"
                  : edge === "right"
                    ? "resize-right-character"
                    : "move-character",
              ...base,
            });
          } else {
            setDragState({
              kind:
                edge === "left"
                  ? "resize-left-action"
                  : edge === "right"
                    ? "resize-right-action"
                    : "move-action",
              ...base,
            });
          }
          onSelectItem({ type, id: annotation.id });
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelectItem({ type, id: annotation.id });
        }}
      >
        <div className="resize-handle left" />
        <span>{label}</span>
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

  function handleZoomAroundPointer(event: React.WheelEvent<HTMLDivElement>) {
    zoomInteractionUntilRef.current = Date.now() + ZOOM_SETTLE_MS;
    queueZoom(
      clampZoom(zoomRef.current * Math.exp(-event.deltaY * 0.0025)),
      getCanvasTime(event.currentTarget, event.clientX, zoomRef.current),
      event.clientX - event.currentTarget.getBoundingClientRect().left,
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
}

function resolveEdge(event: React.PointerEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  const offset = event.clientX - rect.left;
  if (offset < 8) {
    return "left";
  }
  if (rect.width - offset < 8) {
    return "right";
  }
  return "center";
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
) {
  if (String(kind).startsWith("move")) {
    const duration = originalEnd - originalStart;
    const startTime = snapTime(Math.max(0, originalStart + deltaSeconds), snapPoints);
    return { startTime, endTime: startTime + duration };
  }
  if (String(kind).includes("resize-left")) {
    const { startTime, endTime } = clampRange(
      snapTime(Math.max(0, originalStart + deltaSeconds), snapPoints),
      originalEnd,
    );
    return { startTime, endTime };
  }
  const { startTime, endTime } = clampRange(
    originalStart,
    snapTime(Math.max(originalStart + 0.04, originalEnd + deltaSeconds), snapPoints),
  );
  return { startTime, endTime };
}

function getDraftStyle(
  dragState: Extract<NonNullable<DragState>, { kind: "create-action" }>,
  container: HTMLDivElement,
  zoom: number,
) {
  const leftPx = Math.min(
    getLaneX(container, dragState.originX) * zoom,
    getLaneX(container, dragState.currentX) * zoom,
  );
  const rightPx = Math.max(
    getLaneX(container, dragState.originX) * zoom,
    getLaneX(container, dragState.currentX) * zoom,
  );
  return {
    left: leftPx,
    width: Math.max(rightPx - leftPx, 6),
  };
}

function getCanvasX(time: number, zoom: number) {
  return TRACK_LABEL_WIDTH + time * zoom;
}

function getCanvasTime(container: HTMLElement, clientX: number, zoom: number) {
  const bounds = container.getBoundingClientRect();
  const offsetX = clientX - bounds.left + container.scrollLeft;
  return Math.max(0, offsetX - TRACK_LABEL_WIDTH) / zoom;
}

function getCanvasTimeFromViewportOffset(container: HTMLElement, viewportOffset: number, zoom: number) {
  const offsetX = viewportOffset + container.scrollLeft;
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
