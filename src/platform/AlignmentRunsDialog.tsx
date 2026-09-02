import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ALIGNMENT_QUALITY_ISSUE_CODES,
  type AlignmentApplicationPage,
  type AlignmentApplicationSummary,
  type AlignmentQualityAssessmentList,
  type AlignmentQualityAssessmentScope,
  type AlignmentQualityIssueCode,
  type AlignmentQualityVerdict,
  type AlignmentRunPage,
  type AlignmentRunSummary,
  type UpsertAlignmentQualityAssessmentRequest,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { createRuntimeUuid } from "../utils/runtimeUuid";
import {
  canSubmitAlignmentQualityAssessment,
  resolveAlignmentQualityAssessmentAction,
  type AlignmentQualityAssessmentRetry,
} from "./alignmentQualityAssessmentDraft";

const EMPTY_RUN_PAGE: AlignmentRunPage = { items: [], nextCursor: null };
const EMPTY_APPLICATION_PAGE: AlignmentApplicationPage = { items: [], nextCursor: null };
const EMPTY_ASSESSMENTS: AlignmentQualityAssessmentList = { items: [], isPartial: false };

const ISSUE_LABELS: Record<AlignmentQualityIssueCode, string> = {
  lyric_mismatch: "唱词不符",
  missing_character: "漏字",
  duplicate_character: "重复",
  filler_character: "衬字",
  overlapping_voices: "多人重叠",
  unclear_audio: "听不清",
  audio_desync: "音频不同步",
  source_separation_artifact: "人声分离失真",
  boundary_offset: "边界偏移",
  other: "其他",
};

