import type { FastifyInstance, FastifyRequest } from "fastify";
import { validatePermissionScope } from "@xiqu/document-model";
import type {
  MutablePermissionScope,
  PermissionAction,
  PermissionScope,
  ProcessingJobType,
  CourseMemberRole,
} from "@xiqu/shared";
import { badRequest, notFound } from "./errors.js";
import type { ApiAnnotationMode, ApiUser } from "./domain.js";
import type { PrismaPlatformRepository } from "./repository.js";
import type { LocalObjectStorage } from "./storage.js";
import type { CourseAssignmentService } from "./courseAssignmentService.js";

type LoginBody = {
  accountName?: string;
  password?: string;
};

type CreateMediaBody = {
  title?: string;
  description?: string | null;
  primaryFileId?: string | null;
};

type CreateProjectBody = {
  title?: string;
  mediaAssetId?: string;
};

type ProjectParams = {
  projectId: string;
};

type DocumentParams = {
  documentId: string;
};

type FileParams = {
  fileId: string;
};

type FileContentQuery = {
  access_token?: string;
};

type ByteRange = {
  start: number;
  end: number;
};

type VersionParams = {
  versionId: string;
};

type CreateDocumentBody = {
  title?: string;
  mode?: ApiAnnotationMode;
  initialPayload?: unknown;
};

type SaveDocumentBody = {
  baseRevision?: number;
  payload?: unknown;
};

type CreateVersionBody = {
  name?: string;
  description?: string | null;
};

type CreateJobBody = {
  type?: ProcessingJobType;
  inputFileIds?: string[];
  documentId?: string | null;
};

type ValidDraftAssignmentBody = {
  title: string;
  description?: string | null;
  startAt?: string | null;
  dueAt?: string | null;
  scope: {
    startTime?: number | null;
    endTime?: number | null;
    trackIds: string[];
  };
  recipientUserIds: string[];
};

const processingJobTypes = new Set<ProcessingJobType>([
  "pitch_extraction",
  "spectrogram_generation",
  "staff_notation_render",
  "gongche_render",
  "pose_estimation",
  "video_transcode",
  "audio_extract",
  "annotation_export",
]);

