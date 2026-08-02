import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleMinus,
  CirclePlus,
  Files,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationFile, ResourceEntry } from "@xiqu/shared";
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
import { formatResourceDate } from "./ResourceItem";

// 双侧请求状态与变化标签集中定义，避免组件分支使用不一致的状态文本。
type ComparisonSide = "left" | "right";
type LoadedComparisonSide = {
  file: AnnotationFile<unknown> | null;
  loading: boolean;
  error: string | null;
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
  onClose: () => void;
}) {
  const [orderedFiles, setOrderedFiles] = useState<
    [ResourceEntry, ResourceEntry] | null
  >(props.files);
  const [left, setLeft] = useState<LoadedComparisonSide>(EMPTY_SIDE);
  const [right, setRight] = useState<LoadedComparisonSide>(EMPTY_SIDE);
  const [diff, setDiff] = useState<AnnotationDiffResult | null>(null);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
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
    setDiff(null);
    setExpandedDomains(new Set());

    const loadSide = async (
      side: ComparisonSide,
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
    setDiff(result.diff);
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
      setDiff(null);
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
              disabled={!orderedFiles || left.loading || right.loading}
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
                ) : diff ? (
                  <ComparisonResult
                    diff={diff}
                    expandedDomains={expandedDomains}
                    onToggleDomain={toggleDomain}
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
  diff: AnnotationDiffResult;
  expandedDomains: Set<string>;
  onToggleDomain: (domain: string) => void;
}) {
  return (
    <>
      <div className="annotation-comparison-summary">
        {(["added", "removed", "modified", "unchanged"] as const).map((type) => (
          <span key={type} className={`change-${type}`}>
            <ChangeIcon type={type} />
            {CHANGE_LABELS[type]} <strong>{props.diff.counts[type]}</strong>
          </span>
        ))}
        <em>{props.diff.hasDifferences ? "检测到结构化差异" : "两个文件内容一致"}</em>
      </div>

      {/* 警告只呈现可解释的比较限制，不显示或持久化原始 payload。 */}
      {props.diff.warnings.length ? (
        <div className="annotation-comparison-warnings">
          {props.diff.warnings.map((warning) => (
            <span key={warning}><AlertTriangle size={13} /> {warning}</span>
          ))}
        </div>
      ) : null}

      <div className="annotation-comparison-groups">
        {props.diff.groups.map((group) => (
          <ComparisonGroup
            key={group.domain}
            group={group}
            expanded={props.expandedDomains.has(group.domain)}
            onToggle={() => props.onToggleDomain(group.domain)}
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
}) {
  const changedEntries = props.group.entries.filter(({ changeType }) =>
    changeType !== "unchanged");
  return (
    <section className="annotation-comparison-group">
      <button type="button" onClick={props.onToggle} aria-expanded={props.expanded}>
        {props.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <strong>{props.group.label}</strong>
        <span>{changedEntries.length} 处差异</span>
        <small>{props.group.counts.unchanged} 项未变</small>
      </button>
      {props.expanded ? (
        <div className="annotation-comparison-entry-list">
          {changedEntries.length ? changedEntries.map((entry) => (
            <div key={`${entry.changeType}:${entry.identity}`} className={`change-${entry.changeType}`}>
              <ChangeIcon type={entry.changeType} />
              <span>
                <strong title={entry.label}>{entry.label || entry.identity}</strong>
                <small title={entry.identity}>{entry.identity}</small>
              </span>
              <time>{formatComparisonRanges(entry.leftTimeRange, entry.rightTimeRange)}</time>
              <em>{entry.changedFields.length
                ? entry.changedFields.join("、")
                : CHANGE_LABELS[entry.changeType]}</em>
            </div>
          )) : (
            <p>该领域没有结构化差异。</p>
          )}
        </div>
      ) : null}
    </section>
  );
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
