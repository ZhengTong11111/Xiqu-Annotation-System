export type TimelineFocusAlignment = "start" | "center-range";

type TimelineFocusScrollInput = {
  startTime: number;
  endTime: number;
  zoom: number;
  viewportWidth: number;
  timelineWidth: number;
  trackLabelWidth: number;
  alignment: TimelineFocusAlignment;
  startViewportOffset?: number;
  edgePadding?: number;
};

/**
 * 计算一次时间范围定位的横向视口。该函数只处理几何关系，DOM 滚动动画继续由 Timeline 统一负责。
 */
export function getTimelineFocusScrollLeft(input: TimelineFocusScrollInput): number {
  const viewportWidth = normalizePositive(input.viewportWidth, 1);
  const timelineWidth = Math.max(normalizePositive(input.timelineWidth, viewportWidth), viewportWidth);
  const trackLabelWidth = Math.max(0, Math.min(normalizeFinite(input.trackLabelWidth, 0), viewportWidth - 1));
  const zoom = normalizePositive(input.zoom, 1);
  const startTime = Math.max(0, normalizeFinite(input.startTime, 0));
  const endTime = Math.max(startTime, normalizeFinite(input.endTime, startTime));
  const maxScrollLeft = Math.max(timelineWidth - viewportWidth, 0);
  const startCanvasX = trackLabelWidth + startTime * zoom;

  if (input.alignment === "start") {
    const startViewportOffset = Math.max(0, normalizeFinite(input.startViewportOffset, 120));
    return clamp(startCanvasX - startViewportOffset, 0, maxScrollLeft);
  }

  const contentWidth = Math.max(viewportWidth - trackLabelWidth, 1);
  const requestedPadding = Math.max(0, normalizeFinite(input.edgePadding, 24));
  // 小视口中余量不能挤掉主要内容；最多占可视内容宽度的四分之一。
  const edgePadding = Math.min(requestedPadding, contentWidth / 4);
  const rangeWidth = (endTime - startTime) * zoom;
  const centeredRangeFits = rangeWidth <= Math.max(contentWidth - edgePadding * 2, 1);
  const targetLeft = centeredRangeFits
    ? trackLabelWidth + ((startTime + endTime) / 2) * zoom - (trackLabelWidth + contentWidth / 2)
    : startCanvasX - (trackLabelWidth + edgePadding);

  return clamp(targetLeft, 0, maxScrollLeft);
}

function normalizeFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