type DialogView = "runs" | "applications";
export function AlignmentRunsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: PlatformClient;
  annotationFileId: string;
  currentRevision: number;
  currentUserId: string;
  canWrite: boolean;
  canReview: boolean;
  applyDisabledReason?: string;
  onApplyingChange: (applying: boolean) => void;
  onApplied: (application: AlignmentApplicationSummary) => Promise<void>;
}) {
  const [view, setView] = useState<DialogView>("runs");
  const [runPage, setRunPage] = useState<AlignmentRunPage>(EMPTY_RUN_PAGE);
  const [applicationPage, setApplicationPage] = useState<AlignmentApplicationPage>(EMPTY_APPLICATION_PAGE);
  const [runsLoading, setRunsLoading] = useState(false);
  const [applicationsLoading, setApplicationsLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<AlignmentRunSummary | null>(null);
  const [applyingRunId, setApplyingRunId] = useState<string | null>(null);
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null);
  const [assessments, setAssessments] = useState<AlignmentQualityAssessmentList>(EMPTY_ASSESSMENTS);
  const [assessmentsLoading, setAssessmentsLoading] = useState(false);
  const [assessmentScope, setAssessmentScope] = useState<AlignmentQualityAssessmentScope>(
    props.canWrite ? "editor" : "reviewer",
  );
  const [assessmentVerdict, setAssessmentVerdict] = useState<AlignmentQualityVerdict>("correct");
  const [assessmentIssues, setAssessmentIssues] = useState<AlignmentQualityIssueCode[]>([]);
  const [assessmentSubmitting, setAssessmentSubmitting] = useState(false);

  // 模糊网络失败后保留同一 actionId；只有应用/revision 或评价语义改变时才创建新动作。
  const applyRetryRef = useRef<{ runId: string; baseRevision: number; actionId: string } | null>(null);
  const assessmentRetryRef = useRef<AlignmentQualityAssessmentRetry | null>(null);
  const historyRequestEpochRef = useRef(0);

  const selectedApplication = useMemo(
    () => applicationPage.items.find((item) => item.id === selectedApplicationId) ?? null,
    [applicationPage.items, selectedApplicationId],
  );

  useEffect(() => {
    if (!props.open) return;
    const controller = new AbortController();
    const requestEpoch = ++historyRequestEpochRef.current;
    setError(null);
    setRunsLoading(true);
    setApplicationsLoading(true);
    setRunPage(EMPTY_RUN_PAGE);
    setApplicationPage(EMPTY_APPLICATION_PAGE);
    setSelectedApplicationId(null);
    setAssessments(EMPTY_ASSESSMENTS);

    // 两份首屏历史相互独立；任一失败不应抹掉另一份已经可用的结果。
    void props.client.listAlignmentRuns(
      props.annotationFileId,
      { limit: 30 },
      controller.signal,
    ).then(
      (nextPage) => {
        if (historyRequestEpochRef.current === requestEpoch) setRunPage(nextPage);
      },
      (nextError: unknown) => {
        if (!controller.signal.aborted) setError(describeError(nextError));
      },
    ).finally(() => {
      if (!controller.signal.aborted) setRunsLoading(false);
    });
    void props.client.listAlignmentApplications(
      props.annotationFileId,
      { limit: 30 },
      controller.signal,
    ).then(
      (nextPage) => {
        if (historyRequestEpochRef.current !== requestEpoch) return;
        setApplicationPage(nextPage);
        setSelectedApplicationId(nextPage.items[0]?.id ?? null);
      },
      (nextError: unknown) => {
        if (!controller.signal.aborted) setError(describeError(nextError));
      },
    ).finally(() => {
      if (!controller.signal.aborted) setApplicationsLoading(false);
    });
    return () => {
      controller.abort();
      if (historyRequestEpochRef.current === requestEpoch) historyRequestEpochRef.current += 1;
    };
  }, [props.annotationFileId, props.client, props.open]);

  useEffect(() => {
    if (!props.open || !selectedApplicationId) {
      setAssessments(EMPTY_ASSESSMENTS);
      return;
    }
    const controller = new AbortController();
    setAssessments(EMPTY_ASSESSMENTS);
    setAssessmentsLoading(true);
    setError(null);
    void props.client.listAlignmentQualityAssessments(
      props.annotationFileId,
      selectedApplicationId,
      controller.signal,
    ).then(
      setAssessments,
      (nextError: unknown) => {
        if (!controller.signal.aborted) setError(describeError(nextError));
      },
    ).finally(() => {
      if (!controller.signal.aborted) setAssessmentsLoading(false);
    });
    return () => controller.abort();
  }, [props.annotationFileId, props.client, props.open, selectedApplicationId]);

  useEffect(() => {
    // 权限发生变化时优先保留仍可用的 scope；两种能力都没有时表单本身不会显示。
    if (assessmentScope === "editor" && !props.canWrite && props.canReview) {
      setAssessmentScope("reviewer");
    } else if (assessmentScope === "reviewer" && !props.canReview && props.canWrite) {
      setAssessmentScope("editor");
    }
  }, [assessmentScope, props.canReview, props.canWrite]);

  useEffect(() => {
    const own = assessments.items.find((item) =>
      item.assessorUserId === props.currentUserId && item.scope === assessmentScope);
    setAssessmentVerdict(own?.verdict ?? "correct");
    setAssessmentIssues(own?.issueCodes ?? []);
  }, [assessmentScope, assessments.items, props.currentUserId]);

  async function refreshRuns() {
    const requestEpoch = historyRequestEpochRef.current;
    setRunsLoading(true);
    setError(null);
    try {
      const next = await props.client.listAlignmentRuns(props.annotationFileId, { limit: 30 });
      if (historyRequestEpochRef.current === requestEpoch) setRunPage(next);
    } catch (nextError) {
      if (historyRequestEpochRef.current === requestEpoch) setError(describeError(nextError));
    } finally {
      if (historyRequestEpochRef.current === requestEpoch) setRunsLoading(false);
    }
  }

  async function refreshApplications(preferredId?: string) {
    const requestEpoch = historyRequestEpochRef.current;
    setApplicationsLoading(true);
    setError(null);
    try {
      const next = await props.client.listAlignmentApplications(props.annotationFileId, { limit: 30 });
      if (historyRequestEpochRef.current !== requestEpoch) return;
      setApplicationPage(next);
      setSelectedApplicationId((current) => {
        const candidate = preferredId ?? current;
        return candidate && next.items.some((item) => item.id === candidate)
          ? candidate
          : next.items[0]?.id ?? null;
      });
    } catch (nextError) {
      if (historyRequestEpochRef.current === requestEpoch) setError(describeError(nextError));
    } finally {
      if (historyRequestEpochRef.current === requestEpoch) setApplicationsLoading(false);
    }
  }

  async function refreshCurrentView() {
    if (view === "runs") await refreshRuns();
    else await refreshApplications();
  }

  async function loadMoreRuns() {
    if (!runPage.nextCursor || moreLoading) return;
    const requestEpoch = historyRequestEpochRef.current;
    setMoreLoading(true);
    setError(null);
    try {
      const next = await props.client.listAlignmentRuns(props.annotationFileId, {
        cursor: runPage.nextCursor,
        limit: 30,
      });
      if (historyRequestEpochRef.current === requestEpoch) {
        setRunPage((current) => ({
          items: deduplicateById([...current.items, ...next.items]),
          nextCursor: next.nextCursor,
        }));
      }
    } catch (nextError) {
      if (historyRequestEpochRef.current === requestEpoch) setError(describeError(nextError));
    } finally {
      if (historyRequestEpochRef.current === requestEpoch) setMoreLoading(false);
    }
  }

  async function loadMoreApplications() {
    if (!applicationPage.nextCursor || moreLoading) return;
    const requestEpoch = historyRequestEpochRef.current;
    setMoreLoading(true);
    setError(null);
    try {
      const next = await props.client.listAlignmentApplications(props.annotationFileId, {
        cursor: applicationPage.nextCursor,
        limit: 30,
      });
      if (historyRequestEpochRef.current === requestEpoch) {
        setApplicationPage((current) => ({
          items: deduplicateById([...current.items, ...next.items]),
          nextCursor: next.nextCursor,
        }));
      }
    } catch (nextError) {
      if (historyRequestEpochRef.current === requestEpoch) setError(describeError(nextError));
    } finally {
      if (historyRequestEpochRef.current === requestEpoch) setMoreLoading(false);
    }
  }

  async function applyRun(run: AlignmentRunSummary) {
    if (props.applyDisabledReason || applyingRunId) return;
    const previous = applyRetryRef.current;
    const actionId = previous?.runId === run.id && previous.baseRevision === props.currentRevision
      ? previous.actionId
      : createRuntimeUuid();
    applyRetryRef.current = { runId: run.id, baseRevision: props.currentRevision, actionId };
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
      applyRetryRef.current = null;
      setConfirmTarget(null);
      await Promise.all([refreshRuns(), refreshApplications(application.id)]);
      setView("applications");
    } catch (nextError) {
      // 保留 actionId 仅用于同一 revision/run 的显式重试；切换 run 或 revision 会自动生成新动作。
      setError(describeError(nextError));
    } finally {
      setApplyingRunId(null);
      props.onApplyingChange(false);
    }
  }

  async function submitAssessment() {
    if (!selectedApplication || assessmentSubmitting || !canSubmitAlignmentQualityAssessment(
      assessmentScope,
      assessmentVerdict,
      assessmentIssues,
      props.canWrite,
      props.canReview,
    )) return;
    const canonicalIssues = ALIGNMENT_QUALITY_ISSUE_CODES.filter((code) =>
      assessmentIssues.includes(code));
    const action = resolveAlignmentQualityAssessmentAction(
      assessmentRetryRef.current,
      {
        applicationId: selectedApplication.id,
        scope: assessmentScope,
        verdict: assessmentVerdict,
        issueCodes: canonicalIssues,
      },
      createRuntimeUuid,
    );
    assessmentRetryRef.current = action;
    const request: UpsertAlignmentQualityAssessmentRequest = {
      clientActionId: action.actionId,
      scope: assessmentScope,
      verdict: assessmentVerdict,
      issueCodes: canonicalIssues,
    };
    const requestEpoch = historyRequestEpochRef.current;
    setAssessmentSubmitting(true);
    setError(null);
    try {
      await props.client.upsertAlignmentQualityAssessment(
        props.annotationFileId,
        selectedApplication.id,
        request,
      );
      assessmentRetryRef.current = null;
      // 服务端写入可以在关闭对话框后完成，但旧会话不能再覆盖新文件的评价列表。
      if (historyRequestEpochRef.current !== requestEpoch) return;
      const next = await props.client.listAlignmentQualityAssessments(
        props.annotationFileId,
        selectedApplication.id,
      );
      if (historyRequestEpochRef.current !== requestEpoch) return;
      setAssessments(next);
      await refreshApplications(selectedApplication.id);
    } catch (nextError) {
      // 失败时保留完整语义 key 和 UUID；用户改变任一选项后会自动分配新的逻辑动作。
      if (historyRequestEpochRef.current === requestEpoch) setError(describeError(nextError));
    } finally {
      if (historyRequestEpochRef.current === requestEpoch) setAssessmentSubmitting(false);
    }
  }

  const hasAssessmentCapability = props.canWrite || props.canReview;
  const canSubmit = canSubmitAlignmentQualityAssessment(
    assessmentScope,
    assessmentVerdict,
    assessmentIssues,
    props.canWrite,
    props.canReview,
  ) && !assessmentsLoading;

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
                  <Dialog.Description>预测、应用记录与质量评价</Dialog.Description>
                </div>
              </div>
              <div>
                <button
                  type="button"
                  title="刷新当前视图"
                  disabled={runsLoading || applicationsLoading}
                  onClick={() => void refreshCurrentView()}
                >
                  <RefreshCw size={17} />
                </button>
                <Dialog.Close asChild>
                  <button type="button" title="关闭"><X size={17} /></button>
                </Dialog.Close>
              </div>
            </header>

            <div className="alignment-runs-tabs" role="tablist" aria-label="强制对齐视图">
              <button
                type="button"
                role="tab"
                aria-selected={view === "runs"}
                className={view === "runs" ? "is-active" : undefined}
                onClick={() => setView("runs")}
              >预测结果</button>
              <button
                type="button"
                role="tab"
                aria-selected={view === "applications"}
                className={view === "applications" ? "is-active" : undefined}
                onClick={() => setView("applications")}
              >应用评价</button>
            </div>

            {error ? <div className="alignment-runs-error">{error}</div> : null}
            {view === "runs" && props.applyDisabledReason ? (
              <div className="alignment-runs-notice">应用暂不可用：{props.applyDisabledReason}</div>
            ) : null}

            {view === "runs" ? (
              <RunList
                page={runPage}
                loading={runsLoading}
                moreLoading={moreLoading}
                applyingRunId={applyingRunId}
                applyDisabledReason={props.applyDisabledReason}
                onConfirm={setConfirmTarget}
                onLoadMore={() => void loadMoreRuns()}
              />
            ) : (
              <ApplicationAssessmentView
                page={applicationPage}
                loading={applicationsLoading}
                moreLoading={moreLoading}
                selectedApplicationId={selectedApplicationId}
                assessments={assessments}
                assessmentsLoading={assessmentsLoading}
                currentUserId={props.currentUserId}
                canWrite={props.canWrite}
                canReview={props.canReview}
                scope={assessmentScope}
                verdict={assessmentVerdict}
                issues={assessmentIssues}
                submitting={assessmentSubmitting}
                canSubmit={canSubmit}
                hasAssessmentCapability={hasAssessmentCapability}
                onSelect={setSelectedApplicationId}
                onScopeChange={setAssessmentScope}
                onVerdictChange={(verdict) => {
                  setAssessmentVerdict(verdict);
                  if (verdict === "correct") setAssessmentIssues([]);
                }}
                onIssueToggle={(issue, checked) => setAssessmentIssues((current) =>
                  checked
                    ? ALIGNMENT_QUALITY_ISSUE_CODES.filter((code) =>
                        code === issue || current.includes(code))
                    : current.filter((code) => code !== issue))}
                onSubmit={() => void submitAssessment()}
                onLoadMore={() => void loadMoreApplications()}
              />
            )}
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

