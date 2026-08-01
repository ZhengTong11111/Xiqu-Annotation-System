import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  History,
  RefreshCw,
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
  AnnotationRecoverySnapshotDetail,
  AnnotationRecoverySnapshotSummary,
  ResourceEntry,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import { formatResourceDate } from "./ResourceItem";
import {
  buildRecoverySnapshotPreview,
  type RecoverySnapshotProjectSummary,
} from "./recoverySnapshotPreview";

// 组件只管理一份标注文件的恢复历史；资源切换时由 key 重新创建，避免缓存跨文件串用。
export function ResourceRecoveryHistory(props: {
  client: PlatformClient;
  resource: ResourceEntry;
}) {
  const [expanded, setExpanded] = useState(false);
  const [summaries, setSummaries] = useState<
    AnnotationRecoverySnapshotSummary[]
  >([]);
  const [listLoading, setListLoading] = useState(false);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedSummary, setSelectedSummary] =
    useState<AnnotationRecoverySnapshotSummary | null>(null);
  const [details, setDetails] = useState<
    Record<string, AnnotationRecoverySnapshotDetail<unknown>>
  >({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const listRequestGenerationRef = useRef(0);
  const detailRequestGenerationRef = useRef(0);
  const canReadHistory = props.resource.permission.capabilities.includes(
    "write",
  );

  // 切换资源时让尚未结束的请求失效；即使组件未来不再通过 key 重建也不会覆盖新资源。
  useEffect(() => {
    listRequestGenerationRef.current += 1;
    detailRequestGenerationRef.current += 1;
    setExpanded(false);
    setSummaries([]);
    setListLoaded(false);
    setListError(null);
    setSelectedSummary(null);
    setDetails({});
    setDetailLoadingId(null);
    setDetailError(null);
  }, [props.resource.id]);

  // 摘要仅在首次展开或用户刷新时加载，不跟随资源列表的普通刷新反复请求。
  const loadSummaries = useCallback(async () => {
    if (!canReadHistory || listLoading) return;
    const generation = ++listRequestGenerationRef.current;
    setListLoading(true);
    setListError(null);
    try {
      const nextSummaries = await props.client.listRecoverySnapshots(
        props.resource.id,
      );
      if (generation !== listRequestGenerationRef.current) return;
      setSummaries(nextSummaries);
      setListLoaded(true);
    } catch (error) {
      if (generation !== listRequestGenerationRef.current) return;
      setListError(describeRecoveryError(error));
    } finally {
      if (generation === listRequestGenerationRef.current) {
        setListLoading(false);
      }
    }
  }, [
    canReadHistory,
    listLoading,
    props.client,
    props.resource.id,
  ]);

  // 展开动作复用已加载摘要；关闭区块不会清除缓存或制造额外网络请求。
  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && !listLoaded && !listLoading) {
      void loadSummaries();
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

  // 没有编辑权限的账号只能看到明确权限状态，浏览器不会发送必然失败的历史请求。
  if (!canReadHistory) {
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
            <small>{listLoaded ? `${summaries.length} 个快照` : "保存前快照"}</small>
          </span>
        </button>
        {expanded ? (
          <button
            type="button"
            className="resource-recovery-refresh"
            disabled={listLoading}
            onClick={() => void loadSummaries()}
            title="刷新恢复历史"
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
      </div>

      {/* 展开内容集中处理加载、错误、空历史和列表四种互斥状态。 */}
      {expanded ? (
        <div className="resource-recovery-content">
          {listLoading ? (
            <div className="resource-recovery-state">正在读取恢复历史...</div>
          ) : listError ? (
            <div className="resource-recovery-state error">
              <span>{listError}</span>
              <button type="button" onClick={() => void loadSummaries()}>
                重试
              </button>
            </div>
          ) : listLoaded && summaries.length === 0 ? (
            <div className="resource-recovery-state">还没有恢复快照。</div>
          ) : (
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
          )}
        </div>
      ) : null}

      {/* 预览对话框只消费历史详情，不暴露恢复、保存或覆盖当前文件的命令。 */}
      <RecoverySnapshotDialog
        summary={selectedSummary}
        detail={selectedSummary ? details[selectedSummary.id] : undefined}
        loading={Boolean(
          selectedSummary && detailLoadingId === selectedSummary.id,
        )}
        error={detailError}
        onClose={() => {
          detailRequestGenerationRef.current += 1;
          setSelectedSummary(null);
          setDetailLoadingId(null);
          setDetailError(null);
        }}
        onRetry={selectedSummary
          ? () => {
              void openSnapshot(selectedSummary, true);
            }
          : undefined}
      />
    </section>
  );
}

// 对话框把未知 payload 转成安全摘要；转换失败时仍保留快照元数据供用户定位。
function RecoverySnapshotDialog(props: {
  summary: AnnotationRecoverySnapshotSummary | null;
  detail?: AnnotationRecoverySnapshotDetail<unknown>;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry?: () => void;
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
        if (!open) props.onClose();
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  return reason;
}

// 网络与权限错误统一收敛为 Inspector 内联信息，不污染资源列表的全局错误状态。
function describeRecoveryError(error: unknown) {
  return error instanceof Error ? error.message : "读取恢复历史失败。";
}
