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
  CreateGrantRequest,
  CreateMediaAssetRequest,
  CreateProjectRequest,
  CreateProcessingJobRequest,
  EffectiveDocumentPermission,
  GrantSummary,
  ListAuditLogsOptions,
  LoginRequest,
  LoginResponse,
  MediaAsset,
  PlatformUser,
  ProcessingJob,
  SaveAnnotationDocumentRequest,
  StoredFileObject,
  UpdateGrantRequest,
  UploadFileResponse,
  AssignmentRecipient,
  AssignmentSummary,
  CourseMember,
  CourseSummary,
  CreateAssignmentRequest,
  CreateCourseRequest,
  MyAssignment,
  PermissionTrackOption,
  ReturnAssignmentRequest,
  AddCourseMemberRequest,
  UpdateCourseMemberRequest,
  UpdateDraftAssignmentRequest,
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

  listDirectoryUsers(options: { courseId?: string; query?: string; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (options.courseId) params.set("courseId", options.courseId);
    if (options.query) params.set("query", options.query);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.request<PlatformUser[]>(query ? `/users?${query}` : "/users");
  }

  listCourses() {
    return this.request<CourseSummary[]>("/courses");
  }

  createCourse(request: CreateCourseRequest) {
    return this.request<CourseSummary>("/courses", { method: "POST", body: request });
  }

  getCourse(courseId: string) {
    return this.request<CourseSummary>(`/courses/${courseId}`);
  }

  listCourseMembers(courseId: string) {
    return this.request<CourseMember[]>(`/courses/${courseId}/members`);
  }

  addCourseMember(courseId: string, request: AddCourseMemberRequest) {
    return this.request<CourseMember>(`/courses/${courseId}/members`, {
      method: "POST",
      body: request,
    });
  }

  updateCourseMember(courseId: string, memberId: string, request: UpdateCourseMemberRequest) {
    return this.request<CourseMember>(`/courses/${courseId}/members/${memberId}`, {
      method: "PATCH",
      body: request,
    });
  }

  removeCourseMember(courseId: string, memberId: string) {
    return this.request<void>(`/courses/${courseId}/members/${memberId}`, {
      method: "DELETE",
    });
  }

  listCourseAssignments(courseId: string) {
    return this.request<AssignmentSummary[]>(`/courses/${courseId}/assignments`);
  }

  createAssignment(courseId: string, request: CreateAssignmentRequest) {
    return this.request<AssignmentSummary>(`/courses/${courseId}/assignments`, {
      method: "POST",
      body: request,
    });
  }

  getAssignment(assignmentId: string) {
    return this.request<AssignmentSummary>(`/assignments/${assignmentId}`);
  }

  updateDraftAssignment(assignmentId: string, request: UpdateDraftAssignmentRequest) {
    return this.request<AssignmentSummary>(`/assignments/${assignmentId}`, {
      method: "PATCH",
      body: request,
    });
  }

  publishAssignment(assignmentId: string) {
    return this.request<AssignmentSummary>(`/assignments/${assignmentId}/publish`, { method: "POST" });
  }

  listAssignmentRecipients(assignmentId: string) {
    return this.request<AssignmentRecipient[]>(`/assignments/${assignmentId}/recipients`);
  }

  submitAssignment(assignmentId: string) {
    return this.request<AssignmentRecipient>(`/assignments/${assignmentId}/submit`, { method: "POST" });
  }

  returnAssignment(assignmentId: string, recipientId: string, request: ReturnAssignmentRequest) {
    return this.request<AssignmentRecipient>(
      `/assignments/${assignmentId}/recipients/${recipientId}/return`,
      { method: "POST", body: request },
    );
  }

  listMyAssignments() {
    return this.request<MyAssignment[]>("/my-assignments");
  }

  listPermissionTracks(documentId: string) {
    return this.request<PermissionTrackOption[]>(`/annotation-documents/${documentId}/permission-tracks`);
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

  // 查询审计日志。管理员可全局查询，其他账号必须指定后端确认可管理的项目或文档。
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

  // 获取当前用户对文档的有效权限摘要。
  getEffectiveDocumentPermission(documentId: string) {
    return this.request<EffectiveDocumentPermission>(`/annotation-documents/${documentId}/permissions/effective`);
  }

  // 列出文档 grant。需 manage 权限。
  listDocumentGrants(documentId: string) {
    return this.request<GrantSummary[]>(`/annotation-documents/${documentId}/grants`);
  }

  // 为文档新增 grant。
  createDocumentGrant(documentId: string, request: CreateGrantRequest) {
    return this.request<GrantSummary>(`/annotation-documents/${documentId}/grants`, {
      method: "POST",
      body: request,
    });
  }

  // 修改已有 grant。
  updatePermissionGrant(grantId: string, request: UpdateGrantRequest) {
    return this.request<GrantSummary>(`/permission-grants/${grantId}`, {
      method: "PATCH",
      body: request,
    });
  }

  // 撤销 grant。
  revokePermissionGrant(grantId: string) {
    return this.request<void>(`/permission-grants/${grantId}`, {
      method: "DELETE",
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
    // 无 body 的 POST（例如版本恢复）不能声明 JSON，否则 Fastify 会把空请求体判为语法错误。
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
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
