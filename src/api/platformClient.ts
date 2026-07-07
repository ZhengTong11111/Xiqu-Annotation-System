import type {
  AnnotationDocument,
  AnnotationDocumentSummary,
  AnnotationOperationRecord,
  AnnotationProjectSummary,
  AnnotationVersion,
  AuditLogEntry,
  CreateAnnotationDocumentRequest,
  CreateAnnotationOperationRequest,
  CreateAnnotationVersionRequest,
  CreateMediaAssetRequest,
  CreateProjectRequest,
  CreateProcessingJobRequest,
  ListAuditLogsOptions,
  LoginRequest,
  LoginResponse,
  MediaAsset,
  PlatformUser,
  ProcessingJob,
  SaveAnnotationDocumentRequest,
  StoredFileObject,
  UploadFileResponse,
} from "../../packages/shared/src/index";

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

  constructor({ baseUrl = "/api", accessToken = null }: PlatformClientOptions = {}) {
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

  listProjects() {
    return this.request<AnnotationProjectSummary[]>("/projects");
  }

  listFiles() {
    return this.request<StoredFileObject[]>("/files");
  }

  getFileContentUrl(fileId: string) {
    const tokenQuery = this.accessToken ? `?access_token=${encodeURIComponent(this.accessToken)}` : "";
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

  listProjectDocuments(projectId: string) {
    return this.request<AnnotationDocumentSummary[]>(`/projects/${projectId}/documents`);
  }

  createAnnotationDocument<TPayload>(
    projectId: string,
    request: CreateAnnotationDocumentRequest<TPayload>,
  ) {
    return this.request<AnnotationDocument<TPayload>>(`/projects/${projectId}/documents`, {
      method: "POST",
      body: request,
    });
  }

  getAnnotationDocument<TPayload>(documentId: string) {
    return this.request<AnnotationDocument<TPayload>>(`/annotation-documents/${documentId}`);
  }

  saveAnnotationDocument<TPayload>(
    documentId: string,
    request: SaveAnnotationDocumentRequest<TPayload>,
  ) {
    return this.request<AnnotationDocument<TPayload>>(`/annotation-documents/${documentId}/save`, {
      method: "POST",
      body: request,
    });
  }

  listAnnotationVersions<TPayload>(documentId: string) {
    return this.request<AnnotationVersion<TPayload>[]>(`/annotation-documents/${documentId}/versions`);
  }

  createAnnotationVersion<TPayload>(
    documentId: string,
    request: CreateAnnotationVersionRequest,
  ) {
    return this.request<AnnotationVersion<TPayload>>(`/annotation-documents/${documentId}/versions`, {
      method: "POST",
      body: request,
    });
  }

  restoreAnnotationVersion<TPayload>(versionId: string) {
    return this.request<AnnotationDocument<TPayload>>(`/annotation-versions/${versionId}/restore`, {
      method: "POST",
    });
  }

  createProcessingJob(request: CreateProcessingJobRequest) {
    return this.request<ProcessingJob>("/jobs", {
      method: "POST",
      body: request,
    });
  }

  // 查询审计日志。仅管理员/教师/助教可访问（后端做权限检查）。
  async listAuditLogs(options: ListAuditLogsOptions = {}) {
    const params = new URLSearchParams();
    if (options.projectId) params.set("projectId", options.projectId);
    if (options.documentId) params.set("documentId", options.documentId);
    if (options.actorUserId) params.set("actorUserId", options.actorUserId);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    const path = query ? `/audit-logs?${query}` : "/audit-logs";
    return this.request<AuditLogEntry[]>(path);
  }

  // 列出文档的标注操作日志。
  listAnnotationOperations(documentId: string) {
    return this.request<AnnotationOperationRecord[]>(`/annotation-documents/${documentId}/operations`);
  }

  // 提交一条标注操作。
  createAnnotationOperation(documentId: string, request: CreateAnnotationOperationRequest) {
    return this.request<AnnotationOperationRecord>(`/annotation-documents/${documentId}/operations`, {
      method: "POST",
      body: request,
    });
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
    headers.set("content-type", "application/json");
    if (!options.skipAuth && this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json().catch(() => null) as
      | { data?: TData; error?: { code: string; message: string; details?: unknown } }
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

    // 后端统一返回 { data }，这里集中解包，避免 UI 层散落响应格式判断。
    return payload?.data as TData;
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
    const payload = await response.json().catch(() => null) as
      | { data?: TData; error?: { code: string; message: string; details?: unknown } }
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
}
