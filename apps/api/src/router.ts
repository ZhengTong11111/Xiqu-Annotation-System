import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ANNOTATION_CONFIRMATION_DOMAINS,
  AUDIT_ACTIONS,
  RESOURCE_CAPABILITIES,
  type AnnotationConfirmationDomain,
  type AnnotationConfirmationScope,
  type AuditActionName,
  type ProcessingJobType,
  type ResourceCapability,
  type ResourceListView,
  type ResourceSortField,
  type ResourceType,
  type SortDirection,
} from "@xiqu/shared";
import type { AuditLogService } from "./auditLogService.js";
import { badRequest, unauthorized } from "./errors.js";
import type { HealthService } from "./healthService.js";
import type { MediaUploadService } from "./mediaUploadService.js";
import type { MaintenanceCoordinator } from "./maintenanceCoordinator.js";
import type { ObjectLifecycleService } from "./objectLifecycleService.js";
import type { OperationalMetricsCollector } from "./operationalMetricsCollector.js";
import {
  type ApiObservability,
  isValidMetricsToken,
} from "./observability.js";
import type { PrismaPlatformRepository } from "./repository.js";
import type { ResourceService } from "./resourceService.js";
import { MAX_BATCH_RESOURCE_SELECTION } from "./resourceSelection.js";
import type { ObjectStorage } from "./objectStorage.js";
import type { SystemDiagnosticsService } from "./systemDiagnosticsService.js";

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
const CONFIRMATION_DOMAINS = new Set<AnnotationConfirmationDomain>(
  ANNOTATION_CONFIRMATION_DOMAINS,
);
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
// 路由运行时校验复用 shared 动作清单，未知 action 在进入 Prisma 前返回 400。
const AUDIT_ACTION_NAMES = new Set<AuditActionName>(AUDIT_ACTIONS);

