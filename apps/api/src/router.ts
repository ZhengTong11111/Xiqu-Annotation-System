import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AnnotationVersionKind,
  MutableProjectScope,
  ProcessingJobType,
  ProjectCapability,
  ProjectMemberRole,
  WorkspaceStatus,
  WorkspaceType,
} from "@xiqu/shared";
import { PROJECT_CAPABILITIES as PROJECT_CAPABILITY_LIST } from "@xiqu/shared";
import { validateProjectScope } from "@xiqu/document-model";
import type { AnnotationVersionService } from "./annotationVersionService.js";
import type { AnnotationWorkspaceService } from "./annotationWorkspaceService.js";
import { badRequest } from "./errors.js";
import type { ProjectMemberService } from "./projectMemberService.js";
import type { ProjectVersionService } from "./projectVersionService.js";
import type { PrismaPlatformRepository } from "./repository.js";
import type { LocalObjectStorage } from "./storage.js";

type Services = {
  projectMembers: ProjectMemberService;
  annotationWorkspaces: AnnotationWorkspaceService;
  annotationVersions: AnnotationVersionService;
  projectVersions: ProjectVersionService;
};

const PROJECT_MEMBER_ROLES = new Set<ProjectMemberRole>([
  "manager",
  "reviewer",
  "annotator",
  "viewer",
]);
const PROJECT_CAPABILITIES = new Set<ProjectCapability>(
  PROJECT_CAPABILITY_LIST,
);
const WORKSPACE_TYPES = new Set<WorkspaceType>([
  "main",
  "personal",
  "collaborative",
]);
const WORKSPACE_STATUSES = new Set<WorkspaceStatus>([
  "active",
  "submitted",
  "archived",
]);
const ANNOTATION_VERSION_KINDS = new Set<AnnotationVersionKind>([
  "checkpoint",
  "submission",
]);
const PROCESSING_JOB_TYPES = new Set<ProcessingJobType>([
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
  services: Services,
) {
  const {
    projectMembers,
    annotationWorkspaces,
    annotationVersions,
    projectVersions,
  } = services;

  app.get("/api/health", async () => ({
    status: "ok",
    service: "xiqu-platform-api",
    time: new Date().toISOString(),
  }));

  app.post<{ Body: { accountName?: string; password?: string } }>(
    "/api/auth/login",
    async (request) => {
      if (!request.body?.accountName || !request.body.password) {
        throw badRequest("账号和密码不能为空。");
      }
      return repository.login(request.body.accountName, request.body.password);
    },
  );
  app.get("/api/auth/me", async (request) =>
    getCurrentUser(repository, request));

  app.get<{
    Querystring: { projectId?: string; query?: string; limit?: string };
  }>("/api/users", async (request) => {
    const user = await getCurrentUser(repository, request);
    const limit = request.query.limit === undefined
      ? 50
      : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw badRequest("limit 必须是 1–100 的整数。");
    }
    return projectMembers.listDirectoryUsers(user, {
      projectId: normalizedString(request.query.projectId),
      query: normalizedString(request.query.query),
      limit,
    });
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/members",
    async (request) => {
      const user = await getCurrentUser(repository, request);
      return projectMembers.listProjectMembers(user, request.params.projectId);
    },
  );
  app.post<{
    Params: { projectId: string };
    Body: {
      userId?: unknown;
      role?: unknown;
      capabilities?: unknown;
      scope?: unknown;
      expiresAt?: unknown;
    };
  }>("/api/projects/:projectId/members", async (request) => {
    const user = await getCurrentUser(repository, request);
    const body = requireObject(request.body, [
      "userId",
      "role",
      "capabilities",
      "scope",
      "expiresAt",
    ]);
    if (
      typeof body.userId !== "string" ||
      !body.userId.trim() ||
      !isProjectMemberRole(body.role)
    ) {
      throw badRequest("项目成员必须包含有效 userId 和 role。");
    }
    return projectMembers.addProjectMember(user, request.params.projectId, {
      userId: body.userId.trim(),
      role: body.role,
      capabilities: body.capabilities === undefined
        ? undefined
        : parseCapabilities(body.capabilities),
      scope: body.scope === undefined ? undefined : parseScope(body.scope),
      expiresAt: parseExpiration(body.expiresAt),
    });
  });
  app.patch<{
    Params: { projectId: string; memberId: string };
    Body: {
      role?: unknown;
      capabilities?: unknown;
      scope?: unknown;
      expiresAt?: unknown;
    };
  }>("/api/projects/:projectId/members/:memberId", async (request) => {
    const user = await getCurrentUser(repository, request);
    const body = requireObject(request.body, [
      "role",
      "capabilities",
      "scope",
      "expiresAt",
    ], true);
    if (body.role !== undefined && !isProjectMemberRole(body.role)) {
      throw badRequest("项目角色无效。");
    }
    return projectMembers.updateProjectMember(
      user,
      request.params.projectId,
      request.params.memberId,
      {
        role: body.role,
        capabilities: body.capabilities === undefined
          ? undefined
          : parseCapabilities(body.capabilities),
        scope: body.scope === undefined ? undefined : parseScope(body.scope),
        expiresAt: body.expiresAt === undefined
          ? undefined
          : parseExpiration(body.expiresAt),
      },
    );
  });
  app.delete<{ Params: { projectId: string; memberId: string } }>(
    "/api/projects/:projectId/members/:memberId",
    async (request) => {
      const user = await getCurrentUser(repository, request);
      await projectMembers.removeProjectMember(
        user,
        request.params.projectId,
        request.params.memberId,
      );
      return null;
    },
  );
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/permission-tracks",
    async (request) => {
      const user = await getCurrentUser(repository, request);
      return projectMembers.listPermissionTracks(
        user,
        request.params.projectId,
      );
    },
  );

  app.get("/api/files", async (request) =>
    repository.listFiles(await getCurrentUser(repository, request)));
  app.get<{
    Params: { fileId: string };
    Querystring: { access_token?: string };
  }>("/api/files/:fileId/content", async (request, reply) => {
    const user = await getCurrentUser(
      repository,
      request,
      request.query.access_token ?? null,
    );
    const file = await repository.getFileForRead(user, request.params.fileId);
    const range = parseByteRange(request.headers.range, file.size);
    reply.header("content-type", file.mimeType);
    reply.header("accept-ranges", "bytes");
    reply.header(
      "content-disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    if (range === "unsatisfiable") {
      reply.header("content-range", `bytes */${file.size}`);
      return reply.status(416).send();
    }
    if (range) {
      reply.header("content-length", String(range.end - range.start + 1));
      reply.header(
        "content-range",
        `bytes ${range.start}-${range.end}/${file.size}`,
      );
      return reply.status(206).send(
        storage.getObjectStream(file.storageKey, range),
      );
    }
    reply.header("content-length", String(file.size));
    return reply.send(storage.getObjectStream(file.storageKey));
  });
  app.post("/api/files", async (request) => {
    const user = await getCurrentUser(repository, request);
    const uploaded = await request.file();
    if (!uploaded) throw badRequest("请选择要上传的文件。");
    const storageKey = storage.createStorageKey(uploaded.filename);
    const stored = await storage.putObject(storageKey, uploaded.file);
    return {
      file: await repository.createUploadedFile(user, {
        name: uploaded.filename,
        mimeType: uploaded.mimetype || "application/octet-stream",
        size: stored.size,
        storageKey,
        checksum: stored.checksum,
      }),
    };
  });

  app.get("/api/media", async (request) =>
    repository.listMediaAssets(await getCurrentUser(repository, request)));
  app.post<{
    Body: {
      title?: string;
      description?: string | null;
      primaryFileId?: string | null;
    };
  }>("/api/media", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.title?.trim()) {
      throw badRequest("媒体标题不能为空。");
    }
    return repository.createMediaAsset(user, {
      title: request.body.title.trim(),
      description: request.body.description ?? null,
      primaryFileId: request.body.primaryFileId ?? null,
    });
  });

  app.get("/api/projects", async (request) =>
    repository.listProjects(await getCurrentUser(repository, request)));
  app.post<{ Body: { title?: string; mediaAssetId?: string } }>(
    "/api/projects",
    async (request) => {
      const user = await getCurrentUser(repository, request);
      if (!request.body?.title?.trim() || !request.body.mediaAssetId?.trim()) {
        throw badRequest("项目标题和媒体资产不能为空。");
      }
      return repository.createProject(user, {
        title: request.body.title.trim(),
        mediaAssetId: request.body.mediaAssetId.trim(),
      });
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { ownerUserId?: string };
  }>("/api/projects/:projectId/workspaces", async (request) => {
    const user = await getCurrentUser(repository, request);
    return annotationWorkspaces.listProjectWorkspaces(
      user,
      request.params.projectId,
      normalizedString(request.query.ownerUserId),
    );
  });
  app.post<{
    Params: { projectId: string };
    Body: {
      name?: unknown;
      workspaceType?: unknown;
      ownerUserId?: unknown;
      initialPayload?: unknown;
    };
  }>("/api/projects/:projectId/workspaces", async (request) => {
    const user = await getCurrentUser(repository, request);
    const body = requireObject(request.body, [
      "name",
      "workspaceType",
      "ownerUserId",
      "initialPayload",
    ]);
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw badRequest("工作区名称不能为空。");
    }
    if (
      body.workspaceType !== undefined &&
      !isWorkspaceType(body.workspaceType)
    ) {
      throw badRequest("工作区类型无效。");
    }
    if (
      body.ownerUserId !== undefined &&
      (typeof body.ownerUserId !== "string" || !body.ownerUserId.trim())
    ) {
      throw badRequest("ownerUserId 必须是非空字符串。");
    }
    return annotationWorkspaces.createWorkspace(
      user,
      request.params.projectId,
      {
        name: body.name.trim(),
        workspaceType: body.workspaceType,
        ownerUserId: normalizedString(body.ownerUserId),
        initialPayload: body.initialPayload ?? {},
      },
    );
  });
  app.get<{ Params: { workspaceId: string } }>(
    "/api/annotation-workspaces/:workspaceId",
    async (request) =>
      annotationWorkspaces.getWorkspace(
        await getCurrentUser(repository, request),
        request.params.workspaceId,
      ),
  );
  app.post<{
    Params: { workspaceId: string };
    Body: { baseRevision?: unknown; payload?: unknown };
  }>("/api/annotation-workspaces/:workspaceId/save", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!isNonNegativeInteger(request.body?.baseRevision)) {
      throw badRequest("保存工作区必须包含非负整数 baseRevision。");
    }
    return annotationWorkspaces.saveWorkspace(
      user,
      request.params.workspaceId,
      {
        baseRevision: request.body.baseRevision,
        payload: request.body.payload ?? {},
      },
    );
  });
  app.patch<{
    Params: { workspaceId: string };
    Body: { status?: unknown };
  }>("/api/annotation-workspaces/:workspaceId/status", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!isWorkspaceStatus(request.body?.status)) {
      throw badRequest("工作区状态无效。");
    }
    return annotationWorkspaces.updateWorkspaceStatus(
      user,
      request.params.workspaceId,
      { status: request.body.status },
    );
  });

  app.get<{
    Params: { projectId: string };
    Querystring: { createdBy?: string; workspaceId?: string };
  }>("/api/projects/:projectId/annotation-versions", async (request) => {
    const user = await getCurrentUser(repository, request);
    return annotationVersions.listProjectVersions(
      user,
      request.params.projectId,
      {
        createdBy: normalizedString(request.query.createdBy),
        workspaceId: normalizedString(request.query.workspaceId),
      },
    );
  });
  app.get<{ Params: { workspaceId: string } }>(
    "/api/annotation-workspaces/:workspaceId/versions",
    async (request) =>
      annotationVersions.listWorkspaceVersions(
        await getCurrentUser(repository, request),
        request.params.workspaceId,
      ),
  );
  app.post<{
    Params: { workspaceId: string };
    Body: {
      name?: unknown;
      description?: unknown;
      kind?: unknown;
    };
  }>("/api/annotation-workspaces/:workspaceId/versions", async (request) => {
    const user = await getCurrentUser(repository, request);
    const body = requireObject(request.body, ["name", "description", "kind"]);
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw badRequest("标注版本名称不能为空。");
    }
    if (body.kind !== undefined && !isAnnotationVersionKind(body.kind)) {
      throw badRequest("标注版本类型无效。");
    }
    return annotationVersions.completeVersion(
      user,
      request.params.workspaceId,
      {
        name: body.name.trim(),
        description: nullableString(body.description),
        kind: body.kind,
      },
    );
  });
  app.post<{
    Params: { versionId: string };
    Body: { workspaceName?: unknown };
  }>("/api/annotation-versions/:versionId/forks", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (
      typeof request.body?.workspaceName !== "string" ||
      !request.body.workspaceName.trim()
    ) {
      throw badRequest("Fork 后的工作区名称不能为空。");
    }
    return annotationVersions.forkVersion(
      user,
      request.params.versionId,
      { workspaceName: request.body.workspaceName.trim() },
    );
  });
  app.patch<{
    Params: { versionId: string };
    Body: { status?: unknown };
  }>("/api/annotation-versions/:versionId/status", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (request.body?.status !== "archived") {
      throw badRequest("已完成标注版本只支持归档。");
    }
    return annotationVersions.updateVersionStatus(
      user,
      request.params.versionId,
      { status: request.body.status },
    );
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/project-versions",
    async (request) =>
      projectVersions.listProjectVersions(
        await getCurrentUser(repository, request),
        request.params.projectId,
      ),
  );
  app.post<{
    Params: { projectId: string };
    Body: {
      sourceVersionId?: unknown;
      name?: unknown;
      description?: unknown;
    };
  }>("/api/projects/:projectId/project-versions", async (request) => {
    const user = await getCurrentUser(repository, request);
    const body = requireObject(request.body, [
      "sourceVersionId",
      "name",
      "description",
    ]);
    if (
      typeof body.sourceVersionId !== "string" ||
      !body.sourceVersionId.trim() ||
      typeof body.name !== "string" ||
      !body.name.trim()
    ) {
      throw badRequest("项目版本必须包含来源标注版本和名称。");
    }
    return projectVersions.createProjectVersion(
      user,
      request.params.projectId,
      {
        sourceVersionId: body.sourceVersionId.trim(),
        name: body.name.trim(),
        description: nullableString(body.description),
      },
    );
  });
  app.post<{ Params: { projectVersionId: string } }>(
    "/api/project-versions/:projectVersionId/publish",
    async (request) =>
      projectVersions.publishProjectVersion(
        await getCurrentUser(repository, request),
        request.params.projectVersionId,
      ),
  );
  app.patch<{
    Params: { projectVersionId: string };
    Body: { status?: unknown };
  }>("/api/project-versions/:projectVersionId/status", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (request.body?.status !== "archived") {
      throw badRequest("项目版本状态更新只支持 archived。");
    }
    return projectVersions.updateProjectVersionStatus(
      user,
      request.params.projectVersionId,
      { status: "archived" },
    );
  });

  app.post<{
    Body: {
      type?: unknown;
      inputFileIds?: unknown;
      workspaceId?: unknown;
    };
  }>("/api/jobs", async (request) => {
    const user = await getCurrentUser(repository, request);
    const { type, inputFileIds, workspaceId } = request.body ?? {};
    if (
      !isProcessingJobType(type) ||
      !Array.isArray(inputFileIds) ||
      inputFileIds.length === 0 ||
      inputFileIds.some((id) => typeof id !== "string" || !id.trim())
    ) {
      throw badRequest("任务类型和输入文件不能为空。");
    }
    if (
      workspaceId !== undefined &&
      workspaceId !== null &&
      (typeof workspaceId !== "string" || !workspaceId.trim())
    ) {
      throw badRequest("workspaceId 必须是非空字符串或 null。");
    }
    return repository.createProcessingJob(user, {
      type,
      inputFileIds: [...new Set(inputFileIds.map((id) => id.trim()))],
      workspaceId: normalizedString(workspaceId) ?? null,
    });
  });

  app.get<{
    Querystring: {
      projectId?: string;
      workspaceId?: string;
      actorUserId?: string;
      limit?: string;
    };
  }>("/api/audit-logs", async (request) => {
    const user = await getCurrentUser(repository, request);
    const limit = request.query.limit === undefined
      ? undefined
      : Number(request.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw badRequest("limit 必须是正整数。");
    }
    return repository.listAuditLogs(user, {
      projectId: normalizedString(request.query.projectId),
      workspaceId: normalizedString(request.query.workspaceId),
      actorUserId: normalizedString(request.query.actorUserId),
      limit,
    });
  });
  app.get<{ Params: { workspaceId: string } }>(
    "/api/annotation-workspaces/:workspaceId/operations",
    async (request) =>
      repository.listOperations(
        await getCurrentUser(repository, request),
        request.params.workspaceId,
      ),
  );
  app.post<{
    Params: { workspaceId: string };
    Body: {
      baseRevision?: unknown;
      localRevision?: unknown;
      action?: unknown;
      payload?: unknown;
    };
  }>("/api/annotation-workspaces/:workspaceId/operations", async (request) => {
    const user = await getCurrentUser(repository, request);
    const { baseRevision, localRevision, action, payload } = request.body ?? {};
    if (
      !isNonNegativeInteger(baseRevision) ||
      typeof action !== "string" ||
      !action.trim()
    ) {
      throw badRequest("operation 必须包含 baseRevision 和 action。");
    }
    if (
      localRevision !== undefined &&
      localRevision !== null &&
      !isNonNegativeInteger(localRevision)
    ) {
      throw badRequest("localRevision 必须是非负整数或 null。");
    }
    return repository.createOperation(user, request.params.workspaceId, {
      baseRevision,
      localRevision: localRevision as number | null | undefined,
      action: action.trim(),
      payload: payload ?? {},
    });
  });
}

