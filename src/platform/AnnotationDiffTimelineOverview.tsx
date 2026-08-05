import { useEffect, useMemo, useRef, useState } from "react";
import type { AnnotationDiffDomain } from "./annotationDiff";
import {
  hitTestAnnotationDiffTimeline,
  timeToTimelineX,
  type AnnotationDiffTimelineRailBounds,
  type AnnotationDiffTimelineSegment,
} from "./annotationDiffTimeline";

type AnnotationDiffTimelineOverviewProps = {
  duration: number;
  segments: AnnotationDiffTimelineSegment[];
  selectedEntryKey: string | null;
  onSelectSegment: (segment: AnnotationDiffTimelineSegment) => void;
};

type CanvasSize = {
  width: number;
  height: number;
};

const CANVAS_HEIGHT = 116;
const PLOT_LEFT = 46;
const PLOT_RIGHT = 10;
const RAIL_BOUNDS: AnnotationDiffTimelineRailBounds = {
  left: { top: 31, bottom: 51 },
  right: { top: 72, bottom: 92 },
};

// 领域颜色固定且低饱和；上下轨和文字标签继续提供颜色之外的左右语义。
export const ANNOTATION_DIFF_DOMAIN_COLORS: Record<AnnotationDiffDomain, string> = {
  project: "#8290a3",
  subtitle_lines: "#4f83b8",
  characters: "#725fb1",
  gongche: "#238b79",
  banyan_sections: "#b17036",
  banyan_marks: "#bd5e4a",
  custom_tracks: "#7b8798",
  custom_blocks: "#3a91a4",
  attached_points: "#9a6a9d",
};

const CHANGE_TYPE_LABELS = {
  added: "新增",
  removed: "删除",
  modified: "修改",
} as const;

// Canvas 概览只负责绘制和命中；筛选、网络请求和分组展开由比较 Dialog 管理。
export function AnnotationDiffTimelineOverview(
  props: AnnotationDiffTimelineOverviewProps,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: CANVAS_HEIGHT });
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const hoveredSegment = useMemo(() => props.segments.find(({ key }) =>
    key === hoveredKey) ?? null, [hoveredKey, props.segments]);
  const selectedSegments = useMemo(() => props.segments.filter(({ entryKey }) =>
    entryKey === props.selectedEntryKey), [props.segments, props.selectedEntryKey]);

  // 监听实际容器宽度，避免 Dialog 改宽或窄屏时仍使用陈旧的 window 尺寸。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const updateSize = () => setSize({
      width: Math.max(0, host.clientWidth),
      height: CANVAS_HEIGHT,
    });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // 输入片段、选中状态或高 DPI 比例改变时一次性重绘，不为每个标记创建 React 节点。
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || size.width <= 0) return;
    const deviceScale = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = Math.ceil(size.width * deviceScale);
    canvas.height = Math.ceil(size.height * deviceScale);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    drawTimelineOverview(context, {
      width: size.width,
      height: size.height,
      duration: props.duration,
      segments: props.segments,
      selectedEntryKey: props.selectedEntryKey,
      hoveredKey,
    });
  }, [
    hoveredKey,
    props.duration,
    props.segments,
    props.selectedEntryKey,
    size,
  ]);

  // 指针命中先扣除左侧标签区域，再交给纯 helper 选择唯一最佳片段。
  const resolvePointerSegment = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const plotWidth = Math.max(0, rect.width - PLOT_LEFT - PLOT_RIGHT);
    return hitTestAnnotationDiffTimeline(props.segments, {
      duration: props.duration,
      width: plotWidth,
      x: event.clientX - rect.left - PLOT_LEFT,
      y: event.clientY - rect.top,
      railBounds: RAIL_BOUNDS,
      horizontalPadding: 6,
    });
  };

  // hover 仅更新轻量状态文本和重绘高亮，不触发列表滚动或文件加载。
  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    setHoveredKey(resolvePointerSegment(event)?.key ?? null);
  };

  // pointer-down 与桌面时间轴的即时定位习惯一致，也避免拖动结束后才改变当前差异。
  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const segment = resolvePointerSegment(event);
    if (segment) props.onSelectSegment(segment);
  };

  const statusSegment = hoveredSegment ?? selectedSegments[0] ?? null;
  return (
    <section className="annotation-diff-timeline-overview" aria-label="标注差异时间概览">
      <div ref={hostRef} className="annotation-diff-timeline-canvas-host">
        <canvas
          ref={canvasRef}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoveredKey(null)}
          onPointerDown={handlePointerDown}
          aria-label="左右标注文件的差异时间分布图"
        />
      </div>
      {/* 相邻状态文本让 Canvas 的当前焦点无需只靠颜色辨认。 */}
      <p aria-live="polite">
        {statusSegment
          ? `${statusSegment.side === "left" ? "左侧" : "右侧"} · ${CHANGE_TYPE_LABELS[statusSegment.changeType]} · ${statusSegment.label} · ${formatTimeRange(statusSegment.start, statusSegment.end)}`
          : props.selectedEntryKey
            ? "所选差异没有可定位的时间范围。"
            : props.segments.length
            ? "指向时间标记可查看差异，点击可定位到下方条目。"
            : "当前筛选条件下没有可定位的时间差异。"}
      </p>
    </section>
  );
}

