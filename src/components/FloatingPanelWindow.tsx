import { type ReactNode, useEffect, useRef, useState } from "react";

type FloatingPanelWindowProps = {
  title: string;
  initialX: number;
  initialY: number;
  initialWidth: number;
  initialHeight: number;
  onClose: () => void;
  children: ReactNode;
};

export function FloatingPanelWindow({
  title,
  initialX,
  initialY,
  initialWidth,
  initialHeight,
  onClose,
  children,
}: FloatingPanelWindowProps) {
  const [position, setPosition] = useState({ x: initialX, y: initialY });
  const dragStateRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
  } | null>(null);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      const nextX = Math.max(8, dragState.startX + (event.clientX - dragState.originX));
      const nextY = Math.max(8, dragState.startY + (event.clientY - dragState.originY));
      setPosition({ x: nextX, y: nextY });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }
      dragStateRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  return (
    <div
      className="floating-panel-window"
      style={{
        left: position.x,
        top: position.y,
        width: initialWidth,
        height: initialHeight,
      }}
    >
      <div
        className="floating-panel-window-titlebar"
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          dragStateRef.current = {
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            startX: position.x,
            startY: position.y,
          };
        }}
      >
        <strong>{title}</strong>
        <button
          type="button"
          className="floating-panel-window-close"
          onClick={onClose}
          title="收回工作台"
          aria-label="收回工作台"
        >
          ↩
        </button>
      </div>
      <div className="floating-panel-window-body">
        {children}
      </div>
      <div className="floating-panel-window-resize-hint" aria-hidden="true" />
    </div>
  );
}
