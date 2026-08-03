import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ArrowLeftRight,
  Files,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationFile, ResourceEntry } from "@xiqu/shared";
import type { ProjectData } from "../types";
import {
  PlatformApiError,
  type PlatformClient,
} from "../api/platformClient";
import {
  buildAnnotationDiff,
  type AnnotationDiffGroup,
  type AnnotationDiffResult,
} from "./annotationDiff";
import { AnnotationMergeDiffReview } from "./AnnotationMergeDiffReview";
import type {
  AnnotationComparisonFocus,
  AnnotationComparisonSide,
} from "./annotationComparisonNavigation";
import type {
  AnnotationMergePreparationRequest,
  AnnotationMergePreparationResult,
} from "./annotationMergeDraft";
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

// 对话框独立读取两份完整标注，只把结构化差异交给展示层，不污染资源选择或编辑器历史。
export function AnnotationComparisonDialog(props: {
  client: PlatformClient;
  files: [ResourceEntry, ResourceEntry] | null;
  onOpenFileAtTime: (
    resource: ResourceEntry,
    focus: AnnotationComparisonFocus,
  ) => Promise<boolean>;
  onPrepareMerge: (
    request: AnnotationMergePreparationRequest,
  ) => Promise<AnnotationMergePreparationResult>;
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
                  <AnnotationMergeDiffReview
                    key={`${orderedFiles[0].id}:${left.file?.revision ?? 0}:${orderedFiles[1].id}:${right.file?.revision ?? 0}`}
                    comparison={comparison}
                    expandedDomains={expandedDomains}
                    openingSide={openingSide}
                    leftName={orderedFiles[0].name}
                    rightName={orderedFiles[1].name}
                    allowedDirections={["left-to-right", "right-to-left"]}
                    onToggleDomain={toggleDomain}
                    onExpandDomain={expandDomain}
                    sideActions={(["left", "right"] as const).map((side, index) => ({
                      side,
                      label: `打开${side === "left" ? "左" : "右"}侧`,
                      unavailableTitle: `${side === "left" ? "左" : "右"}侧没有可定位时间范围`,
                      onOpen: async (focus) => {
                        setOpeningSide(side);
                        const opened = await props.onOpenFileAtTime(orderedFiles[index], focus);
                        if (!opened) setOpeningSide(null);
                      },
                    }))}
                    onPrepare={(intent) => props.onPrepareMerge({
                      leftResourceId: orderedFiles[0].id,
                      rightResourceId: orderedFiles[1].id,
                      leftRevision: left.file!.revision,
                      rightRevision: right.file!.revision,
                      ...intent,
                    })}
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
