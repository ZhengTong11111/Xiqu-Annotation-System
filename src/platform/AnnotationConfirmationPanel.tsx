import * as AlertDialog from "@radix-ui/react-alert-dialog";
import {
  CheckCircle2,
  History,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ANNOTATION_CONFIRMATION_DOMAINS,
  type AnnotationConfirmationDomain,
  type AnnotationConfirmationScope,
  type AnnotationConfirmationTargets,
} from "@xiqu/shared";
import type { AnnotationConfirmationMutationResult } from "./useAnnotationConfirmations";
import {
  ANNOTATION_CONFIRMATION_DOMAIN_LABELS,
  type AnnotationConfirmationCreateBlocker,
  type AnnotationConfirmationTrackOption,
  type AnnotationConfirmationViewRecord,
  getAnnotationConfirmationBlockerMessage,
} from "./annotationConfirmationView";

// 面板表单沿用共享合同的互斥目标模式，不再维护第二套字符串枚举。
type TargetMode = AnnotationConfirmationTargets["mode"];

// 面板只接收渲染状态和命令回调，平台请求与文档状态仍由上层分别管理。
type AnnotationConfirmationPanelProps = {
  records: AnnotationConfirmationViewRecord[];
  currentRevision: number | null;
  editorRevision: number;
  range: { start: number; end: number } | null;
  trackOptions: AnnotationConfirmationTrackOption[];
  canReview: boolean;
  createBlocker: AnnotationConfirmationCreateBlocker | null;
  loading: boolean;
  mutationPending: boolean;
  error: string | null;
  timelineVisible: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  portalContainer?: HTMLElement;
  onTimelineVisibleChange: (visible: boolean) => void;
  onRefresh: () => Promise<boolean>;
  onCreate: (input: {
    scope: AnnotationConfirmationScope;
    note: string | null;
  }) => Promise<AnnotationConfirmationMutationResult>;
  onRevoke: (
    record: AnnotationConfirmationViewRecord,
    reason: string | null,
  ) => Promise<AnnotationConfirmationMutationResult>;
  canRevoke: (record: AnnotationConfirmationViewRecord) => boolean;
  onNavigate: (record: AnnotationConfirmationViewRecord) => void;
};

