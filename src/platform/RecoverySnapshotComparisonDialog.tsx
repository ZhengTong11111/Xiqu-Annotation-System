import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Files, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AnnotationFile,
  AnnotationRecoverySnapshotDetail,
  ResourceEntry,
} from "@xiqu/shared";
import type { AnnotationComparisonFocus } from "./annotationComparisonNavigation";
import { AnnotationDiffReview } from "./AnnotationDiffReview";
import { formatResourceDate } from "./ResourceItem";
import { buildRecoverySnapshotComparison } from "./recoverySnapshotComparison";

// 快照比较固定历史在左、当前文件在右；它只浏览 diff，不提供交换、整合或恢复写入命令。
export function RecoverySnapshotComparisonDialog(props: {
  open: boolean;
  resource: ResourceEntry;
  snapshot: AnnotationRecoverySnapshotDetail<unknown> | null;
  currentFile: AnnotationFile<unknown> | null;
  loading: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onOpenCurrentAtTime: (focus: AnnotationComparisonFocus) => Promise<boolean>;
}) {
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [openingCurrent, setOpeningCurrent] = useState(false);
  const comparison = useMemo(() => props.snapshot && props.currentFile
    ? buildRecoverySnapshotComparison({ snapshot: props.snapshot, currentFile: props.currentFile })
    : null, [props.currentFile, props.snapshot]);

  // 新比较会话按变化数量初始化前两个领域，关闭后不保留旧筛选与打开状态。
  useEffect(() => {
    if (!props.open || !comparison?.ok) {
      setExpandedDomains(new Set());
      setOpeningCurrent(false);
      return;
    }
    setExpandedDomains(new Set(
      comparison.diff.groups
        .filter((group) => group.counts.added + group.counts.removed + group.counts.modified > 0)
        .slice(0, 2)
        .map(({ domain }) => domain),
    ));
  }, [comparison, props.open]);

  // 当前文件定位继续走平台唯一打开入口；失败时保留比较上下文供用户重试。
  const openCurrentAtTime = async (focus: AnnotationComparisonFocus) => {
    if (openingCurrent) return;
    setOpeningCurrent(true);
    const opened = await props.onOpenCurrentAtTime(focus);
    if (!opened) setOpeningCurrent(false);
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="resource-destination-backdrop" />
        <Dialog.Content className="annotation-comparison-dialog recovery-comparison-dialog">
          {/* 固定头明确历史只读和当前文件方向，避免把恢复快照误认为普通可整合版本。 */}
          <header className="annotation-comparison-header">
            <Files size={18} />
            <span>
              <Dialog.Title>恢复快照与当前文件比较</Dialog.Title>
              <Dialog.Description>只读检查历史内容，不修改当前修订</Dialog.Description>
            </span>
            <Dialog.Close asChild>
              <button type="button" title="关闭比较"><X size={17} /></button>
            </Dialog.Close>
          </header>

          {/* 两侧卡片显示真实 revision 与创建/保存主体，不依赖资源列表的概括文案。 */}
          <section className="annotation-comparison-sides">
            <article>
              <span>左侧 · 恢复快照</span>
              <strong title={props.resource.name}>{props.resource.name}</strong>
              <dl>
                <div><dt>修订</dt><dd>r{props.snapshot?.revision ?? "—"}</dd></div>
                <div><dt>创建者</dt><dd>{props.snapshot?.creator.displayName ?? "—"}</dd></div>
                <div><dt>创建</dt><dd>{props.snapshot ? formatResourceDate(props.snapshot.createdAt) : "—"}</dd></div>
              </dl>
            </article>
            <article className={props.error ? "error" : ""}>
              <span>右侧 · 当前文件</span>
              <strong title={props.resource.name}>{props.resource.name}</strong>
              <dl>
                <div><dt>修订</dt><dd>r{props.currentFile?.revision ?? props.resource.revision ?? "—"}</dd></div>
                <div><dt>编辑者</dt><dd>{props.currentFile?.lastEditor.displayName ?? "—"}</dd></div>
                <div><dt>保存</dt><dd>{props.currentFile ? formatResourceDate(props.currentFile.lastSavedAt) : "—"}</dd></div>
              </dl>
              {props.error ? <p><AlertTriangle size={13} /> {props.error}</p> : null}
            </article>
          </section>

          {/* 主体只复用共享差异浏览；快照侧不传打开动作，因而不会出现历史编辑入口。 */}
          <section className="annotation-comparison-body">
            {props.loading ? (
              <ComparisonState><RefreshCw className="spinning" size={18} /> 正在读取当前文件...</ComparisonState>
            ) : props.error ? (
              <ComparisonState error><AlertTriangle size={18} /> 当前文件读取失败，请关闭后重试。</ComparisonState>
            ) : comparison?.ok ? (
              <AnnotationDiffReview
                diff={comparison.diff}
                expandedDomains={expandedDomains}
                openingSide={openingCurrent ? "right" : null}
                sideActions={[{
                  side: "right",
                  label: "打开当前文件并定位",
                  unavailableTitle: "当前文件没有可定位时间范围",
                  onOpen: openCurrentAtTime,
                }]}
                onToggleDomain={(domain) => setExpandedDomains((current) => {
                  const next = new Set(current);
                  if (next.has(domain)) next.delete(domain);
                  else next.add(domain);
                  return next;
                })}
                onExpandDomain={(domain) => setExpandedDomains((current) =>
                  current.has(domain) ? current : new Set([...current, domain]))}
              />
            ) : comparison ? (
              <ComparisonState error>
                <AlertTriangle size={18} />
                {comparison.errors.map(({ side, message }) => (
                  <span key={`${side}:${message}`}>{side === "left" ? "快照" : "当前文件"}：{message}</span>
                ))}
              </ComparisonState>
            ) : (
              <ComparisonState error><AlertTriangle size={18} /> 无法生成比较结果。</ComparisonState>
            )}
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// 快照比较的加载与错误状态共享紧凑布局，不把网络错误提升为资源管理器全局错误。
function ComparisonState(props: { error?: boolean; children: ReactNode }) {
  return <div className={`annotation-comparison-state${props.error ? " error" : ""}`}>{props.children}</div>;
}
