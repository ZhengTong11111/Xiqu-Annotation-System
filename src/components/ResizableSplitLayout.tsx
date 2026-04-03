import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

type ResizableSplitLayoutProps = {
  orientation: "horizontal" | "vertical";
  primary: ReactNode;
  secondary: ReactNode;
  initialPrimarySize?: number;
  minPrimarySize?: number;
  minSecondarySize?: number;
  storageKey?: string;
  className?: string;
  primaryClassName?: string;
  secondaryClassName?: string;
};

type DragState = {
  pointerId: number;
};

const DEFAULT_PRIMARY_SIZE = 0.6;

export function ResizableSplitLayout({
  orientation,
  primary,
  secondary,
  initialPrimarySize = DEFAULT_PRIMARY_SIZE,
  minPrimarySize = 240,
  minSecondarySize = 240,
  storageKey,
  className,
  primaryClassName,
  secondaryClassName,
}: ResizableSplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const initialSizeRef = useRef(clampRatio(initialPrimarySize));
  const [primarySize, setPrimarySize] = useState(() => clampRatio(initialPrimarySize));
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!storageKey) {
      return;
    }
    const savedSize = window.localStorage.getItem(storageKey);
    if (!savedSize) {
      return;
    }
    const nextSize = Number(savedSize);
    if (!Number.isFinite(nextSize)) {
      return;
    }
    setPrimarySize(clampRatio(nextSize));
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) {
      return;
    }
    window.localStorage.setItem(storageKey, String(primarySize));
  }, [primarySize, storageKey]);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current || !containerRef.current) {
        return;
      }
      const rect = containerRef.current.getBoundingClientRect();
      const containerSize = orientation === "horizontal" ? rect.width : rect.height;
      if (containerSize <= 0) {
        return;
      }
      const pointerOffset = orientation === "horizontal"
        ? event.clientX - rect.left
        : event.clientY - rect.top;
      const minRatio = minPrimarySize / containerSize;
      const maxRatio = 1 - minSecondarySize / containerSize;
      setPrimarySize(clampRatio(pointerOffset / containerSize, minRatio, maxRatio));
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (dragStateRef.current?.pointerId !== event.pointerId) {
        return;
      }
      dragStateRef.current = null;
      setIsDragging(false);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isDragging, minPrimarySize, minSecondarySize, orientation]);

  const primaryStyle = orientation === "horizontal"
    ? { flexBasis: `${primarySize * 100}%`, minWidth: `${minPrimarySize}px` }
    : { flexBasis: `${primarySize * 100}%`, minHeight: `${minPrimarySize}px` };
  const secondaryStyle = orientation === "horizontal"
    ? { minWidth: `${minSecondarySize}px` }
    : { minHeight: `${minSecondarySize}px` };

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    dragStateRef.current = { pointerId: event.pointerId };
    setIsDragging(true);
    document.body.style.cursor = orientation === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  function handleReset() {
    setPrimarySize(initialSizeRef.current);
  }

  return (
    <div
      ref={containerRef}
      className={[
        "resizable-split-layout",
        `split-${orientation}`,
        className ?? "",
        isDragging ? "is-dragging" : "",
      ].join(" ")}
    >
      <div
        className={["split-pane", "split-pane-primary", primaryClassName ?? ""].join(" ")}
        style={primaryStyle}
      >
        {primary}
      </div>
      <div
        role="separator"
        aria-orientation={orientation}
        className="split-divider"
        onPointerDown={handlePointerDown}
        onDoubleClick={handleReset}
      >
        <div className="split-divider-grip" />
      </div>
      <div
        className={["split-pane", "split-pane-secondary", secondaryClassName ?? ""].join(" ")}
        style={secondaryStyle}
      >
        {secondary}
      </div>
    </div>
  );
}

function clampRatio(value: number, min = 0.15, max = 0.85) {
  return Math.min(max, Math.max(min, value));
}
