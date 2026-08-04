import type {
  AnnotationConfirmationDraft,
  AnnotationConfirmationList,
  AnnotationConfirmationRecord,
  AnnotationFile,
  AnnotationOperationRecord,
  AnnotationOperationPage,
  AnnotationCommittedOperationPage,
  AnnotationRecoverySnapshotDetail,
  AnnotationRecoverySnapshotSummary,
  AuditActionName,
  AuditLogPage,
  PlatformUser,
  ProcessingJob,
  ProcessingJobType,
  ResourceCapability,
  ResourceEntry,
  ResourceListPage,
  ResourceListView,
  ResourcePermissionMatrixRow,
  ResourcePermissionRecord,
  ResourceSortField,
  ResourceType,
  SortDirection,
} from "./platform.js";
import type {
  CommitAnnotationCommandBatchRequest,
  CommitAnnotationCommandBatchResponse,
} from "./annotationCommandCommit.js";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_error"
  | "upload_too_large"
  | "unsupported_media"
  | "storage_quota_exceeded"
  | "maintenance_mode"
  | "internal_error";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
};

export type ApiSuccess<TData> = { data: TData };

export type LoginRequest = {
  accountName: string;
  password: string;
};

export type LoginResponse = {
  user: PlatformUser;
  accessToken: string;
};

export type ListResourcesOptions = {
  parentId?: string | null;
  view?: ResourceListView;
  query?: string;
  type?: ResourceType;
  sortBy?: ResourceSortField;
  direction?: SortDirection;
  cursor?: string;
  limit?: number;
};

export type CreateResourceRequest = {
  parentId?: string | null;
  type: Extract<ResourceType, "folder" | "project">;
  name: string;
  description?: string | null;
};

export type CreateAnnotationFileRequest<TPayload = unknown> = {
  parentId: string;
  name: string;
  payload: TPayload;
  mediaResourceId?: string | null;
};

export type UpdateResourceRequest = {
  name?: string;
  archived?: boolean;
  favorite?: boolean;
};

export type MoveResourceRequest = {
  parentId: string | null;
};

export type BatchMoveResourcesRequest = {
  resourceIds: string[];
  parentId: string | null;
};

export type BatchMoveResourcesResponse = {
  moved: ResourceEntry[];
  unchanged: ResourceEntry[];
  collapsedDescendantIds: string[];
};

export type BatchTrashResourcesRequest = {
  resourceIds: string[];
};

export type BatchTrashResourcesResponse = {
  trashed: ResourceEntry[];
  collapsedDescendantIds: string[];
};

export type CopyResourceRequest = {
  parentId: string;
  name?: string;
};

export type SaveAnnotationFileRequest<TPayload = unknown> = {
  baseRevision: number;
  payload: TPayload;
  clientOperationIds: string[];
  mutationLeaseToken?: string;
};

export const ANNOTATION_MUTATION_PURPOSES = [
  "track_structure",
  "bulk_import",
  "bulk_repair",
] as const;

export type AnnotationMutationPurpose = typeof ANNOTATION_MUTATION_PURPOSES[number];

export type AnnotationMutationLeaseSummary = {
  annotationFileId: string;
  holder: { id: string; accountName: string; displayName: string };
  purpose: AnnotationMutationPurpose;
  baseRevision: number;
  createdAt: string;
  expiresAt: string;
};

export type AnnotationMutationLeaseGrant = AnnotationMutationLeaseSummary & {
  token: string;
};

export type AcquireAnnotationMutationLeaseRequest = {
  baseRevision: number;
  purpose: AnnotationMutationPurpose;
};

export type RenewAnnotationMutationLeaseRequest = { token: string };
export type ReleaseAnnotationMutationLeaseRequest = { token: string };

// 恢复历史内容仍然是一次乐观锁写入，只需提交调用方看到的当前 revision。
export type RestoreAnnotationRecoverySnapshotRequest = {
  baseRevision: number;
  mutationLeaseToken?: string;
};

