import { useCallback, useEffect, useRef, useState } from "react";
import {
  invertAnnotationCommandEnvelope,
  parseAnnotationCommandEnvelope,
  PROJECT_SNAPSHOT_BOUNDARY_COMMAND,
  type AnnotationCommandEnvelope,
  type AnnotationDomainCommand,
  type LegacyAnnotationOperationAction,
} from "@xiqu/shared";
import type { ProjectData } from "../types";
import { createRuntimeUuid } from "../utils/runtimeUuid";

export type HistoryAction =
  | "edit"
  | "import-video"
  | "import-srt"
  | "import-project"
  | "merge-project"
  | "repair-sentence-character-track";

export type HistoryEntry = {
  project: ProjectData;
  action: HistoryAction;
  // 保存产生该历史边界的正向命令；undo 使用 inverse，redo 重新使用原命令。
  commandEnvelope?: AnnotationCommandEnvelope;
};

export type ProjectSyncStatus =
  | "saved"
  | "dirty"
  | "saving"
  | "offline"
  | "conflict"
  | "error";

export type ProjectDocumentOperationType =
  | LegacyAnnotationOperationAction
  | AnnotationDomainCommand["type"];

export type ProjectDocumentOperation = {
  id: string;
  type: ProjectDocumentOperationType;
  action: HistoryAction | "track-snap";
  localRevision: number;
  baseRevision: number;
  createdAt: number;
  syncState: "pending" | "submitted" | "acknowledged";
  commandEnvelope?: AnnotationCommandEnvelope;
  // 操作只保留服务端审计需要的紧凑摘要；完整项目由当前草稿快照单份保存，不能在每条操作中重复。
  summary: {
    hasProjectChange: boolean;
    hasTrackSnapChange: boolean;
    changedTrackIds?: string[];
  };
};

// 浏览器草稿恢复 document hook 所需的最小完整状态，不包含临时拖拽、undo/redo 或 UI 浮层状态。
export type ProjectDocumentRecoveryState = {
  currentProject: ProjectData;
  savedProject: ProjectData;
  currentTrackSnapEnabled: Record<string, boolean>;
  savedTrackSnapEnabled: Record<string, boolean>;
  pendingOperations: ProjectDocumentOperation[];
  localRevision: number;
  savedRevision: number;
  lastChangedAt: number | null;
  lastSavedAt: number | null;
};

export type ProjectSyncState = {
  status: ProjectSyncStatus;
  localRevision: number;
  savedRevision: number;
  remoteRevision: number | null;
  pendingOperationCount: number;
  lastChangedAt: number | null;
  lastSavedAt: number | null;
  lastSyncAttemptAt: number | null;
  errorMessage: string | null;
};

type ProjectDocumentStateOptions = {
  initialProject: ProjectData;
  initialTrackSnapEnabled: Record<string, boolean>;
  areProjectsEqual: (left: ProjectData, right: ProjectData) => boolean;
  // 平台权威比较可忽略受保护媒体 URL 等运行时字段；本地模式默认沿用普通项目比较器。
  areAuthoritativeProjectsEqual?: (left: ProjectData, right: ProjectData) => boolean;
  areTrackSnapStatesEqual: (
    left: Record<string, boolean>,
    right: Record<string, boolean>,
  ) => boolean;
  historyLimit?: number;
  operationLogLimit?: number;
  readOnly?: boolean;
  initialRecoveryState?: ProjectDocumentRecoveryState;
};

type TrackSnapUpdateOptions = {
  recordOperation?: boolean;
};

// history action 与可选领域命令通过一个 options 边界进入提交，避免继续扩展位置参数。
type CommitProjectOptions = {
  action?: HistoryAction;
  commandEnvelope?: AnnotationCommandEnvelope;
};

type MarkProjectSavedOptions = {
  acknowledgedOperationIds?: string[];
  savedLocalRevision?: number;
};

export type AtomicCommandAcknowledgement = {
  operationIds: string[];
  expectedServerBaseProject: ProjectData;
  acknowledgedProject: ProjectData;
  acknowledgedTrackSnapEnabled: Record<string, boolean>;
  serverBaseRevision: number;
  committedRevision: number;
  expectedSavedLocalRevision: number;
  acknowledgedLocalRevision: number;
};

export type AtomicCommandAcknowledgementResult =
  | {
      status: "applied";
      remainingOperationCount: number;
      remoteRevision: number;
      savedLocalRevision: number;
      remainsDirty: boolean;
    }
  | {
      status: "rejected";
      reason:
        | "empty_batch"
        | "invalid_revision"
        | "stale_remote_revision"
        | "stale_saved_revision"
        | "operation_prefix_mismatch"
        | "operation_revision_mismatch";
    };

export type PendingCommandRebaseRequest = {
  expectedCurrentProject: ProjectData;
  expectedSavedProject: ProjectData;
  expectedLocalRevision: number;
  expectedSavedRevision: number;
  latestServerProject: ProjectData;
  rebasedCurrentProject: ProjectData;
  rebasedPendingOperations: ProjectDocumentOperation[];
  remoteRevision: number;
};

export type PendingCommandRebaseResult =
  | { status: "applied" }
  | {
      status: "rejected";
      reason:
        | "invalid_revision"
        | "document_changed"
        | "baseline_changed"
        | "local_revision_changed"
        | "operation_chain_changed"
        | "transient_edit_active"
        | "no_pending_operations";
    };

