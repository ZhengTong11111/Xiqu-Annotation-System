import type {
  AddProjectMemberRequest,
  AnnotationOperationRecord,
  AnnotationProjectSummary,
  AnnotationVersion,
  AnnotationVersionSummary,
  AnnotationWorkspace,
  AnnotationWorkspaceSummary,
  AuditLogEntry,
  CompleteAnnotationVersionRequest,
  CreateAnnotationOperationRequest,
  CreateMediaAssetRequest,
  CreateProcessingJobRequest,
  CreateProjectRequest,
  CreateProjectVersionRequest,
  CreateWorkspaceRequest,
  ForkAnnotationVersionRequest,
  ListAuditLogsOptions,
  LoginRequest,
  LoginResponse,
  MediaAsset,
  PermissionTrackOption,
  PlatformUser,
  ProcessingJob,
  ProjectMember,
  ProjectVersion,
  SaveWorkspaceRequest,
  StoredFileObject,
  UpdateAnnotationVersionStatusRequest,
  UpdateProjectMemberRequest,
  UpdateProjectVersionStatusRequest,
  UpdateWorkspaceStatusRequest,
  UploadFileResponse,
} from "@xiqu/shared";

export type PlatformClientOptions = {
  baseUrl?: string;
  accessToken?: string | null;
};

export class PlatformApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class PlatformClient {
  private readonly baseUrl: string;
  private accessToken: string | null;

  constructor({
    baseUrl = "/api",
    accessToken = null,
  }: PlatformClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.accessToken = accessToken;
  }

  setAccessToken(accessToken: string | null) {
    this.accessToken = accessToken;
  }

  login(request: LoginRequest) {
    return this.request<LoginResponse>("/auth/login", {
      method: "POST",
      body: request,
      skipAuth: true,
    });
  }

  me() {
    return this.request<PlatformUser>("/auth/me");
  }

