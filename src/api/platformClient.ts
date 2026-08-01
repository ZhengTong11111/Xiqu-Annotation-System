import type {
  AnnotationFile,
  AnnotationOperationRecord,
  AnnotationRecoverySnapshot,
  AuditLogEntry,
  BatchMoveResourcesRequest,
  BatchMoveResourcesResponse,
  CopyResourceRequest,
  CreateAnnotationFileRequest,
  CreateAnnotationOperationRequest,
  CreateProcessingJobRequest,
  CreateResourceRequest,
  ImportMediaFileRequest,
  ListAuditLogsOptions,
  ListResourcesOptions,
  LoginRequest,
  LoginResponse,
  MoveResourceRequest,
  PlatformUser,
  ProcessingJob,
  ResourceEntry,
  ResourceListPage,
  ResourcePermissionMatrixRow,
  ResourcePermissionRecord,
  SaveAnnotationFileRequest,
  UpdateResourceInheritanceRequest,
  UpdateResourceRequest,
  UpsertResourcePermissionRequest,
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

  listDirectoryUsers(query?: string) {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    return this.request<PlatformUser[]>(
      params.size ? `/users?${params}` : "/users",
    );
  }

  listResources(options: ListResourcesOptions = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
    return this.request<ResourceListPage>(
      params.size ? `/resources?${params}` : "/resources",
    );
  }

  getResource(resourceId: string) {
    return this.request<ResourceEntry>(`/resources/${resourceId}`);
  }

  createResource(request: CreateResourceRequest) {
    return this.request<ResourceEntry>("/resources", {
      method: "POST",
      body: request,
    });
  }

  updateResource(resourceId: string, request: UpdateResourceRequest) {
    return this.request<ResourceEntry>(`/resources/${resourceId}`, {
      method: "PATCH",
      body: request,
    });
  }

  moveResource(resourceId: string, request: MoveResourceRequest) {
    return this.request<ResourceEntry>(`/resources/${resourceId}/move`, {
      method: "POST",
      body: request,
    });
  }

  moveResources(request: BatchMoveResourcesRequest) {
    return this.request<BatchMoveResourcesResponse>("/resources/move-batch", {
      method: "POST",
      body: request,
    });
  }

  copyResource(resourceId: string, request: CopyResourceRequest) {
    return this.request<ResourceEntry>(`/resources/${resourceId}/copy`, {
      method: "POST",
      body: request,
    });
  }

  trashResource(resourceId: string) {
    return this.request<ResourceEntry>(`/resources/${resourceId}/trash`, {
      method: "POST",
    });
  }

  restoreResource(resourceId: string) {
    return this.request<ResourceEntry>(`/resources/${resourceId}/restore`, {
      method: "POST",
    });
  }

  createAnnotationFile<TPayload>(
    request: CreateAnnotationFileRequest<TPayload>,
  ) {
    return this.request<AnnotationFile<TPayload>>("/annotation-files", {
      method: "POST",
      body: request,
    });
  }

  getAnnotationFile<TPayload>(resourceId: string) {
    return this.request<AnnotationFile<TPayload>>(
      `/annotation-files/${resourceId}`,
    );
  }

  saveAnnotationFile<TPayload>(
    resourceId: string,
    request: SaveAnnotationFileRequest<TPayload>,
  ) {
    return this.request<AnnotationFile<TPayload>>(
      `/annotation-files/${resourceId}`,
      { method: "PUT", body: request },
    );
  }

  listRecoverySnapshots<TPayload>(resourceId: string) {
    return this.request<AnnotationRecoverySnapshot<TPayload>[]>(
      `/annotation-files/${resourceId}/recovery-snapshots`,
    );
  }

  listResourcePermissions(resourceId: string) {
    return this.request<ResourcePermissionMatrixRow[]>(
      `/resources/${resourceId}/permissions`,
    );
  }

  upsertResourcePermission(
    resourceId: string,
    userId: string,
    request: UpsertResourcePermissionRequest,
  ) {
    return this.request<ResourcePermissionRecord>(
      `/resources/${resourceId}/permissions/${userId}`,
      { method: "PUT", body: request },
    );
  }

  removeResourcePermission(resourceId: string, userId: string) {
    return this.request<void>(
      `/resources/${resourceId}/permissions/${userId}`,
      { method: "DELETE" },
    );
  }

  updateResourceInheritance(
    resourceId: string,
    request: UpdateResourceInheritanceRequest,
  ) {
    return this.request<ResourceEntry>(
      `/resources/${resourceId}/permission-inheritance`,
      { method: "PATCH", body: request },
    );
  }

  async uploadFile(file: File) {
    const body = new FormData();
    body.set("file", file);
    return this.requestMultipart<UploadFileResponse>("/files/upload", body);
  }

  importMediaFile(request: ImportMediaFileRequest) {
    return this.request<ResourceEntry>("/media-files", {
      method: "POST",
      body: request,
    });
  }

  getFileContentUrl(fileId: string) {
    const tokenQuery = this.accessToken
      ? `?access_token=${encodeURIComponent(this.accessToken)}`
      : "";
    return `${this.baseUrl}/files/${encodeURIComponent(fileId)}/content${tokenQuery}`;
  }

  createProcessingJob(request: CreateProcessingJobRequest) {
    return this.request<ProcessingJob>("/processing-jobs", {
      method: "POST",
      body: request,
    });
  }

  listAuditLogs(options: ListAuditLogsOptions = {}) {
    const params = new URLSearchParams();
    if (options.resourceId) params.set("resourceId", options.resourceId);
    if (options.actorUserId) params.set("actorUserId", options.actorUserId);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    return this.request<AuditLogEntry[]>(
      params.size ? `/audit-logs?${params}` : "/audit-logs",
    );
  }

  listAnnotationOperations(annotationFileId: string) {
    return this.request<AnnotationOperationRecord[]>(
      `/annotation-files/${annotationFileId}/operations`,
    );
  }

  createAnnotationOperation(
    annotationFileId: string,
    request: CreateAnnotationOperationRequest,
  ) {
    return this.request<AnnotationOperationRecord>(
      `/annotation-files/${annotationFileId}/operations`,
      { method: "POST", body: request },
    );
  }

  private async request<TData>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      skipAuth?: boolean;
    } = {},
  ) {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (!options.skipAuth && this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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
  if (response.status === 204) return undefined as TData;
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