// 平台确认面板负责审核事实的浏览和命令，不编辑 ProjectData，也不替代通用标注 Inspector。
export function AnnotationConfirmationPanel(
  props: AnnotationConfirmationPanelProps,
) {
  const [historyMode, setHistoryMode] = useState<"active" | "all">("active");
  const [targetMode, setTargetMode] = useState<TargetMode>("all");
  const [selectedDomains, setSelectedDomains] = useState<AnnotationConfirmationDomain[]>([
    "subtitle_lines",
    "character_annotations",
  ]);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AnnotationConfirmationViewRecord | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  // 默认视图隐藏已撤销事实，但过期的有效确认仍保留，避免把 revision 风险误当成不存在。
  const visibleRecords = useMemo(() => props.records.filter((record) =>
    historyMode === "all" || record.lifecycle === "active"), [historyMode, props.records]);
  const targetSelectionInvalid =
    (targetMode === "domains" && selectedDomains.length === 0) ||
    (targetMode === "tracks" && selectedTrackIds.length === 0);
  const blockerMessage = getAnnotationConfirmationBlockerMessage(props.createBlocker);

  // 轨道在编辑器中被删除后裁剪旧选择，防止提交已经不再持久化的轨道 id。
  useEffect(() => {
    const availableTrackIds = new Set(props.trackOptions.map((track) => track.id));
    setSelectedTrackIds((current) => current.filter((trackId) => availableTrackIds.has(trackId)));
  }, [props.trackOptions]);

  // 多选项切换保持共享合同顺序，提交 payload 因而具有确定结果。
  function toggleDomain(domain: AnnotationConfirmationDomain) {
    setSelectedDomains((current) => current.includes(domain)
      ? current.filter((item) => item !== domain)
      : ANNOTATION_CONFIRMATION_DOMAINS.filter(
          (item) => current.includes(item) || item === domain,
        ));
  }

  // 轨道选择按面板提供的项目顺序保存，不把已删除历史轨道重新写入新确认。
  function toggleTrack(trackId: string) {
    setSelectedTrackIds((current) => current.includes(trackId)
      ? current.filter((item) => item !== trackId)
      : props.trackOptions
          .map((track) => track.id)
          .filter((id) => current.includes(id) || id === trackId));
  }

  // 创建始终绑定当前服务器修订和循环范围；任何缺失条件都在发请求前中止。
  async function createConfirmation() {
    if (
      props.createBlocker ||
      !props.range ||
      props.currentRevision === null ||
      targetSelectionInvalid
    ) {
      return;
    }
    setNotice(null);
    const targets: AnnotationConfirmationTargets = targetMode === "all"
      ? { mode: "all" }
      : targetMode === "domains"
        ? { mode: "domains", domains: selectedDomains }
        : { mode: "tracks", trackIds: selectedTrackIds };
    try {
      const result = await props.onCreate({
        scope: {
          startTime: props.range.start,
          endTime: props.range.end,
          targets,
        },
        note: note.trim() || null,
      });
      setNote("");
      setNotice(result.refreshFailed
        ? "确认已创建，但列表刷新失败，请手动刷新。"
        : "确认范围已创建。");
    } catch (error) {
      console.error("创建确认范围失败:", error);
    }
  }

  // 撤销通过二次确认提交，并保留可选原因；成功后关闭对话框但仍可在“全部”中审阅事实。
  async function revokeConfirmation() {
    if (!revokeTarget || props.mutationPending) return;
    setNotice(null);
    try {
      const result = await props.onRevoke(
        revokeTarget,
        revokeReason.trim() || null,
      );
      setRevokeTarget(null);
      setRevokeReason("");
      setNotice(result.refreshFailed
        ? "确认已撤销，但列表刷新失败，请手动刷新。"
        : "确认记录已撤销。");
    } catch (error) {
      console.error("撤销确认范围失败:", error);
    }
  }

  return (
    <section
      className={["panel", "annotation-confirmation-panel", props.collapsed ? "is-collapsed" : ""].join(" ")}
      aria-label="标注确认"
    >
      <div className="panel-header annotation-confirmation-heading">
        <h2>标注确认</h2>
        <div className="annotation-confirmation-heading-actions">
          {!props.collapsed ? (
            <>
              <span>{props.records.length} 条</span>
              <label title="在时间轴显示确认范围">
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
                title="刷新确认记录"
                aria-label="刷新确认记录"
                disabled={props.loading || props.mutationPending}
                onClick={() => void props.onRefresh()}
              >
                <RefreshCw size={15} />
              </button>
            </>
          ) : null}
          {props.onToggleCollapse ? (
            <button
              type="button"
              className="panel-collapse-button"
              title={props.collapsed ? "展开面板" : "最小化面板"}
              aria-label={props.collapsed ? "展开面板" : "最小化面板"}
              onClick={props.onToggleCollapse}
            >
              {props.collapsed ? "▸" : "—"}
            </button>
          ) : null}
        </div>
      </div>

      {!props.collapsed ? (
        <div className="annotation-confirmation-body">
          <div className="annotation-confirmation-status-row">
            <span>服务器修订 {props.currentRevision ?? "-"}</span>
            <span>编辑器修订 {props.editorRevision}</span>
            <span>{props.records.length} 条记录</span>
          </div>

          {props.error ? <div className="annotation-confirmation-error">{props.error}</div> : null}
          {notice ? <div className="annotation-confirmation-notice">{notice}</div> : null}

          {props.canReview ? (
            <div className="annotation-confirmation-create">
              <div className="annotation-confirmation-range">
                <span>当前范围</span>
                <strong>{props.range
                  ? `${formatTime(props.range.start)} - ${formatTime(props.range.end)}`
                  : "尚未设置循环范围"}</strong>
              </div>
              <div className="annotation-confirmation-segments" aria-label="确认目标模式">
                {(["all", "domains", "tracks"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={targetMode === mode ? "active" : ""}
                    onClick={() => setTargetMode(mode)}
                  >
                    {mode === "all" ? "全部" : mode === "domains" ? "领域" : "轨道"}
                  </button>
                ))}
              </div>

              {targetMode === "domains" ? (
                <div className="annotation-confirmation-options">
                  {ANNOTATION_CONFIRMATION_DOMAINS.map((domain) => (
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
                  {props.trackOptions.length > 0 ? props.trackOptions.map((track) => (
                    <label key={track.id}>
                      <input
                        type="checkbox"
                        checked={selectedTrackIds.includes(track.id)}
                        onChange={() => toggleTrack(track.id)}
                      />
                      {track.label}
                    </label>
                  )) : <span className="annotation-confirmation-muted">当前项目没有可确认轨道。</span>}
                </div>
              ) : null}

              <textarea
                rows={2}
                value={note}
                maxLength={1000}
                placeholder="审核备注（可选）"
                onChange={(event) => setNote(event.target.value)}
              />
              {blockerMessage || targetSelectionInvalid ? (
                <p className="annotation-confirmation-blocker">
                  {blockerMessage ?? "请至少选择一个确认目标。"}
                </p>
              ) : null}
              <button
                type="button"
                className="annotation-confirmation-primary"
                disabled={Boolean(props.createBlocker) || targetSelectionInvalid || props.mutationPending}
                onClick={() => void createConfirmation()}
              >
                <CheckCircle2 size={15} />
                确认当前范围
              </button>
            </div>
          ) : (
            <p className="annotation-confirmation-muted">当前账号可浏览确认记录，但没有审核权限。</p>
          )}

          <div className="annotation-confirmation-history-heading">
            <span><History size={14} />确认历史</span>
            <div className="annotation-confirmation-segments compact">
              <button
                type="button"
                className={historyMode === "active" ? "active" : ""}
                onClick={() => setHistoryMode("active")}
              >
                有效
              </button>
              <button
                type="button"
                className={historyMode === "all" ? "active" : ""}
                onClick={() => setHistoryMode("all")}
              >
                全部
              </button>
            </div>
          </div>

          <div className="annotation-confirmation-list">
            {props.loading && !props.records.length ? (
              <p className="annotation-confirmation-muted">正在读取确认记录…</p>
            ) : visibleRecords.length === 0 ? (
              <p className="annotation-confirmation-muted">当前没有确认记录。</p>
            ) : visibleRecords.map((record) => (
              <article
                key={record.record.id}
                className={[
                  "annotation-confirmation-item",
                  record.lifecycle,
                  record.freshness,
                ].join(" ")}
              >
                <button
                  type="button"
                  className="annotation-confirmation-item-main"
                  onClick={() => props.onNavigate(record)}
                >
                  <span className="annotation-confirmation-item-state">
                    {record.lifecycle === "revoked"
                      ? "已撤销"
                      : record.freshness === "current"
                        ? "当前"
                        : "已过期"}
                  </span>
                  <strong>{formatTime(record.record.scope.startTime)} - {formatTime(record.record.scope.endTime)}</strong>
                  <span>{record.targetLabel}</span>
                  <small>
                    修订 {record.record.confirmedRevision} · {record.record.createdBy.displayName} · {formatDate(record.record.createdAt)}
                  </small>
                  {record.record.note ? <small>备注：{record.record.note}</small> : null}
                  {record.invalidReason ? <small className="invalid">{record.invalidReason}</small> : null}
                  {record.lifecycle === "revoked" && record.record.revokedAt ? (
                    <small>
                      {record.record.revokedBy?.displayName ?? "未知账号"} 于 {formatDate(record.record.revokedAt)} 撤销
                      {record.record.revokeReason ? `：${record.record.revokeReason}` : ""}
                    </small>
                  ) : null}
                </button>
                {props.canRevoke(record) ? (
                  <button
                    type="button"
                    className="annotation-confirmation-revoke"
                    onClick={() => {
                      setRevokeTarget(record);
                      setRevokeReason("");
                    }}
                  >
                    <Undo2 size={14} />
                    撤销
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </div>
      ) : null}

      <AlertDialog.Root
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => {
          if (!open && !props.mutationPending) {
            setRevokeTarget(null);
            setRevokeReason("");
          }
        }}
      >
        <AlertDialog.Portal container={props.portalContainer}>
          <AlertDialog.Overlay className="resource-alert-backdrop" />
          <AlertDialog.Content className="annotation-confirmation-revoke-dialog">
            <AlertDialog.Title>撤销确认记录</AlertDialog.Title>
            <AlertDialog.Description>
              撤销不会删除历史。该范围会保留为已撤销的审核事实。
            </AlertDialog.Description>
            <label>
              撤销原因（可选）
              <textarea
                rows={3}
                maxLength={1000}
                value={revokeReason}
                onChange={(event) => setRevokeReason(event.target.value)}
              />
            </label>
            <div className="annotation-confirmation-revoke-actions">
              <AlertDialog.Cancel asChild>
                <button type="button" disabled={props.mutationPending}>取消</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="danger"
                  disabled={props.mutationPending}
                  onClick={(event) => {
                    event.preventDefault();
                    void revokeConfirmation();
                  }}
                >
                  确认撤销
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}

// 时间格式固定到毫秒，帮助审核者核对精确范围而不是只看到模糊分钟数。
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}:${remaining.toFixed(3).padStart(6, "0")}`;
}

// 审核历史使用当前语言环境的紧凑时间，不依赖资源管理器的文件日期格式。
function formatDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
