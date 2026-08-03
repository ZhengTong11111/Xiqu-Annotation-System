import type {
  HistoryAction,
  ProjectDocumentOperation,
  ProjectDocumentOperationType,
  ProjectDocumentRecoveryState,
} from "../state/projectDocumentState";
import type { ProjectData } from "../types";
import {
  getPersistableProjectData,
  isRecognizableProjectPayload,
  normalizeImportedProjectFile,
} from "../utils/projectFile";
import { prepareProjectForServer } from "./platformProjectPayload";

export const PLATFORM_DRAFT_SCHEMA_VERSION = 1;

// IndexedDB 中每个账号/文件只保存一份 envelope；项目正文与 operation 摘要采用不同层次，避免成倍膨胀。
export type PlatformDraftRecord = {
  key: string;
  schemaVersion: typeof PLATFORM_DRAFT_SCHEMA_VERSION;
  userId: string;
  annotationFileId: string;
  remoteBaseRevision: number;
  currentProject: ProjectData;
  savedProject: ProjectData;
  currentTrackSnapEnabled: Record<string, boolean>;
  savedTrackSnapEnabled: Record<string, boolean>;
  pendingOperations: ProjectDocumentOperation[];
  localRevision: number;
  savedRevision: number;
  lastChangedAt: number | null;
  lastSavedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PlatformDraftCompatibility =
  | { status: "recoverable"; draft: PlatformDraftRecord }
  | { status: "revision-conflict"; draft: PlatformDraftRecord };

const OPERATION_TYPES = new Set<ProjectDocumentOperationType>([
  "project.commit",
  "project.undo",
  "project.redo",
  "track-snap.update",
]);
const HISTORY_ACTIONS = new Set<ProjectDocumentOperation["action"]>([
  "edit",
  "import-video",
  "import-srt",
  "import-project",
  "merge-project",
  "repair-sentence-character-track",
  "track-snap",
]);
const CLIENT_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// 草稿主键使用转义后的稳定身份，不依赖账号名称、文件名称或可轮换的访问 token。
export function getPlatformDraftKey(userId: string, annotationFileId: string) {
  return `${encodeURIComponent(userId)}::${encodeURIComponent(annotationFileId)}`;
}

// document state 转换为可结构化克隆的安全草稿；现有创建时间由仓库回填，更新时不会伪造新草稿。
export function buildPlatformDraftRecord(input: {
  userId: string;
  annotationFileId: string;
  remoteBaseRevision: number;
  recoveryState: ProjectDocumentRecoveryState;
  now?: number;
  createdAt?: number;
}): PlatformDraftRecord {
  const now = input.now ?? Date.now();
  const sanitizeProject = (project: ProjectData) => prepareProjectForServer(
    getPersistableProjectData(project),
  );
  return {
    key: getPlatformDraftKey(input.userId, input.annotationFileId),
    schemaVersion: PLATFORM_DRAFT_SCHEMA_VERSION,
    userId: input.userId,
    annotationFileId: input.annotationFileId,
    remoteBaseRevision: input.remoteBaseRevision,
    currentProject: sanitizeProject(input.recoveryState.currentProject),
    savedProject: sanitizeProject(input.recoveryState.savedProject),
    currentTrackSnapEnabled: { ...input.recoveryState.currentTrackSnapEnabled },
    savedTrackSnapEnabled: { ...input.recoveryState.savedTrackSnapEnabled },
    pendingOperations: input.recoveryState.pendingOperations.map(cloneOperation),
    localRevision: input.recoveryState.localRevision,
    savedRevision: input.recoveryState.savedRevision,
    lastChangedAt: input.recoveryState.lastChangedAt,
    lastSavedAt: input.recoveryState.lastSavedAt,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

// IndexedDB 返回值属于 unknown 边界；这里同时验证身份、数值和 operation，再复用项目唯一迁移入口。
export function normalizePlatformDraftRecord(
  value: unknown,
  expected: { userId: string; annotationFileId: string },
): PlatformDraftRecord | null {
  if (!isRecord(value) || value.schemaVersion !== PLATFORM_DRAFT_SCHEMA_VERSION) return null;
  if (value.userId !== expected.userId || value.annotationFileId !== expected.annotationFileId) return null;
  if (value.key !== getPlatformDraftKey(expected.userId, expected.annotationFileId)) return null;
  if (!isPositiveInteger(value.remoteBaseRevision) ||
    !isNonNegativeInteger(value.localRevision) ||
    !isNonNegativeInteger(value.savedRevision) ||
    value.savedRevision > value.localRevision) return null;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) return null;
  if (!isNullableTimestamp(value.lastChangedAt) || !isNullableTimestamp(value.lastSavedAt)) return null;
  if (!isTrackSnapState(value.currentTrackSnapEnabled) || !isTrackSnapState(value.savedTrackSnapEnabled)) return null;
  if (!Array.isArray(value.pendingOperations)) return null;
  const localRevision = value.localRevision as number;
  const savedRevision = value.savedRevision as number;
  const pendingOperations = value.pendingOperations.map(normalizeOperation);
  if (pendingOperations.some((operation) => operation === null)) return null;
  const typedOperations = pendingOperations as ProjectDocumentOperation[];
  const operationIds = new Set(typedOperations.map((operation) => operation.id));
  if (operationIds.size !== typedOperations.length || typedOperations.some(
    (operation) => operation.localRevision <= savedRevision || operation.localRevision > localRevision,
  )) return null;
  if (!isRecognizableProjectPayload(value.currentProject) || !isRecognizableProjectPayload(value.savedProject)) {
    return null;
  }

  // 项目正文使用同一个导入迁移器，旧草稿格式升级不会另造一套 ProjectData 兼容规则。
  const currentProject = normalizeImportedProjectFile(value.currentProject).project;
  const savedProject = normalizeImportedProjectFile(value.savedProject).project;
  return {
    key: value.key,
    schemaVersion: PLATFORM_DRAFT_SCHEMA_VERSION,
    userId: expected.userId,
    annotationFileId: expected.annotationFileId,
    remoteBaseRevision: value.remoteBaseRevision,
    currentProject,
    savedProject,
    currentTrackSnapEnabled: { ...value.currentTrackSnapEnabled },
    savedTrackSnapEnabled: { ...value.savedTrackSnapEnabled },
    pendingOperations: typedOperations,
    localRevision,
    savedRevision,
    lastChangedAt: value.lastChangedAt,
    lastSavedAt: value.lastSavedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

// 只有完全相同的服务器基准 revision 可直接恢复；差异必须进入后续显式冲突流程。
export function assessPlatformDraftCompatibility(
  draft: PlatformDraftRecord,
  currentRemoteRevision: number,
): PlatformDraftCompatibility {
  return draft.remoteBaseRevision === currentRemoteRevision
    ? { status: "recoverable", draft }
    : { status: "revision-conflict", draft };
}

// 恢复状态回到客户端前不改变 operation id 或 revision，保证刷新后的提交继续复用服务端幂等键。
export function toProjectDocumentRecoveryState(
  draft: PlatformDraftRecord,
  hydrateProject: (project: ProjectData) => ProjectData,
): ProjectDocumentRecoveryState {
  return {
    currentProject: hydrateProject(draft.currentProject),
    savedProject: hydrateProject(draft.savedProject),
    currentTrackSnapEnabled: { ...draft.currentTrackSnapEnabled },
    savedTrackSnapEnabled: { ...draft.savedTrackSnapEnabled },
    pendingOperations: draft.pendingOperations.map(cloneOperation),
    localRevision: draft.localRevision,
    savedRevision: draft.savedRevision,
    lastChangedAt: draft.lastChangedAt,
    lastSavedAt: draft.lastSavedAt,
  };
}

// 精简 operation 仍进行逐字段校验，防止损坏草稿把任意对象带入同步请求。
function normalizeOperation(value: unknown): ProjectDocumentOperation | null {
  if (!isRecord(value) || typeof value.id !== "string" || !CLIENT_OPERATION_ID_PATTERN.test(value.id)) return null;
  if (!OPERATION_TYPES.has(value.type as ProjectDocumentOperationType) ||
    !HISTORY_ACTIONS.has(value.action as HistoryAction | "track-snap")) return null;
  if (!isNonNegativeInteger(value.localRevision) || !isNonNegativeInteger(value.baseRevision)) return null;
  if (!isTimestamp(value.createdAt) || (value.syncState !== "pending" && value.syncState !== "submitted")) return null;
  if (!isRecord(value.summary) || typeof value.summary.hasProjectChange !== "boolean" ||
    typeof value.summary.hasTrackSnapChange !== "boolean") return null;
  const changedTrackIds = value.summary.changedTrackIds;
  if (changedTrackIds !== undefined &&
    (!Array.isArray(changedTrackIds) || changedTrackIds.some((id) => typeof id !== "string"))) return null;
  // operation 类型和摘要必须一致，防止损坏草稿伪造含糊的服务器审计事实。
  if (value.type === "track-snap.update"
    ? !value.summary.hasTrackSnapChange || value.summary.hasProjectChange
    : !value.summary.hasProjectChange || value.summary.hasTrackSnapChange) return null;
  return {
    id: value.id,
    type: value.type as ProjectDocumentOperationType,
    action: value.action as HistoryAction | "track-snap",
    localRevision: value.localRevision,
    baseRevision: value.baseRevision,
    createdAt: value.createdAt,
    syncState: value.syncState,
    summary: {
      hasProjectChange: value.summary.hasProjectChange,
      hasTrackSnapChange: value.summary.hasTrackSnapChange,
      ...(changedTrackIds ? { changedTrackIds: [...changedTrackIds] } : {}),
    },
  };
}

// operation 克隆只复制紧凑标量和数组，不与 React state 共享可变引用。
function cloneOperation(operation: ProjectDocumentOperation): ProjectDocumentOperation {
  return {
    ...operation,
    summary: {
      ...operation.summary,
      ...(operation.summary.changedTrackIds
        ? { changedTrackIds: [...operation.summary.changedTrackIds] }
        : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isTrackSnapState(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((enabled) => typeof enabled === "boolean");
}
