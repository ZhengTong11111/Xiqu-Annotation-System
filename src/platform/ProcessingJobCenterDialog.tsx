import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  Ban,
  ListTodo,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useState } from "react";
import {
  PROCESSING_JOB_STATUSES,
  PROCESSING_JOB_TYPES,
  type PlatformUser,
  type ProcessingJobRequestListItem,
  type ProcessingJobScope,
} from "@xiqu/shared";
import {
  canCancelProcessingJobRequest,
  canForceCancelProcessingJob,
  canRetryProcessingJobRequest,
  formatProcessingJobProgress,
  formatProcessingJobTime,
  PROCESSING_JOB_STATUS_LABELS,
  PROCESSING_JOB_TYPE_LABELS,
} from "./processingJobCenterModel";
import type { ProcessingJobCenterController } from "./useProcessingJobCenter";

const SCOPES: Array<{ value: ProcessingJobScope; label: string }> = [
  { value: "mine", label: "我的任务" },
  { value: "related", label: "相关任务" },
  { value: "all", label: "全部任务" },
];

export function ProcessingJobCenterDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: PlatformUser;
  controller: ProcessingJobCenterController;
}) {
  const [forceCancelTarget, setForceCancelTarget] = useState<ProcessingJobRequestListItem | null>(null);
  const selected = props.controller.selectedItem;
  const detail = props.controller.detail;
  const scopes = props.controller.isAdministrator
    ? SCOPES
    : SCOPES.filter(({ value }) => value !== "all");

  return (
    <>
      <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="system-diagnostics-backdrop" />
          <Dialog.Content className="processing-job-center-dialog">
            <header className="processing-job-center-header">
              <div>
                <ListTodo size={20} />
                <div>
                  <Dialog.Title>后台任务</Dialog.Title>
                  <Dialog.Description>
                    分析、转码与未来计算任务的进度和请求管理
                  </Dialog.Description>
                </div>
              </div>
              <div className="processing-job-center-header-actions">
                <span className="processing-job-active-summary">
                  活动 {props.controller.activeCount}
                  {props.controller.summary?.isPartial ? "+" : ""}
                </span>
                <button type="button" title="刷新任务" onClick={props.controller.refresh}>
                  <RefreshCw size={17} />
                </button>
                <Dialog.Close asChild>
                  <button type="button" title="关闭"><X size={17} /></button>
                </Dialog.Close>
              </div>
            </header>

            <div className="processing-job-center-filters">
              <div className="processing-job-scope-tabs" role="tablist" aria-label="任务范围">
                {scopes.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    role="tab"
                    aria-selected={props.controller.scope === item.value}
                    className={props.controller.scope === item.value ? "active" : ""}
                    onClick={() => props.controller.setScope(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <label className="processing-job-search">
                <Search size={15} />
                <input
                  value={props.controller.queryInput}
                  onChange={(event) => props.controller.setQueryInput(event.target.value)}
                  placeholder="搜索资源、账号或任务 ID"
                  maxLength={100}
                />
              </label>
              <select
                aria-label="任务状态"
                value={props.controller.status}
                onChange={(event) => props.controller.setStatus(
                  event.target.value as typeof props.controller.status,
                )}
              >
                <option value="">全部状态</option>
                {PROCESSING_JOB_STATUSES.map((status) => (
                  <option key={status} value={status}>{PROCESSING_JOB_STATUS_LABELS[status]}</option>
                ))}
              </select>
              <select
                aria-label="任务类型"
                value={props.controller.type}
                onChange={(event) => props.controller.setType(
                  event.target.value as typeof props.controller.type,
                )}
              >
                <option value="">全部类型</option>
                {PROCESSING_JOB_TYPES.map((type) => (
                  <option key={type} value={type}>{PROCESSING_JOB_TYPE_LABELS[type]}</option>
                ))}
              </select>
            </div>

            {/* 固定保留通知网格行；没有错误时压缩为 0，避免 body 因条件节点缺失落入 auto 行而失去独立滚动。 */}
            <div className={`processing-job-error${
              props.controller.error || !props.controller.online ? "" : " is-empty"
            }`}>
              {props.controller.error ?? (
                props.controller.online ? "" : "当前处于离线状态，恢复网络后会自动刷新任务。"
              )}
            </div>

            <div className={`processing-job-center-body${selected ? " has-selection" : ""}`}>
              <section className="processing-job-list" aria-busy={props.controller.listLoading}>
                {props.controller.page.items.map((item) => (
                  <button
                    key={item.requestId}
                    type="button"
                    className={props.controller.selectedRequestId === item.requestId ? "active" : ""}
                    onClick={() => props.controller.setSelectedRequestId(item.requestId)}
                  >
                    <div className="processing-job-list-primary">
                      <strong>{item.contextResource?.name ?? "资源已不可见"}</strong>
                      <span className={`processing-job-status is-${item.job.status}`}>
                        {PROCESSING_JOB_STATUS_LABELS[item.job.status]}
                      </span>
                    </div>
                    <div className="processing-job-list-meta">
                      <span>{PROCESSING_JOB_TYPE_LABELS[item.job.type]}</span>
                      <span>{item.requester.displayName}</span>
                      <span>{formatProcessingJobProgress(item.job.progress)}</span>
                    </div>
                    <div className="processing-job-progress" aria-hidden="true">
                      <span style={{ width: formatProcessingJobProgress(item.job.progress) }} />
                    </div>
                    <small>{formatProcessingJobTime(item.requestedAt)}</small>
                  </button>
                ))}
                {!props.controller.page.items.length && !props.controller.listLoading ? (
                  <div className="processing-job-empty">
                    <ListTodo size={28} />
                    <strong>没有符合条件的任务</strong>
                    <span>调整范围或筛选条件后再试。</span>
                  </div>
                ) : null}
                {props.controller.listLoading && !props.controller.page.items.length ? (
                  <div className="processing-job-empty"><span>正在读取后台任务…</span></div>
                ) : null}
                {props.controller.page.nextCursor ? (
                  <button
                    type="button"
                    className="processing-job-load-more"
                    disabled={props.controller.moreLoading}
                    onClick={() => void props.controller.loadMore()}
                  >
                    {props.controller.moreLoading ? "正在加载…" : "加载更多"}
                  </button>
                ) : null}
              </section>

              <aside className="processing-job-inspector">
                {selected ? (
                  <>
                    <button
                      type="button"
                      className="processing-job-mobile-back"
                      onClick={() => props.controller.setSelectedRequestId(null)}
                    >
                      <ArrowLeft size={16} /> 返回列表
                    </button>
                    <div className="processing-job-inspector-heading">
                      <div>
                        <strong>{selected.contextResource?.name ?? "资源已不可见"}</strong>
                        <span>{PROCESSING_JOB_TYPE_LABELS[selected.job.type]}</span>
                      </div>
                      <span className={`processing-job-status is-${selected.job.status}`}>
                        {PROCESSING_JOB_STATUS_LABELS[selected.job.status]}
                      </span>
                    </div>
                    {props.controller.commandError ? (
                      <div className="processing-job-command-error">{props.controller.commandError}</div>
                    ) : null}
                    <dl className="processing-job-facts">
                      <dt>进度</dt><dd>{formatProcessingJobProgress(selected.job.progress)}</dd>
                      <dt>发起账号</dt><dd>{selected.requester.displayName}（{selected.requester.accountName}）</dd>
                      <dt>请求时间</dt><dd>{formatProcessingJobTime(selected.requestedAt)}</dd>
                      <dt>更新时间</dt><dd>{formatProcessingJobTime(selected.job.updatedAt)}</dd>
                      <dt>完成时间</dt><dd>{formatProcessingJobTime(selected.job.finishedAt)}</dd>
                      <dt>任务 ID</dt><dd className="processing-job-monospace">{selected.job.id}</dd>
                      {selected.job.errorCode ? <><dt>错误类别</dt><dd>{selected.job.errorCode}</dd></> : null}
                    </dl>

                    <section className="processing-job-visible-requests">
                      <h3>可见任务请求</h3>
                      {props.controller.detailLoading && !detail ? <span>正在读取详情…</span> : null}
                      {detail?.visibleRequests.map((request) => (
                        <div key={request.requestId}>
                          <strong>{request.requester.displayName}</strong>
                          <span>{request.cancelledAt ? "已取消需求" : "仍需要此任务"}</span>
                        </div>
                      ))}
                      {detail?.requestsTruncated ? <small>仅显示前 200 条可见请求。</small> : null}
                    </section>

                    <div className="processing-job-actions">
                      {canCancelProcessingJobRequest(selected, props.user) ? (
                        <button
                          type="button"
                          disabled={props.controller.commandBusy || !props.controller.online}
                          onClick={() => void props.controller.executeCommand("cancel", selected)}
                        >
                          <Ban size={16} /> 取消我的任务请求
                        </button>
                      ) : null}
                      {canRetryProcessingJobRequest(selected, props.user) ? (
                        <button
                          type="button"
                          disabled={props.controller.commandBusy || !props.controller.online}
                          onClick={() => void props.controller.executeCommand("retry", selected)}
                        >
                          <RotateCcw size={16} /> 重试任务
                        </button>
                      ) : null}
                      {canForceCancelProcessingJob(selected, props.user) ? (
                        <button
                          type="button"
                          className="danger"
                          disabled={props.controller.commandBusy || !props.controller.online}
                          onClick={() => setForceCancelTarget(selected)}
                        >
                          <Ban size={16} /> 强制取消整个任务
                        </button>
                      ) : null}
                    </div>
                    {canCancelProcessingJobRequest(selected, props.user) ? (
                      <p className="processing-job-action-note">
                        取消自己的请求后，若其他账号仍需要该分析，共享执行会继续。
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="processing-job-empty">
                    <ListTodo size={28} />
                    <strong>选择一项任务</strong>
                    <span>在这里查看进度、可见请求和可用操作。</span>
                  </div>
                )}
              </aside>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <AlertDialog.Root
        open={Boolean(forceCancelTarget)}
        onOpenChange={(open) => { if (!open) setForceCancelTarget(null); }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="resource-alert-backdrop" />
          <AlertDialog.Content className="platform-confirm-dialog">
            <AlertDialog.Title>强制取消整个后台任务？</AlertDialog.Title>
            <AlertDialog.Description>
              这会撤销所有账号对此任务的活动需求，并终止仍在运行的共享计算。该操作不会删除已经完成的其他任务。
            </AlertDialog.Description>
            <div className="platform-confirm-actions">
              <AlertDialog.Cancel asChild><button type="button">返回</button></AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="danger"
                  disabled={props.controller.commandBusy || !props.controller.online}
                  onClick={() => {
                    if (!forceCancelTarget) return;
                    void props.controller.executeCommand("force-cancel", forceCancelTarget)
                      .then((ok) => { if (ok) setForceCancelTarget(null); });
                  }}
                >
                  确认强制取消
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