function RunList(props: {
  page: AlignmentRunPage;
  loading: boolean;
  moreLoading: boolean;
  applyingRunId: string | null;
  applyDisabledReason?: string;
  onConfirm: (run: AlignmentRunSummary) => void;
  onLoadMore: () => void;
}) {
  return (
    <>
      <div className="alignment-runs-list" aria-busy={props.loading}>
        {props.page.items.map((run) => {
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
                {applicable ? <><Check size={15} /> 仍适用于当前正文与音轨</> : describeUnavailable(run)}
              </div>
              <button
                type="button"
                className="platform-primary-button"
                disabled={!applicable || Boolean(props.applyDisabledReason) || Boolean(props.applyingRunId)}
                onClick={() => props.onConfirm(run)}
              >
                {props.applyingRunId === run.id ? "正在应用…" : "应用逐字时间"}
              </button>
            </article>
          );
        })}
        {!props.loading && props.page.items.length === 0 ? (
          <div className="alignment-runs-empty">当前文件还没有强制对齐结果。</div>
        ) : null}
        {props.loading && props.page.items.length === 0 ? (
          <div className="alignment-runs-empty">正在读取强制对齐历史…</div>
        ) : null}
      </div>
      {props.page.nextCursor ? (
        <button
          type="button"
          className="alignment-runs-load-more"
          disabled={props.moreLoading}
          onClick={props.onLoadMore}
        >
          {props.moreLoading ? "正在加载…" : "加载更多"}
        </button>
      ) : null}
    </>
  );
}

