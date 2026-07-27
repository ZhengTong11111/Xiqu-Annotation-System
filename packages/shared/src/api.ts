import type {
  AnnotationOperationRecord,
  AnnotationProjectSummary,
  AnnotationVersion,
  AnnotationVersionKind,
  AnnotationVersionSummary,
  AnnotationVersionStatus,
  AnnotationWorkspace,
  AnnotationWorkspaceSummary,
  AuditLogEntry,
  MediaAsset,
  MutableProjectScope,
  PermissionTrackOption,
  PlatformUser,
  ProcessingJob,
  ProcessingJobType,
  ProjectCapability,
  ProjectMember,
  ProjectMemberRole,
  ProjectVersion,
  ProjectVersionStatus,
  StoredFileObject,
  WorkspaceStatus,
  WorkspaceType,
} from "./platform.js";

export type AddProjectMemberRequest = {
  userId: string;
  role: ProjectMemberRole;
  capabilities?: ProjectCapability[];
  scope?: MutableProjectScope;
  expiresAt?: string | null;
};

export type UpdateProjectMemberRequest = {
  role?: ProjectMemberRole;
  capabilities?: ProjectCapability[];
  scope?: MutableProjectScope;
  expiresAt?: string | null;
};

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

export type CreateWorkspaceRequest<TPayload = unknown> = {
  name: string;
  workspaceType?: WorkspaceType;
  ownerUserId?: string;
  initialPayload: TPayload;
};

export type SaveWorkspaceRequest<TPayload = unknown> = {
  baseRevision: number;
  payload: TPayload;
};

export type UpdateWorkspaceStatusRequest = {
  status: WorkspaceStatus;
};

export type CompleteAnnotationVersionRequest = {
  name: string;
  description?: string | null;
  kind?: AnnotationVersionKind;
};

export type ForkAnnotationVersionRequest = {
  workspaceName: string;
};

export type UpdateAnnotationVersionStatusRequest = {
  status: Extract<AnnotationVersionStatus, "archived">;
};

export type CreateProjectVersionRequest = {
  sourceVersionId: string;
  name: string;
  description?: string | null;
};

export type UpdateProjectVersionStatusRequest = {
  status: Exclude<ProjectVersionStatus, "published" | "superseded">;
};

export type CreateAnnotationOperationRequest = {
  baseRevision: number;
  localRevision?: number | null;
  action: string;
  payload: unknown;
};

export type ListAuditLogsOptions = {
  projectId?: string;
  workspaceId?: string;
  actorUserId?: string;
  limit?: number;
};

export type CreateProcessingJobRequest = {
  type: ProcessingJobType;
  inputFileIds: string[];
  workspaceId?: string | null;
};

export type PlatformApiContract<TPayload = unknown> = {
  login: { request: LoginRequest; response: LoginResponse };
  me: { response: PlatformUser };
  listProjects: { response: AnnotationProjectSummary[] };
  listFiles: { response: StoredFileObject[] };
  uploadFile: { response: UploadFileResponse };
  listMediaAssets: { response: MediaAsset[] };
  createProject: { request: CreateProjectRequest; response: AnnotationProjectSummary };
  createMediaAsset: { request: CreateMediaAssetRequest; response: MediaAsset };
  listProjectWorkspaces: { response: AnnotationWorkspaceSummary[] };
  createWorkspace: {
    request: CreateWorkspaceRequest<TPayload>;
    response: AnnotationWorkspace<TPayload>;
  };
  getWorkspace: { response: AnnotationWorkspace<TPayload> };
  saveWorkspace: {
    request: SaveWorkspaceRequest<TPayload>;
    response: AnnotationWorkspace<TPayload>;
  };
  updateWorkspaceStatus: {
    request: UpdateWorkspaceStatusRequest;
    response: AnnotationWorkspaceSummary;
  };
  listProjectAnnotationVersions: { response: AnnotationVersionSummary[] };
  listWorkspaceAnnotationVersions: { response: AnnotationVersionSummary[] };
  completeAnnotationVersion: {
    request: CompleteAnnotationVersionRequest;
    response: AnnotationVersion<TPayload>;
  };
  forkAnnotationVersion: {
    request: ForkAnnotationVersionRequest;
    response: AnnotationWorkspace<TPayload>;
  };
  updateAnnotationVersionStatus: {
    request: UpdateAnnotationVersionStatusRequest;
    response: AnnotationVersionSummary;
  };
  listProjectVersions: { response: ProjectVersion[] };
  createProjectVersion: {
    request: CreateProjectVersionRequest;
    response: ProjectVersion;
  };
  publishProjectVersion: { response: ProjectVersion };
  updateProjectVersionStatus: {
    request: UpdateProjectVersionStatusRequest;
    response: ProjectVersion;
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
  listDirectoryUsers: { response: PlatformUser[] };
  listProjectMembers: { response: ProjectMember[] };
  addProjectMember: { request: AddProjectMemberRequest; response: ProjectMember };
  updateProjectMember: { request: UpdateProjectMemberRequest; response: ProjectMember };
  removeProjectMember: { response: void };
  listPermissionTracks: { response: PermissionTrackOption[] };
};