export type AlreadySatisfiedPendingReconciliationRequest = {
  expectedRecoveryState: ProjectDocumentRecoveryState;
  latestServerProject: ProjectData;
  expectedRemoteRevision: number;
  remoteRevision: number;
};

export type AlreadySatisfiedPendingReconciliationResult =
  | { status: "applied"; reconciledOperationCount: number }
  | {
      status: "rejected";
      reason:
        | "invalid_revision"
        | "remote_revision_changed"
        | "document_changed"
        | "baseline_changed"
        | "authoritative_project_mismatch"
        | "track_snap_changed"
        | "local_revision_changed"
        | "operation_chain_changed"
        | "transient_edit_active"
        | "no_pending_operations";
    };

export type PendingCommandSnapshotCompactionResult =
  | { status: "applied"; replacedOperationCount: number }
  | {
      status: "rejected";
      reason: "invalid_boundary" | "no_pending_operations" | "transient_edit_active";
    };

type RemoteProjectReplacementFacts = {
  hasDocumentChanges: boolean;
  pendingOperationCount: number;
  hasTransientProject: boolean;
  syncStatus: ProjectSyncStatus;
};

// 远端替换资格是独立纯规则。完全 clean 的 error 会话允许由权威服务器状态自愈；
// 任何文档、操作或拖拽状态仍然存在时继续 fail closed，避免错误恢复覆盖本地草稿。
export function canReplaceProjectFromRemote({
  hasDocumentChanges,
  pendingOperationCount,
  hasTransientProject,
  syncStatus,
}: RemoteProjectReplacementFacts): boolean {
  return !hasDocumentChanges &&
    pendingOperationCount === 0 &&
    !hasTransientProject &&
    (syncStatus === "saved" || syncStatus === "error");
}

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_OPERATION_LOG_LIMIT = 500;

// 冲突恢复只能改写命令的 before/after，不能借机替换操作身份、顺序或审计摘要。
function isValidRebasedOperationChain(
  current: readonly ProjectDocumentOperation[],
  rebased: readonly ProjectDocumentOperation[],
): boolean {
  if (current.length !== rebased.length) return false;
  return current.every((operation, index) => {
    const next = rebased[index];
    const envelope = parseAnnotationCommandEnvelope(next?.commandEnvelope);
    return Boolean(
      next &&
      envelope &&
      operation.id === next.id &&
      operation.type === next.type &&
      operation.action === next.action &&
      operation.localRevision === next.localRevision &&
      operation.baseRevision === next.baseRevision &&
      operation.createdAt === next.createdAt &&
      operation.syncState === "pending" &&
      next.syncState === "pending" &&
      envelope.command.type === next.type &&
      operation.summary.hasProjectChange === next.summary.hasProjectChange &&
      operation.summary.hasTrackSnapChange === next.summary.hasTrackSnapChange &&
      JSON.stringify(operation.summary.changedTrackIds ?? []) ===
        JSON.stringify(next.summary.changedTrackIds ?? []),
    );
  });
}

function createOperationId() {
  return `op-${createRuntimeUuid()}`;
}

