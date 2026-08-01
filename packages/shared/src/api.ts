import type {
  AnnotationFile,
  AnnotationOperationRecord,
  AnnotationRecoverySnapshot,
  AuditLogEntry,
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
  StoredFileObject,
} from "./platform.js";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_error"
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

export type ImportMediaFileRequest = {
  parentId: string;
  fileId: string;
  name?: string;
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

export type CopyResourceRequest = {
  parentId: string;
  name?: string;
};

export type SaveAnnotationFileRequest<TPayload = unknown> = {
  baseRevision: number;
  payload: TPayload;
};

export type UpsertResourcePermissionRequest = {
  capabilities: ResourceCapability[];
  inheritToChildren?: boolean;
  expiresAt?: string | null;
};

export type UpdateResourceInheritanceRequest = {
  breakPermissionInheritance: boolean;
};

export type UploadFileResponse = {
  file: StoredFileObject;
};

export type CreateAnnotationOperationRequest = {
  baseRevision: number;
  localRevision?: number | null;
  action: string;
  payload: unknown;
};

export type ListAuditLogsOptions = {
  resourceId?: string;
  actorUserId?: string;
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
  createResource: { request: CreateResourceRequest; response: ResourceEntry };
  updateResource: { request: UpdateResourceRequest; response: ResourceEntry };
  moveResource: { request: MoveResourceRequest; response: ResourceEntry };
  moveResources: {
    request: BatchMoveResourcesRequest;
    response: BatchMoveResourcesResponse;
  };
  copyResource: { request: CopyResourceRequest; response: ResourceEntry };
  trashResource: { response: ResourceEntry };
  restoreResource: { response: ResourceEntry };
  uploadFile: { response: UploadFileResponse };
  importMediaFile: { request: ImportMediaFileRequest; response: ResourceEntry };
  createAnnotationFile: {
    request: CreateAnnotationFileRequest<TPayload>;
    response: AnnotationFile<TPayload>;
  };
  getAnnotationFile: { response: AnnotationFile<TPayload> };
  saveAnnotationFile: {
    request: SaveAnnotationFileRequest<TPayload>;
    response: AnnotationFile<TPayload>;
  };
  listRecoverySnapshots: {
    response: AnnotationRecoverySnapshot<TPayload>[];
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
  listAuditLogs: { response: AuditLogEntry[] };
  listAnnotationOperations: { response: AnnotationOperationRecord[] };
  createAnnotationOperation: {
    request: CreateAnnotationOperationRequest;
    response: AnnotationOperationRecord;
  };
};
