import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleMinus,
  CirclePlus,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type AnnotationDiffChangeType,
  type AnnotationDiffGroup,
  type AnnotationDiffResult,
  type AnnotationDiffTimeRange,
} from "./annotationDiff";
import {
  buildAnnotationComparisonFocus,
  type AnnotationComparisonFocus,
  type AnnotationComparisonSide,
} from "./annotationComparisonNavigation";
import {
  ANNOTATION_DIFF_DOMAIN_COLORS,
  AnnotationDiffTimelineOverview,
} from "./AnnotationDiffTimelineOverview";
import {
  buildAnnotationDiffTimelineIndex,
  filterAnnotationDiffTimeline,
  getAnnotationDiffEntryKey,
  type AnnotationDiffTimelineChangeType,
  type AnnotationDiffTimelineSegment,
} from "./annotationDiffTimeline";

export type AnnotationDiffReviewEntry = AnnotationDiffGroup["entries"][number];

export type AnnotationDiffReviewSideAction = {
  side: AnnotationComparisonSide;
  label: string;
  unavailableTitle: string;
  onOpen: (focus: AnnotationComparisonFocus) => void | Promise<void>;
};

export type AnnotationDiffReviewProps = {
  diff: AnnotationDiffResult;
  expandedDomains: ReadonlySet<string>;
  openingSide: AnnotationComparisonSide | null;
  sideActions: readonly AnnotationDiffReviewSideAction[];
  onToggleDomain: (domain: AnnotationDiffGroup["domain"]) => void;
  onExpandDomain: (domain: AnnotationDiffGroup["domain"]) => void;
  beforeGroups?: ReactNode;
  renderGroupControl?: (group: AnnotationDiffGroup) => ReactNode;
  renderEntryControl?: (entry: AnnotationDiffReviewEntry) => ReactNode;
};

const CHANGE_LABELS: Record<AnnotationDiffChangeType, string> = {
  added: "新增",
  removed: "删除",
  modified: "修改",
  unchanged: "未变",
};

