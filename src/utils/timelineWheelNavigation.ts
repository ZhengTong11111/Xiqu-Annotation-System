type TimelineWheelFacts = {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
};

const PIXELS_PER_WHEEL_LINE = 40;

// Shift+滚轮使用主导轴横移；部分浏览器会预先把纵轮转换为 deltaX，因此不能只读取 deltaY。
export function getTimelineHorizontalWheelDelta(
  event: TimelineWheelFacts,
  viewportWidth: number,
): number | null {
  if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  if (!Number.isFinite(rawDelta) || rawDelta === 0) return 0;
  if (event.deltaMode === 1) return rawDelta * PIXELS_PER_WHEEL_LINE;
  if (event.deltaMode === 2) return rawDelta * Math.max(1, viewportWidth * 0.9);
  return rawDelta;
}