export function registerApiRoutes(
  app: FastifyInstance,
  repository: PrismaPlatformRepository,
  storage: LocalObjectStorage,
  courseAssignments: CourseAssignmentService,
) {
  app.get("/api/health", async () => ({
    status: "ok",
    service: "xiqu-platform-api",
    time: new Date().toISOString(),
  }));

  app.post<{ Body: LoginBody }>("/api/auth/login", async (request) => {
    if (!request.body?.accountName || !request.body.password) {
      throw badRequest("账号和密码不能为空。");
    }
    return repository.login(request.body.accountName, request.body.password);
  });

  app.get("/api/auth/me", async (request) => getCurrentUser(repository, request));

  app.get<{ Querystring: { courseId?: string; query?: string; limit?: string } }>("/api/users", async (request) => {
    const user = await getCurrentUser(repository, request);
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw badRequest("limit 必须是 1–100 的整数。");
    }
    return courseAssignments.listDirectoryUsers(user, {
      courseId: request.query.courseId?.trim() || undefined,
      query: request.query.query?.trim() || undefined,
      limit,
    });
  });

  app.get("/api/courses", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.listCourses(user);
  });

  app.post<{ Body: { title?: string; description?: string | null } }>("/api/courses", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (
      typeof request.body?.title !== "string" ||
      !request.body.title.trim() ||
      (request.body.description !== undefined &&
        request.body.description !== null &&
        typeof request.body.description !== "string")
    ) {
      throw badRequest("课程名称不能为空，说明必须是字符串或 null。");
    }
    return courseAssignments.createCourse(user, {
      title: request.body.title.trim(),
      description: request.body.description?.trim() || null,
    });
  });

  app.get<{ Params: { courseId: string } }>("/api/courses/:courseId", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.getCourse(user, request.params.courseId);
  });

  app.get<{ Params: { courseId: string } }>("/api/courses/:courseId/members", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.listCourseMembers(user, request.params.courseId);
  });

  app.post<{ Params: { courseId: string }; Body: { userId?: string; role?: CourseMemberRole } }>("/api/courses/:courseId/members", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (
      typeof request.body?.userId !== "string" ||
      !request.body.userId.trim() ||
      !isCourseMemberRole(request.body.role)
    ) {
      throw badRequest("课程成员必须包含有效 userId 和 role。");
    }
    return courseAssignments.addCourseMember(user, request.params.courseId, {
      userId: request.body.userId,
      role: request.body.role,
    });
  });

  app.patch<{ Params: { courseId: string; memberId: string }; Body: { role?: CourseMemberRole } }>("/api/courses/:courseId/members/:memberId", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!isCourseMemberRole(request.body?.role)) {
      throw badRequest("role 必须是 instructor、assistant 或 student。");
    }
    return courseAssignments.updateCourseMember(
      user,
      request.params.courseId,
      request.params.memberId,
      { role: request.body.role },
    );
  });

  app.delete<{ Params: { courseId: string; memberId: string } }>("/api/courses/:courseId/members/:memberId", async (request) => {
    const user = await getCurrentUser(repository, request);
    await courseAssignments.removeCourseMember(user, request.params.courseId, request.params.memberId);
    return { data: null };
  });

  app.get<{ Params: { courseId: string } }>("/api/courses/:courseId/assignments", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.listCourseAssignments(user, request.params.courseId);
  });

  app.post<{
    Params: { courseId: string };
    Body: {
      title?: string; description?: string | null; projectId?: string;
      sourceDocumentId?: string; startAt?: string | null; dueAt?: string | null;
      scope?: { startTime?: number | null; endTime?: number | null; trackIds?: string[] };
      recipientUserIds?: string[];
    };
  }>("/api/courses/:courseId/assignments", async (request) => {
    const user = await getCurrentUser(repository, request);
    const body = request.body;
    if (
      typeof body?.title !== "string" || !body.title.trim() ||
      typeof body.projectId !== "string" || !body.projectId.trim() ||
      typeof body.sourceDocumentId !== "string" || !body.sourceDocumentId.trim() ||
      (body.description !== undefined && body.description !== null && typeof body.description !== "string") ||
      !isOptionalIsoDate(body.startAt) || !isOptionalIsoDate(body.dueAt) ||
      !body.scope || !Array.isArray(body.scope.trackIds) ||
      body.scope.trackIds.some((id) => typeof id !== "string" || !id.trim()) ||
      !isOptionalFiniteNumber(body.scope.startTime) ||
      !isOptionalFiniteNumber(body.scope.endTime) ||
      !Array.isArray(body.recipientUserIds) || body.recipientUserIds.length === 0 ||
      body.recipientUserIds.some((id) => typeof id !== "string" || !id.trim()) ||
      new Set(body.recipientUserIds.map((id) => id.trim())).size !== body.recipientUserIds.length
    ) {
      throw badRequest("作业标题、基准文档、范围和至少一名学生不能为空。");
    }
    return courseAssignments.createAssignment(user, request.params.courseId, {
      title: body.title.trim(),
      description: body.description?.trim() || null,
      projectId: body.projectId.trim(),
      sourceDocumentId: body.sourceDocumentId.trim(),
      startAt: body.startAt ?? null,
      dueAt: body.dueAt ?? null,
      scope: {
        startTime: body.scope.startTime ?? null,
        endTime: body.scope.endTime ?? null,
        trackIds: [...new Set(body.scope.trackIds.map((id) => id.trim()))],
      },
      recipientUserIds: body.recipientUserIds.map((id) => id.trim()),
    });
  });

  app.get<{ Params: { assignmentId: string } }>("/api/assignments/:assignmentId", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.getAssignment(user, request.params.assignmentId);
  });

  app.patch<{
    Params: { assignmentId: string };
    Body: {
      title?: string; description?: string | null; startAt?: string | null; dueAt?: string | null;
      scope?: { startTime?: number | null; endTime?: number | null; trackIds?: string[] };
      recipientUserIds?: string[];
    };
  }>("/api/assignments/:assignmentId", async (request) => {
    const user = await getCurrentUser(repository, request);
    const body = request.body;
    if (!isValidDraftAssignmentBody(body)) {
      throw badRequest("草稿必须包含合法标题、日期、范围和至少一名学生。");
    }
    return courseAssignments.updateDraftAssignment(user, request.params.assignmentId, {
      title: body.title.trim(),
      description: body.description?.trim() || null,
      startAt: body.startAt ?? null,
      dueAt: body.dueAt ?? null,
      scope: {
        startTime: body.scope.startTime ?? null,
        endTime: body.scope.endTime ?? null,
        trackIds: [...new Set(body.scope.trackIds.map((id) => id.trim()))],
      },
      recipientUserIds: body.recipientUserIds.map((id) => id.trim()),
    });
  });

  app.post<{ Params: { assignmentId: string } }>("/api/assignments/:assignmentId/publish", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.publishAssignment(user, request.params.assignmentId);
  });

  app.get<{ Params: { assignmentId: string } }>("/api/assignments/:assignmentId/recipients", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.listAssignmentRecipients(user, request.params.assignmentId);
  });

  app.post<{ Params: { assignmentId: string } }>("/api/assignments/:assignmentId/submit", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.submitAssignment(user, request.params.assignmentId);
  });

  app.post<{ Params: { assignmentId: string; recipientId: string }; Body: { feedback?: string | null } }>("/api/assignments/:assignmentId/recipients/:recipientId/return", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (
      request.body?.feedback !== undefined &&
      request.body.feedback !== null &&
      typeof request.body.feedback !== "string"
    ) {
      throw badRequest("退回说明必须是字符串或 null。");
    }
    return courseAssignments.returnAssignment(
      user,
      request.params.assignmentId,
      request.params.recipientId,
      { feedback: request.body?.feedback?.trim() || null },
    );
  });

  app.get("/api/my-assignments", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.listMyAssignments(user);
  });

  app.get<{ Params: DocumentParams }>("/api/annotation-documents/:documentId/permission-tracks", async (request) => {
    const user = await getCurrentUser(repository, request);
    return courseAssignments.listPermissionTracks(user, request.params.documentId);
  });

  app.get("/api/files", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listFiles(user);
  });

  app.get<{ Params: FileParams; Querystring: FileContentQuery }>("/api/files/:fileId/content", async (request, reply) => {
    const user = await getCurrentUser(repository, request, request.query.access_token ?? null);
    const file = await repository.getFileForRead(user, request.params.fileId);
    const range = parseByteRange(request.headers.range, file.size);

    reply.header("content-type", file.mimeType);
    reply.header("accept-ranges", "bytes");
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);

    if (range === "unsatisfiable") {
      reply.header("content-range", `bytes */${file.size}`);
      return reply.status(416).send();
    }

    if (range) {
      reply.header("content-length", String(range.end - range.start + 1));
      reply.header("content-range", `bytes ${range.start}-${range.end}/${file.size}`);
      return reply.status(206).send(storage.getObjectStream(file.storageKey, range));
    }

    reply.header("content-length", String(file.size));
    return reply.send(storage.getObjectStream(file.storageKey));
  });

  app.post("/api/files", async (request) => {
    const user = await getCurrentUser(repository, request);
    const uploadedFile = await request.file();
    if (!uploadedFile) {
      throw badRequest("请选择要上传的文件。");
    }
    const storageKey = storage.createStorageKey(uploadedFile.filename);
    const storedBinary = await storage.putObject(storageKey, uploadedFile.file);
    const file = await repository.createUploadedFile(user, {
      name: uploadedFile.filename,
      mimeType: uploadedFile.mimetype || "application/octet-stream",
      size: storedBinary.size,
      storageKey,
      checksum: storedBinary.checksum,
    });
    return { file };
  });

  app.get("/api/media", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listMediaAssets(user);
  });

  app.post<{ Body: CreateMediaBody }>("/api/media", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.title) {
      throw badRequest("媒体标题不能为空。");
    }
    return repository.createMediaAsset(user, {
      title: request.body.title,
      description: request.body.description ?? null,
      primaryFileId: request.body.primaryFileId ?? null,
    });
  });

  app.get("/api/projects", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listProjects(user);
  });

  app.post<{ Body: CreateProjectBody }>("/api/projects", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.title || !request.body.mediaAssetId) {
      throw badRequest("项目标题和媒体资产不能为空。");
    }
    return repository.createProject(user, {
      title: request.body.title,
      mediaAssetId: request.body.mediaAssetId,
    });
  });

  app.get<{ Params: ProjectParams }>("/api/projects/:projectId/documents", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listProjectDocuments(user, request.params.projectId);
  });

  app.post<{ Params: ProjectParams; Body: CreateDocumentBody }>("/api/projects/:projectId/documents", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.title || !isAnnotationMode(request.body.mode)) {
      throw badRequest("标注文档标题和模式不能为空。");
    }
    return repository.createDocument(user, request.params.projectId, {
      title: request.body.title,
      mode: request.body.mode,
      initialPayload: request.body.initialPayload ?? {},
    });
  });

  app.get<{ Params: DocumentParams }>("/api/annotation-documents/:documentId", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.getDocument(user, request.params.documentId);
  });

  app.post<{ Params: DocumentParams; Body: SaveDocumentBody }>("/api/annotation-documents/:documentId/save", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (typeof request.body?.baseRevision !== "number") {
      throw badRequest("保存文档必须包含 baseRevision。");
    }
    return repository.saveDocument(user, request.params.documentId, {
      baseRevision: request.body.baseRevision,
      payload: request.body.payload ?? {},
    });
  });

  app.get<{ Params: DocumentParams }>("/api/annotation-documents/:documentId/versions", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listVersions(user, request.params.documentId);
  });

  app.post<{ Params: DocumentParams; Body: CreateVersionBody }>("/api/annotation-documents/:documentId/versions", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.name) {
      throw badRequest("版本名称不能为空。");
    }
    return repository.createVersion(user, request.params.documentId, {
      name: request.body.name,
      description: request.body.description ?? null,
    });
  });

  app.post<{ Params: VersionParams }>("/api/annotation-versions/:versionId/restore", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.restoreVersion(user, request.params.versionId);
  });

  app.post<{ Body: CreateJobBody }>("/api/jobs", async (request) => {
    const user = await getCurrentUser(repository, request);
    const { type, inputFileIds, documentId } = request.body ?? {};
    if (
      !type ||
      !processingJobTypes.has(type) ||
      !Array.isArray(inputFileIds) ||
      inputFileIds.length === 0 ||
      inputFileIds.some((fileId) => typeof fileId !== "string" || !fileId.trim())
    ) {
      throw badRequest("任务类型和输入文件不能为空。");
    }
    if (
      documentId !== undefined &&
      documentId !== null &&
      (typeof documentId !== "string" || !documentId.trim())
    ) {
      throw badRequest("documentId 必须是非空字符串或 null。");
    }
    return repository.createProcessingJob(user, {
      type,
      inputFileIds: [...new Set(inputFileIds.map((fileId) => fileId.trim()))],
      documentId: documentId?.trim() || null,
    });
  });

  // 审计日志查询。管理员可全局访问，其他用户必须管理指定的项目或文档。
  app.get<{ Querystring: { projectId?: string; documentId?: string; actorUserId?: string; limit?: string } }>("/api/audit-logs", async (request) => {
    const user = await getCurrentUser(repository, request);
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    // limit 非法时显式拒绝，避免 NaN/小数透传到 Prisma take。
    if (limit !== undefined && (!isNonNegativeInteger(limit) || limit < 1)) {
      throw badRequest("limit 必须是正整数。");
    }
    return repository.listAuditLogs(user, {
      projectId: request.query.projectId,
      documentId: request.query.documentId,
      actorUserId: request.query.actorUserId,
      limit,
    });
  });

  // 列出文档标注操作日志。
  app.get<{ Params: DocumentParams }>("/api/annotation-documents/:documentId/operations", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listOperations(user, request.params.documentId);
  });

  // 提交一条标注操作。初版只落日志，不改变文档 snapshot。
  app.post<{ Params: DocumentParams; Body: { baseRevision?: number; localRevision?: number | null; action?: string; payload?: unknown } }>("/api/annotation-documents/:documentId/operations", async (request) => {
    const user = await getCurrentUser(repository, request);
    const { baseRevision, localRevision, action, payload } = request.body ?? {};
    if (!isNonNegativeInteger(baseRevision) || typeof action !== "string" || !action.trim()) {
      throw badRequest("operation 必须包含 baseRevision 和 action。");
    }
    if (localRevision !== undefined && localRevision !== null && !isNonNegativeInteger(localRevision)) {
      throw badRequest("localRevision 必须是非负整数或 null。");
    }
    return repository.createOperation(user, request.params.documentId, {
      baseRevision,
      localRevision: localRevision ?? null,
      action: action.trim(),
      payload: payload ?? {},
    });
  });

  // 获取当前用户对文档的有效权限摘要。
  app.get<{ Params: DocumentParams }>("/api/annotation-documents/:documentId/permissions/effective", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.getEffectiveDocumentPermission(user, request.params.documentId);
  });

  // 列出文档的所有 grant。需项目 owner / 管理员 / manage 权限。
  app.get<{ Params: DocumentParams }>("/api/annotation-documents/:documentId/grants", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listDocumentGrants(user, request.params.documentId);
  });

  // 为文档新增一条 grant。
  app.post<{ Params: DocumentParams; Body: { userId?: string; actions?: unknown; scope?: unknown; expiresAt?: unknown } }>("/api/annotation-documents/:documentId/grants", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.userId) {
      throw badRequest("userId 和 actions 不能为空。");
    }
    const actions = parsePermissionActions(request.body.actions, true);
    const scope = parseCreatePermissionScope(request.body.scope);
    const expiresAt = parseExpiration(request.body.expiresAt);
    return repository.createDocumentGrant(user, request.params.documentId, {
      userId: request.body.userId,
      actions,
      scope,
      expiresAt,
    });
  });

  // 修改已有 grant。
  app.patch<{ Params: { grantId: string }; Body: { actions?: unknown; scope?: unknown; expiresAt?: unknown } }>("/api/permission-grants/:grantId", async (request) => {
    const user = await getCurrentUser(repository, request);
    const body = request.body ?? {};
    if (
      body.actions === undefined &&
      body.scope === undefined &&
      body.expiresAt === undefined
    ) {
      throw badRequest("至少需要提供一个要更新的授权字段。");
    }
    return repository.updatePermissionGrant(user, request.params.grantId, {
      actions: body.actions === undefined
        ? undefined
        : parsePermissionActions(body.actions, true),
      scope: parseUpdatePermissionScope(body.scope),
      expiresAt: body.expiresAt === undefined
        ? undefined
        : parseExpiration(body.expiresAt),
    });
  });

  // 撤销 grant。
  app.delete<{ Params: { grantId: string } }>("/api/permission-grants/:grantId", async (request) => {
    const user = await getCurrentUser(repository, request);
    await repository.revokePermissionGrant(user, request.params.grantId);
    return { data: null };
  });

  app.setNotFoundHandler(() => {
    throw notFound("接口不存在。");
  });
}

