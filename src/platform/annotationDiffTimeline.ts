import type {
  AnnotationDiffChangeType,
  AnnotationDiffDomain,
  AnnotationDiffEntry,
  AnnotationDiffResult,
  AnnotationDiffTimeRange,
} from "./annotationDiff";

// 时间概览只接收真实变化类型；未变化实体继续留在结构化列表中，不进入导航索引。
export type AnnotationDiffTimelineChangeType = Exclude<
  AnnotationDiffChangeType,
  "unchanged"
>;

export type AnnotationDiffTimelineSide = "left" | "right";

export type AnnotationDiffTimelineSegment = {
  key: string;
  entryKey: string;
  side: AnnotationDiffTimelineSide;
  domain: AnnotationDiffDomain;
  changeType: AnnotationDiffTimelineChangeType;
  identity: string;
  label: string;
  start: number;
  end: number;
};

export type AnnotationDiffTimelineUntimedEntry = {
  entryKey: string;
  domain: AnnotationDiffDomain;
  changeType: AnnotationDiffTimelineChangeType;
};

export type AnnotationDiffTimelineIndex = {
  duration: number;
  segments: AnnotationDiffTimelineSegment[];
  untimedEntries: AnnotationDiffTimelineUntimedEntry[];
  invalidRangeCount: number;
  normalizedRangeCount: number;
};

export type AnnotationDiffTimelineFilter = {
  domains: ReadonlySet<AnnotationDiffDomain>;
  changeTypes: ReadonlySet<AnnotationDiffTimelineChangeType>;
  timeWindow?: AnnotationDiffTimeRange | null;
};

export type FilteredAnnotationDiffTimeline = {
  duration: number;
  segments: AnnotationDiffTimelineSegment[];
  untimedChangedCount: number;
  invalidRangeCount: number;
  normalizedRangeCount: number;
};

export type AnnotationDiffTimelineRailBounds = Record<
  AnnotationDiffTimelineSide,
  { top: number; bottom: number }
>;

const TIMELINE_SIDES: AnnotationDiffTimelineSide[] = ["left", "right"];

// 领域和 identity 一起组成 UI 稳定键，防止不同研究领域恰好复用相同业务 id。
export function getAnnotationDiffEntryKey(
  entry: Pick<AnnotationDiffEntry, "domain" | "identity">,
) {
  return `${entry.domain}:${entry.identity}`;
}

// 结构化 diff 在此一次转换为可筛选时间索引；React 和 Canvas 不再各自解释左右时间范围。
export function buildAnnotationDiffTimelineIndex(
  diff: AnnotationDiffResult,
): AnnotationDiffTimelineIndex {
  const segments: AnnotationDiffTimelineSegment[] = [];
  const untimedEntries: AnnotationDiffTimelineUntimedEntry[] = [];
  let invalidRangeCount = 0;
  let normalizedRangeCount = 0;

  // 每个变化实体最多生成左右各一个片段；修改实体因此可以在双侧轨道上同时出现。
  for (const group of diff.groups) {
    for (const entry of group.entries) {
      if (entry.changeType === "unchanged") continue;
      const entryKey = getAnnotationDiffEntryKey(entry);
      let validRangeCount = 0;

      for (const side of TIMELINE_SIDES) {
        const rawRange = side === "left"
          ? entry.leftTimeRange
          : entry.rightTimeRange;
        if (!rawRange) continue;
        const normalized = normalizeTimelineRange(rawRange);
        if (!normalized) {
          invalidRangeCount += 1;
          continue;
        }
        if (normalized.wasReversed) normalizedRangeCount += 1;
        const range = normalized.range;
        validRangeCount += 1;
        segments.push({
          key: `${entryKey}:${side}`,
          entryKey,
          side,
          domain: entry.domain,
          changeType: entry.changeType,
          identity: entry.identity,
          label: entry.label || entry.identity,
          start: range.start,
          end: range.end,
        });
      }

      // 没有任何有效左右范围的变化仍需计数，避免概览把项目字段等差异悄悄吞掉。
      if (validRangeCount === 0) {
        untimedEntries.push({
          entryKey,
          domain: entry.domain,
          changeType: entry.changeType,
        });
      }
    }
  }

  // 稳定排序保证相同输入的绘制、命中和测试顺序一致，不依赖 Map 或数组插入细节。
  segments.sort((left, right) =>
    TIMELINE_SIDES.indexOf(left.side) - TIMELINE_SIDES.indexOf(right.side) ||
    left.start - right.start ||
    left.end - right.end ||
    left.domain.localeCompare(right.domain) ||
    left.identity.localeCompare(right.identity));

  return {
    duration: segments.reduce((maximum, segment) =>
      Math.max(maximum, segment.end), 0),
    segments,
    untimedEntries,
    invalidRangeCount,
    normalizedRangeCount,
  };
}

