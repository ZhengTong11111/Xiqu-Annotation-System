import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock3,
  Files,
  History,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AnnotationFile,
  AnnotationRecoverySnapshotDetail,
  AnnotationRecoverySnapshotSummary,
  ResourceEntry,
} from "@xiqu/shared";
import {
  PlatformApiError,
  type PlatformClient,
} from "../api/platformClient";
import { formatResourceDate } from "./ResourceItem";
import {
  buildRecoverySnapshotPreview,
  type RecoverySnapshotProjectSummary,
} from "./recoverySnapshotPreview";
import type { AnnotationComparisonFocus } from "./annotationComparisonNavigation";
import { RecoverySnapshotComparisonDialog } from "./RecoverySnapshotComparisonDialog";
import { applyRecoverySnapshotPage } from "./recoverySnapshotPaging";

// 组件只管理一份标注文件的恢复历史；资源切换时由 key 重新创建，避免缓存跨文件串用。
export function ResourceRecoveryHistory(props: {
  client: PlatformClient;
  resource: ResourceEntry;
  onRestored?: (file: AnnotationFile<unknown>) => void | Promise<void>;
  onOpenCurrentAtTime: (focus: AnnotationComparisonFocus) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [summaries, setSummaries] = useState<
    AnnotationRecoverySnapshotSummary[]
  >([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoadingMode, setListLoadingMode] = useState<"replace" | "append" | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [selectedSummary, setSelectedSummary] =
    useState<AnnotationRecoverySnapshotSummary | null>(null);
  const [details, setDetails] = useState<
    Record<string, AnnotationRecoverySnapshotDetail<unknown>>
  >({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [currentRevision, setCurrentRevision] = useState(
    props.resource.revision ?? 0,
  );
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [comparisonSnapshotId, setComparisonSnapshotId] = useState<string | null>(null);
  const [comparisonCurrentFile, setComparisonCurrentFile] =
    useState<AnnotationFile<unknown> | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const listRequestGenerationRef = useRef(0);
  const detailRequestGenerationRef = useRef(0);
  const restoreRequestGenerationRef = useRef(0);
  const comparisonRequestGenerationRef = useRef(0);
  const canUseRecoveryHistory = props.resource.permission.capabilities.includes(
    "write",
  );

  // 切换资源时让尚未结束的请求失效；即使组件未来不再通过 key 重建也不会覆盖新资源。
  useEffect(() => {
    listRequestGenerationRef.current += 1;
    detailRequestGenerationRef.current += 1;
    restoreRequestGenerationRef.current += 1;
    comparisonRequestGenerationRef.current += 1;
    setExpanded(false);
    setSummaries([]);
    setNextCursor(null);
    setListLoadingMode(null);
    setListLoaded(false);
    setListError(null);
    setLoadMoreError(null);
    setSelectedSummary(null);
    setDetails({});
    setDetailLoadingId(null);
    setDetailError(null);
    setCurrentRevision(props.resource.revision ?? 0);
    setRestoreConfirmOpen(false);
    setRestoring(false);
    setRestoreError(null);
    setComparisonSnapshotId(null);
    setComparisonCurrentFile(null);
    setComparisonLoading(false);
    setComparisonError(null);
  }, [props.resource.id]);

  // 外层资源刷新可能带回更高 revision，但不应因此折叠用户正在查看的历史列表。
  useEffect(() => {
    setCurrentRevision(props.resource.revision ?? 0);
  }, [props.resource.revision]);

  // 刷新替换第一页，续页按 opaque cursor 追加；generation 使资源切换或刷新后的迟到响应失效。
  const loadSummaries = useCallback(async (mode: "replace" | "append") => {
    if (!canUseRecoveryHistory) return;
    const cursor = mode === "append" ? nextCursor : null;
    if (mode === "append" && (!cursor || listLoadingMode !== null)) return;
    const generation = ++listRequestGenerationRef.current;
    setListLoadingMode(mode);
    if (mode === "replace") {
      setListError(null);
      setLoadMoreError(null);
    } else {
      setLoadMoreError(null);
    }
    try {
      const page = await props.client.listRecoverySnapshots(
        props.resource.id,
        cursor ? { cursor } : {},
      );
      if (generation !== listRequestGenerationRef.current) return;
      const nextState = applyRecoverySnapshotPage(
        { summaries, nextCursor },
        page,
        mode,
      );
      setSummaries(nextState.summaries);
      setNextCursor(nextState.nextCursor);
      setListLoaded(true);
    } catch (error) {
      if (generation !== listRequestGenerationRef.current) return;
      const message = describeRecoveryError(error);
      if (mode === "append") setLoadMoreError(message);
      else setListError(message);
    } finally {
      if (generation === listRequestGenerationRef.current) {
        setListLoadingMode(null);
      }
    }
  }, [
    canUseRecoveryHistory,
    listLoadingMode,
    nextCursor,
    props.client,
    props.resource.id,
    summaries,
  ]);

  // 展开动作复用已加载摘要；关闭区块不会清除缓存或制造额外网络请求。
  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && !listLoaded && listLoadingMode === null) {
      void loadSummaries("replace");
    }
  };

  // 用户主动选择一条历史后才请求完整 payload，并在当前资源组件内缓存详情。
  const openSnapshot = async (
    summary: AnnotationRecoverySnapshotSummary,
    forceReload = false,
  ) => {
    setSelectedSummary(summary);
    setDetailError(null);
    if (!forceReload && details[summary.id]) return;
    const generation = ++detailRequestGenerationRef.current;
    setDetailLoadingId(summary.id);
    try {
      const detail = await props.client.getRecoverySnapshot<unknown>(
        props.resource.id,
        summary.id,
      );
      if (generation !== detailRequestGenerationRef.current) return;
      setDetails((current) => ({ ...current, [summary.id]: detail }));
    } catch (error) {
      if (generation !== detailRequestGenerationRef.current) return;
      setDetailError(describeRecoveryError(error));
    } finally {
      if (generation === detailRequestGenerationRef.current) {
        setDetailLoadingId(null);
      }
    }
  };

  // 恢复必须把用户预览时看到的当前 revision 交给服务端，防止并发保存被静默覆盖。
  const restoreSelectedSnapshot = async () => {
    if (!selectedSummary || restoring || currentRevision < 1) return;
    const generation = ++restoreRequestGenerationRef.current;
    setRestoring(true);
    setRestoreError(null);
    try {
      const restored = await props.client.restoreAnnotationRecoverySnapshot(
        props.resource.id,
        selectedSummary.id,
        { baseRevision: currentRevision },
      );
      if (generation !== restoreRequestGenerationRef.current) return;
      setCurrentRevision(restored.revision);
      setRestoreConfirmOpen(false);
      setSelectedSummary(null);
      setDetails({});
      comparisonRequestGenerationRef.current += 1;
      setComparisonSnapshotId(null);
      setComparisonCurrentFile(null);
      setComparisonLoading(false);
      setComparisonError(null);
      await props.onRestored?.(restored);
      if (generation !== restoreRequestGenerationRef.current) return;
      await loadSummaries("replace");
    } catch (error) {
      if (generation !== restoreRequestGenerationRef.current) return;
      setRestoreError(describeRestoreError(error));
    } finally {
      if (generation === restoreRequestGenerationRef.current) {
        setRestoring(false);
      }
    }
  };

  // 比较打开时重新读取当前文件，避免把资源列表旧 revision 或编辑器未保存状态当作服务器事实。
  const openCurrentComparison = async () => {
    if (!selectedSummary || !details[selectedSummary.id] || comparisonLoading) return;
    const generation = ++comparisonRequestGenerationRef.current;
    setComparisonSnapshotId(selectedSummary.id);
    setComparisonCurrentFile(null);
    setComparisonLoading(true);
    setComparisonError(null);
    try {
      const currentFile = await props.client.getAnnotationFile<unknown>(props.resource.id);
      if (generation !== comparisonRequestGenerationRef.current) return;
      setComparisonCurrentFile(currentFile);
      setCurrentRevision(currentFile.revision);
    } catch (error) {
      if (generation !== comparisonRequestGenerationRef.current) return;
      setComparisonError(describeRecoveryError(error));
    } finally {
      if (generation === comparisonRequestGenerationRef.current) {
        setComparisonLoading(false);
      }
    }
  };

  // 没有编辑权限的账号只能看到明确权限状态，浏览器不会发送必然失败的历史请求。
  if (!canUseRecoveryHistory) {
    return (
      <section className="resource-recovery-history">
        <div className="resource-recovery-heading">
          <History size={15} />
          <div>
            <strong>恢复历史</strong>
            <span>需要编辑权限</span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="resource-recovery-history">
      {/* 历史区默认折叠，避免长期挤占 Inspector 中的账号权限空间。 */}
      <div className="resource-recovery-heading">
        <button
          type="button"
          className="resource-recovery-toggle"
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <History size={15} />
          <span>
            <strong>恢复历史</strong>
            <small>{listLoaded
              ? nextCursor
                ? `已加载 ${summaries.length} 条，仍有更多`
                : `共加载 ${summaries.length} 条`
              : "保存前快照"}</small>
          </span>
        </button>
        {expanded ? (
          <button
            type="button"
            className="resource-recovery-refresh"
            disabled={listLoadingMode === "replace"}
            onClick={() => void loadSummaries("replace")}
            title="刷新恢复历史"
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
      </div>

      {/* 展开内容集中处理加载、错误、空历史和列表四种互斥状态。 */}
      {expanded ? (
        <div className="resource-recovery-content">
          {listLoadingMode === "replace" && !listLoaded ? (
            <div className="resource-recovery-state">正在读取恢复历史...</div>
          ) : listError && !listLoaded ? (
            <div className="resource-recovery-state error">
              <span>{listError}</span>
              <button type="button" onClick={() => void loadSummaries("replace")}>
                重试
              </button>
            </div>
          ) : listLoaded && summaries.length === 0 ? (
            <div className="resource-recovery-state">还没有恢复快照。</div>
          ) : (
            <>
              <div className="resource-recovery-list">
                {summaries.map((summary) => (
                  <button
                    key={summary.id}
                    type="button"
                    className="resource-recovery-item"
                    onClick={() => void openSnapshot(summary)}
                  >
                    <Clock3 size={14} />
                    <span>
                      <strong>修订 {summary.revision}</strong>
                      <small>{formatSnapshotReason(summary.reason)}</small>
                    </span>
                    <span>
                      <small>{summary.creator.displayName}</small>
                      <time>{formatResourceDate(summary.createdAt)}</time>
                    </span>
                  </button>
                ))}
              </div>
              <div className={`resource-recovery-page-footer${loadMoreError || listError ? " error" : ""}`}>
                {listLoadingMode === "append" ? (
                  <span>正在加载更多...</span>
                ) : listLoadingMode === "replace" ? (
                  <span>正在刷新...</span>
                ) : loadMoreError ? (
                  <>
                    <span>{loadMoreError}</span>
                    <button type="button" onClick={() => void loadSummaries("append")}>重试</button>
                  </>
                ) : listError ? (
                  <>
                    <span>{listError}</span>
                    <button type="button" onClick={() => void loadSummaries("replace")}>重试刷新</button>
                  </>
                ) : nextCursor ? (
                  <button type="button" onClick={() => void loadSummaries("append")}>
                    加载更多
                  </button>
                ) : (
                  <span>共加载 {summaries.length} 条</span>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* 预览与恢复确认分层，避免用户浏览历史时误触覆盖当前内容。 */}
      <RecoverySnapshotDialog
        resourceName={props.resource.name}
        summary={selectedSummary}
        detail={selectedSummary ? details[selectedSummary.id] : undefined}
        loading={Boolean(
          selectedSummary && detailLoadingId === selectedSummary.id,
        )}
        error={detailError}
        currentRevision={currentRevision}
        restoreConfirmOpen={restoreConfirmOpen}
        restoring={restoring}
        restoreError={restoreError}
        onRestoreConfirmOpenChange={(open) => {
          if (restoring) return;
          setRestoreConfirmOpen(open);
          if (!open) setRestoreError(null);
        }}
        onRestore={() => void restoreSelectedSnapshot()}
        onClose={() => {
          detailRequestGenerationRef.current += 1;
          setSelectedSummary(null);
          setDetailLoadingId(null);
          setDetailError(null);
          setRestoreConfirmOpen(false);
          setRestoreError(null);
        }}
        onRetry={selectedSummary
          ? () => {
              void openSnapshot(selectedSummary, true);
            }
          : undefined}
        onCompare={() => void openCurrentComparison()}
      />
      {/* 快照比较是独立只读层；关闭后保留原快照详情和恢复确认上下文。 */}
      <RecoverySnapshotComparisonDialog
        open={Boolean(comparisonSnapshotId)}
        resource={props.resource}
        snapshot={comparisonSnapshotId ? details[comparisonSnapshotId] ?? null : null}
        currentFile={comparisonCurrentFile}
        loading={comparisonLoading}
        error={comparisonError}
        onOpenChange={(open) => {
          if (open) return;
          comparisonRequestGenerationRef.current += 1;
          setComparisonSnapshotId(null);
          setComparisonCurrentFile(null);
          setComparisonLoading(false);
          setComparisonError(null);
        }}
        onOpenCurrentAtTime={props.onOpenCurrentAtTime}
      />
    </section>
  );
}

// 对话框把未知 payload 转成安全摘要；转换失败时仍保留快照元数据供用户定位。
function RecoverySnapshotDialog(props: {
  resourceName: string;
  summary: AnnotationRecoverySnapshotSummary | null;
  detail?: AnnotationRecoverySnapshotDetail<unknown>;
  loading: boolean;
  error: string | null;
  currentRevision: number;
  restoreConfirmOpen: boolean;
  restoring: boolean;
  restoreError: string | null;
  onRestoreConfirmOpenChange: (open: boolean) => void;
  onRestore: () => void;
  onClose: () => void;
  onRetry?: () => void;
  onCompare: () => void;
}) {
  const preview = useMemo(
    () => props.detail
      ? buildRecoverySnapshotPreview(props.detail.payload)
      : null,
    [props.detail],
  );
  return (
    <Dialog.Root
      open={Boolean(props.summary)}
      onOpenChange={(open) => {
        if (!open && !props.restoring) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="resource-destination-backdrop" />
        <Dialog.Content className="resource-recovery-dialog">
          {/* 固定头部明确这是只读事故恢复快照，避免与普通标注文件或发布版本混淆。 */}
          <header className="resource-recovery-dialog-header">
            <History size={20} />
            <span>
              <Dialog.Title>
                修订 {props.summary?.revision ?? "—"}
              </Dialog.Title>
              <Dialog.Description>
                只读恢复快照
              </Dialog.Description>
            </span>
            <Dialog.Close asChild>
              <button type="button" title="关闭快照预览">
                <X size={17} />
              </button>
            </Dialog.Close>
          </header>

          {/* 元数据始终可见，即使旧 payload 已损坏也能确认创建者、时间和原因。 */}
          <dl className="resource-recovery-metadata">
            <dt>创建者</dt>
            <dd>{props.summary?.creator.displayName ?? "—"}</dd>
            <dt>创建时间</dt>
            <dd>{props.summary
              ? formatResourceDate(props.summary.createdAt)
              : "—"}</dd>
            <dt>原因</dt>
            <dd>{formatSnapshotReason(props.summary?.reason)}</dd>
          </dl>

          {/* 详情主体区分请求中、请求失败、格式失败与正常摘要，状态之间不会重叠。 */}
          <div className="resource-recovery-dialog-body">
            {props.loading ? (
              <div className="resource-recovery-dialog-state">
                正在读取快照内容...
              </div>
            ) : props.error ? (
              <div className="resource-recovery-dialog-state error">
                <span>{props.error}</span>
                {props.onRetry ? (
                  <button type="button" onClick={props.onRetry}>重试</button>
                ) : null}
              </div>
            ) : preview?.ok ? (
              <RecoveryProjectSummary summary={preview.summary} />
            ) : preview ? (
              <div className="resource-recovery-dialog-state error">
                {preview.message}
              </div>
            ) : null}
          </div>

          {/* 快照可以无法生成结构化预览，但仍可能是可恢复的旧数据，因此只警告而不武断禁用。 */}
          <footer className="resource-recovery-dialog-footer">
            <span>
              当前文件修订 {props.currentRevision}
              {preview && !preview.ok ? " · 快照格式无法预览" : ""}
            </span>
            <div>
              <button
                type="button"
                disabled={!preview?.ok || props.loading || Boolean(props.error)}
                onClick={props.onCompare}
              >
                <Files size={15} />
                与当前文件比较
              </button>
              <button
                type="button"
                className="primary"
                disabled={!props.detail || props.loading || Boolean(props.error)}
                onClick={() => props.onRestoreConfirmOpenChange(true)}
              >
                <RotateCcw size={15} />
                恢复此快照
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>

      {/* 二次确认使用可访问的 AlertDialog，焦点锁定和 Escape 行为由成熟依赖统一处理。 */}
      <RestoreSnapshotAlertDialog
        open={props.restoreConfirmOpen}
        resourceName={props.resourceName}
        summary={props.summary}
        currentRevision={props.currentRevision}
        previewUnavailable={Boolean(preview && !preview.ok)}
        restoring={props.restoring}
        error={props.restoreError}
        onOpenChange={props.onRestoreConfirmOpenChange}
        onRestore={props.onRestore}
      />
    </Dialog.Root>
  );
}

// 确认框明确说明恢复会生成新 revision，而不是回退或删除当前历史。
function RestoreSnapshotAlertDialog(props: {
  open: boolean;
  resourceName: string;
  summary: AnnotationRecoverySnapshotSummary | null;
  currentRevision: number;
  previewUnavailable: boolean;
  restoring: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onRestore: () => void;
}) {
  return (
    <AlertDialog.Root
      open={props.open}
      onOpenChange={(open) => {
        if (!props.restoring) props.onOpenChange(open);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="resource-alert-backdrop" />
        <AlertDialog.Content className="resource-restore-alert">
          <header>
            <AlertTriangle size={21} />
            <span>
              <AlertDialog.Title>恢复历史内容？</AlertDialog.Title>
              <AlertDialog.Description>
                当前内容会先自动保存为恢复快照，然后生成一个新的修订。
              </AlertDialog.Description>
            </span>
          </header>
          <dl>
            <dt>标注文件</dt>
            <dd>{props.resourceName}</dd>
            <dt>当前修订</dt>
            <dd>{props.currentRevision}</dd>
            <dt>恢复来源</dt>
            <dd>修订 {props.summary?.revision ?? "—"}</dd>
            <dt>快照创建者</dt>
            <dd>{props.summary?.creator.displayName ?? "—"}</dd>
            <dt>快照时间</dt>
            <dd>{props.summary
              ? formatResourceDate(props.summary.createdAt)
              : "—"}</dd>
          </dl>
          {props.previewUnavailable ? (
            <p className="resource-restore-warning">
              此快照无法安全预览。恢复后可能需要旧版工具、重新关联视频或人工修复。
            </p>
          ) : null}
          {props.error ? (
            <p className="resource-restore-error">{props.error}</p>
          ) : null}
          <footer>
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={props.restoring}>取消</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                className="danger"
                disabled={props.restoring}
                onClick={(event) => {
                  // 请求完成前阻止 Radix 自动关闭，失败信息才能留在当前确认上下文中。
                  event.preventDefault();
                  props.onRestore();
                }}
              >
                <RotateCcw size={15} />
                {props.restoring ? "正在恢复..." : "确认恢复"}
              </button>
            </AlertDialog.Action>
          </footer>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// 摘要以紧凑定义列表展示多模态计数，保持 Finder Inspector 的扫描节奏。
function RecoveryProjectSummary(props: {
  summary: RecoverySnapshotProjectSummary;
}) {
  const rows = [
    ["视频", props.summary.videoName ?? "未关联"],
    ["句级字幕", String(props.summary.subtitleLineCount)],
    ["逐字标注", String(props.summary.characterAnnotationCount)],
    [
      "工尺谱",
      `${props.summary.gongcheAnnotationCount} 块 · ${props.summary.gongcheSymbolCount} 符号`,
    ],
    [
      "板眼",
      `${props.summary.banyanSectionCount} 区段 · ${props.summary.banyanMarkCount} 点`,
    ],
    [
      "自定义轨道",
      `${props.summary.customTrackCount} 条（文字 ${props.summary.customTextTrackCount} · 动作 ${props.summary.customActionTrackCount}）`,
    ],
    ["自定义块", String(props.summary.customBlockCount)],
    ["附属点", String(props.summary.attachedPointCount)],
    ["文件格式", `v${props.summary.normalizedFileVersion}`],
  ];
  return (
    <div className="resource-recovery-summary">
      {/* 定义列表只承载键值摘要，额外提示放在列表外以保持 HTML 语义正确。 */}
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {props.summary.requiresManualVideoImport ? (
        <p>原视频需要在编辑器中重新关联。</p>
      ) : null}
    </div>
  );
}

// 服务端 reason 使用稳定机器值，UI 在一处映射为可读中文。
function formatSnapshotReason(reason?: string | null) {
  if (!reason || reason === "save") return "保存前自动快照";
  if (reason === "before_snapshot_restore") return "恢复前保护快照";
  return reason;
}

// 网络与权限错误统一收敛为 Inspector 内联信息，不污染资源列表的全局错误状态。
function describeRecoveryError(error: unknown) {
  return error instanceof Error ? error.message : "读取恢复历史失败。";
}

// revision 冲突需要给出可操作提示，其他服务端错误则保留原始用户可见信息。
function describeRestoreError(error: unknown) {
  if (error instanceof PlatformApiError && error.status === 409) {
    return "当前文件已被其他保存推进。请关闭预览、刷新文件信息后重新选择快照。";
  }
  return error instanceof Error ? error.message : "恢复快照失败。";
}
