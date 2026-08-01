import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  RESOURCE_CAPABILITIES,
  type ProcessingJobType,
  type ResourceCapability,
  type ResourceListView,
  type ResourceSortField,
  type ResourceType,
  type SortDirection,
} from "@xiqu/shared";
import { Readable } from "node:stream";
import { badRequest } from "./errors.js";
import type { PrismaPlatformRepository } from "./repository.js";
import type { ResourceService } from "./resourceService.js";
import { MAX_BATCH_RESOURCE_SELECTION } from "./resourceSelection.js";
import type { LocalObjectStorage } from "./storage.js";

const RESOURCE_TYPES = new Set<ResourceType>([
  "folder",
  "project",
  "annotation_file",
  "media_file",
]);
const RESOURCE_VIEWS = new Set<ResourceListView>([
  "children",
  "all_projects",
  "recent",
  "favorites",
  "shared",
  "archived",
  "trash",
]);
const RESOURCE_SORT_FIELDS = new Set<ResourceSortField>([
  "name",
  "createdAt",
  "updatedAt",
  "size",
]);
const SORT_DIRECTIONS = new Set<SortDirection>(["asc", "desc"]);
const CAPABILITIES = new Set<ResourceCapability>(RESOURCE_CAPABILITIES);
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
  resources: ResourceService,
  storage: LocalObjectStorage,
) {
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

  app.get<{ Querystring: { query?: string } }>("/api/users", async (request) =>
    repository.listDirectoryUsers(
      await getCurrentUser(repository, request),
      normalizedString(request.query.query),
    ));

  app.get<{
    Querystring: {
      parentId?: string;
      view?: string;
      query?: string;
      type?: string;
      sortBy?: string;
      direction?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/api/resources", async (request) => {
    const limit = parseOptionalInteger(request.query.limit, "limit", 1, 200);
    return resources.listResources(
      await getCurrentUser(repository, request),
      {
        parentId: normalizedString(request.query.parentId),
        view: parseOptionalSetValue(
          request.query.view,
          RESOURCE_VIEWS,
          "资源视图",
        ),
        query: normalizedString(request.query.query),
        type: parseOptionalSetValue(
          request.query.type,
          RESOURCE_TYPES,
          "资源类型",
        ),
        sortBy: parseOptionalSetValue(
          request.query.sortBy,
          RESOURCE_SORT_FIELDS,
          "排序字段",
        ),
        direction: parseOptionalSetValue(
          request.query.direction,
          SORT_DIRECTIONS,
          "排序方向",
        ),
        cursor: normalizedString(request.query.cursor),
        limit,
      },
    );
  });

  app.get<{ Params: { resourceId: string } }>(
    "/api/resources/:resourceId",
    async (request) =>
      resources.getResource(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      ),
  );

  app.post<{
    Body: {
      parentId?: unknown;
      type?: unknown;
      name?: unknown;
      description?: unknown;
    };
  }>("/api/resources", async (request) => {
    const body = requireObject(request.body);
    if (
      (body.type !== "folder" && body.type !== "project") ||
      typeof body.name !== "string"
    ) {
      throw badRequest("创建资源需要有效的 type 和 name。");
    }
    const user = await getCurrentUser(repository, request);
    const created = await resources.createResource(user, {
      parentId: optionalStringOrNull(body.parentId) ?? null,
      type: body.type,
      name: body.name,
      description: optionalStringOrNull(body.description),
    });
    await repository.writeAuditLog({
      action: "resource_create",
      actorUserId: user.id,
      resourceId: created.id,
      detail: { type: created.type, name: created.name },
    });
    return created;
  });

  app.patch<{
    Params: { resourceId: string };
    Body: { name?: unknown; archived?: unknown; favorite?: unknown };
  }>("/api/resources/:resourceId", async (request) => {
    const body = requireObject(request.body);
    if (body.name !== undefined && typeof body.name !== "string") {
      throw badRequest("资源名称必须是字符串。");
    }
    if (body.archived !== undefined && typeof body.archived !== "boolean") {
      throw badRequest("archived 必须是布尔值。");
    }
    if (body.favorite !== undefined && typeof body.favorite !== "boolean") {
      throw badRequest("favorite 必须是布尔值。");
    }
    const user = await getCurrentUser(repository, request);
    const updated = await resources.updateResource(user, request.params.resourceId, {
      name: body.name,
      archived: body.archived,
      favorite: body.favorite,
    });
    await repository.writeAuditLog({
      action: "resource_update",
      actorUserId: user.id,
      resourceId: updated.id,
      detail: body,
    });
    return updated;
  });

  app.post<{
    Body: { resourceIds?: unknown; parentId?: unknown };
  }>("/api/resources/move-batch", async (request) => {
    const body = requireObject(request.body);
    const resourceIds = parseUniqueStringArray(
      body.resourceIds,
      "resourceIds",
      1,
      MAX_BATCH_RESOURCE_SELECTION,
    );
    const user = await getCurrentUser(repository, request);
    const result = await resources.moveResources(user, {
      resourceIds,
      parentId: optionalStringOrNull(body.parentId) ?? null,
    });
    for (const resource of result.moved) {
      await repository.writeAuditLog({
        action: "resource_move",
        actorUserId: user.id,
        resourceId: resource.id,
        detail: {
          parentId: resource.parentId,
          batchSize: resourceIds.length,
          collapsedSelectionCount: result.collapsedDescendantIds.length,
        },
      });
    }
    return result;
  });

  app.post<{
    Params: { resourceId: string };
    Body: { parentId?: unknown };
  }>("/api/resources/:resourceId/move", async (request) => {
    const body = requireObject(request.body);
    const user = await getCurrentUser(repository, request);
    // 单项接口保留兼容性，但与批量移动共享同一个事务核心，避免两套权限和循环规则漂移。
    const result = await resources.moveResources(user, {
      resourceIds: [request.params.resourceId],
      parentId: optionalStringOrNull(body.parentId) ?? null,
    });
    const updated = result.moved[0] ?? result.unchanged[0];
    if (!updated) throw badRequest("待移动资源不存在。");
    if (result.moved.length) {
      await repository.writeAuditLog({
        action: "resource_move",
        actorUserId: user.id,
        resourceId: updated.id,
        detail: {
          parentId: updated.parentId,
          batchSize: 1,
          collapsedSelectionCount: 0,
        },
      });
    }
    return updated;
  });

  app.post<{
    Params: { resourceId: string };
    Body: { parentId?: unknown; name?: unknown };
  }>("/api/resources/:resourceId/copy", async (request) => {
    const body = requireObject(request.body);
    if (typeof body.parentId !== "string") {
      throw badRequest("复制资源需要目标 parentId。");
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      throw badRequest("副本名称必须是字符串。");
    }
    const user = await getCurrentUser(repository, request);
    const copied = await resources.copyResource(user, request.params.resourceId, {
      parentId: body.parentId,
      name: body.name,
    });
    await repository.writeAuditLog({
      action: "resource_copy",
      actorUserId: user.id,
      resourceId: copied.resource.id,
      detail: {
        sourceResourceId: request.params.resourceId,
        copiedNodeCount: copied.summary.copiedNodeCount,
        copiedAnnotationCount: copied.summary.copiedAnnotationCount,
        reusedFileObjectCount: copied.summary.reusedFileObjectCount,
      },
    });
    return copied.resource;
  });

  app.post<{ Body: { resourceIds?: unknown } }>(
    "/api/resources/trash-batch",
    async (request) => {
      const body = requireObject(request.body);
      const resourceIds = parseUniqueStringArray(
        body.resourceIds,
        "resourceIds",
        1,
        MAX_BATCH_RESOURCE_SELECTION,
      );
      const user = await getCurrentUser(repository, request);
      return resources.trashResources(user, { resourceIds });
    },
  );

  app.post<{ Params: { resourceId: string } }>(
    "/api/resources/:resourceId/trash",
    async (request) => {
      const user = await getCurrentUser(repository, request);
      // 单项接口保留兼容性，但删除事务和审计只由批量核心实现一次。
      const result = await resources.trashResources(user, {
        resourceIds: [request.params.resourceId],
      });
      return result.trashed[0]!;
    },
  );

  app.post<{ Params: { resourceId: string } }>(
    "/api/resources/:resourceId/restore",
    async (request) => {
      const user = await getCurrentUser(repository, request);
      const restored = await resources.restoreResource(
        user,
        request.params.resourceId,
      );
      await repository.writeAuditLog({
        action: "resource_restore",
        actorUserId: user.id,
        resourceId: restored.id,
        detail: {},
      });
      return restored;
    },
  );

  app.post<{
    Body: {
      parentId?: unknown;
      name?: unknown;
      payload?: unknown;
      mediaResourceId?: unknown;
    };
  }>("/api/annotation-files", async (request) => {
    const body = requireObject(request.body);
    if (typeof body.parentId !== "string" || typeof body.name !== "string") {
      throw badRequest("创建标注文件需要 parentId 和 name。");
    }
    return resources.createAnnotationFile(
      await getCurrentUser(repository, request),
      {
        parentId: body.parentId,
        name: body.name,
        payload: body.payload ?? {},
        mediaResourceId: optionalStringOrNull(body.mediaResourceId),
      },
    );
  });

  app.get<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId",
    async (request) =>
      resources.getAnnotationFile(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      ),
  );

  app.put<{
    Params: { resourceId: string };
    Body: { baseRevision?: unknown; payload?: unknown };
  }>("/api/annotation-files/:resourceId", async (request) => {
    const body = requireObject(request.body);
    if (!Number.isInteger(body.baseRevision) || Number(body.baseRevision) < 1) {
      throw badRequest("baseRevision 必须是正整数。");
    }
    const user = await getCurrentUser(repository, request);
    const saved = await resources.saveAnnotationFile(
      user,
      request.params.resourceId,
      {
        baseRevision: Number(body.baseRevision),
        payload: body.payload ?? {},
      },
    );
    return saved;
  });

  app.get<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId/recovery-snapshots",
    async (request) =>
      resources.listRecoverySnapshots(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      ),
  );

  // 完整快照按需读取，路由中的 resourceId 参与归属校验而不是只凭 snapshotId 查询。
  app.get<{ Params: { resourceId: string; snapshotId: string } }>(
    "/api/annotation-files/:resourceId/recovery-snapshots/:snapshotId",
    async (request) =>
      resources.getRecoverySnapshot(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.snapshotId,
      ),
  );

  // 恢复请求必须携带当前 revision；服务端把历史内容写成新 revision，而不是回退计数器。
  app.post<{
    Params: { resourceId: string; snapshotId: string };
    Body: { baseRevision?: unknown };
  }>(
    "/api/annotation-files/:resourceId/recovery-snapshots/:snapshotId/restore",
    async (request) => {
      const body = requireObject(request.body);
      if (
        !Number.isInteger(body.baseRevision) ||
        Number(body.baseRevision) < 1
      ) {
        throw badRequest("baseRevision 必须是正整数。");
      }
      return resources.restoreAnnotationRecoverySnapshot(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.snapshotId,
        { baseRevision: Number(body.baseRevision) },
      );
    },
  );

  app.get<{ Params: { resourceId: string } }>(
    "/api/resources/:resourceId/permissions",
    async (request) =>
      resources.listPermissionMatrix(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      ),
  );

  app.put<{
    Params: { resourceId: string; userId: string };
    Body: {
      capabilities?: unknown;
      inheritToChildren?: unknown;
      expiresAt?: unknown;
    };
  }>("/api/resources/:resourceId/permissions/:userId", async (request) => {
    const body = requireObject(request.body);
    const capabilities = parseCapabilities(body.capabilities);
    if (
      body.inheritToChildren !== undefined &&
      typeof body.inheritToChildren !== "boolean"
    ) {
      throw badRequest("inheritToChildren 必须是布尔值。");
    }
    const user = await getCurrentUser(repository, request);
    const permission = await resources.upsertPermission(
      user,
      request.params.resourceId,
      request.params.userId,
      {
        capabilities,
        inheritToChildren: body.inheritToChildren,
        expiresAt: optionalDateStringOrNull(body.expiresAt, "权限到期时间"),
      },
    );
    await repository.writeAuditLog({
      action: "resource_permission_upsert",
      actorUserId: user.id,
      resourceId: request.params.resourceId,
      targetUserId: request.params.userId,
      detail: {
        capabilities,
        inheritToChildren: permission.inheritToChildren,
      },
    });
    return permission;
  });

  app.delete<{ Params: { resourceId: string; userId: string } }>(
    "/api/resources/:resourceId/permissions/:userId",
    async (request) => {
      const user = await getCurrentUser(repository, request);
      await resources.removePermission(
        user,
        request.params.resourceId,
        request.params.userId,
      );
      await repository.writeAuditLog({
        action: "resource_permission_remove",
        actorUserId: user.id,
        resourceId: request.params.resourceId,
        targetUserId: request.params.userId,
        detail: {},
      });
      return null;
    },
  );

  app.patch<{
    Params: { resourceId: string };
    Body: { breakPermissionInheritance?: unknown };
  }>("/api/resources/:resourceId/permission-inheritance", async (request) => {
    const body = requireObject(request.body);
    if (typeof body.breakPermissionInheritance !== "boolean") {
      throw badRequest("breakPermissionInheritance 必须是布尔值。");
    }
    const user = await getCurrentUser(repository, request);
    const updated = await resources.updateInheritance(
      user,
      request.params.resourceId,
      body.breakPermissionInheritance,
    );
    await repository.writeAuditLog({
      action: "resource_inheritance_update",
      actorUserId: user.id,
      resourceId: updated.id,
      detail: {
        breakPermissionInheritance: updated.breakPermissionInheritance,
      },
    });
    return updated;
  });

  app.post("/api/files/upload", async (request) => {
    const user = await getCurrentUser(repository, request);
    const file = await request.file();
    if (!file) throw badRequest("请选择需要上传的文件。");
    const storageKey = storage.createStorageKey(file.filename);
    const stored = await storage.putObject(
      storageKey,
      Readable.from(file.file),
    );
    try {
      return {
        file: await repository.createUploadedFile(user, {
          name: file.filename,
          mimeType: file.mimetype,
          size: stored.size,
          storageKey: stored.storageKey,
          checksum: stored.checksum,
        }),
      };
    } catch (error) {
      // PostgreSQL 无法回滚已经完成的文件系统写入；数据库落库失败时必须显式补偿。
      await storage.deleteObject(stored.storageKey).catch((cleanupError) => {
        request.log.error(cleanupError, "清理上传孤儿对象失败");
      });
      throw error;
    }
  });

  app.post<{
    Body: { parentId?: unknown; fileId?: unknown; name?: unknown };
  }>("/api/media-files", async (request) => {
    const body = requireObject(request.body);
    if (typeof body.parentId !== "string" || typeof body.fileId !== "string") {
      throw badRequest("媒体文件需要 parentId 和 fileId。");
    }
    return resources.importMediaFile(
      await getCurrentUser(repository, request),
      {
        parentId: body.parentId,
        fileId: body.fileId,
        name: typeof body.name === "string" ? body.name : undefined,
      },
    );
  });

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
    const range = parseRange(request.headers.range, file.size);
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", file.mimeType);
    if (range.kind === "invalid") {
      reply.status(416);
      reply.header("Content-Range", `bytes */${file.size}`);
      return reply.send();
    }
    if (range.kind === "range") {
      reply.status(206);
      reply.header(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${file.size}`,
      );
      reply.header("Content-Length", range.end - range.start + 1);
      return reply.send(storage.getObjectStream(file.storageKey, range));
    }
    reply.header("Content-Length", file.size);
    return reply.send(storage.getObjectStream(file.storageKey));
  });

  app.post<{
    Body: { type?: unknown; inputFileIds?: unknown; resourceId?: unknown };
  }>("/api/processing-jobs", async (request) => {
    const body = requireObject(request.body);
    if (
      typeof body.type !== "string" ||
      !PROCESSING_JOB_TYPES.has(body.type as ProcessingJobType) ||
      !Array.isArray(body.inputFileIds) ||
      body.inputFileIds.some((id) => typeof id !== "string")
    ) {
      throw badRequest("处理任务参数不正确。");
    }
    return repository.createProcessingJob(
      await getCurrentUser(repository, request),
      {
        type: body.type as ProcessingJobType,
        inputFileIds: body.inputFileIds as string[],
        resourceId: optionalStringOrNull(body.resourceId),
      },
    );
  });

  app.get<{
    Querystring: { resourceId?: string; actorUserId?: string; limit?: string };
  }>("/api/audit-logs", async (request) =>
    repository.listAuditLogs(
      await getCurrentUser(repository, request),
      {
        resourceId: normalizedString(request.query.resourceId),
        actorUserId: normalizedString(request.query.actorUserId),
        limit: parseOptionalInteger(request.query.limit, "limit", 1, 200),
      },
    ));

  app.get<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId/operations",
    async (request) =>
      repository.listAnnotationOperations(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      ),
  );

  app.post<{
    Params: { resourceId: string };
    Body: {
      baseRevision?: unknown;
      localRevision?: unknown;
      action?: unknown;
      payload?: unknown;
    };
  }>("/api/annotation-files/:resourceId/operations", async (request) => {
    const body = requireObject(request.body);
    if (
      !Number.isInteger(body.baseRevision) ||
      Number(body.baseRevision) < 0 ||
      (body.localRevision !== undefined &&
        body.localRevision !== null &&
        (!Number.isInteger(body.localRevision) ||
          Number(body.localRevision) < 0)) ||
      typeof body.action !== "string" ||
      !body.action.trim()
    ) {
      throw badRequest("标注操作参数不正确。");
    }
    return repository.createAnnotationOperation(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      {
        baseRevision: Number(body.baseRevision),
        localRevision: body.localRevision === null ||
          body.localRevision === undefined
          ? null
          : Number(body.localRevision),
        action: body.action,
        payload: body.payload ?? {},
      },
    );
  });
}

async function getCurrentUser(
  repository: PrismaPlatformRepository,
  request: FastifyRequest,
  queryToken: string | null = null,
) {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : queryToken;
  return repository.getUserByToken(token);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("请求体必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function normalizedString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest("字段必须是字符串或 null。");
  return value.trim() || null;
}

function optionalDateStringOrNull(
  value: unknown,
  label: string,
): string | null | undefined {
  const normalized = optionalStringOrNull(value);
  if (
    typeof normalized === "string" &&
    Number.isNaN(Date.parse(normalized))
  ) {
    throw badRequest(`${label}必须是有效日期时间。`);
  }
  return normalized;
}

function parseCapabilities(value: unknown): ResourceCapability[] {
  if (
    !Array.isArray(value) ||
    value.some((item) =>
      typeof item !== "string" ||
      !CAPABILITIES.has(item as ResourceCapability))
  ) {
    throw badRequest("capabilities 包含无效的资源能力。");
  }
  return [...new Set(value as ResourceCapability[])];
}

function parseUniqueStringArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw badRequest(`${label} 必须是非空字符串数组。`);
  }
  const normalized = [...new Set(value.map((item) => item.trim()))];
  if (normalized.length < minimum || normalized.length > maximum) {
    throw badRequest(`${label} 必须包含 ${minimum}–${maximum} 个不同资源。`);
  }
  return normalized;
}

function parseOptionalSetValue<T extends string>(
  value: unknown,
  set: Set<T>,
  label: string,
) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !set.has(value as T)) {
    throw badRequest(`${label}无效。`);
  }
  return value as T;
}

function parseOptionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw badRequest(`${label} 必须是 ${minimum}–${maximum} 的整数。`);
  }
  return parsed;
}

type ParsedRange =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "range"; start: number; end: number };

function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    return { kind: "invalid" };
  }

  // `bytes=-N` 表示最后 N 个字节，不是从 0 到 N；单独处理可避免视频尾部 seek 错位。
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return { kind: "invalid" };
    }
    return {
      kind: "range",
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) return { kind: "invalid" };
  return {
    kind: "range",
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}