// 创建确认只接收审核 revision、范围和备注；文件 id 始终来自受保护的路由路径。
export type CreateAnnotationConfirmationRequest = Pick<
  AnnotationConfirmationDraft,
  "confirmedRevision" | "scope" | "note"
>;

export type RevokeAnnotationConfirmationRequest = {
  reason?: string | null;
};

export type UpsertResourcePermissionRequest = {
  capabilities: ResourceCapability[];
  inheritToChildren?: boolean;
  expiresAt?: string | null;
};

export type UpdateResourceInheritanceRequest = {
  breakPermissionInheritance: boolean;
};

export type StorageOrphanCategory =
  | "staged_binary"
  | "orphan_binary"
  | "unreferenced_file"
  | "missing_binary";

// 存储审计只返回相对 key 和元数据，不暴露服务器绝对路径或文件内容。
export type StorageOrphanSummary = {
  category: StorageOrphanCategory;
  fileId?: string;
  name?: string;
  storageKey: string;
  size: number;
  createdAt: string;
  cleanupEligible: boolean;
};

export type StorageOrphanReport = {
  generatedAt: string;
  graceMs: number;
  items: StorageOrphanSummary[];
};

export type StorageOrphanCleanupResult = {
  inspectedCount: number;
  eligibleCount: number;
  deletedBinaryCount: number;
  deletedFileObjectCount: number;
};

// 健康探针只公开组件状态和耗时，不把数据库地址或对象目录路径暴露给调用方。
export type HealthComponentStatus = {
  status: "ok" | "unavailable";
  latencyMs: number;
  message?: string;
};

export type ServiceHealthResponse = {
  status: "ok" | "ready" | "unavailable";
  service: "xiqu-platform-api";
  time: string;
  startedAt: string;
  components?: {
    database: HealthComponentStatus;
    storage: HealthComponentStatus;
  };
};

export type SystemDiagnosticAlert = {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
};

export type SystemDiagnostics = {
  generatedAt: string;
  health: ServiceHealthResponse;
  capacity: {
    platformUsedBytes: number;
    platformQuotaBytes: number;
    accountUsedBytes: number;
    accountQuotaBytes: number;
  };
  resources: {
    active: number;
    trashed: number;
    byType: Record<ResourceType, number>;
    fileObjects: number;
    mediaFiles: number;
    annotationFiles: number;
    recoverySnapshots: number;
  };
  storage: {
    finalObjectCount: number;
    finalObjectBytes: number;
    stagedObjectCount: number;
    stagedObjectBytes: number;
    issuesByCategory: Record<StorageOrphanCategory, number>;
    cleanupEligibleCount: number;
  };
  jobs: Record<"queued" | "running" | "succeeded" | "failed", number>;
  alerts: SystemDiagnosticAlert[];
  recentOperations: Array<{
    action: "media_upload" | "storage_orphan_cleanup";
    createdAt: string;
    summary: string;
  }>;
  maintenance: PlatformMaintenanceStatus;
};

export type PlatformMaintenanceStatus = {
  enabled: boolean;
  reason: string | null;
  startedAt: string | null;
  startedBy: {
    id: string;
    accountName: string;
    displayName: string;
  } | null;
  updatedAt: string;
};

export type SetPlatformMaintenanceRequest = {
  enabled: boolean;
  reason?: string | null;
};

export type CreateAnnotationOperationRequest = {
  clientOperationId: string;
  baseRevision: number;
  localRevision?: number | null;
  action: string;
  payload: unknown;
  mutationLeaseToken?: string;
};

export type ListAnnotationOperationsOptions = {
  cursor?: string;
  limit?: number;
};

export type ListCommittedAnnotationOperationsOptions = ListAnnotationOperationsOptions;

export type ListAuditLogsOptions = {
  resourceId?: string;
  actorUserId?: string;
  targetUserId?: string;
  action?: AuditActionName;
  createdFrom?: string;
  createdTo?: string;
  cursor?: string;
  limit?: number;
};

export type CreateProcessingJobRequest = {
  type: ProcessingJobType;
  inputFileIds: string[];
  resourceId?: string | null;
};

