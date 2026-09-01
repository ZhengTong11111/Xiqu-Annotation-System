import * as Dialog from "@radix-ui/react-dialog";
import { FileCheck2, Link2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  AnnotationReviewLinkDryRun,
  AnnotationReviewLinkRecord,
  AnnotationReviewPackageV1,
} from "@xiqu/shared";
import { parseAnnotationReviewPackage } from "@xiqu/document-model";

const MAX_REVIEW_PACKAGE_FILE_BYTES = 8 * 1024 * 1024;

type Props = {
  open: boolean;
  busy: boolean;
  portalContainer?: HTMLElement;
  onOpenChange: (open: boolean) => void;
  onDryRun: (reviewPackage: AnnotationReviewPackageV1) => Promise<AnnotationReviewLinkDryRun>;
  onConfirm: (reviewPackage: AnnotationReviewPackageV1) => Promise<AnnotationReviewLinkRecord>;
};

// 导入窗口显式分成“读取本地包 -> 服务端预检 -> 用户确认”三步，避免客户端预览被误认为已经写入。
export function AnnotationReviewImportDialog(props: Props) {
  const [reviewPackage, setReviewPackage] = useState<AnnotationReviewPackageV1 | null>(null);
  const [dryRun, setDryRun] = useState<AnnotationReviewLinkDryRun | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setReviewPackage(null);
    setDryRun(null);
    setFileName(null);
    setChecking(false);
    setSubmitting(false);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [props.open]);

  async function inspectFile(file: File | undefined) {
    if (!file || checking || submitting) return;
    setError(null);
    setReviewPackage(null);
    setDryRun(null);
    setFileName(file.name);
    if (file.size > MAX_REVIEW_PACKAGE_FILE_BYTES) {
      setError("审核包超过 8 MiB 安全读取上限。");
      return;
    }
    setChecking(true);
    try {
      const parsedJson = JSON.parse(await file.text()) as unknown;
      const parsed = parseAnnotationReviewPackage(parsedJson);
      if (!parsed.ok) throw new Error(`审核包格式不正确：${parsed.issues.join("；")}`);
      setReviewPackage(parsed.value);
      // 客户端解析只改善反馈速度；来源真实性、权限和目标映射必须由服务端重新核验。
      const result = await props.onDryRun(parsed.value);
      setDryRun(result);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setChecking(false);
    }
  }

  async function confirmImport() {
    if (!reviewPackage || dryRun?.status !== "ready" || checking || submitting || props.busy) return;
    setSubmitting(true);
    setError(null);
    try {
      await props.onConfirm(reviewPackage);
      props.onOpenChange(false);
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setSubmitting(false);
    }
  }

  const interactionBusy = checking || submitting || props.busy;
  return <Dialog.Root
    open={props.open}
    onOpenChange={(open) => {
      if (!interactionBusy) props.onOpenChange(open);
    }}
  >
    <Dialog.Portal container={props.portalContainer}>
      <Dialog.Overlay className="system-diagnostics-backdrop" />
      <Dialog.Content className="annotation-review-import-dialog">
        <header className="system-diagnostics-header">
          <div><Link2 size={20} /><div>
            <Dialog.Title>重新链接审核包</Dialog.Title>
            <Dialog.Description>把已验证来源的审核历史关联到当前文件</Dialog.Description>
          </div></div>
          <Dialog.Close asChild>
            <button type="button" title="关闭" disabled={interactionBusy}><X size={17} /></button>
          </Dialog.Close>
        </header>

        <div className="annotation-review-import-body">
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => void inspectFile(event.target.files?.[0])}
          />
          <button
            type="button"
            className="annotation-review-import-file"
            disabled={interactionBusy}
            onClick={() => inputRef.current?.click()}
          >
            <Upload size={17} />
            <span>{fileName ?? "选择 .review-package.json"}</span>
          </button>

          {checking ? <p className="annotation-confirmation-muted">正在核验来源、权限、目标修订和轨道…</p> : null}
          {error ? <div className="annotation-confirmation-error">{error}</div> : null}
          {dryRun ? <section className="annotation-review-import-summary">
            <div className="annotation-review-import-summary-title">
              <FileCheck2 size={17} />
              <strong>{dryRun.status === "ready" ? "预检通过" : "已经关联"}</strong>
            </div>
            <dl>
              <div><dt>来源</dt><dd>{dryRun.source.annotationFileName}</dd></div>
              <div><dt>来源修订</dt><dd>v{dryRun.source.revision}</dd></div>
              <div><dt>目标</dt><dd>{dryRun.target.annotationFileName}</dd></div>
              <div><dt>目标修订</dt><dd>v{dryRun.target.revision}</dd></div>
              <div><dt>记录</dt><dd>{dryRun.counts.confirmations} 条确认，{dryRun.counts.rangeRecords} 条评论/反馈</dd></div>
              <div><dt>轨道</dt><dd>{dryRun.matchedTrackIds.length ? `${dryRun.matchedTrackIds.length} 条精确匹配` : "不含轨道限定"}</dd></div>
            </dl>
            <p>关联只增加可撤销的来源关系；不会移动、修改或删除来源审核记录，也不会修改当前标注内容。</p>
            {dryRun.status === "duplicate" ? <p className="annotation-confirmation-blocker">
              相同内容已经关联，当前状态为{dryRun.duplicateLifecycle === "active" ? "有效" : "已撤销"}，不能重复导入。
            </p> : null}
          </section> : null}
        </div>

        <footer className="annotation-review-import-actions">
          <Dialog.Close asChild><button type="button" disabled={interactionBusy}>取消</button></Dialog.Close>
          <button
            type="button"
            className="annotation-confirmation-primary"
            disabled={interactionBusy || dryRun?.status !== "ready" || !reviewPackage}
            onClick={() => void confirmImport()}
          >{submitting ? "正在关联…" : "确认关联"}</button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "审核包预检失败，请检查文件后重试。";
}
