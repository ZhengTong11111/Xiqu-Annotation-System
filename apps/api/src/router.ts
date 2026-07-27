import type { FastifyInstance, FastifyRequest } from "fastify";
import { validatePermissionScope } from "@xiqu/document-model";
import type {
  MutablePermissionScope,
  PermissionAction,
  PermissionScope,
} from "@xiqu/shared";
import { badRequest, notFound } from "./errors.js";
import type { ApiAnnotationMode, ApiUser } from "./domain.js";
import type { PrismaPlatformRepository } from "./repository.js";
import type { LocalObjectStorage } from "./storage.js";

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
  type?: "pitch_extraction" | "spectrogram_generation" | "staff_notation_render" | "gongche_render" | "pose_estimation" | "video_transcode" | "audio_extract" | "annotation_export";
  inputFileIds?: string[];
  documentId?: string | null;
};

export function registerApiRoutes(
  app: FastifyInstance,
  repository: PrismaPlatformRepository,
  storage: LocalObjectStorage,
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
    if (!request.body?.type || !Array.isArray(request.body.inputFileIds)) {
      throw badRequest("任务类型和输入文件不能为空。");
    }
    return repository.createProcessingJob(user, {
      type: request.body.type,
      inputFileIds: request.body.inputFileIds,
      documentId: request.body.documentId ?? null,
    });
  });

  // 审计日志查询。仅管理员/教师/助教可访问，支持按 project/document/actor 筛选。
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
