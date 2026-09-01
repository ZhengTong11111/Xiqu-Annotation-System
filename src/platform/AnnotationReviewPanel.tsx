import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { CheckCircle2, History, MessageSquareText, MessageSquareWarning, RefreshCw, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ANNOTATION_REVIEW_DOMAINS,
  type AnnotationReviewDomain,
  type AnnotationReviewScope,
  type AnnotationReviewTargets,
} from "@xiqu/shared";
import type { AnnotationReviewMutationResult } from "./useAnnotationReviews";
import {
  ANNOTATION_CONFIRMATION_DOMAIN_LABELS,
  type AnnotationReviewCreateBlocker,
  type AnnotationConfirmationTrackOption,
  type AnnotationConfirmationViewRecord,
  type AnnotationRangeCommentViewRecord,
  getAnnotationReviewBlockerMessage,
} from "./annotationConfirmationView";

type TargetMode = AnnotationReviewTargets["mode"];
type CreateMode = "confirmation" | "comment" | "feedback";
type HistoryKind = "all" | CreateMode;

type AnnotationReviewPanelProps = {
  confirmations: AnnotationConfirmationViewRecord[];
  comments: AnnotationRangeCommentViewRecord[];
  currentRevision: number | null;
  editorRevision: number;
  range: { start: number; end: number } | null;
  trackOptions: AnnotationConfirmationTrackOption[];
  canReview: boolean;
  canWrite: boolean;
  createBlocker: AnnotationReviewCreateBlocker | null;
  loading: boolean;
  loadingMoreConfirmations: boolean;
  loadingMoreComments: boolean;
  hasMoreConfirmations: boolean;
  hasMoreComments: boolean;
  mutationPending: boolean;
  error: string | null;
  timelineVisible: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  portalContainer?: HTMLElement;
  onTimelineVisibleChange: (visible: boolean) => void;
  onRefresh: () => Promise<boolean>;
  onLoadMoreConfirmations: () => Promise<void>;
  onLoadMoreComments: () => Promise<void>;
  onCreateConfirmation: (input: {
    scope: AnnotationReviewScope;
    note: string | null;
  }) => Promise<AnnotationReviewMutationResult<AnnotationConfirmationViewRecord["record"]>>;
  onCreateComment: (input: {
    scope: AnnotationReviewScope;
    kind: "review_comment" | "editor_feedback";
    body: string;
  }) => Promise<AnnotationReviewMutationResult<AnnotationRangeCommentViewRecord["record"]>>;
  onRevokeConfirmation: (
    record: AnnotationConfirmationViewRecord,
    reason: string | null,
  ) => Promise<AnnotationReviewMutationResult<AnnotationConfirmationViewRecord["record"]>>;
  onWithdrawComment: (
    record: AnnotationRangeCommentViewRecord,
    reason: string | null,
  ) => Promise<AnnotationReviewMutationResult<AnnotationRangeCommentViewRecord["record"]>>;
  canRevokeConfirmation: (record: AnnotationConfirmationViewRecord) => boolean;
  canWithdrawComment: (record: AnnotationRangeCommentViewRecord) => boolean;
  onNavigate: (scope: AnnotationReviewScope) => void;
};

type HistoryItem =
  | { kind: "confirmation"; createdAt: string; item: AnnotationConfirmationViewRecord }
  | { kind: "comment" | "feedback"; createdAt: string; item: AnnotationRangeCommentViewRecord };

type WithdrawTarget =
  | { kind: "confirmation"; item: AnnotationConfirmationViewRecord }
  | { kind: "range-record"; item: AnnotationRangeCommentViewRecord };