// 绘制顺序固定为背景、刻度、片段和选中轮廓，避免高亮被后绘制的普通片段覆盖。
function drawTimelineOverview(
  context: CanvasRenderingContext2D,
  options: {
    width: number;
    height: number;
    duration: number;
    segments: AnnotationDiffTimelineSegment[];
    selectedEntryKey: string | null;
    hoveredKey: string | null;
  },
) {
  context.clearRect(0, 0, options.width, options.height);
  context.fillStyle = "#f7f9fc";
  context.fillRect(0, 0, options.width, options.height);
  const plotWidth = Math.max(0, options.width - PLOT_LEFT - PLOT_RIGHT);
  drawTimelineAxes(context, plotWidth, options.duration);
  if (plotWidth <= 0 || options.duration <= 0) return;

  // 普通片段先绘制，较透明的填色能保留密集区域的分布感。
  for (const segment of options.segments) {
    drawTimelineSegment(context, segment, plotWidth, options.duration, false, false);
  }

  // 选中实体可同时在左右各有一个范围，两侧都用深色外框标明关联。
  for (const segment of options.segments) {
    if (segment.entryKey === options.selectedEntryKey) {
      drawTimelineSegment(context, segment, plotWidth, options.duration, true, false);
    }
  }
  const hovered = options.segments.find(({ key }) => key === options.hoveredKey);
  if (hovered) {
    drawTimelineSegment(context, hovered, plotWidth, options.duration, false, true);
  }
}

// 双侧轨共享一个 0–duration 坐标轴，筛选变化时不会重新缩放导致标记跳动。
function drawTimelineAxes(
  context: CanvasRenderingContext2D,
  plotWidth: number,
  duration: number,
) {
  context.font = "10px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillStyle = "#68778b";
  context.fillText("左侧", 9, 41);
  context.fillText("右侧", 9, 82);
  for (const rail of Object.values(RAIL_BOUNDS)) {
    context.fillStyle = "#edf2f7";
    context.fillRect(PLOT_LEFT, rail.top, plotWidth, rail.bottom - rail.top);
    context.strokeStyle = "#d8e1eb";
    context.strokeRect(PLOT_LEFT + 0.5, rail.top + 0.5, Math.max(0, plotWidth - 1), rail.bottom - rail.top - 1);
  }
  if (plotWidth <= 0) return;

  // 五个刻度足以提供定位语义，同时避免窄屏标签互相遮挡。
  for (let index = 0; index <= 4; index += 1) {
    const ratio = index / 4;
    const x = PLOT_LEFT + plotWidth * ratio;
    context.strokeStyle = "#dfe6ee";
    context.beginPath();
    context.moveTo(x + 0.5, 21);
    context.lineTo(x + 0.5, 98);
    context.stroke();
    context.fillStyle = "#7c899a";
    context.textAlign = index === 0 ? "left" : index === 4 ? "right" : "center";
    context.fillText(formatAxisTime(duration * ratio), x, 12);
  }
  context.textAlign = "left";
}

// 时间点使用窄竖标，区间使用胶囊矩形；最小宽度仅服务可见和命中，不改变真实范围。
function drawTimelineSegment(
  context: CanvasRenderingContext2D,
  segment: AnnotationDiffTimelineSegment,
  plotWidth: number,
  duration: number,
  selected: boolean,
  hovered: boolean,
) {
  const rail = RAIL_BOUNDS[segment.side];
  const rawLeft = PLOT_LEFT + timeToTimelineX(segment.start, duration, plotWidth);
  const rawRight = PLOT_LEFT + timeToTimelineX(segment.end, duration, plotWidth);
  const width = Math.max(segment.start === segment.end ? 3 : 2, rawRight - rawLeft);
  const left = rawLeft - (segment.start === segment.end ? width / 2 : 0);
  const top = rail.top + 3;
  const height = rail.bottom - rail.top - 6;

  context.save();
  context.globalAlpha = selected || hovered ? 1 : 0.66;
  context.fillStyle = ANNOTATION_DIFF_DOMAIN_COLORS[segment.domain];
  context.beginPath();
  context.roundRect(left, top, width, height, Math.min(3, width / 2));
  context.fill();
  // 虚线轮廓区分删除，实线轮廓区分修改；新增保持纯填色，避免只依赖颜色判断变化类型。
  if (segment.changeType !== "added" && !selected && !hovered) {
    context.globalAlpha = 0.9;
    context.lineWidth = 1;
    context.strokeStyle = segment.changeType === "removed" ? "#8d3841" : "#66531e";
    if (segment.changeType === "removed") context.setLineDash([2, 2]);
    context.stroke();
  }
  if (selected || hovered) {
    context.globalAlpha = 1;
    context.lineWidth = selected ? 2 : 1.5;
    context.strokeStyle = selected ? "#173f68" : "#ffffff";
    context.stroke();
  }
  context.restore();
}

// 总轴刻度按分秒显示，适配从短片段到整折视频的常见长度。
function formatAxisTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

// 当前实体状态保留毫秒精度，便于研究者和下方结构化时间字段交叉核对。
function formatTimeRange(start: number, end: number) {
  if (start === end) return `${start.toFixed(3)}s`;
  return `${start.toFixed(3)}–${end.toFixed(3)}s`;
}