// 共享只读差异浏览器只处理筛选、时间导航和结构化条目；普通文件整合与快照恢复通过组合槽扩展。
export function AnnotationDiffReview(props: AnnotationDiffReviewProps) {
  const timelineIndex = useMemo(() =>
    buildAnnotationDiffTimelineIndex(props.diff), [props.diff]);
  const availableDomains = useMemo(() => new Set(
    props.diff.groups
      .filter((group) => changedCount(group) > 0)
      .map(({ domain }) => domain),
  ), [props.diff.groups]);
  const [selectedDomains, setSelectedDomains] = useState(() =>
    new Set(availableDomains));
  const [selectedChangeTypes, setSelectedChangeTypes] = useState<
    Set<AnnotationDiffTimelineChangeType>
  >(() => new Set(["added", "removed", "modified"]));
  const [navigationEntryKey, setNavigationEntryKey] = useState<string | null>(null);
  const [pendingScrollEntryKey, setPendingScrollEntryKey] = useState<string | null>(null);
  const entryElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const filteredTimeline = useMemo(() => filterAnnotationDiffTimeline(
    timelineIndex,
    { domains: selectedDomains, changeTypes: selectedChangeTypes },
  ), [timelineIndex, selectedChangeTypes, selectedDomains]);
  const visibleEntryCount = useMemo(() => new Set(
    filteredTimeline.segments.map(({ entryKey }) => entryKey),
  ).size, [filteredTimeline.segments]);
  const groupLabels = useMemo(() => new Map(props.diff.groups.map((group) =>
    [group.domain, group.label])), [props.diff.groups]);

  // 当前导航条目始终从稳定 key 反查，不复制 diff 对象或持有可能过期的数组引用。
  const selectedEntry = useMemo(() => {
    if (!navigationEntryKey) return null;
    for (const group of props.diff.groups) {
      const entry = group.entries.find((item) =>
        getAnnotationDiffEntryKey(item) === navigationEntryKey);
      if (entry) return entry;
    }
    return null;
  }, [navigationEntryKey, props.diff.groups]);

  // 领域真正展开并挂载差异按钮后再滚动，避免依赖 React 提交时序猜测 DOM。
  useEffect(() => {
    if (!pendingScrollEntryKey) return;
    const element = entryElementsRef.current.get(pendingScrollEntryKey);
    if (!element) return;
    element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setPendingScrollEntryKey(null);
  }, [pendingScrollEntryKey, props.expandedDomains]);

  // 筛选变化会清理旧导航高亮，防止屏幕显示与当前选中条目互相矛盾。
  const toggleTimelineDomain = (domain: AnnotationDiffGroup["domain"]) => {
    setNavigationEntryKey(null);
    setSelectedDomains((current) => toggleSetValue(current, domain));
  };

  const toggleTimelineChangeType = (changeType: AnnotationDiffTimelineChangeType) => {
    setNavigationEntryKey(null);
    setSelectedChangeTypes((current) => toggleSetValue(current, changeType));
  };

  // Canvas 命中先展开目标领域，再把对应差异按钮滚入当前对话框视口。
  const selectTimelineSegment = (segment: AnnotationDiffTimelineSegment) => {
    setNavigationEntryKey(segment.entryKey);
    setPendingScrollEntryKey(segment.entryKey);
    props.onExpandDomain(segment.domain);
  };

  // 从差异列表选择条目时同步打开对应筛选，使 Canvas 必然能显示左右时间范围。
  const selectDiffEntry = (entry: AnnotationDiffReviewEntry) => {
    setNavigationEntryKey(getAnnotationDiffEntryKey(entry));
    if (entry.changeType === "unchanged") return;
    const visibleChangeType: AnnotationDiffTimelineChangeType = entry.changeType;
    setSelectedDomains((current) => current.has(entry.domain)
      ? current
      : new Set([...current, entry.domain]));
    setSelectedChangeTypes((current) => current.has(visibleChangeType)
      ? current
      : new Set([...current, visibleChangeType]));
  };

  return (
    <>
      {/* 摘要与警告完全消费结构化 diff，不从原始 payload 二次推断。 */}
      <div className="annotation-comparison-summary">
        {(["added", "removed", "modified", "unchanged"] as const).map((type) => (
          <span key={type} className={`change-${type}`}>
            <ChangeIcon type={type} />
            {CHANGE_LABELS[type]} <strong>{props.diff.counts[type]}</strong>
          </span>
        ))}
        <em>{props.diff.hasDifferences ? "检测到结构化差异" : "两个文件内容一致"}</em>
      </div>
      {props.diff.warnings.length ? (
        <div className="annotation-comparison-warnings">
          {props.diff.warnings.map((warning) => (
            <span key={warning}><AlertTriangle size={13} /> {warning}</span>
          ))}
        </div>
      ) : null}

      {/* 时间概览提供纯只读筛选和导航；可打开哪一侧由调用方显式提供。 */}
      <section className="annotation-comparison-timeline-section">
        <div className="annotation-comparison-timeline-heading">
          <span>
            <strong>时间差异概览</strong>
            <small>左右内容共用 0–{formatAxisDuration(timelineIndex.duration)} 时间尺度</small>
          </span>
          <em>{visibleEntryCount} 项可定位 · {filteredTimeline.untimedChangedCount} 项无时间</em>
        </div>
        <fieldset className="annotation-comparison-filters">
          <legend>研究领域</legend>
          {[...availableDomains].map((domain) => (
            <label
              key={domain}
              style={{
                "--annotation-domain-color": ANNOTATION_DIFF_DOMAIN_COLORS[domain],
              } as CSSProperties}
            >
              <input
                type="checkbox"
                checked={selectedDomains.has(domain)}
                onChange={() => toggleTimelineDomain(domain)}
              />
              <span className="annotation-comparison-domain-swatch" aria-hidden="true" />
              {groupLabels.get(domain) ?? domain}
            </label>
          ))}
        </fieldset>
        <fieldset className="annotation-comparison-filters compact">
          <legend>变化类型</legend>
          {(["added", "removed", "modified"] as const).map((changeType) => (
            <label key={changeType} className={`change-${changeType}`}>
              <input
                type="checkbox"
                checked={selectedChangeTypes.has(changeType)}
                onChange={() => toggleTimelineChangeType(changeType)}
              />
              {CHANGE_LABELS[changeType]}
            </label>
          ))}
          {timelineIndex.invalidRangeCount ? (
            <small>{timelineIndex.invalidRangeCount} 个非法时间范围未绘制</small>
          ) : null}
          {timelineIndex.normalizedRangeCount ? (
            <small>{timelineIndex.normalizedRangeCount} 个反向范围已纠正</small>
          ) : null}
        </fieldset>
        <AnnotationDiffTimelineOverview
          duration={filteredTimeline.duration}
          segments={filteredTimeline.segments}
          selectedEntryKey={navigationEntryKey}
          onSelectSegment={selectTimelineSegment}
        />
        <div className="annotation-comparison-open-actions">
          <span>
            {selectedEntry
              ? `当前选择：${selectedEntry.label || selectedEntry.identity}`
              : "选择时间概览或下方差异条目后，可打开允许定位的一侧。"}
          </span>
          {props.sideActions.map((action) => {
            const focus = selectedEntry
              ? buildAnnotationComparisonFocus(selectedEntry, action.side)
              : null;
            return (
              <button
                key={action.side}
                type="button"
                disabled={!focus || props.openingSide !== null}
                title={focus ? action.label : action.unavailableTitle}
                onClick={() => {
                  if (focus) void action.onOpen(focus);
                }}
              >
                {props.openingSide === action.side
                  ? <RefreshCw className="spinning" size={14} />
                  : <ExternalLink size={14} />}
                {action.label}
              </button>
            );
          })}
        </div>
      </section>

      {props.beforeGroups}

      {/* 差异分组允许调用方插入只读之外的前导控件，但共享层不理解整合或恢复业务。 */}
      <div className="annotation-comparison-groups">
        {props.diff.groups.map((group) => (
          <DiffGroup
            key={group.domain}
            group={group}
            expanded={props.expandedDomains.has(group.domain)}
            navigationEntryKey={navigationEntryKey}
            onToggle={() => props.onToggleDomain(group.domain)}
            onSelectEntry={selectDiffEntry}
            renderGroupControl={props.renderGroupControl}
            renderEntryControl={props.renderEntryControl}
            registerEntryElement={(key, element) => {
              if (element) entryElementsRef.current.set(key, element);
              else entryElementsRef.current.delete(key);
            }}
          />
        ))}
      </div>
    </>
  );
}

