import * as Dialog from "@radix-ui/react-dialog";
import {
  Download,
  FilterX,
  RefreshCw,
  ScrollText,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AUDIT_ACTIONS,
  type AuditActionName,
  type AuditLogEntry,
  type ListAuditLogsOptions,
  type PlatformUser,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import {
  AUDIT_ACTION_LABELS,
  formatAuditAction,
  formatAuditResource,
  formatAuditTime,
  formatAuditUser,
  summarizeAuditDetail,
} from "./auditLogView";

type AuditLogDialogProps = {
  client: PlatformClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// 筛选草稿保留 datetime-local 的本地值，只有应用时才转换为服务端 ISO 时间。
type AuditFilterDraft = {
  resourceId: string;
  actorUserId: string;
  targetUserId: string;
  action: AuditActionName | "";
  createdFrom: string;
  createdTo: string;
};

const EMPTY_FILTER_DRAFT: AuditFilterDraft = {
  resourceId: "",
  actorUserId: "",
  targetUserId: "",
  action: "",
  createdFrom: "",
  createdTo: "",
};

// 审计日志窗口独立管理查询和下载状态，不把全局运维数据塞进资源 Inspector 或系统诊断面板。
export function AuditLogDialog(props: AuditLogDialogProps) {
  const [draft, setDraft] = useState<AuditFilterDraft>(EMPTY_FILTER_DRAFT);
  const [filters, setFilters] = useState<ListAuditLogsOptions>({ limit: 50 });
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  // 第一页刷新会淘汰旧响应，避免快速切换筛选后旧请求覆盖新结果。
  const loadFirstPage = useCallback(async (
    requestedFilters: ListAuditLogsOptions,
  ) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setItems([]);
    setNextCursor(null);
    try {
      const page = await props.client.listAuditLogs({
        ...requestedFilters,
        cursor: undefined,
      });
      if (requestId !== requestIdRef.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (nextError) {
      if (requestId !== requestIdRef.current) return;
      setError(describeAuditError(nextError));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [props.client]);

  useEffect(() => {
    // Dialog 关闭时不产生审计请求；重新打开会读取当前筛选下的最新第一页。
    if (!props.open) {
      requestIdRef.current += 1;
      return;
    }
    setNotice(null);
    void loadFirstPage(filters);
  }, [filters, loadFirstPage, props.open]);

  useEffect(() => {
    // 账号目录只用于筛选展示；读取失败不阻断日志本身，仍可按资源和动作查询。
    if (!props.open || users.length) return;
    let active = true;
    void props.client.listDirectoryUsers()
      .then((nextUsers) => {
        if (active) setUsers(nextUsers);
      })
      .catch((nextError) => {
        if (active) setError(describeAuditError(nextError));
      });
    return () => {
      active = false;
    };
  }, [props.client, props.open, users.length]);

  // 下一页只能使用当前已应用筛选和服务端 cursor，禁止把草稿或旧查询混入追加结果。
  async function loadMore() {
    if (!nextCursor || loading || loadingMore) return;
    const requestId = requestIdRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await props.client.listAuditLogs({
        ...filters,
        cursor: nextCursor,
      });
      // 筛选、刷新或关闭窗口会推进 request id，旧分页响应不得混入新的第一页。
      if (requestId !== requestIdRef.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (nextError) {
      if (requestId !== requestIdRef.current) return;
      setError(describeAuditError(nextError));
    } finally {
      if (requestId === requestIdRef.current) setLoadingMore(false);
    }
  }

  // 应用时才把本地日期转为绝对 ISO 时间，保证服务端与导出使用完全相同的范围。
  function applyFilters() {
    setNotice(null);
    setFilters({
      resourceId: draft.resourceId.trim() || undefined,
      actorUserId: draft.actorUserId || undefined,
      targetUserId: draft.targetUserId || undefined,
      action: draft.action || undefined,
      createdFrom: toIsoTime(draft.createdFrom),
      createdTo: toIsoTime(draft.createdTo),
      limit: 50,
    });
  }

  // 重置同时清空草稿与已应用筛选；若本来就是空筛选则主动刷新第一页。
  function resetFilters() {
    setDraft(EMPTY_FILTER_DRAFT);
    setNotice(null);
    const cleared = { limit: 50 } satisfies ListAuditLogsOptions;
    if (areAuditFiltersEqual(filters, cleared)) {
      void loadFirstPage(cleared);
    } else {
      setFilters(cleared);
    }
  }

  // 下载使用临时 object URL，并在浏览器取得 Blob 后延迟撤销，兼顾 Safari 与内存回收。
  async function exportCurrentFilters() {
    if (exporting) return;
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const { cursor: _cursor, limit: _limit, ...exportFilters } = filters;
      const result = await props.client.exportAuditLogs(exportFilters);
      downloadBlob(result.blob, result.filename);
      setNotice(
        result.truncated
          ? `已导出前 ${result.exportedCount} 条，结果达到服务端上限。`
          : `已导出 ${result.exportedCount} 条审计记录。`,
      );
    } catch (nextError) {
      setError(describeAuditError(nextError));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="system-diagnostics-backdrop" />
        <Dialog.Content className="audit-log-dialog">
          <header className="system-diagnostics-header">
            <div>
              <ScrollText size={20} />
              <div>
                <Dialog.Title>审计日志</Dialog.Title>
                <Dialog.Description>
                  资源操作、权限变更、标注保存与系统运维记录
                </Dialog.Description>
              </div>
            </div>
            <div className="system-diagnostics-header-actions">
              <button
                type="button"
                title="刷新当前筛选"
                disabled={loading || loadingMore}
                onClick={() => void loadFirstPage(filters)}
              >
                <RefreshCw size={16} className={loading ? "is-spinning" : ""} />
              </button>
              <Dialog.Close asChild>
                <button type="button" title="关闭审计日志"><X size={17} /></button>
              </Dialog.Close>
            </div>
          </header>

          {/* 筛选区保持工具栏密度，草稿只有点击“应用”后才改变服务端查询。 */}
          <section className="audit-log-filters">
            <label>
              <span>动作</span>
              <select
                value={draft.action}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  action: event.target.value as AuditFilterDraft["action"],
                }))}
              >
                <option value="">全部动作</option>
                {AUDIT_ACTIONS.map((action) => (
                  <option key={action} value={action}>{AUDIT_ACTION_LABELS[action]}</option>
                ))}
              </select>
            </label>
            <AccountFilter
              label="执行账号"
              value={draft.actorUserId}
              users={users}
              onChange={(actorUserId) => setDraft((current) => ({
                ...current,
                actorUserId,
              }))}
            />
            <AccountFilter
              label="目标账号"
              value={draft.targetUserId}
              users={users}
              onChange={(targetUserId) => setDraft((current) => ({
                ...current,
                targetUserId,
              }))}
            />
            <label>
              <span>资源 ID</span>
              <input
                value={draft.resourceId}
                placeholder="全部资源"
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  resourceId: event.target.value,
                }))}
              />
            </label>
            <label>
              <span>开始时间</span>
              <input
                type="datetime-local"
                value={draft.createdFrom}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  createdFrom: event.target.value,
                }))}
              />
            </label>
            <label>
              <span>结束时间</span>
              <input
                type="datetime-local"
                value={draft.createdTo}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  createdTo: event.target.value,
                }))}
              />
            </label>
            <div className="audit-log-filter-actions">
              <button type="button" onClick={resetFilters}>
                <FilterX size={15} /> 重置
              </button>
              <button type="button" className="is-primary" onClick={applyFilters}>
                应用筛选
              </button>
            </div>
          </section>

          <div className="audit-log-feedback">
            {error ? <div className="resource-error-banner">{error}</div> : null}
            {notice ? <div className="system-diagnostics-notice">{notice}</div> : null}
          </div>

          {/* 表头固定在窗口内容区，记录自身在独立滚动容器中增量挂载。 */}
          <section className="audit-log-table-region" aria-busy={loading}>
            <div className="audit-log-table-header" role="row">
              <span>时间</span>
              <span>动作</span>
              <span>执行账号</span>
              <span>资源 / 目标</span>
              <span>摘要</span>
            </div>
            <div className="audit-log-table-body">
              {!items.length && loading ? (
                <div className="audit-log-empty">正在读取审计记录…</div>
              ) : null}
              {!items.length && !loading && !error ? (
                <div className="audit-log-empty">当前筛选下没有审计记录。</div>
              ) : null}
              {items.map((entry) => <AuditLogRow key={entry.id} entry={entry} />)}
              {nextCursor ? (
                <button
                  type="button"
                  className="audit-log-load-more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "正在加载" : "加载更多"}
                </button>
              ) : null}
            </div>
          </section>

          <footer className="audit-log-footer">
            <span>已加载 {items.length} 条{nextCursor ? "，还有更多" : ""}</span>
            <button
              type="button"
              disabled={exporting}
              onClick={() => void exportCurrentFilters()}
            >
              <Download size={15} /> {exporting ? "正在导出" : "导出当前筛选"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// 账号筛选复用同一目录列表，option 同时显示名称与账号避免重名误选。
function AccountFilter(props: {
  label: string;
  value: string;
  users: readonly PlatformUser[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">全部账号</option>
        {props.users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.displayName} ({user.accountName})
          </option>
        ))}
      </select>
    </label>
  );
}