// 筛选保持全局 duration 不变，使用户切换领域时标记不会因坐标轴缩放而跳动。
export function filterAnnotationDiffTimeline(
  index: AnnotationDiffTimelineIndex,
  filter: AnnotationDiffTimelineFilter,
): FilteredAnnotationDiffTimeline {
  const windowRange = filter.timeWindow
    ? normalizeTimelineRange(filter.timeWindow)?.range ?? null
    : null;
  const matchesCategory = (
    item: Pick<AnnotationDiffTimelineSegment, "domain" | "changeType">,
  ) => filter.domains.has(item.domain) &&
    filter.changeTypes.has(item.changeType);

  return {
    duration: index.duration,
    segments: index.segments.filter((segment) =>
      matchesCategory(segment) &&
      (!windowRange || rangesIntersect(segment, windowRange))),
    untimedChangedCount: index.untimedEntries.filter(matchesCategory).length,
    invalidRangeCount: index.invalidRangeCount,
    normalizedRangeCount: index.normalizedRangeCount,
  };
}

// Canvas 命中使用 CSS 像素计算，区间与点事件都获得最小可点宽度，但不修改其真实时间值。
export function hitTestAnnotationDiffTimeline(
  segments: readonly AnnotationDiffTimelineSegment[],
  options: {
    duration: number;
    width: number;
    x: number;
    y: number;
    railBounds: AnnotationDiffTimelineRailBounds;
    horizontalPadding?: number;
    verticalPadding?: number;
  },
): AnnotationDiffTimelineSegment | null {
  if (options.duration <= 0 || options.width <= 0) return null;
  const horizontalPadding = options.horizontalPadding ?? 5;
  const verticalPadding = options.verticalPadding ?? 5;
  const candidates: Array<{
    segment: AnnotationDiffTimelineSegment;
    distance: number;
    duration: number;
  }> = [];

  // 先按双侧轨道限制候选，再计算指针到真实投影区间的距离。
  for (const segment of segments) {
    const rail = options.railBounds[segment.side];
    if (
      options.y < rail.top - verticalPadding ||
      options.y > rail.bottom + verticalPadding
    ) continue;
    const startX = timeToTimelineX(segment.start, options.duration, options.width);
    const endX = timeToTimelineX(segment.end, options.duration, options.width);
    const left = Math.min(startX, endX);
    const right = Math.max(startX, endX);
    const distance = options.x < left
      ? left - options.x
      : options.x > right
        ? options.x - right
        : 0;
    if (distance > horizontalPadding) continue;
    candidates.push({
      segment,
      distance,
      duration: segment.end - segment.start,
    });
  }

  // 重叠时优先真正离指针更近的片段，再选更短区间，最后用稳定 key 消除随机选择。
  candidates.sort((left, right) =>
    left.distance - right.distance ||
    left.duration - right.duration ||
    left.segment.key.localeCompare(right.segment.key));
  return candidates[0]?.segment ?? null;
}

// 时间到横坐标的纯映射由模型与 Canvas 共用，边界值固定夹在可视宽度内。
export function timeToTimelineX(time: number, duration: number, width: number) {
  if (duration <= 0 || width <= 0) return 0;
  return Math.max(0, Math.min(width, (time / duration) * width));
}

// 导入数据可能存在反向范围；有限非负值可安全归一化，NaN、Infinity 和负值则拒绝进入绘制层。
function normalizeTimelineRange(
  range: AnnotationDiffTimeRange,
): { range: AnnotationDiffTimeRange; wasReversed: boolean } | null {
  if (
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.start < 0 ||
    range.end < 0
  ) return null;
  return {
    range: {
      start: Math.min(range.start, range.end),
      end: Math.max(range.start, range.end),
    },
    wasReversed: range.start > range.end,
  };
}

// 时间窗口采用闭区间相交语义，恰好落在窗口边界的点标记仍然保留。
function rangesIntersect(
  left: AnnotationDiffTimeRange,
  right: AnnotationDiffTimeRange,
) {
  return left.end >= right.start && left.start <= right.end;
}
