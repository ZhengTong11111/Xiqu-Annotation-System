import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  AlignmentApplicationSummary,
  AlignmentRunPage,
  AlignmentRunSummary,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { createRuntimeUuid } from "../utils/runtimeUuid";

const EMPTY_PAGE: AlignmentRunPage = { items: [], nextCursor: null };

export function AlignmentRunsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: PlatformClient;
  annotationFileId: string;
  currentRevision: number;
  applyDisabledReason?: string;
  onApplyingChange: (applying: boolean) => void;
  onApplied: (application: AlignmentApplicationSummary) => Promise<void>;
}) {
  const [page, setPage] = useState<AlignmentRunPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<AlignmentRunSummary | null>(null);
  const [applyingRunId, setApplyingRunId] = useState<string | null>(null);
  // 模糊网络失败后保留同一 actionId；用户点击重试时服务端才能返回原提交，而不是重复形成 revision。
  const retryActionRef = useRef<{ runId: string; baseRevision: number; actionId: string } | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void props.client.listAlignmentRuns(
      props.annotationFileId,
      { limit: 30 },
      controller.signal,
    ).then(
      (nextPage) => setPage(nextPage),
      (nextError: unknown) => {
        if (!controller.signal.aborted) setError(describeError(nextError));
      },
    ).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [props.annotationFileId, props.client, props.open]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setPage(await props.client.listAlignmentRuns(props.annotationFileId, { limit: 30 }));
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!page.nextCursor || moreLoading) return;
    setMoreLoading(true);
    setError(null);
    try {
      const next = await props.client.listAlignmentRuns(props.annotationFileId, {
        cursor: page.nextCursor,
        limit: 30,
      });
      setPage((current) => ({
        items: deduplicateRuns([...current.items, ...next.items]),
        nextCursor: next.nextCursor,
      }));
    } catch (nextError) {
      setError(describeError(nextError));
    } finally {
      setMoreLoading(false);
    }
  }

  async function applyRun(run: AlignmentRunSummary) {
    if (props.applyDisabledReason || applyingRunId) return;
    const previous = retryActionRef.current;
    const actionId = previous?.runId === run.id && previous.baseRevision === props.currentRevision
      ? previous.actionId
      : createRuntimeUuid();
    retryActionRef.current = { runId: run.id, baseRevision: props.currentRevision, actionId };
    props.onApplyingChange(true);
    setApplyingRunId(run.id);
    setError(null);
    try {
      const application = await props.client.applyAlignmentRun(
        props.annotationFileId,
        run.id,
        { clientActionId: actionId, baseRevision: props.currentRevision },
      );
      await props.onApplied(application);
      retryActionRef.current = null;
      setConfirmTarget(null);
      await refresh();
    } catch (nextError) {
      // 保留 actionId 仅用于同一 revision/run 的显式重试；切换 run 或 revision 会自动生成新动作。
      setError(describeError(nextError));
    } finally {
      setApplyingRunId(null);
      props.onApplyingChange(false);
    }
  }

  return (
    <>
      <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="system-diagnostics-backdrop" />
          <Dialog.Content className="alignment-runs-dialog">
            <header className="alignment-runs-header">
              <div>
                <Sparkles size={20} />
                <div>
                  <Dialog.Title>强制对齐结果</Dialog.Title>
                  <Dialog.Description>查看后台预测，并明确应用到当前逐字时间</Dialog.Description>
                </div>
              </div>
              <div>
                <button type="button" title="刷新结果" disabled={loading} onClick={() => void refresh()}>
                  <RefreshCw size={17} />
                </button>
                <Dialog.Close asChild>
                  <button type="button" title="关闭"><X size={17} /></button>
                </Dialog.Close>
              </div>
            </header>

            {error ? <div className="alignment-runs-error">{error}</div> : null}
            {props.applyDisabledReason ? (
              <div className="alignment-runs-notice">应用暂不可用：{props.applyDisabledReason}</div>
            ) : null}

            <div className="alignment-runs-list" aria-busy={loading}>
              {page.items.map((run) => {
                const applicable = run.status === "succeeded" &&
                  run.artifactAvailable && run.canApplyToCurrentDocument;
                return (
                  <article key={run.id} className="alignment-run-row">
                    <div className="alignment-run-primary">
                      <strong>{run.modelLabel}</strong>
                      <span className={`alignment-run-status is-${run.status}`}>
                        {formatStatus(run)}
                      </span>
                    </div>
                    <div className="alignment-run-facts">
                      <span>输入版本 v{run.inputRevision}</span>
                      <span>{run.inputSentenceCount} 句</span>
                      <span>{run.inputCharacterCount} 字</span>
                      <span>{formatTime(run.completedAt ?? run.createdAt)}</span>
                    </div>
                    <div className="alignment-run-compatibility">
                      {applicable ? (
                        <><Check size={15} /> 仍适用于当前正文与音轨</>
                      ) : describeUnavailable(run)}
                    </div>
                    <button
                      type="button"
                      className="platform-primary-button"
                      disabled={!applicable || Boolean(props.applyDisabledReason) || Boolean(applyingRunId)}
                      onClick={() => setConfirmTarget(run)}
                    >
                      {applyingRunId === run.id ? "正在应用…" : "应用逐字时间"}
                    </button>
                  </article>
                );
              })}
              {!loading && page.items.length === 0 ? (
                <div className="alignment-runs-empty">当前文件还没有强制对齐结果。</div>
              ) : null}
              {loading && page.items.length === 0 ? (
                <div className="alignment-runs-empty">正在读取强制对齐历史…</div>
              ) : null}
            </div>
            {page.nextCursor ? (
              <button
                type="button"
                className="alignment-runs-load-more"
                disabled={moreLoading}
                onClick={() => void loadMore()}
              >
                {moreLoading ? "正在加载…" : "加载更多"}
              </button>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root
        open={Boolean(confirmTarget)}
        onOpenChange={(open) => {
          if (!open && !applyingRunId) setConfirmTarget(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="system-diagnostics-backdrop" />
          <AlertDialog.Content className="alignment-apply-confirm-dialog">
            <AlertDialog.Title>应用强制对齐逐字时间？</AlertDialog.Title>
            <AlertDialog.Description>
              这会覆盖当前文件全部逐字块的时间边界，并作为一次普通平台修订保存。句级字幕不会改变，之后仍可使用撤销或历史记录检查本次变更。
            </AlertDialog.Description>
            <div className="alignment-apply-confirm-actions">
              <AlertDialog.Cancel asChild>
                <button type="button" className="platform-secondary-button" disabled={Boolean(applyingRunId)}>取消</button>
              </AlertDialog.Cancel>
              <button
                type="button"
                className="platform-primary-button"
                disabled={!confirmTarget || Boolean(applyingRunId)}
                onClick={() => confirmTarget && void applyRun(confirmTarget)}
              >
                {applyingRunId ? "正在应用并同步…" : "确认应用"}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

function deduplicateRuns(runs: AlignmentRunSummary[]) {
  return [...new Map(runs.map((run) => [run.id, run])).values()];
}

function formatStatus(run: AlignmentRunSummary) {
  if (run.status === "queued") return "等待中";
  if (run.status === "running") return `处理中 ${Math.round(run.progress * 100)}%`;
  if (run.status === "succeeded") return "已完成";
  if (run.status === "cancelled") return "已取消";
  return "失败";
}

function describeUnavailable(run: AlignmentRunSummary) {
  if (run.status !== "succeeded") return "结果尚不可应用";
  if (!run.artifactAvailable) return "预测文件不可用";
  if (!run.canApplyToCurrentDocument) return "当前正文或音轨已变化";
  return "结果不可应用";
}

function formatTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "强制对齐结果操作失败，请稍后重试。";
}