async function getCurrentUser(
  repository: PrismaPlatformRepository,
  request: FastifyRequest,
  fallbackToken: string | null = null,
): Promise<ApiUser> {
  return repository.getUserByToken(getBearerToken(request) ?? fallbackToken);
}

function getBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}

function isAnnotationMode(value: unknown): value is ApiAnnotationMode {
  return value === "independent" || value === "collaborative";
}

function isCourseMemberRole(value: unknown): value is CourseMemberRole {
  return value === "instructor" || value === "assistant" || value === "student";
}

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || value === null ||
    (typeof value === "number" && Number.isFinite(value));
}

function isOptionalIsoDate(value: unknown) {
  return value === undefined || value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isValidDraftAssignmentBody(value: unknown): value is ValidDraftAssignmentBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const scope = body.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return false;
  const scopeRecord = scope as Record<string, unknown>;
  return (
    typeof body.title === "string" &&
    Boolean(body.title.trim()) &&
    (body.description === undefined || body.description === null || typeof body.description === "string") &&
    isOptionalIsoDate(body.startAt) &&
    isOptionalIsoDate(body.dueAt) &&
    isOptionalFiniteNumber(scopeRecord.startTime) &&
    isOptionalFiniteNumber(scopeRecord.endTime) &&
    Array.isArray(scopeRecord.trackIds) &&
    scopeRecord.trackIds.every((id) => typeof id === "string" && Boolean(id.trim())) &&
    Array.isArray(body.recipientUserIds) &&
    body.recipientUserIds.length > 0 &&
    body.recipientUserIds.every((id) => typeof id === "string" && Boolean(id.trim())) &&
    new Set(body.recipientUserIds.map((id) => (id as string).trim())).size === body.recipientUserIds.length
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const PERMISSION_ACTIONS = new Set<PermissionAction>([
  "view",
  "edit",
  "comment",
  "submit",
  "review",
  "merge",
  "confirm",
  "manage",
]);

function parsePermissionActions(value: unknown, required: boolean) {
  if (!Array.isArray(value)) {
    throw badRequest("actions 必须是权限动作数组。");
  }
  const actions = [...new Set(value)];
  if (
    (required && actions.length === 0) ||
    actions.some((action) =>
      typeof action !== "string" ||
      !PERMISSION_ACTIONS.has(action as PermissionAction),
    )
  ) {
    throw badRequest("actions 包含空值或不支持的权限动作。");
  }
  return actions as PermissionAction[];
}

function parseCreatePermissionScope(value: unknown): PermissionScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = validatePermissionScope(value);
  if (!result.valid) {
    throw badRequest(result.reason);
  }
  return value as PermissionScope;
}

function parseUpdatePermissionScope(value: unknown): MutablePermissionScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("scope 必须是对象。");
  }
  const scope = value as Record<string, unknown>;
  if (
    Object.keys(scope).some((key) =>
      key !== "timeRange" && key !== "trackScope",
    )
  ) {
    throw badRequest("更新 scope 只能包含 timeRange 和 trackScope。");
  }
  const validationValue = {
    ...(scope.timeRange === null ? {} : { timeRange: scope.timeRange }),
    ...(scope.trackScope === null ? {} : { trackScope: scope.trackScope }),
  };
  const result = validatePermissionScope(validationValue);
  if (!result.valid) {
    throw badRequest(result.reason);
  }
  return {
    timeRange: scope.timeRange as MutablePermissionScope["timeRange"],
    trackScope: scope.trackScope as MutablePermissionScope["trackScope"],
  };
}

function parseExpiration(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw badRequest("expiresAt 必须是 ISO 日期字符串或 null。");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw badRequest("expiresAt 必须是有效的未来时间。");
  }
  return new Date(timestamp).toISOString();
}

function parseByteRange(header: string | string[] | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const rawHeader = Array.isArray(header) ? header[0] : header;
  if (!rawHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rawHeader.trim());
  if (!match) {
    return "unsatisfiable";
  }

  const [, startText, endText] = match;
  if (!startText && !endText) {
    return "unsatisfiable";
  }

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "unsatisfiable";
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}
