import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleMinus,
  CirclePlus,
  ExternalLink,
  Files,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnnotationFile, ResourceEntry } from "@xiqu/shared";
import type { ProjectData } from "../types";
import {
  PlatformApiError,
  type PlatformClient,
} from "../api/platformClient";
import {
  buildAnnotationDiff,
  type AnnotationDiffChangeType,
  type AnnotationDiffGroup,
  type AnnotationDiffResult,
  type AnnotationDiffTimeRange,
} from "./annotationDiff";
import { AnnotationMergePlanPanel } from "./AnnotationMergePlanPanel";
import {
  buildAnnotationComparisonFocus,
  type AnnotationComparisonFocus,
  type AnnotationComparisonSide,
} from "./annotationComparisonNavigation";
import {
  buildAnnotationMergePlan,
  type AnnotationMergeDirection,
} from "./annotationMergePlan";
import {
  getMergeGroupSelectionState,
  isMergeEntrySelectable,
  normalizeMergeSelection,
  setMergeEntrySelection,
  setMergeGroupSelection,
} from "./annotationMergeSelection";
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
import { formatResourceDate } from "./ResourceItem";

// 双侧请求状态与变化标签集中定义，避免组件分支使用不一致的状态文本。
type LoadedComparisonSide = {
  file: AnnotationFile<unknown> | null;
  loading: boolean;
  error: string | null;
};

// 比较会话只保留同一次规范化产生的 diff 与两侧项目，避免 UI 和计划器各自迁移原始 payload。
type LoadedComparisonModel = {
  diff: AnnotationDiffResult;
  leftProject: ProjectData;
  rightProject: ProjectData;
};

const EMPTY_SIDE: LoadedComparisonSide = {
  file: null,
  loading: false,
  error: null,
};

const CHANGE_LABELS: Record<AnnotationDiffChangeType, string> = {
  added: "新增",
  removed: "删除",
  modified: "修改",
  unchanged: "未变",
};