function ApplicationAssessmentView(props: {
  page: AlignmentApplicationPage;
  loading: boolean;
  moreLoading: boolean;
  selectedApplicationId: string | null;
  assessments: AlignmentQualityAssessmentList;
  assessmentsLoading: boolean;
  currentUserId: string;
  canWrite: boolean;
  canReview: boolean;
  scope: AlignmentQualityAssessmentScope;
  verdict: AlignmentQualityVerdict;
  issues: AlignmentQualityIssueCode[];
  submitting: boolean;
  canSubmit: boolean;
  hasAssessmentCapability: boolean;
  onSelect: (applicationId: string) => void;
  onScopeChange: (scope: AlignmentQualityAssessmentScope) => void;
  onVerdictChange: (verdict: AlignmentQualityVerdict) => void;
  onIssueToggle: (issue: AlignmentQualityIssueCode, checked: boolean) => void;
  onSubmit: () => void;
  onLoadMore: () => void;
}) {
  const selected = props.page.items.find((item) => item.id === props.selectedApplicationId) ?? null;
  return (
    <div className="alignment-applications-workspace">
      <aside className="alignment-application-list" aria-busy={props.loading}>
        {props.page.items.map((application) => (
          <button
            key={application.id}
            type="button"
            disabled={props.submitting}
            className={application.id === props.selectedApplicationId ? "is-selected" : undefined}
            onClick={() => props.onSelect(application.id)}
          >
            <strong>{application.modelLabel}</strong>
            <span>v{application.baseRevision} → v{application.committedRevision}</span>
            <small>{application.appliedCharacterCount} 字 · {application.currentAssessmentCount} 条评价</small>
            <time>{formatTime(application.createdAt)}</time>
          </button>
        ))}
        {!props.loading && props.page.items.length === 0 ? (
          <div className="alignment-applications-empty">当前文件还没有应用记录。</div>
        ) : null}
        {props.loading && props.page.items.length === 0 ? (
          <div className="alignment-applications-empty">正在读取应用历史…</div>
        ) : null}
        {props.page.nextCursor ? (
          <button
            type="button"
            className="alignment-application-more"
            disabled={props.moreLoading}
            onClick={props.onLoadMore}
          >{props.moreLoading ? "正在加载…" : "加载更多"}</button>
        ) : null}
      </aside>

      <section className="alignment-assessment-panel">
        {!selected ? (
          <div className="alignment-applications-empty">选择一次应用记录查看评价。</div>
        ) : (
          <>
            <header>
              <div>
                <strong>{selected.modelLabel}</strong>
                <span>应用于 v{selected.committedRevision} · {selected.appliedCharacterCount} 字</span>
              </div>
              <time>{formatTime(selected.createdAt)}</time>
            </header>
            <div className="alignment-current-assessments" aria-busy={props.assessmentsLoading}>
              {props.assessments.items.map((assessment) => (
                <div key={assessment.id} className="alignment-assessment-summary">
                  <strong>{assessment.scope === "reviewer" ? "审核评价" : "编辑评价"}</strong>
                  <span>{formatVerdict(assessment.verdict)}</span>
                  <small>{assessment.issueCodes.length
                    ? assessment.issueCodes.map((code) => ISSUE_LABELS[code]).join("、")
                    : "无异常"}</small>
                  <em>{assessment.assessorUserId === props.currentUserId
                    ? "我"
                    : shortenIdentifier(assessment.assessorUserId)}</em>
                </div>
              ))}
              {!props.assessmentsLoading && props.assessments.items.length === 0 ? (
                <div className="alignment-assessments-empty">尚无质量评价。</div>
              ) : null}
              {props.assessmentsLoading ? (
                <div className="alignment-assessments-empty">正在读取评价…</div>
              ) : null}
              {props.assessments.isPartial ? (
                <div className="alignment-assessments-partial">当前仅显示前 500 条评价。</div>
              ) : null}
            </div>

            {props.hasAssessmentCapability ? (
              <div className="alignment-assessment-form">
                {props.canWrite && props.canReview ? (
                  <div className="alignment-assessment-scope" role="group" aria-label="评价类型">
                    <button
                      type="button"
                      className={props.scope === "editor" ? "is-active" : undefined}
                      onClick={() => props.onScopeChange("editor")}
                    >编辑评价</button>
                    <button
                      type="button"
                      className={props.scope === "reviewer" ? "is-active" : undefined}
                      onClick={() => props.onScopeChange("reviewer")}
                    >审核评价</button>
                  </div>
                ) : (
                  <strong className="alignment-assessment-form-title">
                    {props.canReview ? "审核评价" : "编辑评价"}
                  </strong>
                )}

                <div className="alignment-assessment-verdicts" role="radiogroup" aria-label="评价结论">
                  {(["correct", "needs_adjustment", "unusable"] as const).map((verdict) => (
                    <label key={verdict}>
                      <input
                        type="radio"
                        name={`alignment-verdict-${selected.id}-${props.scope}`}
                        checked={props.verdict === verdict}
                        onChange={() => props.onVerdictChange(verdict)}
                      />
                      <span>{formatVerdict(verdict)}</span>
                    </label>
                  ))}
                </div>

                <div className={`alignment-assessment-issues ${props.verdict === "correct" ? "is-disabled" : ""}`}>
                  {ALIGNMENT_QUALITY_ISSUE_CODES.map((issue) => (
                    <label key={issue}>
                      <input
                        type="checkbox"
                        disabled={props.verdict === "correct"}
                        checked={props.issues.includes(issue)}
                        onChange={(event) => props.onIssueToggle(issue, event.target.checked)}
                      />
                      <span>{ISSUE_LABELS[issue]}</span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className="platform-primary-button alignment-assessment-submit"
                  disabled={!props.canSubmit || props.submitting}
                  onClick={props.onSubmit}
                >
                  {props.submitting ? "正在保存评价…" : "保存评价"}
                </button>
              </div>
            ) : (
              <div className="alignment-runs-notice">当前账号可查看评价，但没有编辑或审核评价权限。</div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function deduplicateById<T extends { id: string }>(items: readonly T[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
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

function formatVerdict(verdict: AlignmentQualityVerdict) {
  if (verdict === "correct") return "正确";
  if (verdict === "needs_adjustment") return "需修改";
  return "不可用";
}

function formatTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function shortenIdentifier(value: string) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "强制对齐结果操作失败，请稍后重试。";
}
