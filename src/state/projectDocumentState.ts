import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectData } from "../types";

export type HistoryAction =
  | "edit"
  | "import-video"
  | "import-srt"
  | "import-project"
  | "merge-project";

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
  | "project.commit"
  | "project.undo"
  | "project.redo"
  | "track-snap.update";

export type ProjectDocumentOperation = {
  id: string;
  type: ProjectDocumentOperationType;
  action: HistoryAction | "track-snap";
  localRevision: number;
  baseRevision: number;
  createdAt: number;
  syncState: "pending" | "acknowledged";
  beforeProject?: ProjectData;
  afterProject?: ProjectData;
  beforeTrackSnapEnabled?: Record<string, boolean>;
  afterTrackSnapEnabled?: Record<string, boolean>;
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
};

type TrackSnapUpdateOptions = {
  recordOperation?: boolean;
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
}: ProjectDocumentStateOptions) {
  const [project, setProject] = useState<ProjectData>(initialProject);
  const [trackSnapEnabled, setTrackSnapEnabled] = useState(initialTrackSnapEnabled);
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [operationLog, setOperationLog] = useState<ProjectDocumentOperation[]>([]);
  const [pendingOperations, setPendingOperations] = useState<ProjectDocumentOperation[]>([]);
  const [syncState, setSyncState] = useState<ProjectSyncState>({
    status: "saved",
    localRevision: 0,
    savedRevision: 0,
    remoteRevision: null,
    pendingOperationCount: 0,
    lastChangedAt: null,
    lastSavedAt: null,
    lastSyncAttemptAt: null,
    errorMessage: null,
  });

  const projectRef = useRef(project);
  const trackSnapEnabledRef = useRef(trackSnapEnabled);
  const savedProjectRef = useRef(initialProject);
  const savedTrackSnapEnabledRef = useRef(initialTrackSnapEnabled);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);
  const transientProjectRef = useRef<ProjectData | null>(null);
  const localRevisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const operationLogRef = useRef<ProjectDocumentOperation[]>([]);
  const pendingOperationsRef = useRef<ProjectDocumentOperation[]>([]);
  const areProjectsEqualRef = useRef(areProjectsEqual);
  const areTrackSnapStatesEqualRef = useRef(areTrackSnapStatesEqual);

  areProjectsEqualRef.current = areProjectsEqual;
  areTrackSnapStatesEqualRef.current = areTrackSnapStatesEqual;

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
    action: HistoryAction = "edit",
  ) {
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
      type: "project.commit",
      action,
      baseRevision: localRevisionRef.current,
      beforeProject: baseProject,
      afterProject: nextProject,
    });
  }

  function applyProjectWithoutHistory(nextProject: ProjectData) {
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
    if (areTrackSnapStatesEqual(trackSnapEnabledRef.current, nextTrackSnapState)) {
      return;
    }
    const previousTrackSnapState = trackSnapEnabledRef.current;
    trackSnapEnabledRef.current = nextTrackSnapState;
    setTrackSnapEnabled(nextTrackSnapState);
    if (options.recordOperation !== false) {
      recordOperation({
        type: "track-snap.update",
        action: "track-snap",
        baseRevision: localRevisionRef.current,
        beforeTrackSnapEnabled: previousTrackSnapState,
        afterTrackSnapEnabled: nextTrackSnapState,
      });
      return;
    }
    syncDirtyState(projectRef.current, nextTrackSnapState);
  }

  function markProjectAsSaved(
    projectToSave = projectRef.current,
    trackSnapState = trackSnapEnabledRef.current,
  ) {
    const savedAt = Date.now();
    savedProjectRef.current = projectToSave;
    savedTrackSnapEnabledRef.current = trackSnapState;
    savedRevisionRef.current = localRevisionRef.current;
    pendingOperationsRef.current = [];
    operationLogRef.current = operationLogRef.current.map((operation) =>
      operation.syncState === "pending"
        ? { ...operation, syncState: "acknowledged" }
        : operation,
    );
    setOperationLog(operationLogRef.current);
    setPendingOperations([]);
    setHasUnsavedChanges(false);
    setSyncState((current) => ({
      ...current,
      status: "saved",
      localRevision: localRevisionRef.current,
      savedRevision: savedRevisionRef.current,
      pendingOperationCount: 0,
      lastSavedAt: savedAt,
      errorMessage: null,
    }));
  }

  function undoProject(shouldUndo?: (entry: HistoryEntry) => boolean) {
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
      beforeProject: currentProject,
      afterProject: previousEntry.project,
    });
    return true;
  }

  function redoProject() {
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
      beforeProject: currentProject,
      afterProject: nextEntry.project,
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
    syncState,
    transientProjectRef,
    applyProjectState,
    applyProjectWithoutHistory,
    commitProject,
    applyTrackSnapEnabledState,
    markProjectAsSaved,
    undoProject,
    redoProject,
    setSyncStatus,
  };
}
