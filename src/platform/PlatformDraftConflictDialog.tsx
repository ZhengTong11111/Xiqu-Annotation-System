import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Files, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AnnotationFile } from "@xiqu/shared";
import type { ProjectData } from "../types";
import { buildAnnotationDiff } from "./annotationDiff";
import {
  AnnotationMergeDiffReview,
  type AnnotationMergeReviewIntent,
} from "./AnnotationMergeDiffReview";
import type { PlatformDraftRecord } from "./platformDraft";
import { formatResourceDate } from "./ResourceItem";

// stale 草稿比较固定本地在左、服务器在右；草稿不是资源文件，因此左侧不提供编辑器打开命令。
export function PlatformDraftConflictDialog(props: {
  file: AnnotationFile<ProjectData>;
  draft: PlatformDraftRecord;
  onBack: () => void;
  onPrepare: (intent: AnnotationMergeReviewIntent) => Promise<
    { ok: true } | { ok: false; message: string }
  >;
}) {
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [preparing, setPreparing] = useState(false);
  const comparison = useMemo(() => buildAnnotationDiff(
    props.draft.currentProject,
    props.file.payload,
  ), [props.draft.currentProject, props.file.payload]);

  // 新比较按真实变化初始化前两个领域，返回恢复提示后不保留旧选择或展开状态。
  useEffect(() => {
    if (!comparison.ok) {
      setExpandedDomains(new Set());
      return;
    }
    setExpandedDomains(new Set(
      comparison.diff.groups
        .filter((group) => group.counts.added + group.counts.removed + group.counts.modified > 0)
        .slice(0, 2)
        .map(({ domain }) => domain),
    ));
  }, [comparison]);

  return (
    <Dialog.Root open onOpenChange={(open) => {
      if (!open && !preparing) props.onBack();
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="resource-destination-backdrop" />
        <Dialog.Content className="annotation-comparison-dialog platform-draft-conflict-dialog">
          {/* 固定标题明确该流程只是生成未保存整合草稿，不会直接改写服务器。 */}
          <header className="annotation-comparison-header">
            <Files size={18} />
            <span>
              <Dialog.Title>比较本地草稿与服务器文件</Dialog.Title>
              <Dialog.Description>选择保留的本地改动，不会直接覆盖服务器</Dialog.Description>
            </span>
            <button
              type="button"
              title="返回草稿处理"
              disabled={preparing}
              onClick={props.onBack}
            >
              <X size={17} />
            </button>
          </header>

          {/* 两侧元数据使用草稿 envelope 与刚读取的 AnnotationFile，不引用资源列表旧摘要。 */}
          <section className="annotation-comparison-sides">
            <article>
              <span>左侧 · 浏览器草稿</span>
              <strong title={props.file.resource.name}>{props.file.resource.name}</strong>
              <dl>
                <div><dt>基准</dt><dd>r{props.draft.remoteBaseRevision}</dd></div>
                <div><dt>本地修订</dt><dd>{props.draft.localRevision}</dd></div>
                <div><dt>更新</dt><dd>{formatResourceDate(new Date(props.draft.updatedAt).toISOString())}</dd></div>
              </dl>
            </article>
            <article>
              <span>右侧 · 服务器当前</span>
              <strong title={props.file.resource.name}>{props.file.resource.name}</strong>
              <dl>
                <div><dt>修订</dt><dd>r{props.file.revision}</dd></div>
                <div><dt>编辑者</dt><dd>{props.file.lastEditor.displayName}</dd></div>
                <div><dt>保存</dt><dd>{formatResourceDate(props.file.lastSavedAt)}</dd></div>
              </dl>
            </article>
          </section>

          {/* 主体复用普通文件整合审阅，但方向固定左到右且不提供草稿侧打开动作。 */}
          <section className="annotation-comparison-body">
            {comparison.ok ? (
              <AnnotationMergeDiffReview
                comparison={comparison}
                expandedDomains={expandedDomains}
                openingSide={null}
                sideActions={[]}
                leftName="本地草稿"
                rightName="服务器当前文件"
                allowedDirections={["left-to-right"]}
                onToggleDomain={(domain) => setExpandedDomains((current) => {
                  const next = new Set(current);
                  if (next.has(domain)) next.delete(domain);
                  else next.add(domain);
                  return next;
                })}
                onExpandDomain={(domain) => setExpandedDomains((current) =>
                  current.has(domain) ? current : new Set([...current, domain]))}
                onPrepare={props.onPrepare}
                onPreparingChange={setPreparing}
              />
            ) : (
              <div className="annotation-comparison-state error">
                <AlertTriangle size={18} />
                {comparison.errors.map(({ side, message }) => (
                  <span key={`${side}:${message}`}>
                    {side === "left" ? "本地草稿" : "服务器文件"}：{message}
                  </span>
                ))}
              </div>
            )}
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