export function useProjectDocumentState({
  initialProject,
  initialTrackSnapEnabled,
  areProjectsEqual,
  areAuthoritativeProjectsEqual = areProjectsEqual,
  areTrackSnapStatesEqual,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  operationLogLimit = DEFAULT_OPERATION_LOG_LIMIT,
  readOnly = false,
  initialRecoveryState,
}: ProjectDocumentStateOptions) {
  // 恢复状态必须在首次 render 时一次性装入 state 与 refs，避免 effect 回填造成短暂的错误 clean 状态。
  const initialCurrentProject = initialRecoveryState?.currentProject ?? initialProject;
  const initialSavedProject = initialRecoveryState?.savedProject ?? initialProject;
  const initialCurrentTrackSnapEnabled = initialRecoveryState?.currentTrackSnapEnabled ?? initialTrackSnapEnabled;
  const initialSavedTrackSnapEnabled = initialRecoveryState?.savedTrackSnapEnabled ?? initialTrackSnapEnabled;
  const initialPendingOperations = initialRecoveryState?.pendingOperations ?? [];
  const initialLocalRevision = initialRecoveryState?.localRevision ?? 0;
  const initialSavedRevision = initialRecoveryState?.savedRevision ?? 0;
  const initialHasUnsavedChanges = !areProjectsEqual(initialSavedProject, initialCurrentProject) ||
    !areTrackSnapStatesEqual(initialSavedTrackSnapEnabled, initialCurrentTrackSnapEnabled) ||
    initialPendingOperations.length > 0;

  const [project, setProject] = useState<ProjectData>(initialCurrentProject);
  const [trackSnapEnabled, setTrackSnapEnabled] = useState(initialCurrentTrackSnapEnabled);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(initialHasUnsavedChanges);
  const [operationLog, setOperationLog] = useState<ProjectDocumentOperation[]>(initialPendingOperations);
  const [pendingOperations, setPendingOperations] = useState<ProjectDocumentOperation[]>(initialPendingOperations);
  const [syncState, setSyncState] = useState<ProjectSyncState>({
    status: initialHasUnsavedChanges
      ? typeof navigator !== "undefined" && navigator.onLine === false
        ? "offline"
        : "dirty"
      : "saved",
    localRevision: initialLocalRevision,
    savedRevision: initialSavedRevision,
    remoteRevision: null,
    pendingOperationCount: initialPendingOperations.length,
    lastChangedAt: initialRecoveryState?.lastChangedAt ?? null,
    lastSavedAt: initialRecoveryState?.lastSavedAt ?? null,
    lastSyncAttemptAt: null,
    errorMessage: null,
  });

  const projectRef = useRef(project);
  const trackSnapEnabledRef = useRef(trackSnapEnabled);
  const savedProjectRef = useRef(initialSavedProject);
  const savedTrackSnapEnabledRef = useRef(initialSavedTrackSnapEnabled);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);
  const transientProjectRef = useRef<ProjectData | null>(null);
  const localRevisionRef = useRef(initialLocalRevision);
  const savedRevisionRef = useRef(initialSavedRevision);
  const operationLogRef = useRef<ProjectDocumentOperation[]>(initialPendingOperations);
  const pendingOperationsRef = useRef<ProjectDocumentOperation[]>(initialPendingOperations);
  const syncStateRef = useRef(syncState);
  const areProjectsEqualRef = useRef(areProjectsEqual);
  const areAuthoritativeProjectsEqualRef = useRef(areAuthoritativeProjectsEqual);
  const areTrackSnapStatesEqualRef = useRef(areTrackSnapStatesEqual);
  const readOnlyRef = useRef(readOnly);

  areProjectsEqualRef.current = areProjectsEqual;
  areAuthoritativeProjectsEqualRef.current = areAuthoritativeProjectsEqual;
  areTrackSnapStatesEqualRef.current = areTrackSnapStatesEqual;
  readOnlyRef.current = readOnly;
  syncStateRef.current = syncState;

  const computeHasUnsavedChanges = useCallback((
    nextProject = projectRef.current,
    nextTrackSnapState = trackSnapEnabledRef.current,
  ) => (
    !areProjectsEqualRef.current(savedProjectRef.current, nextProject) ||
    !areTrackSnapStatesEqualRef.current(savedTrackSnapEnabledRef.current, nextTrackSnapState) ||
    // 一组正向/反向命令可能让正文暂时回到 saved 值，但未确认的服务器事实仍然必须保持 dirty。
    pendingOperationsRef.current.length > 0
  ), []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const updateOnlineStatus = () => {
      const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
      const isDirty = computeHasUnsavedChanges();
      setSyncState((current) => {
        const nextStatus: ProjectSyncStatus = !isDirty
          ? "saved"
          : isOffline
            ? "offline"
            : current.status === "offline"
              ? "dirty"
              : current.status;
        return {
          ...current,
          status: nextStatus,
          localRevision: localRevisionRef.current,
          savedRevision: savedRevisionRef.current,
          pendingOperationCount: pendingOperationsRef.current.length,
          lastSyncAttemptAt: isOffline ? Date.now() : current.lastSyncAttemptAt,
        };
      });
    };

    updateOnlineStatus();
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, [computeHasUnsavedChanges]);

  function applyUndoStackState(nextUndoStack: HistoryEntry[]) {
    undoStackRef.current = nextUndoStack;
    setUndoStack(nextUndoStack);
  }

  function applyRedoStackState(nextRedoStack: HistoryEntry[]) {
    redoStackRef.current = nextRedoStack;
    setRedoStack(nextRedoStack);
  }

  function syncDirtyState(
    nextProject = projectRef.current,
    nextTrackSnapState = trackSnapEnabledRef.current,
    changedAt: number | null = null,
  ) {
    const nextHasUnsavedChanges = computeHasUnsavedChanges(nextProject, nextTrackSnapState);
    setHasUnsavedChanges(nextHasUnsavedChanges);
    setSyncState((current) => {
      const status: ProjectSyncStatus = nextHasUnsavedChanges
        ? current.status === "saving" ||
          current.status === "offline" ||
          current.status === "conflict" ||
          current.status === "error"
          ? current.status
          : "dirty"
        : "saved";
      return {
        ...current,
        status,
        localRevision: localRevisionRef.current,
        savedRevision: savedRevisionRef.current,
        pendingOperationCount: pendingOperationsRef.current.length,
        lastChangedAt: changedAt ?? current.lastChangedAt,
        errorMessage: nextHasUnsavedChanges ? current.errorMessage : null,
      };
    });
  }

  function applyProjectState(nextProject: ProjectData) {
    projectRef.current = nextProject;
    setProject(nextProject);
    syncDirtyState(nextProject, trackSnapEnabledRef.current);
  }

  function recordOperation(
    operation: Omit<ProjectDocumentOperation, "id" | "createdAt" | "localRevision" | "syncState">,
  ) {
    const createdAt = Date.now();
    const nextRevision = localRevisionRef.current + 1;
    localRevisionRef.current = nextRevision;
    const nextOperation: ProjectDocumentOperation = {
      ...operation,
      id: createOperationId(),
      createdAt,
      localRevision: nextRevision,
      syncState: "pending",
    };
    operationLogRef.current = [...operationLogRef.current, nextOperation].slice(-operationLogLimit);
    pendingOperationsRef.current = [...pendingOperationsRef.current, nextOperation];
    setOperationLog(operationLogRef.current);
    setPendingOperations(pendingOperationsRef.current);
    syncDirtyState(projectRef.current, trackSnapEnabledRef.current, createdAt);
  }

  function commitProject(
    nextProject: ProjectData,
    baseProject = transientProjectRef.current ?? projectRef.current,
    options: CommitProjectOptions = {},
  ) {
    // 未提供领域命令的调用点仍生成 legacy project.commit；渐进迁移期间不能猜测操作语义。
    const action = options.action ?? "edit";
    if (readOnlyRef.current) {
      transientProjectRef.current = null;
      return;
    }
    if (areProjectsEqual(baseProject, nextProject)) {
      transientProjectRef.current = null;
      applyProjectState(nextProject);
      return;
    }
    applyUndoStackState([
      ...undoStackRef.current.slice(-(historyLimit - 1)),
      {
        project: baseProject,
        action,
        ...(options.commandEnvelope ? { commandEnvelope: options.commandEnvelope } : {}),
      },
    ]);
    applyRedoStackState([]);
    transientProjectRef.current = null;
    applyProjectState(nextProject);
    recordOperation({
      type: options.commandEnvelope?.command.type ?? "project.commit",
      action,
      baseRevision: localRevisionRef.current,
      ...(options.commandEnvelope ? { commandEnvelope: options.commandEnvelope } : {}),
      summary: {
        hasProjectChange: true,
        hasTrackSnapChange: false,
      },
    });
  }

  function applyProjectWithoutHistory(nextProject: ProjectData) {
    if (readOnlyRef.current) {
      return;
    }
    if (areProjectsEqual(projectRef.current, nextProject)) {
      return;
    }
    if (!transientProjectRef.current) {
      transientProjectRef.current = projectRef.current;
    }
    applyProjectState(nextProject);
  }

  // 时间轴预览必须以“正式提交”或“显式取消”结束。取消只恢复本次预览开始前的项目，
  // 不生成历史、operation 或 revision，避免未被命令表示的 ProjectData 混入后续协作保存。
  function cancelTransientProjectEdit(): boolean {
    const transientBaseProject = transientProjectRef.current;
    if (!transientBaseProject) return false;
    transientProjectRef.current = null;
    if (!areProjectsEqualRef.current(projectRef.current, transientBaseProject)) {
      applyProjectState(transientBaseProject);
    } else {
      syncDirtyState(transientBaseProject, trackSnapEnabledRef.current);
    }
    return true;
  }

  // 历史坏链只能在 App 已重新核对同 revision 权威服务器基线后压缩。
  // 单一 snapshot boundary 保留“发生过受控修复”的审计事实，避免逐条补交数百条已不可重放的旧命令。
  function compactPendingOperationsToSnapshotBoundary(
    value: unknown,
  ): PendingCommandSnapshotCompactionResult {
    const envelope = parseAnnotationCommandEnvelope(value);
    if (
      !envelope ||
      envelope.command.type !== PROJECT_SNAPSHOT_BOUNDARY_COMMAND ||
      envelope.command.kind !== "collaboration_chain_repair"
    ) {
      return { status: "rejected", reason: "invalid_boundary" };
    }
    if (transientProjectRef.current !== null) {
      return { status: "rejected", reason: "transient_edit_active" };
    }
    if (pendingOperationsRef.current.length === 0) {
      return { status: "rejected", reason: "no_pending_operations" };
    }

    const replacedOperationIds = new Set(pendingOperationsRef.current.map((operation) => operation.id));
    const replacement: ProjectDocumentOperation = {
      id: createOperationId(),
      type: envelope.command.type,
      action: "edit",
      baseRevision: savedRevisionRef.current,
      // 压缩不制造新的用户编辑；沿用当前最新 local revision，使保存确认后基线一次追到现状。
      localRevision: localRevisionRef.current,
      createdAt: Date.now(),
      syncState: "pending",
      commandEnvelope: envelope,
      summary: { hasProjectChange: true, hasTrackSnapChange: false },
    };
    const replacedOperationCount = pendingOperationsRef.current.length;
    pendingOperationsRef.current = [replacement];
    operationLogRef.current = [
      ...operationLogRef.current.filter((operation) => !replacedOperationIds.has(operation.id)),
      replacement,
    ].slice(-operationLogLimit);
    setPendingOperations(pendingOperationsRef.current);
    setOperationLog(operationLogRef.current);
    syncDirtyState(projectRef.current, trackSnapEnabledRef.current);
    return { status: "applied", replacedOperationCount };
  }

  function applyTrackSnapEnabledState(
    nextTrackSnapState: Record<string, boolean>,
    options: TrackSnapUpdateOptions = {},
  ) {
    if (readOnlyRef.current) {
      return;
    }
    if (areTrackSnapStatesEqual(trackSnapEnabledRef.current, nextTrackSnapState)) {
      return;
    }
    const previousTrackSnapState = trackSnapEnabledRef.current;
    trackSnapEnabledRef.current = nextTrackSnapState;
    setTrackSnapEnabled(nextTrackSnapState);
    if (options.recordOperation !== false) {
      // 吸附操作在产生时计算变化轨道；恢复后无需保留两份完整开关对象也能提交相同审计摘要。
      const trackIds = new Set([
        ...Object.keys(previousTrackSnapState),
        ...Object.keys(nextTrackSnapState),
      ]);
      recordOperation({
        type: "track-snap.update",
        action: "track-snap",
        baseRevision: localRevisionRef.current,
        summary: {
          hasProjectChange: false,
          hasTrackSnapChange: true,
          changedTrackIds: Array.from(trackIds).filter(
            (trackId) => previousTrackSnapState[trackId] !== nextTrackSnapState[trackId],
          ),
        },
      });
      return;
    }
    syncDirtyState(projectRef.current, nextTrackSnapState);
  }

  function markOperationsAsSubmitted(operationIds: string[]) {
    if (!operationIds.length) {
      return;
    }
    const operationIdSet = new Set(operationIds);
    const markSubmitted = (operation: ProjectDocumentOperation): ProjectDocumentOperation =>
      operationIdSet.has(operation.id) && operation.syncState === "pending"
        ? { ...operation, syncState: "submitted" }
        : operation;
    operationLogRef.current = operationLogRef.current.map(markSubmitted);
    pendingOperationsRef.current = pendingOperationsRef.current.map(markSubmitted);
    setOperationLog(operationLogRef.current);
    setPendingOperations(pendingOperationsRef.current);
    syncDirtyState(projectRef.current, trackSnapEnabledRef.current);
  }

  function markProjectAsSaved(
    projectToSave = projectRef.current,
    trackSnapState = trackSnapEnabledRef.current,
    options: MarkProjectSavedOptions = {},
  ) {
    const savedAt = Date.now();
    const acknowledgedOperationIdSet = options.acknowledgedOperationIds
      ? new Set(options.acknowledgedOperationIds)
      : null;
    const shouldAcknowledge = (operation: ProjectDocumentOperation) =>
      !acknowledgedOperationIdSet || acknowledgedOperationIdSet.has(operation.id);
    savedProjectRef.current = projectToSave;
    savedTrackSnapEnabledRef.current = trackSnapState;
    savedRevisionRef.current = options.savedLocalRevision ?? localRevisionRef.current;
    pendingOperationsRef.current = pendingOperationsRef.current.filter((operation) => !shouldAcknowledge(operation));
    operationLogRef.current = operationLogRef.current.map((operation) =>
      shouldAcknowledge(operation) && operation.syncState !== "acknowledged"
        ? { ...operation, syncState: "acknowledged" }
        : operation,
    );
    setOperationLog(operationLogRef.current);
    setPendingOperations(pendingOperationsRef.current);
    const nextHasUnsavedChanges = computeHasUnsavedChanges(projectRef.current, trackSnapEnabledRef.current);
    setHasUnsavedChanges(nextHasUnsavedChanges);
    // 服务器保存可能跨过多个 await。若保存期间用户继续编辑，新 operation 不应被误清空；
    // 此时 savedProjectRef 指向已保存的快照，当前 projectRef 仍然更“新”，状态应回到 dirty。
    setSyncState((current) => ({
      ...current,
      status: nextHasUnsavedChanges ? "dirty" : "saved",
      localRevision: localRevisionRef.current,
      savedRevision: savedRevisionRef.current,
      pendingOperationCount: pendingOperationsRef.current.length,
      lastSavedAt: savedAt,
      errorMessage: null,
    }));
  }

  // 原子确认只推进已提交前缀的基线；当前项目、后续 pending 和 undo/redo 必须原样保留。
  function acknowledgeAtomicCommandBatch(
    acknowledgement: AtomicCommandAcknowledgement,
  ): AtomicCommandAcknowledgementResult {
    if (acknowledgement.operationIds.length === 0) {
      return { status: "rejected", reason: "empty_batch" };
    }
    if (acknowledgement.committedRevision !== acknowledgement.serverBaseRevision + 1) {
      return { status: "rejected", reason: "invalid_revision" };
    }
    const documentRemoteRevision = syncStateRef.current.remoteRevision;
    if (documentRemoteRevision !== null && documentRemoteRevision !== acknowledgement.serverBaseRevision) {
      // 已经应用到更高 revision 时，这一定是迟到响应，不能回退文档基线。
      if (documentRemoteRevision > acknowledgement.serverBaseRevision) {
        return { status: "rejected", reason: "stale_remote_revision" };
      }
      // 旧页面可能只推进了 ProjectData、漏推进 revision 元数据。只有 saved 项目与冻结的服务器基线完全
      // 一致时才允许补齐该元数据；否则客户端可能真的漏了远端内容，必须继续 fail closed。
      if (!areProjectsEqualRef.current(
        savedProjectRef.current,
        acknowledgement.expectedServerBaseProject,
      )) {
        return { status: "rejected", reason: "stale_remote_revision" };
      }
    }
    if (savedRevisionRef.current !== acknowledgement.expectedSavedLocalRevision) {
      return { status: "rejected", reason: "stale_saved_revision" };
    }

    const prefix = pendingOperationsRef.current.slice(0, acknowledgement.operationIds.length);
    if (
      prefix.length !== acknowledgement.operationIds.length ||
      prefix.some((operation, index) =>
        operation.id !== acknowledgement.operationIds[index] || operation.syncState !== "pending")
    ) {
      return { status: "rejected", reason: "operation_prefix_mismatch" };
    }
    const finalOperation = prefix[prefix.length - 1];
    if (finalOperation.localRevision !== acknowledgement.acknowledgedLocalRevision) {
      return { status: "rejected", reason: "operation_revision_mismatch" };
    }

    const acknowledgedIds = new Set(acknowledgement.operationIds);
    const savedAt = Date.now();
    savedProjectRef.current = acknowledgement.acknowledgedProject;
    savedTrackSnapEnabledRef.current = acknowledgement.acknowledgedTrackSnapEnabled;
    savedRevisionRef.current = acknowledgement.acknowledgedLocalRevision;
    pendingOperationsRef.current = pendingOperationsRef.current.slice(prefix.length);
    operationLogRef.current = operationLogRef.current.map((operation) =>
      acknowledgedIds.has(operation.id)
        ? { ...operation, syncState: "acknowledged" }
        : operation,
    );
    setOperationLog(operationLogRef.current);
    setPendingOperations(pendingOperationsRef.current);

    const projectMatchesSaved = areProjectsEqualRef.current(
      savedProjectRef.current,
      projectRef.current,
    );
    const trackSnapMatchesSaved = areTrackSnapStatesEqualRef.current(
      savedTrackSnapEnabledRef.current,
      trackSnapEnabledRef.current,
    );
    const remainsDirty = !projectMatchesSaved ||
      !trackSnapMatchesSaved ||
      pendingOperationsRef.current.length > 0;
    if (remainsDirty && pendingOperationsRef.current.length === 0) {
      // 原子确认后若没有 pending 仍为 dirty，说明某个本地基线漂移；只记录布尔事实，不泄露项目内容。
      console.warn(
        `原子确认后仍存在未表示差异：project=${projectMatchesSaved}, trackSnap=${trackSnapMatchesSaved}`,
      );
    }
    setHasUnsavedChanges(remainsDirty);
    const nextSyncState: ProjectSyncState = {
      ...syncStateRef.current,
      status: remainsDirty ? "dirty" : "saved",
      localRevision: localRevisionRef.current,
      savedRevision: savedRevisionRef.current,
      remoteRevision: acknowledgement.committedRevision,
      pendingOperationCount: pendingOperationsRef.current.length,
      lastSavedAt: savedAt,
      errorMessage: null,
    };
    syncStateRef.current = nextSyncState;
    setSyncState(nextSyncState);
    return {
      status: "applied",
      remainingOperationCount: pendingOperationsRef.current.length,
      remoteRevision: acknowledgement.committedRevision,
      savedLocalRevision: savedRevisionRef.current,
      remainsDirty,
    };
  }

  // 远端追赶只能替换完全 clean 的基线；项目和服务器 revision 必须在同一状态边界内推进。
  // 如果只更新 App 外层 revision，下一次服务器虽然提交成功，本地确认器仍会拿旧 revision 误判成功响应。
  function replaceCleanProjectFromRemote(
    nextProject: ProjectData,
    remoteRevision: number,
  ): boolean {
    if (!Number.isSafeInteger(remoteRevision) || remoteRevision < 0) return false;
    const currentStatus = syncStateRef.current.status;
    const currentRemoteRevision = syncStateRef.current.remoteRevision;
    if (currentRemoteRevision !== null && remoteRevision < currentRemoteRevision) return false;
    const canReplace = canReplaceProjectFromRemote({
      hasDocumentChanges: computeHasUnsavedChanges(),
      pendingOperationCount: pendingOperationsRef.current.length,
      hasTransientProject: transientProjectRef.current !== null,
      syncStatus: currentStatus,
    });
    if (!canReplace) return false;

    projectRef.current = nextProject;
    savedProjectRef.current = nextProject;
    setProject(nextProject);
    applyUndoStackState([]);
    applyRedoStackState([]);
    setHasUnsavedChanges(false);
    const nextSyncState: ProjectSyncState = {
      ...syncStateRef.current,
      status: "saved",
      remoteRevision,
      pendingOperationCount: 0,
      errorMessage: null,
    };
    // ref 先推进，保证远端追赶结束后立即发生的本地编辑/保存也读取到新基线。
    syncStateRef.current = nextSyncState;
    setSyncState(nextSyncState);
    return true;
  }

  // 并发协调只替换服务器基线、当前项目和已验证 envelope，保留原 operation id/local revision。
  // 请求发出后的任何新编辑、基线推进或临时拖拽都会使门禁失败，避免用迟到结果覆盖本地状态。
  function rebasePendingProjectFromRemote(
    request: PendingCommandRebaseRequest,
  ): PendingCommandRebaseResult {
    if (!Number.isSafeInteger(request.remoteRevision) || request.remoteRevision < 0) {
      return { status: "rejected", reason: "invalid_revision" };
    }
    if (transientProjectRef.current !== null) {
      return { status: "rejected", reason: "transient_edit_active" };
    }
    if (pendingOperationsRef.current.length === 0) {
      return { status: "rejected", reason: "no_pending_operations" };
    }
    if (!areProjectsEqualRef.current(projectRef.current, request.expectedCurrentProject)) {
      return { status: "rejected", reason: "document_changed" };
    }
    if (!areProjectsEqualRef.current(savedProjectRef.current, request.expectedSavedProject)) {
      return { status: "rejected", reason: "baseline_changed" };
    }
    if (
      localRevisionRef.current !== request.expectedLocalRevision ||
      savedRevisionRef.current !== request.expectedSavedRevision
    ) {
      return { status: "rejected", reason: "local_revision_changed" };
    }
    if (!isValidRebasedOperationChain(
      pendingOperationsRef.current,
      request.rebasedPendingOperations,
    )) {
      return { status: "rejected", reason: "operation_chain_changed" };
    }

    // 409 已证明旧 envelope 没有落库；此时可安全保留 operation id，并仅替换经过协调的新命令。
    const replacements = new Map(request.rebasedPendingOperations.map((operation) => [operation.id, operation]));
    pendingOperationsRef.current = request.rebasedPendingOperations;
    operationLogRef.current = operationLogRef.current.map((operation) =>
      replacements.get(operation.id) ?? operation,
    );
    setPendingOperations(pendingOperationsRef.current);
    setOperationLog(operationLogRef.current);
    projectRef.current = request.rebasedCurrentProject;
    savedProjectRef.current = request.latestServerProject;
    setProject(request.rebasedCurrentProject);
    // 旧 history 快照基于远端旧版本；保留它会让 undo 把已经追入的他人修改一起撤销。
    applyUndoStackState([]);
    applyRedoStackState([]);
    setHasUnsavedChanges(true);
    const nextSyncState: ProjectSyncState = {
      ...syncStateRef.current,
      status: "dirty",
      remoteRevision: request.remoteRevision,
      pendingOperationCount: pendingOperationsRef.current.length,
      errorMessage: null,
    };
    syncStateRef.current = nextSyncState;
    setSyncState(nextSyncState);
    return { status: "applied" };
  }

  // 服务端可能已经由更早的成功请求达到当前完整本地结果，此时旧 pending 的 before 前提会被严格拒绝。
  // 这里不放宽命令校验，只在重新读取的权威正文与完整当前正文完全一致时原子清理冗余本地命令。
  function reconcileAlreadySatisfiedPendingFromRemote(
    request: AlreadySatisfiedPendingReconciliationRequest,
  ): AlreadySatisfiedPendingReconciliationResult {
    if (!Number.isSafeInteger(request.remoteRevision) || request.remoteRevision < 0) {
      return { status: "rejected", reason: "invalid_revision" };
    }
    if (request.remoteRevision !== request.expectedRemoteRevision) {
      return { status: "rejected", reason: "remote_revision_changed" };
    }
    if (transientProjectRef.current !== null) {
      return { status: "rejected", reason: "transient_edit_active" };
    }
    const expected = request.expectedRecoveryState;
    if (pendingOperationsRef.current.length === 0) {
      return { status: "rejected", reason: "no_pending_operations" };
    }
    if (!areProjectsEqualRef.current(projectRef.current, expected.currentProject)) {
      return { status: "rejected", reason: "document_changed" };
    }
    if (!areProjectsEqualRef.current(savedProjectRef.current, expected.savedProject)) {
      return { status: "rejected", reason: "baseline_changed" };
    }
    if (!areAuthoritativeProjectsEqualRef.current(projectRef.current, request.latestServerProject)) {
      return { status: "rejected", reason: "authoritative_project_mismatch" };
    }
    if (
      !areTrackSnapStatesEqualRef.current(
        trackSnapEnabledRef.current,
        expected.currentTrackSnapEnabled,
      ) ||
      !areTrackSnapStatesEqualRef.current(
        savedTrackSnapEnabledRef.current,
        expected.savedTrackSnapEnabled,
      ) ||
      !areTrackSnapStatesEqualRef.current(
        trackSnapEnabledRef.current,
        savedTrackSnapEnabledRef.current,
      )
    ) {
      // 吸附开关不是服务器 ProjectData；存在本地差异时不能借正文等价把它一并当作已保存。
      return { status: "rejected", reason: "track_snap_changed" };
    }
    if (
      localRevisionRef.current !== expected.localRevision ||
      savedRevisionRef.current !== expected.savedRevision
    ) {
      return { status: "rejected", reason: "local_revision_changed" };
    }
    const operationChainUnchanged = pendingOperationsRef.current.length === expected.pendingOperations.length &&
      pendingOperationsRef.current.every((operation, index) => operation === expected.pendingOperations[index]);
    if (!operationChainUnchanged) {
      // operation 对象在状态转换时始终不可变替换；引用身份能同时捕捉新增编辑和 submitted 状态变化。
      return { status: "rejected", reason: "operation_chain_changed" };
    }

    const reconciledOperationIds = new Set(pendingOperationsRef.current.map((operation) => operation.id));
    const reconciledOperationCount = reconciledOperationIds.size;
    pendingOperationsRef.current = [];
    // 这些命令没有成为服务端 operation 事实，不能伪装为 acknowledged；从本地运行日志中移除更准确。
    operationLogRef.current = operationLogRef.current.filter(
      (operation) => !reconciledOperationIds.has(operation.id),
    );
    setPendingOperations(pendingOperationsRef.current);
    setOperationLog(operationLogRef.current);

    projectRef.current = request.latestServerProject;
    savedProjectRef.current = request.latestServerProject;
    savedTrackSnapEnabledRef.current = trackSnapEnabledRef.current;
    savedRevisionRef.current = localRevisionRef.current;
    setProject(request.latestServerProject);
    applyUndoStackState([]);
    applyRedoStackState([]);
    setHasUnsavedChanges(false);
    const nextSyncState: ProjectSyncState = {
      ...syncStateRef.current,
      status: "saved",
      localRevision: localRevisionRef.current,
      savedRevision: savedRevisionRef.current,
      remoteRevision: request.remoteRevision,
      pendingOperationCount: 0,
      lastSavedAt: Date.now(),
      errorMessage: null,
    };
    syncStateRef.current = nextSyncState;
    setSyncState(nextSyncState);
    return { status: "applied", reconciledOperationCount };
  }

  function undoProject(shouldUndo?: (entry: HistoryEntry) => boolean) {
    if (readOnlyRef.current) {
      return false;
    }
    if (cancelTransientProjectEdit()) return true;
    const currentUndoStack = undoStackRef.current;
    const previousEntry = currentUndoStack[currentUndoStack.length - 1];
    if (!previousEntry) {
      return false;
    }
    if (shouldUndo && !shouldUndo(previousEntry)) {
      return false;
    }
    const currentProject = projectRef.current;
    applyRedoStackState([...redoStackRef.current, {
      project: currentProject,
      action: previousEntry.action,
      ...(previousEntry.commandEnvelope ? { commandEnvelope: previousEntry.commandEnvelope } : {}),
    }]);
    applyUndoStackState(currentUndoStack.slice(0, -1));
    applyProjectState(previousEntry.project);
    const inverseEnvelope = previousEntry.commandEnvelope
      ? invertAnnotationCommandEnvelope(previousEntry.commandEnvelope)
      : null;
    recordOperation({
      type: inverseEnvelope?.command.type ?? "project.undo",
      action: previousEntry.action,
      baseRevision: localRevisionRef.current,
      ...(inverseEnvelope ? { commandEnvelope: inverseEnvelope } : {}),
      summary: {
        hasProjectChange: true,
        hasTrackSnapChange: false,
      },
    });
    return true;
  }

  function redoProject() {
    if (readOnlyRef.current) {
      return false;
    }
    const currentRedoStack = redoStackRef.current;
    const nextEntry = currentRedoStack[currentRedoStack.length - 1];
    if (!nextEntry) {
      return false;
    }
    const currentProject = projectRef.current;
    applyUndoStackState([...undoStackRef.current, {
      project: currentProject,
      action: nextEntry.action,
      ...(nextEntry.commandEnvelope ? { commandEnvelope: nextEntry.commandEnvelope } : {}),
    }]);
    applyRedoStackState(currentRedoStack.slice(0, -1));
    applyProjectState(nextEntry.project);
    recordOperation({
      type: nextEntry.commandEnvelope?.command.type ?? "project.redo",
      action: nextEntry.action,
      baseRevision: localRevisionRef.current,
      ...(nextEntry.commandEnvelope ? { commandEnvelope: nextEntry.commandEnvelope } : {}),
      summary: {
        hasProjectChange: true,
        hasTrackSnapChange: false,
      },
    });
    return true;
  }

  function setSyncStatus(
    status: ProjectSyncStatus,
    updates: Partial<Omit<ProjectSyncState, "status">> = {},
  ) {
    const nextSyncState: ProjectSyncState = {
      ...syncStateRef.current,
      ...updates,
      status,
      lastSyncAttemptAt:
        status === "saving" || status === "error" || status === "offline"
          ? Date.now()
          : syncStateRef.current.lastSyncAttemptAt,
    };
    syncStateRef.current = nextSyncState;
    setSyncState(nextSyncState);
  }

  // IndexedDB 层只通过这一条快照接口读取 document 状态，避免 App 直接拼接内部 refs 与 revision。
  function getRecoveryState(): ProjectDocumentRecoveryState {
    return {
      currentProject: projectRef.current,
      savedProject: savedProjectRef.current,
      currentTrackSnapEnabled: trackSnapEnabledRef.current,
      savedTrackSnapEnabled: savedTrackSnapEnabledRef.current,
      pendingOperations: pendingOperationsRef.current,
      localRevision: localRevisionRef.current,
      savedRevision: savedRevisionRef.current,
      lastChangedAt: syncState.lastChangedAt,
      lastSavedAt: syncState.lastSavedAt,
    };
  }

  return {
    project,
    projectRef,
    trackSnapEnabled,
    trackSnapEnabledRef,
    undoStack,
    redoStack,
    hasUnsavedChanges,
    operationLog,
    pendingOperations,
    pendingOperationsRef,
    syncState,
    transientProjectRef,
    applyProjectState,
    applyProjectWithoutHistory,
    cancelTransientProjectEdit,
    compactPendingOperationsToSnapshotBoundary,
    commitProject,
    applyTrackSnapEnabledState,
    markOperationsAsSubmitted,
    markProjectAsSaved,
    acknowledgeAtomicCommandBatch,
    replaceCleanProjectFromRemote,
    rebasePendingProjectFromRemote,
    reconcileAlreadySatisfiedPendingFromRemote,
    undoProject,
    redoProject,
    setSyncStatus,
    getRecoveryState,
  };
}
