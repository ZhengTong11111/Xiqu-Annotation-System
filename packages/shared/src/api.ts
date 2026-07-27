import type {
  AnnotationDocument,
  AnnotationDocumentSummary,
  AnnotationMode,
  AnnotationOperationRecord,
  AnnotationProjectSummary,
  AnnotationVersion,
  AuditLogEntry,
  CreateGrantRequest,
  EffectiveDocumentPermission,
  GrantSummary,
  MediaAsset,
  PermissionGrant,
  PlatformUser,
  ProcessingJob,
  ProcessingJobType,
  StoredFileObject,
  UpdateGrantRequest,
} from "./platform.js";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "permission_scope_violation"
  | "validation_error"
  | "internal_error";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
};

export type ApiSuccess<TData> = {
  data: TData;
};

export type LoginRequest = {
  accountName: string;
  password: string;
};

export type LoginResponse = {
  user: PlatformUser;
  accessToken: string;
};

export type CreateProjectRequest = {
  title: string;
  mediaAssetId: string;
};

export type CreateMediaAssetRequest = {
  title: string;
  description?: string | null;
  primaryFileId?: string | null;
};

export type UploadFileResponse = {
  file: StoredFileObject;
};

export type CreateAnnotationDocumentRequest<TPayload = unknown> = {
  title: string;
  mode: AnnotationMode;
  initialPayload: TPayload;
  grants?: PermissionGrant[];
};

export type SaveAnnotationDocumentRequest<TPayload = unknown> = {
  baseRevision: number;
  payload: TPayload;
};

export type CreateAnnotationVersionRequest = {
  name: string;
  description?: string | null;
};

export type CreateAnnotationOperationRequest = {
  baseRevision: number;
  localRevision?: number | null;
  action: string;
  payload: unknown;
};

export type ListAuditLogsOptions = {
  projectId?: string;
  documentId?: string;
  actorUserId?: string;
  limit?: number;
};

export type CreateProcessingJobRequest = {
  type: ProcessingJobType;
  inputFileIds: string[];
  documentId?: string | null;
};

export type PlatformApiContract<TPayload = unknown> = {
  login: {
    request: LoginRequest;
    response: LoginResponse;
  };
  me: {
    response: PlatformUser;
  };
  listProjects: {
    response: AnnotationProjectSummary[];
  };
  listFiles: {
    response: StoredFileObject[];
  };
  uploadFile: {
    response: UploadFileResponse;
  };
  listMediaAssets: {
    response: MediaAsset[];
  };
  createProject: {
    request: CreateProjectRequest;
    response: AnnotationProjectSummary;
  };
  createMediaAsset: {
    request: CreateMediaAssetRequest;
    response: MediaAsset;
  };
  listProjectDocuments: {
    response: AnnotationDocumentSummary[];
  };
  createAnnotationDocument: {
    request: CreateAnnotationDocumentRequest<TPayload>;
    response: AnnotationDocument<TPayload>;
  };
  getAnnotationDocument: {
    response: AnnotationDocument<TPayload>;
  };
  saveAnnotationDocument: {
    request: SaveAnnotationDocumentRequest<TPayload>;
    response: AnnotationDocument<TPayload>;
  };
  listAnnotationVersions: {
    response: AnnotationVersion<TPayload>[];
  };
  createAnnotationVersion: {
    request: CreateAnnotationVersionRequest;
    response: AnnotationVersion<TPayload>;
  };
  createProcessingJob: {
    request: CreateProcessingJobRequest;
    response: ProcessingJob;
  };
  listAuditLogs: {
    response: AuditLogEntry[];
  };
  listAnnotationOperations: {
    response: AnnotationOperationRecord[];
  };
  createAnnotationOperation: {
    request: CreateAnnotationOperationRequest;
    response: AnnotationOperationRecord;
  };
  getEffectiveDocumentPermission: {
    response: EffectiveDocumentPermission;
  };
  listDocumentGrants: {
    response: GrantSummary[];
  };
  createDocumentGrant: {
    request: CreateGrantRequest;
    response: GrantSummary;
  };
  updatePermissionGrant: {
    request: UpdateGrantRequest;
    response: GrantSummary;
  };
  revokePermissionGrant: {
    response: void;
  };
};
