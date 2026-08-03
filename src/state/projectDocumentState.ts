import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnnotationCommandEnvelope,
  AnnotationDomainCommand,
  LegacyAnnotationOperationAction,
} from "@xiqu/shared";
import type { ProjectData } from "../types";

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

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_OPERATION_LOG_LIMIT = 500;

function createOperationId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `op-${crypto.randomUUID()}`;
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useProjectDocumentState({
  initialProject,
  initialTrackSnapEnabled,
  areProjectsEqual,
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
    !areTrackSnapStatesEqual(initialSavedTrackSnapEnabled, initialCurrentTrackSnapEnabled);

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
  const areProjectsEqualRef = useRef(areProjectsEqual);
  const areTrackSnapStatesEqualRef = useRef(areTrackSnapStatesEqual);
  const readOnlyRef = useRef(readOnly);

  areProjectsEqualRef.current = areProjectsEqual;
  areTrackSnapStatesEqualRef.current = areTrackSnapStatesEqual;
  readOnlyRef.current = readOnly;

  const computeHasUnsavedChanges = useCallback((
    nextProject = projectRef.current,
    nextTrackSnapState = trackSnapEnabledRef.current,
  ) => (
    !areProjectsEqualRef.current(savedProjectRef.current, nextProject) ||
    !areTrackSnapStatesEqualRef.current(savedTrackSnapEnabledRef.current, nextTrackSnapState)
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
      { project: baseProject, action },
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

  function undoProject(shouldUndo?: (entry: HistoryEntry) => boolean) {
    if (readOnlyRef.current) {
      return false;
    }
    if (transientProjectRef.current) {
      const transientProject = transientProjectRef.current;
      transientProjectRef.current = null;
      if (!areProjectsEqual(projectRef.current, transientProject)) {
        applyProjectState(transientProject);
      }
      return true;
    }
    const currentUndoStack = undoStackRef.current;
    const previousEntry = currentUndoStack[currentUndoStack.length - 1];
    if (!previousEntry) {
      return false;
    }
    if (shouldUndo && !shouldUndo(previousEntry)) {
      return false;
    }
    const currentProject = projectRef.current;
    applyRedoStackState([...redoStackRef.current, { project: currentProject, action: previousEntry.action }]);
    applyUndoStackState(currentUndoStack.slice(0, -1));
    applyProjectState(previousEntry.project);
    recordOperation({
      type: "project.undo",
      action: previousEntry.action,
      baseRevision: localRevisionRef.current,
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
    applyUndoStackState([...undoStackRef.current, { project: currentProject, action: nextEntry.action }]);
    applyRedoStackState(currentRedoStack.slice(0, -1));
    applyProjectState(nextEntry.project);
    recordOperation({
      type: "project.redo",
      action: nextEntry.action,
      baseRevision: localRevisionRef.current,
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
    setSyncState((current) => ({
      ...current,
      ...updates,
      status,
      lastSyncAttemptAt:
        status === "saving" || status === "error" || status === "offline"
          ? Date.now()
          : current.lastSyncAttemptAt,
    }));
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
    commitProject,
    applyTrackSnapEnabledState,
    markOperationsAsSubmitted,
    markProjectAsSaved,
    undoProject,
    redoProject,
    setSyncStatus,
    getRecoveryState,
  };
}