// 面板在同一作用域上提供确认、审核评论和编辑反馈三种互不替代的范围事实。
export function AnnotationReviewPanel(props: AnnotationReviewPanelProps) {
  const [createMode, setCreateMode] = useState<CreateMode>("confirmation");
  const [historyKind, setHistoryKind] = useState<HistoryKind>("all");
  const [showInactive, setShowInactive] = useState(false);
  const [targetMode, setTargetMode] = useState<TargetMode>("all");
  const [selectedDomains, setSelectedDomains] = useState<AnnotationReviewDomain[]>([
    "subtitle_lines", "character_annotations",
  ]);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [confirmationNote, setConfirmationNote] = useState("");
  const [rangeBody, setRangeBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<WithdrawTarget | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");

  const availableCreateModes = useMemo<CreateMode[]>(() => [
    ...(props.canReview ? ["confirmation" as const, "comment" as const] : []),
    ...(props.canWrite ? ["feedback" as const] : []),
  ], [props.canReview, props.canWrite]);
  const effectiveCreateMode = availableCreateModes.includes(createMode)
    ? createMode
    : availableCreateModes[0] ?? "confirmation";
  const historyItems = useMemo<HistoryItem[]>(() => [
    ...props.confirmations.map((item) => ({
      kind: "confirmation" as const,
      createdAt: item.record.createdAt,
      item,
    })),
    ...props.comments.map((item) => ({
      kind: item.record.kind === "editor_feedback" ? "feedback" as const : "comment" as const,
      createdAt: item.record.createdAt,
      item,
    })),
  ].filter((entry) => {
    if (historyKind !== "all" && entry.kind !== historyKind) return false;
    if (showInactive) return true;
    return entry.item.lifecycle === "active";
  }).sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    right.item.record.id.localeCompare(left.item.record.id)), [
    historyKind,
    props.comments,
    props.confirmations,
    showInactive,
  ]);
  const targetSelectionInvalid =
    (targetMode === "domains" && selectedDomains.length === 0) ||
    (targetMode === "tracks" && selectedTrackIds.length === 0);
  const bodyInvalid = effectiveCreateMode !== "confirmation" && !rangeBody.trim();
  const blockerMessage = getAnnotationReviewBlockerMessage(props.createBlocker);

  useEffect(() => {
    const available = new Set(props.trackOptions.map((track) => track.id));
    setSelectedTrackIds((current) => current.filter((trackId) => available.has(trackId)));
  }, [props.trackOptions]);

  function toggleDomain(domain: AnnotationReviewDomain) {
    setSelectedDomains((current) => current.includes(domain)
      ? current.filter((item) => item !== domain)
      : ANNOTATION_REVIEW_DOMAINS.filter((item) => current.includes(item) || item === domain));
  }

  function toggleTrack(trackId: string) {
    setSelectedTrackIds((current) => current.includes(trackId)
      ? current.filter((item) => item !== trackId)
      : props.trackOptions.map((track) => track.id)
          .filter((id) => current.includes(id) || id === trackId));
  }

  function buildScope(): AnnotationReviewScope | null {
    if (!props.range || targetSelectionInvalid) return null;
    const targets: AnnotationReviewTargets = targetMode === "all"
      ? { mode: "all" }
      : targetMode === "domains"
        ? { mode: "domains", domains: selectedDomains }
        : { mode: "tracks", trackIds: selectedTrackIds };
    return { startTime: props.range.start, endTime: props.range.end, targets };
  }

  async function createReviewFact() {
    if (props.createBlocker || props.currentRevision === null || bodyInvalid) return;
    const scope = buildScope();
    if (!scope) return;
    setNotice(null);
    try {
      const result = effectiveCreateMode === "confirmation"
        ? await props.onCreateConfirmation({ scope, note: confirmationNote.trim() || null })
        : await props.onCreateComment({
            scope,
            kind: effectiveCreateMode === "feedback" ? "editor_feedback" : "review_comment",
            body: rangeBody.trim(),
          });
      if (effectiveCreateMode === "confirmation") setConfirmationNote("");
      else setRangeBody("");
      const action = effectiveCreateMode === "confirmation"
        ? "确认"
        : effectiveCreateMode === "feedback" ? "反馈" : "评论";
      setNotice(result.refreshFailed
        ? `${action}已创建，但列表刷新失败，请手动刷新。`
        : `${action}已创建。`);
    } catch (error) {
      console.error("创建标注审核事实失败:", error);
    }
  }

  async function withdrawReviewFact() {
    if (!withdrawTarget || props.mutationPending) return;
    setNotice(null);
    try {
      const result = withdrawTarget.kind === "confirmation"
        ? await props.onRevokeConfirmation(withdrawTarget.item, withdrawReason.trim() || null)
        : await props.onWithdrawComment(withdrawTarget.item, withdrawReason.trim() || null);
      const action = withdrawTarget.kind === "confirmation"
        ? "确认已撤销"
        : withdrawTarget.item.record.kind === "editor_feedback" ? "反馈已撤回" : "评论已撤回";
      setWithdrawTarget(null);
      setWithdrawReason("");
      setNotice(result.refreshFailed ? `${action}，但列表刷新失败，请手动刷新。` : `${action}。`);
    } catch (error) {
      console.error("撤回标注审核事实失败:", error);
    }
  }

  const totalCount = props.confirmations.length + props.comments.length;
  const hasMoreRecords = props.hasMoreConfirmations || props.hasMoreComments;
  return (
    <section
      className={["panel", "annotation-confirmation-panel", props.collapsed ? "is-collapsed" : ""].join(" ")}
      aria-label="标注审核与反馈"
    >
      <div className="panel-header annotation-confirmation-heading">
        <h2>标注审核与反馈</h2>
        <div className="annotation-confirmation-heading-actions">
          {!props.collapsed ? (
            <>
              <span>{totalCount} 条{hasMoreRecords ? "已加载" : ""}</span>
              <label title="在时间轴显示审核与反馈范围">
                <input
                  type="checkbox"
                  checked={props.timelineVisible}
                  onChange={(event) => props.onTimelineVisibleChange(event.target.checked)}
                />
                时间轴
              </label>
              <button
                type="button"
                className="icon-button"
                title="刷新范围记录"
                aria-label="刷新范围记录"
                disabled={props.loading || props.mutationPending}
                onClick={() => void props.onRefresh()}
              ><RefreshCw size={15} /></button>
            </>
          ) : null}
          {props.onToggleCollapse ? (
            <button
              type="button"
              className="panel-collapse-button"
              title={props.collapsed ? "展开面板" : "最小化面板"}
              aria-label={props.collapsed ? "展开面板" : "最小化面板"}
              onClick={props.onToggleCollapse}
            >{props.collapsed ? "▸" : "—"}</button>
          ) : null}
        </div>
      </div>

      {!props.collapsed ? (
        <div className="annotation-confirmation-body">
          <div className="annotation-confirmation-status-row">
            <span>服务器修订 {props.currentRevision ?? "-"}</span>
            <span>编辑器修订 {props.editorRevision}</span>
            <span>{hasMoreRecords ? `已加载 ${totalCount} 条记录` : `${totalCount} 条记录`}</span>
          </div>
          {props.error ? <div className="annotation-confirmation-error">{props.error}</div> : null}
          {notice ? <div className="annotation-confirmation-notice">{notice}</div> : null}

          {availableCreateModes.length ? (
            <div className="annotation-confirmation-create">
              <div className="annotation-confirmation-segments annotation-review-kind-segments" aria-label="范围动作">
                {props.canReview ? <button
                  type="button"
                  className={`review-action confirmation${effectiveCreateMode === "confirmation" ? " active" : ""}`}
                  onClick={() => setCreateMode("confirmation")}
                ><CheckCircle2 size={14} />确认</button> : null}
                {props.canReview ? <button
                  type="button"
                  className={`review-action comment${effectiveCreateMode === "comment" ? " active" : ""}`}
                  onClick={() => setCreateMode("comment")}
                ><MessageSquareText size={14} />评论</button> : null}
                {props.canWrite ? <button
                  type="button"
                  className={`review-action feedback${effectiveCreateMode === "feedback" ? " active" : ""}`}
                  onClick={() => setCreateMode("feedback")}
                ><MessageSquareWarning size={14} />反馈</button> : null}
              </div>
              <div className="annotation-confirmation-range">
                <span>当前范围</span>
                <strong>{props.range
                  ? `${formatTime(props.range.start)} - ${formatTime(props.range.end)}`
                  : "尚未设置循环范围"}</strong>
              </div>
              <div className="annotation-confirmation-segments" aria-label="审核目标模式">
                {(["all", "domains", "tracks"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={targetMode === mode ? "active" : ""}
                    onClick={() => setTargetMode(mode)}
                  >{mode === "all" ? "全部" : mode === "domains" ? "领域" : "轨道"}</button>
                ))}
              </div>
              {targetMode === "domains" ? (
                <div className="annotation-confirmation-options">
                  {ANNOTATION_REVIEW_DOMAINS.map((domain) => (
                    <label key={domain}>
                      <input
                        type="checkbox"
                        checked={selectedDomains.includes(domain)}
                        onChange={() => toggleDomain(domain)}
                      />
                      {ANNOTATION_CONFIRMATION_DOMAIN_LABELS[domain]}
                    </label>
                  ))}
                </div>
              ) : null}
              {targetMode === "tracks" ? (
                <div className="annotation-confirmation-options">
                  {props.trackOptions.length ? props.trackOptions.map((track) => (
                    <label key={track.id}>
                      <input
                        type="checkbox"
                        checked={selectedTrackIds.includes(track.id)}
                        onChange={() => toggleTrack(track.id)}
                      />
                      {track.label}
                    </label>
                  )) : <span className="annotation-confirmation-muted">当前项目没有可选择的持久轨道。</span>}
                </div>
              ) : null}
              {effectiveCreateMode === "confirmation" ? (
                <label>
                  审核备注（可选）
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={confirmationNote}
                    onChange={(event) => setConfirmationNote(event.target.value)}
                  />
                </label>
              ) : (
                <label>
                  {effectiveCreateMode === "feedback" ? "标注反馈" : "范围评论"}
                  <textarea
                    rows={4}
                    maxLength={4000}
                    required
                    placeholder={effectiveCreateMode === "feedback"
                      ? "写下标注过程中需要审核者关注的问题"
                      : "写下对当前范围的审核意见"}
                    value={rangeBody}
                    onChange={(event) => setRangeBody(event.target.value)}
                  />
                  {effectiveCreateMode === "feedback" ? <small>反馈不会把该范围标记为已确认。</small> : null}
                </label>
              )}
              {blockerMessage ? <p className="annotation-confirmation-blocker">{blockerMessage}</p> : null}
              {targetSelectionInvalid ? <p className="annotation-confirmation-blocker">请至少选择一个审核目标。</p> : null}
              {bodyInvalid ? <p className="annotation-confirmation-blocker">
                {effectiveCreateMode === "feedback" ? "标注反馈正文不能为空。" : "范围评论正文不能为空。"}
              </p> : null}
              <button
                type="button"
                className="annotation-confirmation-primary"
                disabled={Boolean(props.createBlocker) || targetSelectionInvalid || bodyInvalid || props.mutationPending}
                onClick={() => void createReviewFact()}
              >
                {effectiveCreateMode === "confirmation"
                  ? <CheckCircle2 size={15} />
                  : effectiveCreateMode === "feedback"
                    ? <MessageSquareWarning size={15} />
                    : <MessageSquareText size={15} />}
                {effectiveCreateMode === "confirmation"
                  ? "确认当前范围"
                  : effectiveCreateMode === "feedback" ? "反馈当前范围" : "评论当前范围"}
              </button>
            </div>
          ) : <p className="annotation-confirmation-muted">当前账号可浏览范围记录，但没有审核或编辑权限。</p>}

          <div className="annotation-confirmation-history-heading">
            <span><History size={14} />范围记录</span>
            <div className="annotation-confirmation-segments compact">
              {(["all", "confirmation", "comment", "feedback"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={historyKind === kind ? "active" : ""}
                  onClick={() => setHistoryKind(kind)}
                >{kind === "all" ? "全部" : kind === "confirmation" ? "确认" : kind === "feedback" ? "反馈" : "评论"}</button>
              ))}
            </div>
          </div>
          <label className="annotation-review-inactive-toggle">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            显示已撤销与已撤回
          </label>

          <div className="annotation-confirmation-list">
            {props.loading && !totalCount ? (
              <p className="annotation-confirmation-muted">正在读取范围记录…</p>
            ) : historyItems.length === 0 ? (
              <p className="annotation-confirmation-muted">当前没有符合筛选的范围记录。</p>
            ) : historyItems.map((entry) => entry.kind === "confirmation"
              ? renderConfirmationItem(entry.item)
              : renderRangeRecordItem(entry.item))}
            <div className="annotation-review-load-more-row">
              {props.hasMoreConfirmations && (historyKind === "all" || historyKind === "confirmation") ? (
                <button
                  type="button"
                  className="annotation-review-load-more"
                  disabled={props.loadingMoreConfirmations}
                  onClick={() => void props.onLoadMoreConfirmations()}
                >{props.loadingMoreConfirmations ? "正在加载…" : "加载更多确认"}</button>
              ) : null}
              {props.hasMoreComments && historyKind !== "confirmation" ? (
                <button
                  type="button"
                  className="annotation-review-load-more"
                  disabled={props.loadingMoreComments}
                  onClick={() => void props.onLoadMoreComments()}
                >{props.loadingMoreComments ? "正在加载…" : "加载更多评论与反馈"}</button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <AlertDialog.Root
        open={Boolean(withdrawTarget)}
        onOpenChange={(open) => {
          if (!open && !props.mutationPending) {
            setWithdrawTarget(null);
            setWithdrawReason("");
          }
        }}
      >
        <AlertDialog.Portal container={props.portalContainer}>
          <AlertDialog.Overlay className="resource-alert-backdrop" />
          <AlertDialog.Content className="annotation-confirmation-revoke-dialog">
            <AlertDialog.Title>{withdrawTarget?.kind === "range-record"
              ? withdrawTarget.item.record.kind === "editor_feedback" ? "撤回标注反馈" : "撤回范围评论"
              : "撤销确认记录"}</AlertDialog.Title>
            <AlertDialog.Description>
              操作不会删除历史；该记录仍可在“显示已撤销与已撤回”中查看。
            </AlertDialog.Description>
            <label>
              原因（可选）
              <textarea
                rows={3}
                maxLength={1000}
                value={withdrawReason}
                onChange={(event) => setWithdrawReason(event.target.value)}
              />
            </label>
            <div className="annotation-confirmation-revoke-actions">
              <AlertDialog.Cancel asChild><button type="button" disabled={props.mutationPending}>取消</button></AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="danger"
                  disabled={props.mutationPending}
                  onClick={(event) => {
                    event.preventDefault();
                    void withdrawReviewFact();
                  }}
                >确认操作</button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );

  function renderConfirmationItem(record: AnnotationConfirmationViewRecord) {
    return (
      <article key={`confirmation:${record.record.id}`} className={["annotation-confirmation-item", record.lifecycle, record.freshness].join(" ")}>
        <button type="button" className="annotation-confirmation-item-main" onClick={() => props.onNavigate(record.record.scope)}>
          <span className="annotation-review-record-heading">
            <span className="annotation-review-kind-badge confirmation">确认</span>
            <span className="annotation-confirmation-item-state">{formatState(record.lifecycle, record.freshness)}</span>
          </span>
          <strong>{formatTime(record.record.scope.startTime)} - {formatTime(record.record.scope.endTime)}</strong>
          <span>{record.targetLabel}</span>
          <small>修订 {record.record.confirmedRevision} · {record.record.createdBy.displayName} · {formatDate(record.record.createdAt)}</small>
          {record.record.note ? <small>备注：{record.record.note}</small> : null}
          {record.lifecycle === "revoked" && record.record.revokedAt ? (
            <small>
              {record.record.revokedBy?.displayName ?? "未知账号"} 于 {formatDate(record.record.revokedAt)} 撤销
              {record.record.revokeReason ? `：${record.record.revokeReason}` : ""}
            </small>
          ) : null}
          {record.invalidReason ? <small className="invalid">{record.invalidReason}</small> : null}
        </button>
        {props.canRevokeConfirmation(record) ? (
          <button type="button" className="annotation-confirmation-revoke" onClick={() => setWithdrawTarget({ kind: "confirmation", item: record })}>
            <Undo2 size={14} />撤销
          </button>
        ) : null}
      </article>
    );
  }

  function renderRangeRecordItem(record: AnnotationRangeCommentViewRecord) {
    const isFeedback = record.record.kind === "editor_feedback";
    return (
      <article
        key={`range-record:${record.record.id}`}
        className={["annotation-confirmation-item", isFeedback ? "feedback" : "comment", record.lifecycle, record.freshness].join(" ")}
      >
        <button type="button" className="annotation-confirmation-item-main" onClick={() => props.onNavigate(record.record.scope)}>
          <span className="annotation-review-record-heading">
            <span className={`annotation-review-kind-badge ${isFeedback ? "feedback" : "comment"}`}>
              {isFeedback ? "反馈" : "评论"}
            </span>
            <span className="annotation-confirmation-item-state">{formatState(record.lifecycle, record.freshness)}</span>
          </span>
          <strong>{formatTime(record.record.scope.startTime)} - {formatTime(record.record.scope.endTime)}</strong>
          <span>{record.targetLabel}</span>
          <small>修订 {record.record.commentedRevision} · {record.record.createdBy.displayName} · {formatDate(record.record.createdAt)}</small>
          <small className="annotation-review-range-body">{record.record.body}</small>
          {record.lifecycle === "withdrawn" && record.record.withdrawnAt ? (
            <small>
              {record.record.withdrawnBy?.displayName ?? "未知账号"} 于 {formatDate(record.record.withdrawnAt)} 撤回
              {record.record.withdrawReason ? `：${record.record.withdrawReason}` : ""}
            </small>
          ) : null}
          {record.invalidReason ? <small className="invalid">{record.invalidReason}</small> : null}
        </button>
        {props.canWithdrawComment(record) ? (
          <button type="button" className="annotation-confirmation-revoke" onClick={() => setWithdrawTarget({ kind: "range-record", item: record })}>
            <Undo2 size={14} />撤回
          </button>
        ) : null}
      </article>
    );
  }
}

function formatState(lifecycle: string, freshness: "current" | "stale") {
  if (lifecycle === "revoked") return "已撤销";
  if (lifecycle === "withdrawn") return "已撤回";
  return freshness === "current" ? "当前" : "基于旧修订";
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}:${remaining.toFixed(3).padStart(6, "0")}`;
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(timestamp);
}