export type PlatformApiContract<TPayload = unknown> = {
  login: { request: LoginRequest; response: LoginResponse };
  me: { response: PlatformUser };
  listDirectoryUsers: { response: PlatformUser[] };
  listResources: { response: ResourceListPage };
  getResource: { response: ResourceEntry };
  markResourceOpened: { response: void };
  createResource: { request: CreateResourceRequest; response: ResourceEntry };
  updateResource: { request: UpdateResourceRequest; response: ResourceEntry };
  moveResource: { request: MoveResourceRequest; response: ResourceEntry };
  moveResources: {
    request: BatchMoveResourcesRequest;
    response: BatchMoveResourcesResponse;
  };
  trashResources: {
    request: BatchTrashResourcesRequest;
    response: BatchTrashResourcesResponse;
  };
  copyResource: { request: CopyResourceRequest; response: ResourceEntry };
  trashResource: { response: ResourceEntry };
  restoreResource: { response: ResourceEntry };
  uploadMedia: { response: ResourceEntry };
  inspectStorageOrphans: { response: StorageOrphanReport };
  cleanupStorageOrphans: { response: StorageOrphanCleanupResult };
  health: { response: ServiceHealthResponse };
  systemDiagnostics: { response: SystemDiagnostics };
  getPlatformMaintenance: { response: PlatformMaintenanceStatus };
  setPlatformMaintenance: {
    request: SetPlatformMaintenanceRequest;
    response: PlatformMaintenanceStatus;
  };
  createAnnotationFile: {
    request: CreateAnnotationFileRequest<TPayload>;
    response: AnnotationFile<TPayload>;
  };
  getAnnotationFile: { response: AnnotationFile<TPayload> };
  saveAnnotationFile: {
    request: SaveAnnotationFileRequest<TPayload>;
    response: AnnotationFile<TPayload>;
  };
  getAnnotationMutationLease: { response: AnnotationMutationLeaseSummary | null };
  acquireAnnotationMutationLease: {
    request: AcquireAnnotationMutationLeaseRequest;
    response: AnnotationMutationLeaseGrant;
  };
  renewAnnotationMutationLease: {
    request: RenewAnnotationMutationLeaseRequest;
    response: AnnotationMutationLeaseGrant;
  };
  releaseAnnotationMutationLease: {
    request: ReleaseAnnotationMutationLeaseRequest;
    response: void;
  };
  listRecoverySnapshots: {
    response: AnnotationRecoverySnapshotSummary[];
  };
  getRecoverySnapshot: {
    response: AnnotationRecoverySnapshotDetail<TPayload>;
  };
  restoreAnnotationRecoverySnapshot: {
    request: RestoreAnnotationRecoverySnapshotRequest;
    response: AnnotationFile<TPayload>;
  };
  listAnnotationConfirmations: { response: AnnotationConfirmationList };
  createAnnotationConfirmation: {
    request: CreateAnnotationConfirmationRequest;
    response: AnnotationConfirmationRecord;
  };
  revokeAnnotationConfirmation: {
    request: RevokeAnnotationConfirmationRequest;
    response: AnnotationConfirmationRecord;
  };
  listResourcePermissions: { response: ResourcePermissionMatrixRow[] };
  upsertResourcePermission: {
    request: UpsertResourcePermissionRequest;
    response: ResourcePermissionRecord;
  };
  removeResourcePermission: { response: void };
  updateResourceInheritance: {
    request: UpdateResourceInheritanceRequest;
    response: ResourceEntry;
  };
  createProcessingJob: {
    request: CreateProcessingJobRequest;
    response: ProcessingJob;
  };
  listAuditLogs: { response: AuditLogPage };
  listAnnotationOperations: { response: AnnotationOperationPage };
  listCommittedAnnotationOperations: { response: AnnotationCommittedOperationPage };
  createAnnotationOperation: {
    request: CreateAnnotationOperationRequest;
    response: AnnotationOperationRecord;
  };
  commitAnnotationCommandBatch: {
    request: CommitAnnotationCommandBatchRequest;
    response: CommitAnnotationCommandBatchResponse;
  };
};
