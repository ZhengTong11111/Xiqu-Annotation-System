import type {
  AnnotationDiffEntry,
  AnnotationDiffTimeRange,
} from "./annotationDiff";

// 比较导航只允许打开明确的左、右文件，避免 UI 使用数组下标自行推断方向。
export type AnnotationComparisonSide = "left" | "right";

// 初始焦点是一次性的编辑器会话指令，不属于标注项目数据，也不会参与保存或撤销历史。
export type AnnotationComparisonFocus = {
  time: number;
  start: number;
  end: number;
  source: "annotation-comparison";
};

// 将所选侧的真实时间范围转换为编辑器启动焦点；无有效范围时返回 null 供 UI 禁用命令。
export function buildAnnotationComparisonFocus(
  entry: AnnotationDiffEntry,
  side: AnnotationComparisonSide,
): AnnotationComparisonFocus | null {
  const range = side === "left" ? entry.leftTimeRange : entry.rightTimeRange;
  const normalizedRange = normalizeComparisonTimeRange(range);
  if (!normalizedRange) return null;

  return {
    time: normalizedRange.start,
    start: normalizedRange.start,
    end: normalizedRange.end,
    source: "annotation-comparison",
  };
}

// 比较文件可能来自旧数据，导航前必须拒绝非法时间并纠正反向范围，不能用 0 秒掩盖坏数据。
function normalizeComparisonTimeRange(
  range: AnnotationDiffTimeRange | null,
): AnnotationDiffTimeRange | null {
  if (
    !range ||
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.start < 0 ||
    range.end < 0
  ) {
    return null;
  }

  return {
    start: Math.min(range.start, range.end),
    end: Math.max(range.start, range.end),
  };
}