// 分组只负责差异条目展示；普通文件的整合复选框通过可选槽组合，不污染快照比较。
function DiffGroup(props: {
  group: AnnotationDiffGroup;
  expanded: boolean;
  navigationEntryKey: string | null;
  onToggle: () => void;
  onSelectEntry: (entry: AnnotationDiffReviewEntry) => void;
  renderGroupControl?: (group: AnnotationDiffGroup) => ReactNode;
  renderEntryControl?: (entry: AnnotationDiffReviewEntry) => ReactNode;
  registerEntryElement: (key: string, element: HTMLButtonElement | null) => void;
}) {
  const changedEntries = props.group.entries.filter(({ changeType }) =>
    changeType !== "unchanged");
  return (
    <section className="annotation-comparison-group">
      <header className="annotation-comparison-group-header">
        <button type="button" onClick={props.onToggle} aria-expanded={props.expanded}>
          {props.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <strong>{props.group.label}</strong>
          <span>{changedEntries.length} 处差异</span>
          <small>{props.group.counts.unchanged} 项未变</small>
        </button>
        {props.renderGroupControl?.(props.group)}
      </header>
      {props.expanded ? (
        <div className="annotation-comparison-entry-list">
          {changedEntries.length ? changedEntries.map((entry) => {
            const entryKey = getAnnotationDiffEntryKey(entry);
            return (
              <div
                key={`${entry.changeType}:${entry.identity}`}
                className={`annotation-comparison-entry-row change-${entry.changeType}`}
              >
                {props.renderEntryControl?.(entry)}
                <button
                  ref={(element) => props.registerEntryElement(entryKey, element)}
                  type="button"
                  className={props.navigationEntryKey === entryKey ? "selected" : ""}
                  onClick={() => props.onSelectEntry(entry)}
                  aria-pressed={props.navigationEntryKey === entryKey}
                >
                  <ChangeIcon type={entry.changeType} />
                  <span>
                    <strong title={entry.label}>{entry.label || entry.identity}</strong>
                    <small title={entry.identity}>{entry.identity}</small>
                  </span>
                  <time>{formatComparisonRanges(entry.leftTimeRange, entry.rightTimeRange)}</time>
                  <em>{entry.changedFields.length
                    ? entry.changedFields.join("、")
                    : CHANGE_LABELS[entry.changeType]}</em>
                </button>
              </div>
            );
          }) : <p>该领域没有结构化差异。</p>}
        </div>
      ) : null}
    </section>
  );
}

// 变化图标为颜色之外提供第二重含义，保证不同视觉条件下仍能识别状态。
function ChangeIcon(props: { type: AnnotationDiffChangeType }) {
  if (props.type === "added") return <CirclePlus size={14} />;
  if (props.type === "removed") return <CircleMinus size={14} />;
  if (props.type === "modified") return <RefreshCw size={14} />;
  return <Check size={14} />;
}

// 时间范围同时保留左右值；只有一侧存在时仍能定位新增或删除对象。
function formatComparisonRanges(
  left: AnnotationDiffTimeRange | null,
  right: AnnotationDiffTimeRange | null,
) {
  const format = (value: AnnotationDiffTimeRange | null) => value
    ? `${value.start.toFixed(3)}–${value.end.toFixed(3)}s`
    : "—";
  if (left && right && left.start === right.start && left.end === right.end) return format(left);
  return `左 ${format(left)} / 右 ${format(right)}`;
}

// Set 切换 helper 同时服务领域和变化类型，避免两个事件处理器维护不同更新语义。
function toggleSetValue<T>(current: ReadonlySet<T>, value: T) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// 分组差异数排除未变化项，用于筛选初始值。
function changedCount(group: AnnotationDiffGroup) {
  return group.counts.added + group.counts.removed + group.counts.modified;
}

// 轴总长使用简洁分秒格式，毫秒精度继续保留在具体条目的时间文字中。
function formatAxisDuration(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${Math.floor(safeSeconds % 60).toString().padStart(2, "0")}`;
}
