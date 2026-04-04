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
  collapsedPrimary?: boolean;
  collapsedSecondary?: boolean;
  collapsedSize?: number;
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
  collapsedPrimary = false,
  collapsedSecondary = false,
  collapsedSize = 44,
}: ResizableSplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const initialSizeRef = useRef(clampRatio(initialPrimarySize));
  const [primarySize, setPrimarySize] = useState(() => clampRatio(initialPrimarySize));
  const [isDragging, setIsDragging] = useState(false);
  const [containerSize, setContainerSize] = useState(0);

  const { minPrimarySize: effectiveMinPrimarySize, minSecondarySize: effectiveMinSecondarySize } =
    getEffectiveMinSizes(containerSize, minPrimarySize, minSecondarySize);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const updateContainerSize = () => {
      if (!containerRef.current) {
        return;
      }
      const rect = containerRef.current.getBoundingClientRect();
      setContainerSize(orientation === "horizontal" ? rect.width : rect.height);
    };

    updateContainerSize();

    const observer = new ResizeObserver(() => {
      updateContainerSize();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [orientation]);

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
    if (containerSize <= 0) {
      return;
    }
    const { minRatio, maxRatio } = getRatioBounds(
      containerSize,
      effectiveMinPrimarySize,
      effectiveMinSecondarySize,
    );
    setPrimarySize((current) => clampRatio(current, minRatio, maxRatio));
  }, [containerSize, effectiveMinPrimarySize, effectiveMinSecondarySize]);

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
      const { minRatio, maxRatio } = getRatioBounds(
        containerSize,
        effectiveMinPrimarySize,
        effectiveMinSecondarySize,
      );
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
  }, [
    effectiveMinPrimarySize,
    effectiveMinSecondarySize,
    isDragging,
    orientation,
  ]);

  const primaryStyle = getPaneStyle({
    orientation,
    role: "primary",
    primarySize,
    minPrimarySize: effectiveMinPrimarySize,
    minSecondarySize: effectiveMinSecondarySize,
    collapsedPrimary,
    collapsedSecondary,
    collapsedSize,
  });
  const secondaryStyle = getPaneStyle({
    orientation,
    role: "secondary",
    primarySize,
    minPrimarySize: effectiveMinPrimarySize,
    minSecondarySize: effectiveMinSecondarySize,
    collapsedPrimary,
    collapsedSecondary,
    collapsedSize,
  });
  const showDivider = !collapsedPrimary && !collapsedSecondary;

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
        collapsedPrimary || collapsedSecondary ? "has-collapsed-pane" : "",
        isDragging ? "is-dragging" : "",
      ].join(" ")}
    >
      <div
        className={[
          "split-pane",
          "split-pane-primary",
          primaryClassName ?? "",
          collapsedPrimary ? "is-collapsed-pane" : "",
        ].join(" ")}
        style={primaryStyle}
      >
        {primary}
      </div>
      {showDivider ? (
        <div
          role="separator"
          aria-orientation={orientation}
          className="split-divider"
          onPointerDown={handlePointerDown}
          onDoubleClick={handleReset}
        >
          <div className="split-divider-grip" />
        </div>
      ) : null}
      <div
        className={[
          "split-pane",
          "split-pane-secondary",
          secondaryClassName ?? "",
          collapsedSecondary ? "is-collapsed-pane" : "",
        ].join(" ")}
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

function getEffectiveMinSizes(containerSize: number, minPrimarySize: number, minSecondarySize: number) {
  if (containerSize <= 0) {
    return { minPrimarySize, minSecondarySize };
  }

  const totalMinSize = minPrimarySize + minSecondarySize;
  if (totalMinSize <= containerSize) {
    return { minPrimarySize, minSecondarySize };
  }

  const scale = containerSize / totalMinSize;
  return {
    minPrimarySize: Math.max(120, Math.floor(minPrimarySize * scale)),
    minSecondarySize: Math.max(120, Math.floor(minSecondarySize * scale)),
  };
}

function getRatioBounds(containerSize: number, minPrimarySize: number, minSecondarySize: number) {
  if (containerSize <= 0) {
    return { minRatio: 0.15, maxRatio: 0.85 };
  }
  const minRatio = minPrimarySize / containerSize;
  const maxRatio = 1 - minSecondarySize / containerSize;
  if (minRatio > maxRatio) {
    const midpoint = (minRatio + maxRatio) / 2;
    return { minRatio: midpoint, maxRatio: midpoint };
  }
  return { minRatio, maxRatio };
}

function getPaneStyle({
  orientation,
  role,
  primarySize,
  minPrimarySize,
  minSecondarySize,
  collapsedPrimary,
  collapsedSecondary,
  collapsedSize,
}: {
  orientation: "horizontal" | "vertical";
  role: "primary" | "secondary";
  primarySize: number;
  minPrimarySize: number;
  minSecondarySize: number;
  collapsedPrimary: boolean;
  collapsedSecondary: boolean;
  collapsedSize: number;
}) {
  const collapsedKey = orientation === "horizontal" ? "minWidth" : "minHeight";
  const collapsedMaxKey = orientation === "horizontal" ? "maxWidth" : "maxHeight";

  if (role === "primary" && collapsedPrimary) {
    return {
      flex: "0 0 auto",
      flexBasis: `${collapsedSize}px`,
      [collapsedKey]: `${collapsedSize}px`,
      [collapsedMaxKey]: `${collapsedSize}px`,
    };
  }

  if (role === "secondary" && collapsedSecondary) {
    return {
      flex: "0 0 auto",
      flexBasis: `${collapsedSize}px`,
      [collapsedKey]: `${collapsedSize}px`,
      [collapsedMaxKey]: `${collapsedSize}px`,
    };
  }

  if (role === "primary" && collapsedSecondary) {
    return orientation === "horizontal"
      ? { flex: "1 1 0%", minWidth: "0" }
      : { flex: "1 1 0%", minHeight: "0" };
  }

  if (role === "secondary" && collapsedPrimary) {
    return orientation === "horizontal"
      ? { flex: "1 1 0%", minWidth: "0" }
      : { flex: "1 1 0%", minHeight: "0" };
  }

  if (role === "primary") {
    return orientation === "horizontal"
      ? { flexBasis: `${primarySize * 100}%`, minWidth: `${minPrimarySize}px` }
      : { flexBasis: `${primarySize * 100}%`, minHeight: `${minPrimarySize}px` };
  }

  return orientation === "horizontal"
    ? { minWidth: `${minSecondarySize}px` }
    : { minHeight: `${minSecondarySize}px` };
}