  listDirectoryUsers(
    options: { projectId?: string; query?: string; limit?: number } = {},
  ) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.query) params.set("query", options.query);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.request<PlatformUser[]>(query ? `/users?${query}` : "/users");
  }

  listProjectMembers(projectId: string) {
    return this.request<ProjectMember[]>(`/projects/${projectId}/members`);
  }

  addProjectMember(projectId: string, request: AddProjectMemberRequest) {
    return this.request<ProjectMember>(`/projects/${projectId}/members`, {
      method: "POST",
      body: request,
    });
  }

  updateProjectMember(
    projectId: string,
    memberId: string,
    request: UpdateProjectMemberRequest,
  ) {
    return this.request<ProjectMember>(
      `/projects/${projectId}/members/${memberId}`,
      { method: "PATCH", body: request },
    );
  }

  removeProjectMember(projectId: string, memberId: string) {
    return this.request<void>(
      `/projects/${projectId}/members/${memberId}`,
      { method: "DELETE" },
    );
  }

  listPermissionTracks(projectId: string) {
    return this.request<PermissionTrackOption[]>(
      `/projects/${projectId}/permission-tracks`,
    );
  }

  listProjects() {
    return this.request<AnnotationProjectSummary[]>("/projects");
  }

  listFiles() {
    return this.request<StoredFileObject[]>("/files");
  }

  getFileContentUrl(fileId: string) {
    const tokenQuery = this.accessToken
      ? `?access_token=${encodeURIComponent(this.accessToken)}`
      : "";
    return `${this.baseUrl}/files/${encodeURIComponent(fileId)}/content${tokenQuery}`;
  }

  async uploadFile(file: File) {
    const body = new FormData();
    body.set("file", file);
    return this.requestMultipart<UploadFileResponse>("/files", body);
  }

  listMediaAssets() {
    return this.request<MediaAsset[]>("/media");
  }

  createMediaAsset(request: CreateMediaAssetRequest) {
    return this.request<MediaAsset>("/media", {
      method: "POST",
      body: request,
    });
  }

  createProject(request: CreateProjectRequest) {
    return this.request<AnnotationProjectSummary>("/projects", {
      method: "POST",
      body: request,
    });
  }

  listProjectWorkspaces(
    projectId: string,
    options: { ownerUserId?: string } = {},
  ) {
    const params = new URLSearchParams();
    if (options.ownerUserId) {
      params.set("ownerUserId", options.ownerUserId);
    }
    const query = params.toString();
    return this.request<AnnotationWorkspaceSummary[]>(
      `/projects/${projectId}/workspaces${query ? `?${query}` : ""}`,
    );
  }

  createWorkspace<TPayload>(
    projectId: string,
    request: CreateWorkspaceRequest<TPayload>,
  ) {
    return this.request<AnnotationWorkspace<TPayload>>(
      `/projects/${projectId}/workspaces`,
      { method: "POST", body: request },
    );
  }

  getWorkspace<TPayload>(workspaceId: string) {
    return this.request<AnnotationWorkspace<TPayload>>(
      `/annotation-workspaces/${workspaceId}`,
    );
  }

  saveWorkspace<TPayload>(
    workspaceId: string,
    request: SaveWorkspaceRequest<TPayload>,
  ) {
    return this.request<AnnotationWorkspace<TPayload>>(
      `/annotation-workspaces/${workspaceId}/save`,
      { method: "POST", body: request },
    );
  }

  updateWorkspaceStatus(
    workspaceId: string,
    request: UpdateWorkspaceStatusRequest,
  ) {
    return this.request<AnnotationWorkspaceSummary>(
      `/annotation-workspaces/${workspaceId}/status`,
      { method: "PATCH", body: request },
    );
  }

  listProjectAnnotationVersions(
    projectId: string,
    filters: { createdBy?: string; workspaceId?: string } = {},
  ) {
    const params = new URLSearchParams();
    if (filters.createdBy) params.set("createdBy", filters.createdBy);
    if (filters.workspaceId) params.set("workspaceId", filters.workspaceId);
    const query = params.toString();
    return this.request<AnnotationVersionSummary[]>(
      `/projects/${projectId}/annotation-versions${query ? `?${query}` : ""}`,
    );
  }

  listWorkspaceAnnotationVersions(workspaceId: string) {
    return this.request<AnnotationVersionSummary[]>(
      `/annotation-workspaces/${workspaceId}/versions`,
    );
  }

  completeAnnotationVersion<TPayload>(
    workspaceId: string,
    request: CompleteAnnotationVersionRequest,
  ) {
    return this.request<AnnotationVersion<TPayload>>(
      `/annotation-workspaces/${workspaceId}/versions`,
      { method: "POST", body: request },
    );
  }

  forkAnnotationVersion<TPayload>(
    versionId: string,
    request: ForkAnnotationVersionRequest,
  ) {
    return this.request<AnnotationWorkspace<TPayload>>(
      `/annotation-versions/${versionId}/forks`,
      { method: "POST", body: request },
    );
  }

  updateAnnotationVersionStatus(
    versionId: string,
    request: UpdateAnnotationVersionStatusRequest,
  ) {
    return this.request<AnnotationVersionSummary>(
      `/annotation-versions/${versionId}/status`,
      { method: "PATCH", body: request },
    );
  }

  listProjectVersions(projectId: string) {
    return this.request<ProjectVersion[]>(
      `/projects/${projectId}/project-versions`,
    );
  }

  createProjectVersion(
    projectId: string,
    request: CreateProjectVersionRequest,
  ) {
    return this.request<ProjectVersion>(
      `/projects/${projectId}/project-versions`,
      { method: "POST", body: request },
    );
  }

  publishProjectVersion(projectVersionId: string) {
    return this.request<ProjectVersion>(
      `/project-versions/${projectVersionId}/publish`,
      { method: "POST" },
    );
  }

  updateProjectVersionStatus(
    projectVersionId: string,
    request: UpdateProjectVersionStatusRequest,
  ) {
    return this.request<ProjectVersion>(
      `/project-versions/${projectVersionId}/status`,
      { method: "PATCH", body: request },
    );
  }

  createProcessingJob(request: CreateProcessingJobRequest) {
    return this.request<ProcessingJob>("/jobs", {
      method: "POST",
      body: request,
    });
  }

  listAuditLogs(options: ListAuditLogsOptions = {}) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.workspaceId) params.set("workspaceId", options.workspaceId);
    if (options.actorUserId) {
      params.set("actorUserId", options.actorUserId);
    }
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    const query = params.toString();
    return this.request<AuditLogEntry[]>(
      query ? `/audit-logs?${query}` : "/audit-logs",
    );
  }

  listAnnotationOperations(workspaceId: string) {
    return this.request<AnnotationOperationRecord[]>(
      `/annotation-workspaces/${workspaceId}/operations`,
    );
  }

  createAnnotationOperation(
    workspaceId: string,
    request: CreateAnnotationOperationRequest,
  ) {
    return this.request<AnnotationOperationRecord>(
      `/annotation-workspaces/${workspaceId}/operations`,
      { method: "POST", body: request },
    );
  }

  private async request<TData>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      skipAuth?: boolean;
    } = {},
  ) {
    const headers = new Headers();
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (!options.skipAuth && this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    });
    return unwrapResponse<TData>(response);
  }

  private async requestMultipart<TData>(path: string, body: FormData) {
    const headers = new Headers();
    if (this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body,
    });
    return unwrapResponse<TData>(response);
  }
}

async function unwrapResponse<TData>(response: Response) {
  const payload = await response.json().catch(() => null) as
    | {
        data?: TData;
        error?: { code: string; message: string; details?: unknown };
      }
    | null;
  if (!response.ok || payload?.error) {
    const error = payload?.error;
    throw new PlatformApiError(
      response.status,
      error?.code ?? "internal_error",
      error?.message ?? "平台接口请求失败。",
      error?.details,
    );
  }
  return payload?.data as TData;
}