export function registerApiRoutes(
  app: FastifyInstance,
  repository: PrismaPlatformRepository,
  auditLogs: AuditLogService,
  resources: ResourceService,
  storage: Pick<ObjectStorage, "getObjectStream">,
  mediaUploads: MediaUploadService,
  objectLifecycle: ObjectLifecycleService,
  health: HealthService,
  maintenance: MaintenanceCoordinator,
  diagnostics: SystemDiagnosticsService,
  observability: ApiObservability,
  operationalMetrics: OperationalMetricsCollector,
  metricsToken: string | null,
) {
  // liveness 不访问外部依赖；readiness 与兼容 health 在依赖失败时明确返回 503。
  app.get("/api/health/live", async () => health.getLiveness());
  app.get("/api/health/ready", async (_request, reply) => {
    const result = await health.getReadiness();
    if (result.status === "unavailable") reply.status(503);
    return result;
  });
  app.get("/api/health", async (_request, reply) => {
    const result = await health.getReadiness();
    if (result.status === "unavailable") reply.status(503);
    return result;
  });

  // 维护状态读取和切换均要求全局管理员；POST 是唯一可绕过维护 gate 的恢复通道。
  app.get("/api/admin/maintenance", async (request) =>
    maintenance.getStatus(await getCurrentUser(repository, request)));
  app.post<{
    Body: { enabled?: unknown; reason?: unknown };
  }>("/api/admin/maintenance", async (request) => {
    if (typeof request.body?.enabled !== "boolean") {
      throw badRequest("维护状态需要有效的 enabled 参数。");
    }
    const reason = normalizedString(
      typeof request.body.reason === "string" ? request.body.reason : undefined,
    );
    // 业务层统一维护原因必填和长度约束，供 HTTP 与后续运维 CLI 共用同一不变量。
    return maintenance.setMaintenance(
      await getCurrentUser(repository, request),
      { enabled: request.body.enabled, reason: reason ?? null },
    );
  });

  // Prometheus 凭据与用户 session 分离；未配置时关闭入口，避免开发默认意外暴露进程指标。
  app.get("/metrics", async (request, reply) => {
    if (!metricsToken) return reply.status(404).send();
    if (!isValidMetricsToken(metricsToken, request.headers.authorization)) {
      throw unauthorized("监控凭据无效。");
    }
    // 授权后才执行依赖采集；失败通过 Gauge 暴露，端点仍返回可解析的 Prometheus 文本。
    try {
      observability.recordOperationalSnapshot(
        await operationalMetrics.collect(),
      );
    } catch (error) {
      observability.recordOperationalCollectionFailure();
      request.log.warn({ err: error }, "Operational metrics collection failed");
    }
    reply.header("Content-Type", observability.registry.contentType);
    return observability.registry.metrics();
  });

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

  // 最近打开从 GET 副作用中拆出，确保维护模式可以放行真正只读的标注文件读取。
  app.post<{ Params: { resourceId: string } }>(
    "/api/resources/:resourceId/opened",
    async (request, reply) => {
      await resources.markResourceOpened(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      );
      return reply.status(204).send();
    },
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

  // 确认列表属于标注文件治理元数据；读取权限由服务层按文件逐项执行。
  app.get<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId/confirmations",
    async (request) =>
      resources.listAnnotationConfirmations(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      ),
  );

  // 创建请求在路由边界解析 unknown，revision、轨道存在性和 review 权限仍由事务服务校验。
  app.post<{
    Params: { resourceId: string };
    Body: {
      confirmedRevision?: unknown;
      scope?: unknown;
      note?: unknown;
    };
  }>("/api/annotation-files/:resourceId/confirmations", async (request) => {
    const body = requireObject(request.body);
    if (
      !Number.isInteger(body.confirmedRevision) ||
      Number(body.confirmedRevision) < 1
    ) {
      throw badRequest("confirmedRevision 必须是正整数。");
    }
    if (
      body.note !== undefined &&
      body.note !== null &&
      typeof body.note !== "string"
    ) {
      throw badRequest("审核备注必须是字符串或 null。");
    }
    return resources.createAnnotationConfirmation(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      {
        confirmedRevision: Number(body.confirmedRevision),
        scope: parseAnnotationConfirmationScope(body.scope),
        note: body.note as string | null | undefined,
      },
    );
  });

  // 撤销使用独立命令而非删除，历史事实与审计记录因此能够长期保留。
  app.post<{
    Params: { resourceId: string; confirmationId: string };
    Body: { reason?: unknown };
  }>(
    "/api/annotation-files/:resourceId/confirmations/:confirmationId/revoke",
    async (request) => {
      const body = requireObject(request.body);
      if (
        body.reason !== undefined &&
        body.reason !== null &&
        typeof body.reason !== "string"
      ) {
        throw badRequest("撤销原因必须是字符串或 null。");
      }
      return resources.revokeAnnotationConfirmation(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.confirmationId,
        body.reason as string | null | undefined,
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

  app.post<{
    Querystring: { parentId?: string; name?: string };
  }>("/api/media-files/upload", async (request) => {
    if (!request.query.parentId || !request.query.name) {
      throw badRequest("媒体上传需要目标目录和文件名。");
    }
    const user = await getCurrentUser(repository, request);
    // request.file 只解析 multipart 并交出流；服务会在真正消费流和落盘前完成权限预检。
    const file = await request.file();
    if (!file) throw badRequest("请选择需要上传的文件。");
    return mediaUploads.upload(
      user,
      {
        parentId: request.query.parentId,
        name: request.query.name,
        stream: file.file,
        wasTruncated: () => file.file.truncated,
      },
      request.log,
    );
  });

  // 对象审计为管理员运维接口；GET 永不删除，cleanup 必须显式确认。
  app.get("/api/admin/storage/orphans", async (request) =>
    objectLifecycle.inspect(
      await getCurrentUser(repository, request),
    ));

  app.post<{ Body: { confirm?: unknown } }>(
    "/api/admin/storage/orphans/cleanup",
    async (request) => {
      if (request.body?.confirm !== true) {
        throw badRequest("清理对象存储需要显式确认。");
      }
      try {
        const result = await objectLifecycle.cleanup(
          await getCurrentUser(repository, request),
        );
        observability.recordStorageCleanup(
          "success",
          result.deletedBinaryCount,
          result.deletedFileObjectCount,
        );
        return result;
      } catch (error) {
        observability.recordStorageCleanup("failure");
        throw error;
      }
    },
  );

  // 系统级容量和对象一致性只对全局管理员开放，资源级 ACL 不会放大为系统诊断权限。
  app.get("/api/admin/diagnostics", async (request) =>
    diagnostics.getDiagnostics(await getCurrentUser(repository, request)));

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
      return reply.send(await storage.getObjectStream(file.storageKey, range));
    }
    reply.header("Content-Length", file.size);
    return reply.send(await storage.getObjectStream(file.storageKey));
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
    Querystring: {
      resourceId?: string;
      actorUserId?: string;
      targetUserId?: string;
      action?: string;
      createdFrom?: string;
      createdTo?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/api/audit-logs", async (request) => {
    // action 使用共享枚举做运行时收窄，未知值不能穿过类型断言进入 Prisma。
    const action = parseOptionalAuditAction(request.query.action);
    return auditLogs.listAuditLogs(
      await getCurrentUser(repository, request),
      {
        resourceId: normalizedString(request.query.resourceId),
        actorUserId: normalizedString(request.query.actorUserId),
        targetUserId: normalizedString(request.query.targetUserId),
        action,
        createdFrom: normalizedString(request.query.createdFrom),
        createdTo: normalizedString(request.query.createdTo),
        cursor: normalizedString(request.query.cursor),
        limit: parseOptionalInteger(request.query.limit, "limit", 1, 200),
      },
    );
  });

  app.get<{
    Querystring: {
      resourceId?: string;
      actorUserId?: string;
      targetUserId?: string;
      action?: string;
      createdFrom?: string;
      createdTo?: string;
    };
  }>("/api/audit-logs/export", async (request, reply) => {
    // 导出不接收 cursor/limit，始终由服务端按当前筛选执行有界完整扫描。
    const result = await auditLogs.exportAuditLogs(
      await getCurrentUser(repository, request),
      {
        resourceId: normalizedString(request.query.resourceId),
        actorUserId: normalizedString(request.query.actorUserId),
        targetUserId: normalizedString(request.query.targetUserId),
        action: parseOptionalAuditAction(request.query.action),
        createdFrom: normalizedString(request.query.createdFrom),
        createdTo: normalizedString(request.query.createdTo),
      },
    );
    const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="xiqu-audit-${timestamp}.csv"`,
    );
    reply.header("X-Audit-Export-Count", String(result.exportedCount));
    reply.header("X-Audit-Export-Truncated", String(result.truncated));
    return result.csv;
  });

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

// 可选审计动作只接受共享合同中的稳定值，空字符串等同于未筛选。
function parseOptionalAuditAction(value: unknown): AuditActionName | undefined {
  const normalized = normalizedString(value);
  if (!normalized) return undefined;
  if (!AUDIT_ACTION_NAMES.has(normalized as AuditActionName)) {
    throw badRequest("审计动作筛选值无效。");
  }
  return normalized as AuditActionName;
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

// 作用域解析只接受三种互斥目标形状；更细的去重、长度与时间规则交给共享领域校验器。
function parseAnnotationConfirmationScope(
  value: unknown,
): AnnotationConfirmationScope {
  const scope = requireObject(value);
  if (
    typeof scope.startTime !== "number" ||
    typeof scope.endTime !== "number"
  ) {
    throw badRequest("审核时间范围必须使用数字秒数。");
  }
  const targets = requireObject(scope.targets);
  if (targets.mode === "all") {
    return {
      startTime: scope.startTime,
      endTime: scope.endTime,
      targets: { mode: "all" },
    };
  }
  if (
    targets.mode === "domains" &&
    Array.isArray(targets.domains) &&
    targets.domains.every((domain) =>
      typeof domain === "string" &&
      CONFIRMATION_DOMAINS.has(domain as AnnotationConfirmationDomain))
  ) {
    return {
      startTime: scope.startTime,
      endTime: scope.endTime,
      targets: {
        mode: "domains",
        domains: targets.domains as AnnotationConfirmationDomain[],
      },
    };
  }
  if (
    targets.mode === "tracks" &&
    Array.isArray(targets.trackIds) &&
    targets.trackIds.every((trackId) => typeof trackId === "string")
  ) {
    return {
      startTime: scope.startTime,
      endTime: scope.endTime,
      targets: { mode: "tracks", trackIds: targets.trackIds as string[] },
    };
  }
  throw badRequest("审核目标必须是 all、有效领域列表或轨道标识列表。");
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