async function getCurrentUser(
  repository: PrismaPlatformRepository,
  request: FastifyRequest,
  fallbackToken: string | null = null,
) {
  return repository.getUserByToken(
    getBearerToken(request) ?? fallbackToken,
  );
}

function getBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function requireObject(
  value: unknown,
  allowedKeys: string[],
  requireAtLeastOne = false,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("请求结构无效。");
  }
  const record = value as Record<string, unknown>;
  if (
    (requireAtLeastOne && Object.keys(record).length === 0) ||
    Object.keys(record).some((key) => !allowedKeys.includes(key))
  ) {
    throw badRequest("请求包含未知字段或缺少更新内容。");
  }
  return record;
}

function parseCapabilities(value: unknown): ProjectCapability[] {
  if (
    !Array.isArray(value) ||
    value.some((capability) =>
      typeof capability !== "string" ||
      !PROJECT_CAPABILITIES.has(capability as ProjectCapability)
    )
  ) {
    throw badRequest("capabilities 必须是有效项目能力数组。");
  }
  return [...new Set(value)] as ProjectCapability[];
}

function parseScope(value: unknown): MutableProjectScope {
  if (value === null) {
    return { timeRange: null, trackScope: null };
  }
  const validation = validateProjectScope(value);
  if (!validation.valid) throw badRequest(validation.reason);
  const record = value as {
    timeRange?: MutableProjectScope["timeRange"];
    trackScope?: MutableProjectScope["trackScope"];
  };
  return {
    timeRange: record.timeRange,
    trackScope: record.trackScope,
  };
}

function parseExpiration(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw badRequest("expiresAt 必须是合法日期或 null。");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw badRequest("说明必须是字符串。");
  return value.trim() || null;
}

function normalizedString(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return typeof value === "string" &&
    PROJECT_MEMBER_ROLES.has(value as ProjectMemberRole);
}

function isWorkspaceType(value: unknown): value is WorkspaceType {
  return typeof value === "string" &&
    WORKSPACE_TYPES.has(value as WorkspaceType);
}

function isWorkspaceStatus(value: unknown): value is WorkspaceStatus {
  return typeof value === "string" &&
    WORKSPACE_STATUSES.has(value as WorkspaceStatus);
}

function isAnnotationVersionKind(
  value: unknown,
): value is AnnotationVersionKind {
  return typeof value === "string" &&
    ANNOTATION_VERSION_KINDS.has(value as AnnotationVersionKind);
}

function isProcessingJobType(value: unknown): value is ProcessingJobType {
  return typeof value === "string" &&
    PROCESSING_JOB_TYPES.has(value as ProcessingJobType);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

type ByteRange = { start: number; end: number };

function parseByteRange(
  header: string | undefined,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return "unsatisfiable";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "unsatisfiable";
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}