// 单行只展示有界摘要，完整原始字段通过 title 和 CSV 保留供追溯。
function AuditLogRow({ entry }: { entry: AuditLogEntry }) {
  const detail = summarizeAuditDetail(entry.detail);
  const target = entry.targetUserId
    ? formatAuditUser(entry.targetUser, entry.targetUserId)
    : "";
  return (
    <div className="audit-log-table-row" role="row">
      <time title={entry.createdAt}>{formatAuditTime(entry.createdAt)}</time>
      <span className="audit-log-action" title={entry.action}>
        {formatAuditAction(entry.action)}
      </span>
      <span title={entry.actorUserId ?? undefined}>
        {formatAuditUser(entry.actor, entry.actorUserId)}
      </span>
      <span title={[entry.resourceId, entry.targetUserId].filter(Boolean).join(" / ")}>
        <strong>{formatAuditResource(entry)}</strong>
        {target ? <small>{target}</small> : null}
      </span>
      <span className="audit-log-detail" title={detail}>{detail || "—"}</span>
    </div>
  );
}

// datetime-local 按用户本地时区解释，转换为绝对 ISO 后交给服务端统一比较。
function toIsoTime(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

// 重置时比较已应用筛选，避免无意义 state 更新同时仍能主动刷新当前第一页。
function areAuditFiltersEqual(
  left: ListAuditLogsOptions,
  right: ListAuditLogsOptions,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Blob 下载采用隐藏锚点触发并延迟撤销 URL，不把导出文件留在 React 状态。
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 下一任务再撤销 URL，避免 Safari 在真正读取 Blob 前遇到已失效地址。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

// API 客户端已经将结构化错误转成 Error；未知异常使用稳定中文提示兜底。
function describeAuditError(error: unknown): string {
  return error instanceof Error ? error.message : "读取审计日志失败。";
}