// 对话框独立读取两份完整标注，只把结构化差异交给展示层，不污染资源选择或编辑器历史。
export function AnnotationComparisonDialog(props: {
  client: PlatformClient;
  files: [ResourceEntry, ResourceEntry] | null;
  onOpenFileAtTime: (
    resource: ResourceEntry,
    focus: AnnotationComparisonFocus,
  ) => Promise<boolean>;
  onClose: () => void;
}) {
  const [orderedFiles, setOrderedFiles] = useState<
    [ResourceEntry, ResourceEntry] | null
  >(props.files);
  const [left, setLeft] = useState<LoadedComparisonSide>(EMPTY_SIDE);
  const [right, setRight] = useState<LoadedComparisonSide>(EMPTY_SIDE);
  const [comparison, setComparison] = useState<LoadedComparisonModel | null>(null);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [openingSide, setOpeningSide] = useState<AnnotationComparisonSide | null>(null);
  const requestGenerationRef = useRef(0);

  // 外层选择确定一次比较会话；关闭和重新打开时重新建立明确的左右顺序。
  useEffect(() => {
    setOrderedFiles(props.files);
  }, [props.files]);

  // 单侧读取使用共享 generation；交换、关闭或换文件后，迟到响应不能覆盖新会话。
  const loadComparison = useCallback(async (
    files: [ResourceEntry, ResourceEntry],
  ) => {
    const generation = ++requestGenerationRef.current;
    setLeft({ file: null, loading: true, error: null });
    setRight({ file: null, loading: true, error: null });
    setComparison(null);
    setExpandedDomains(new Set());
    setOpeningSide(null);

    const loadSide = async (
      side: AnnotationComparisonSide,
      resource: ResourceEntry,
    ): Promise<AnnotationFile<unknown> | null> => {
      try {
        const file = await props.client.getAnnotationFile<unknown>(resource.id);
        if (generation !== requestGenerationRef.current) return null;
        const setter = side === "left" ? setLeft : setRight;
        setter({ file, loading: false, error: null });
        return file;
      } catch (error) {
        if (generation !== requestGenerationRef.current) return null;
        const setter = side === "left" ? setLeft : setRight;
        setter({ file: null, loading: false, error: describeComparisonError(error) });
        return null;
      }
    };

    const [leftFile, rightFile] = await Promise.all([
      loadSide("left", files[0]),
      loadSide("right", files[1]),
    ]);
    if (
      generation !== requestGenerationRef.current ||
      !leftFile ||
      !rightFile
    ) return;

    // 两侧网络读取都成功后才做项目迁移；迁移失败继续归属到明确的一侧。
    const result = buildAnnotationDiff(leftFile.payload, rightFile.payload);
    if (!result.ok) {
      for (const error of result.errors) {
        const setter = error.side === "left" ? setLeft : setRight;
        setter((current) => ({ ...current, error: error.message }));
      }
      return;
    }
    // 同一次正式迁移同时供应 diff 和计划器，React 不再二次解释原始 payload。
    setComparison({
      diff: result.diff,
      leftProject: result.leftProject,
      rightProject: result.rightProject,
    });
    setExpandedDomains(new Set(
      result.diff.groups
        .filter((group) => changedCount(group) > 0)
        .slice(0, 2)
        .map((group) => group.domain),
    ));
  }, [props.client]);

  // 每次左右资源改变时完整重读，交换后摘要、错误方向和文件信息都保持一致。
  useEffect(() => {
    if (!orderedFiles) {
      requestGenerationRef.current += 1;
      setLeft(EMPTY_SIDE);
      setRight(EMPTY_SIDE);
      setComparison(null);
      return;
    }
    void loadComparison(orderedFiles);
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [loadComparison, orderedFiles]);

  // 领域行只管理展示展开状态；比较结果本身保持不可变。
  const toggleDomain = (domain: string) => {
    setExpandedDomains((current) => {
      const next = new Set(current);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  // Canvas 定位需要把目标领域明确展开；与用户手动折叠的 toggle 语义分开。
  const expandDomain = (domain: string) => {
    setExpandedDomains((current) => current.has(domain)
      ? current
      : new Set([...current, domain]));
  };

  const close = () => {
    requestGenerationRef.current += 1;
    props.onClose();
  };

  return (
    <Dialog.Root open={Boolean(orderedFiles)} onOpenChange={(open) => {
      if (!open) close();
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="resource-destination-backdrop" />
        <Dialog.Content className="annotation-comparison-dialog">
          {/* 固定头部保留文件方向和关闭命令，主体滚动时仍能确认比较上下文。 */}
          <header className="annotation-comparison-header">
            <Files size={18} />
            <span>
              <Dialog.Title>比较标注文件</Dialog.Title>
              <Dialog.Description>按保存实体与稳定标识检查多模态差异</Dialog.Description>
            </span>
            <button
              type="button"
              disabled={
                !orderedFiles ||
                left.loading ||
                right.loading ||
                openingSide !== null
              }
              onClick={() => setOrderedFiles((current) => current
                ? [current[1], current[0]]
                : null)}
              title="交换左右文件"
            >
              <ArrowLeftRight size={16} />
            </button>
            <Dialog.Close asChild>
              <button type="button" title="关闭比较"><X size={17} /></button>
            </Dialog.Close>
          </header>

          {orderedFiles ? (
            <>
              {/* 双侧文件条分别展示请求状态，单侧失败不会被模糊成一个全局错误。 */}
              <section className="annotation-comparison-sides">
                <ComparisonSideHeader
                  label="左侧"
                  resource={orderedFiles[0]}
                  state={left}
                />
                <ComparisonSideHeader
                  label="右侧"
                  resource={orderedFiles[1]}
                  state={right}
                />
              </section>

              <section className="annotation-comparison-body">
                {left.loading || right.loading ? (
                  <ComparisonState icon={<RefreshCw className="spinning" size={18} />}>
                    正在读取并迁移两份标注文件...
                  </ComparisonState>
                ) : left.error || right.error ? (
                  <ComparisonState icon={<AlertTriangle size={18} />} error>
                    <span>比较尚未生成，请先处理上方标出的文件错误。</span>
                    <button type="button" onClick={() => void loadComparison(orderedFiles)}>
                      <RefreshCw size={14} /> 重新读取
                    </button>
                  </ComparisonState>
                ) : comparison ? (
                  <ComparisonResult
                    key={`${orderedFiles[0].id}:${left.file?.revision ?? 0}:${orderedFiles[1].id}:${right.file?.revision ?? 0}`}
                    comparison={comparison}
                    expandedDomains={expandedDomains}
                    files={orderedFiles}
                    openingSide={openingSide}
                    onToggleDomain={toggleDomain}
                    onExpandDomain={expandDomain}
                    onOpenFileAtTime={async (resource, focus, side) => {
                      setOpeningSide(side);
                      const opened = await props.onOpenFileAtTime(resource, focus);
                      if (!opened) setOpeningSide(null);
                    }}
                  />
                ) : (
                  <ComparisonState icon={<AlertTriangle size={18} />} error>
                    无法生成比较结果。
                  </ComparisonState>
                )}
              </section>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// 单侧文件信息同时呈现资源元数据和实际读取到的 revision/最后编辑者。
function ComparisonSideHeader(props: {
  label: string;
  resource: ResourceEntry;
  state: LoadedComparisonSide;
}) {
  return (
    <article className={props.state.error ? "error" : ""}>
      <span>{props.label}</span>
      <strong title={props.resource.name}>{props.resource.name}</strong>
      <dl>
        <div><dt>版本</dt><dd>r{props.state.file?.revision ?? props.resource.revision ?? "—"}</dd></div>
        <div><dt>所有者</dt><dd>{props.resource.owner.displayName}</dd></div>
        <div><dt>修改</dt><dd>{formatResourceDate(props.resource.updatedAt)}</dd></div>
        {props.state.file ? (
          <div><dt>编辑者</dt><dd>{props.state.file.lastEditor.displayName}</dd></div>
        ) : null}
      </dl>
      {props.state.error ? (
        <p><AlertTriangle size={13} /> {props.state.error}</p>
      ) : null}
    </article>
  );
}

// 结果总览先给出全局计数，再按固定研究领域展开差异条目。
function ComparisonResult(props: {
  comparison: LoadedComparisonModel;
  files: [ResourceEntry, ResourceEntry];
  openingSide: AnnotationComparisonSide | null;
  expandedDomains: Set<string>;
  onToggleDomain: (domain: string) => void;
  onExpandDomain: (domain: string) => void;
  onOpenFileAtTime: (
    resource: ResourceEntry,
    focus: AnnotationComparisonFocus,
    side: AnnotationComparisonSide,
  ) => Promise<void>;
}) {
  const diff = props.comparison.diff;
  const timelineIndex = useMemo(() =>
    buildAnnotationDiffTimelineIndex(diff), [diff]);
  const availableDomains = useMemo(() => new Set(
    diff.groups
      .filter((group) => changedCount(group) > 0)
      .map(({ domain }) => domain),
  ), [diff.groups]);
  const [selectedDomains, setSelectedDomains] = useState(() =>
    new Set(availableDomains));
  const [selectedChangeTypes, setSelectedChangeTypes] = useState<
    Set<AnnotationDiffTimelineChangeType>
  >(() => new Set(["added", "removed", "modified"]));
  const [navigationEntryKey, setNavigationEntryKey] = useState<string | null>(null);
  const [mergeDirection, setMergeDirection] = useState<AnnotationMergeDirection>(
    "left-to-right",
  );
  const [mergeSelectedEntryKeys, setMergeSelectedEntryKeys] = useState<Set<string>>(
    new Set(),
  );
  const [pendingScrollEntryKey, setPendingScrollEntryKey] = useState<string | null>(null);
  const entryElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const filteredTimeline = useMemo(() => filterAnnotationDiffTimeline(
    timelineIndex,
    {
      domains: selectedDomains,
      changeTypes: selectedChangeTypes,
    },
  ), [timelineIndex, selectedChangeTypes, selectedDomains]);
  const visibleEntryCount = useMemo(() => new Set(
    filteredTimeline.segments.map(({ entryKey }) => entryKey),
  ).size, [filteredTimeline.segments]);
  const groupLabels = useMemo(() => new Map(diff.groups.map((group) =>
    [group.domain, group.label])), [diff.groups]);
  // 当前条目始终从稳定 key 反查，不复制 diff 对象，交换与筛选后不会保留陈旧实体。
  const selectedEntry = useMemo(() => {
    if (!navigationEntryKey) return null;
    for (const group of diff.groups) {
      const entry = group.entries.find((item) =>
        getAnnotationDiffEntryKey(item) === navigationEntryKey);
      if (entry) return entry;
    }
    return null;
  }, [diff.groups, navigationEntryKey]);
  const mergePlan = useMemo(() => buildAnnotationMergePlan({
    leftProject: props.comparison.leftProject,
    rightProject: props.comparison.rightProject,
    diff,
    direction: mergeDirection,
    selectedEntryKeys: [...mergeSelectedEntryKeys],
  }), [diff, mergeDirection, mergeSelectedEntryKeys, props.comparison]);
  const leftFocus = selectedEntry
    ? buildAnnotationComparisonFocus(selectedEntry, "left")
    : null;
  const rightFocus = selectedEntry
    ? buildAnnotationComparisonFocus(selectedEntry, "right")
    : null;

  // 等目标领域真正展开并挂载差异按钮后再滚动，避免依赖 React 提交时序猜测 DOM 是否存在。
  useEffect(() => {
    if (!pendingScrollEntryKey) return;
    const element = entryElementsRef.current.get(pendingScrollEntryKey);
    if (!element) return;
    element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setPendingScrollEntryKey(null);
  }, [pendingScrollEntryKey, props.expandedDomains]);

  // 筛选切换以不可变 Set 更新，并清理可能已隐藏的旧高亮。
  const toggleTimelineDomain = (domain: AnnotationDiffGroup["domain"]) => {
    setNavigationEntryKey(null);
    setSelectedDomains((current) => toggleSetValue(current, domain));
  };

  const toggleTimelineChangeType = (
    changeType: AnnotationDiffTimelineChangeType,
  ) => {
    setNavigationEntryKey(null);
    setSelectedChangeTypes((current) => toggleSetValue(current, changeType));
  };

  // Canvas 片段定位先展开领域，再等 React 挂载目标按钮后滚到当前 Dialog 视口内。
  const selectTimelineSegment = (segment: AnnotationDiffTimelineSegment) => {
    setNavigationEntryKey(segment.entryKey);
    setPendingScrollEntryKey(segment.entryKey);
    props.onExpandDomain(segment.domain);
  };

  // 差异按钮引用只服务定位，在领域折叠卸载时同步删除，避免保存失效 DOM。
  const registerEntryElement = (key: string, element: HTMLButtonElement | null) => {
    if (element) entryElementsRef.current.set(key, element);
    else entryElementsRef.current.delete(key);
  };

  // 从结构化列表选择条目时同步打开对应筛选，使 Canvas 必然能高亮其左右时间范围。
  const selectDiffEntry = (
    entry: AnnotationDiffGroup["entries"][number],
  ) => {
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
      <div className="annotation-comparison-summary">
        {(["added", "removed", "modified", "unchanged"] as const).map((type) => (
          <span key={type} className={`change-${type}`}>
            <ChangeIcon type={type} />
            {CHANGE_LABELS[type]} <strong>{diff.counts[type]}</strong>
          </span>
        ))}
        <em>{diff.hasDifferences ? "检测到结构化差异" : "两个文件内容一致"}</em>
      </div>

      {/* 警告只呈现可解释的比较限制，不显示或持久化原始 payload。 */}
      {diff.warnings.length ? (
        <div className="annotation-comparison-warnings">
          {diff.warnings.map((warning) => (
            <span key={warning}><AlertTriangle size={13} /> {warning}</span>
          ))}
        </div>
      ) : null}

      {/* 时间概览使用纯 diff 索引，提供筛选及 Canvas/条目双向定位，不加载第二份编辑器。 */}
      <section className="annotation-comparison-timeline-section">
        <div className="annotation-comparison-timeline-heading">
          <span>
            <strong>时间差异概览</strong>
            <small>左右文件共用 0–{formatAxisDuration(timelineIndex.duration)} 时间尺度</small>
          </span>
          <em>
            {visibleEntryCount} 项可定位 · {filteredTimeline.untimedChangedCount} 项无时间
          </em>
        </div>
        <fieldset className="annotation-comparison-filters">
          <legend>研究领域</legend>
          {[...availableDomains].map((domain) => (
            <label
              key={domain}
              style={{
                "--annotation-domain-color": ANNOTATION_DIFF_DOMAIN_COLORS[domain],
              } as React.CSSProperties}
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
        {/* 单侧打开命令使用真实结构化范围；不存在或无时间的侧明确禁用，不回退到 0 秒。 */}
        <div className="annotation-comparison-open-actions">
          <span>
            {selectedEntry
              ? `当前选择：${selectedEntry.label || selectedEntry.identity}`
              : "选择时间概览或下方差异条目后，可打开对应文件定位。"}
          </span>
          <button
            type="button"
            disabled={!leftFocus || props.openingSide !== null}
            title={leftFocus ? "打开左侧文件并定位到该差异" : "左侧没有可定位时间范围"}
            onClick={() => {
              if (leftFocus) {
                void props.onOpenFileAtTime(props.files[0], leftFocus, "left");
              }
            }}
          >
            {props.openingSide === "left"
              ? <RefreshCw className="spinning" size={14} />
              : <ExternalLink size={14} />}
            打开左侧
          </button>
          <button
            type="button"
            disabled={!rightFocus || props.openingSide !== null}
            title={rightFocus ? "打开右侧文件并定位到该差异" : "右侧没有可定位时间范围"}
            onClick={() => {
              if (rightFocus) {
                void props.onOpenFileAtTime(props.files[1], rightFocus, "right");
              }
            }}
          >
            {props.openingSide === "right"
              ? <RefreshCw className="spinning" size={14} />
              : <ExternalLink size={14} />}
            打开右侧
          </button>
        </div>
      </section>

      <AnnotationMergePlanPanel
        direction={mergeDirection}
        leftFileName={props.files[0].name}
        rightFileName={props.files[1].name}
        selectedEntryCount={mergeSelectedEntryKeys.size}
        plan={mergePlan}
        onDirectionChange={(direction) => {
          // 方向切换保留双侧修改项，但清除新来源侧不存在的单侧实体。
          setMergeDirection(direction);
          setMergeSelectedEntryKeys((current) =>
            normalizeMergeSelection(diff, direction, current));
        }}
        onClearSelection={() => setMergeSelectedEntryKeys(new Set())}
      />

      <div className="annotation-comparison-groups">
        {diff.groups.map((group) => (
          <ComparisonGroup
            key={group.domain}
            group={group}
            expanded={props.expandedDomains.has(group.domain)}
            onToggle={() => props.onToggleDomain(group.domain)}
            navigationEntryKey={navigationEntryKey}
            mergeDirection={mergeDirection}
            mergeSelectedEntryKeys={mergeSelectedEntryKeys}
            onSelectEntry={selectDiffEntry}
            onSetMergeEntrySelection={(entryKey, selected) => {
              setMergeSelectedEntryKeys((current) =>
                setMergeEntrySelection(current, entryKey, selected));
            }}
            onSetMergeGroupSelection={(selected) => {
              setMergeSelectedEntryKeys((current) =>
                setMergeGroupSelection(current, group, mergeDirection, selected));
            }}
            registerEntryElement={registerEntryElement}
          />
        ))}
      </div>
    </>
  );
}

// 分组默认只列出真正变化的保存实体，未变化数量仍保留在分组计数中供用户核对。
function ComparisonGroup(props: {
  group: AnnotationDiffGroup;
  expanded: boolean;
  onToggle: () => void;
  navigationEntryKey: string | null;
  mergeDirection: AnnotationMergeDirection;
  mergeSelectedEntryKeys: ReadonlySet<string>;
  onSelectEntry: (entry: AnnotationDiffGroup["entries"][number]) => void;
  onSetMergeEntrySelection: (entryKey: string, selected: boolean) => void;
  onSetMergeGroupSelection: (selected: boolean) => void;
  registerEntryElement: (key: string, element: HTMLButtonElement | null) => void;
}) {
  const changedEntries = props.group.entries.filter(({ changeType }) =>
    changeType !== "unchanged");
  const groupSelection = getMergeGroupSelectionState(
    props.mergeSelectedEntryKeys,
    props.group,
    props.mergeDirection,
  );
  return (
    <section className="annotation-comparison-group">
      <header className="annotation-comparison-group-header">
        <button type="button" onClick={props.onToggle} aria-expanded={props.expanded}>
          {props.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <strong>{props.group.label}</strong>
          <span>{changedEntries.length} 处差异</span>
          <small>{props.group.counts.unchanged} 项未变</small>
        </button>
        <MergeGroupCheckbox
          state={groupSelection}
          label={`${props.group.label}整合选择`}
          onChange={props.onSetMergeGroupSelection}
        />
      </header>
      {props.expanded ? (
        <div className="annotation-comparison-entry-list">
          {changedEntries.length ? changedEntries.map((entry) => {
            const entryKey = getAnnotationDiffEntryKey(entry);
            const mergeSelectable = isMergeEntrySelectable(
              entry,
              props.mergeDirection,
            );
            return (
              <div
                key={`${entry.changeType}:${entry.identity}`}
                className={`annotation-comparison-entry-row change-${entry.changeType}`}
              >
                <label
                  className="annotation-comparison-merge-checkbox"
                  title={mergeSelectable
                    ? "加入选择性整合预检"
                    : getMergeDisabledReason(entry, props.mergeDirection)}
                >
                  <input
                    type="checkbox"
                    checked={props.mergeSelectedEntryKeys.has(entryKey)}
                    disabled={!mergeSelectable}
                    aria-label={`${entry.label || entry.identity}加入整合预检`}
                    onChange={(event) => props.onSetMergeEntrySelection(
                      entryKey,
                      event.currentTarget.checked,
                    )}
                  />
                </label>
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
          );}) : (
            <p>该领域没有结构化差异。</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

// 原生 checkbox 的 indeterminate 只能通过 DOM 属性设置，独立组件避免每个分组复制 ref 逻辑。
function MergeGroupCheckbox(props: {
  state: ReturnType<typeof getMergeGroupSelectionState>;
  label: string;
  onChange: (selected: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = props.state.indeterminate;
    }
  }, [props.state.indeterminate]);
  return (
    <label
      className="annotation-comparison-group-selection"
      title={props.state.selectableCount > 0
        ? "选择或取消该领域全部可整合差异"
        : "该领域没有当前方向可整合的差异"}
    >
      <input
        ref={inputRef}
        type="checkbox"
        checked={props.state.checked}
        disabled={props.state.selectableCount === 0}
        aria-label={props.label}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>{props.state.selectedCount}/{props.state.selectableCount}</span>
    </label>
  );
}

// 禁用原因按业务方向解释，避免用户只能看到一个没有语义的灰色 checkbox。
function getMergeDisabledReason(
  entry: AnnotationDiffGroup["entries"][number],
  direction: AnnotationMergeDirection,
) {
  if (entry.domain === "project") return "项目与媒体设置不能作为局部实体整合";
  if (entry.changeType === "unchanged") return "未变化实体只会在需要时作为自动依赖";
  return direction === "left-to-right"
    ? "该实体只存在于右侧，左侧没有可整合来源"
    : "该实体只存在于左侧，右侧没有可整合来源";
}

// 状态区复用加载、失败和空结果布局，避免三套近似 JSX 漂移。
function ComparisonState(props: {
  icon: JSX.Element;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`annotation-comparison-state${props.error ? " error" : ""}`}>
      {props.icon}
      {props.children}
    </div>
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
  if (left && right && left.start === right.start && left.end === right.end) {
    return format(left);
  }
  return `左 ${format(left)} / 右 ${format(right)}`;
}

// 网络错误只输出安全的人类可读摘要，不把响应详情或 payload 暴露到界面。
function describeComparisonError(error: unknown) {
  if (error instanceof PlatformApiError) {
    if (error.status === 403) return "没有读取该文件的权限。";
    if (error.status === 404) return "文件不存在或已不可见。";
    return error.message || `读取失败（${error.status}）。`;
  }
  return error instanceof Error ? error.message : "读取标注文件失败。";
}

// 分组差异数排除未变化项，用于默认展开和标题摘要。
function changedCount(group: AnnotationDiffGroup) {
  return group.counts.added + group.counts.removed + group.counts.modified;
}

// Set 切换 helper 同时服务领域和变化类型，避免两个事件处理器维护不同更新语义。
function toggleSetValue<T>(current: ReadonlySet<T>, value: T) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// 轴总长使用简洁分秒格式，毫秒精度继续保留在具体条目的时间文字中。
function formatAxisDuration(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${Math.floor(safeSeconds % 60).toString().padStart(2, "0")}`;
}
