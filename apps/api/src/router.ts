import type { FastifyInstance } from "fastify";
import {
  ANNOTATION_REVIEW_DOMAINS,
  ANNOTATION_REVIEW_PAGE_MAX_LIMIT,
  ANNOTATION_RANGE_COMMENT_KINDS,
  AUDIT_ACTIONS,
  encodeMediaAnalysisTileBatchHeader,
  isValidAnnotationOperationPayload,
  MAX_MEDIA_ANALYSIS_BATCH_ASSETS,
  parseAnnotationCommandBatchRequest,
  parseAnnotationToolAttemptBatchRequest,
  parseApplyAlignmentRunRequest,
  parseCreateAlignmentRunRequest,
  parseUpsertAlignmentQualityAssessmentRequest,
  PROCESSING_JOB_STATUSES,
  PROCESSING_JOB_TYPES,
  RESOURCE_CAPABILITIES,
  type AnnotationConfirmationDomain,
  type AnnotationConfirmationScope,
  type AnnotationReviewScope,
  type AnnotationRangeCommentKind,
  type AnnotationClientSyncFailureCategory,
  type AnnotationClientSyncFailureOperation,
  type AnnotationClientSyncFailureReport,
  type AnnotationWorkflowStatus,
  type AuditActionName,
  type CreateMediaAudioTrackRequest,
  type CancelProcessingJobRequest,
  type MediaAudioTrackKind,
  type PlatformRole,
  type ProcessingJobScope,
  type ProcessingJobStatus,
  type ProcessingJobType,
  type RetryProcessingJobRequest,
  type ResourceCapability,
  type ResourceListView,
  type ResourceSortField,
  type ResourceType,
  type SortDirection,
} from "@xiqu/shared";
import type { AuditLogService } from "./auditLogService.js";
import type { AccountAdminService } from "./accountAdminService.js";
import { badRequest, unauthorized } from "./errors.js";
import type { HealthService } from "./healthService.js";
import type { MediaUploadService } from "./mediaUploadService.js";
import type { MediaAnalysisJobService } from "./mediaAnalysisJobService.js";
import type { AlignmentRunService } from "./alignmentRunService.js";
import type { AlignmentApplicationService } from "./alignmentApplicationService.js";
import type { AlignmentQualityAssessmentService } from "./alignmentQualityAssessmentService.js";
import type { ProcessingJobQueryService } from "./processingJobQueryService.js";
import type { ProcessingJobCommandService } from "./processingJobCommandService.js";
import type { MediaAudioTrackService } from "./mediaAudioTrackService.js";
import type { MediaAudioPlaybackSessionService } from "./mediaAudioPlaybackSessionService.js";
import type { MaintenanceCoordinator } from "./maintenanceCoordinator.js";
import {
  MAINTENANCE_CONTROL_ROUTE,
  MAINTENANCE_READ_ROUTE,
} from "./maintenanceRouteAccess.js";
import type { ObjectLifecycleService } from "./objectLifecycleService.js";
import type { OperationalMetricsCollector } from "./operationalMetricsCollector.js";
import {
  type ApiObservability,
  isValidMetricsToken,
} from "./observability.js";
import type { PrismaPlatformRepository } from "./repository.js";
import type { ResourceService } from "./resourceService.js";
import type { AnnotationCommandCommitService } from "./annotationCommandCommitService.js";
import type { AnnotationToolAttemptService } from "./annotationToolAttemptService.js";
import type { AnnotationRecoveryBackupService } from "./annotationRecoveryBackupService.js";
import type { AnnotationReviewLinkService } from "./annotationReviewLinkService.js";
import { MAX_BATCH_RESOURCE_SELECTION } from "./resourceSelection.js";
import type { ObjectStorage } from "./objectStorage.js";
import type { SystemDiagnosticsService } from "./systemDiagnosticsService.js";
import { isValidClientOperationId } from "./annotationOperationIdempotency.js";
import {
  isValidAnnotationMutationLeaseToken,
  parseAnnotationMutationPurpose,
} from "./annotationMutationLease.js";
import { getCurrentUser } from "./requestAuthentication.js";
import {
  openAbortableResponseStream,
  bindHttpDisconnectSignal,
  createAbortableObjectBatchStream,
} from "./abortableHttpStream.js";
import { isValidProcessingJobClientRequestId } from "./processingJobIdentity.js";

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
const PROCESSING_JOB_SCOPE_NAMES = new Set<ProcessingJobScope>(["mine", "related", "all"]);
const PROCESSING_JOB_STATUS_NAMES = new Set<ProcessingJobStatus>(PROCESSING_JOB_STATUSES);
const PROCESSING_JOB_TYPE_NAMES = new Set<ProcessingJobType>(PROCESSING_JOB_TYPES);
const REVIEW_DOMAINS = new Set<AnnotationConfirmationDomain>(
  ANNOTATION_REVIEW_DOMAINS,
);
// 路由运行时校验复用 shared 动作清单，未知 action 在进入 Prisma 前返回 400。
const AUDIT_ACTION_NAMES = new Set<AuditActionName>(AUDIT_ACTIONS);
const ANNOTATION_SYNC_FAILURE_CATEGORIES = new Set<AnnotationClientSyncFailureCategory>([
  "atomic_plan",
  "atomic_protocol",
  "draft_persistence",
  "mutation_lease",
  "auto_save_runtime",
  "server_save",
  "unknown",
]);
const ANNOTATION_WORKFLOW_STATUSES = new Set<AnnotationWorkflowStatus>([
  "unannotated",
  "annotated",
  "reviewed",
]);

export function registerApiRoutes(
  app: FastifyInstance,
  repository: PrismaPlatformRepository,
  accounts: AccountAdminService,
  auditLogs: AuditLogService,
  resources: ResourceService,
  annotationRecoveryBackups: AnnotationRecoveryBackupService,
  annotationReviewLinks: AnnotationReviewLinkService,
  mediaAnalysis: MediaAnalysisJobService,
  alignmentRuns: AlignmentRunService,
  alignmentApplications: AlignmentApplicationService,
  alignmentQualityAssessments: AlignmentQualityAssessmentService,
  processingJobs: ProcessingJobQueryService,
  processingJobCommands: ProcessingJobCommandService,
  mediaAudioTracks: MediaAudioTrackService,
  mediaAudioPlaybackSessions: MediaAudioPlaybackSessionService,
  annotationCommandCommits: AnnotationCommandCommitService,
  annotationToolAttempts: AnnotationToolAttemptService,
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
  }>("/api/admin/maintenance", MAINTENANCE_CONTROL_ROUTE, async (request) => {
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

  app.get<{
    Querystring: {
      scope?: string;
      status?: string;
      type?: string;
      query?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/api/processing-jobs", async (request) => {
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    return processingJobs.list(
      await getCurrentUser(repository, request),
      {
        scope: parseProcessingJobScope(request.query.scope),
        status: parseProcessingJobStatus(request.query.status),
        type: parseProcessingJobType(request.query.type),
        query: request.query.query,
        cursor: request.query.cursor,
        limit,
      },
    );
  });

  app.get<{ Querystring: { scope?: string } }>(
    "/api/processing-jobs/summary",
    async (request) => processingJobs.summary(
      await getCurrentUser(repository, request),
      parseProcessingJobScope(request.query.scope) ?? "mine",
    ),
  );

  app.get<{ Params: { jobId: string } }>(
    "/api/processing-jobs/:jobId",
    async (request) => processingJobs.detail(
      await getCurrentUser(repository, request),
      requireString(request.params.jobId, "jobId"),
    ),
  );

  app.post<{
    Params: { requestId: string };
    Body: CancelProcessingJobRequest;
  }>("/api/processing-job-requests/:requestId/cancel", async (request) =>
    processingJobCommands.cancelRequest(
      await getCurrentUser(repository, request),
      requireString(request.params.requestId, "requestId"),
      requireProcessingJobCancellationBody(request.body),
    ));

  app.post<{
    Params: { jobId: string };
    Body: CancelProcessingJobRequest;
  }>("/api/processing-jobs/:jobId/force-cancel", async (request) =>
    processingJobCommands.forceCancel(
      await getCurrentUser(repository, request),
      requireString(request.params.jobId, "jobId"),
      requireProcessingJobCancellationBody(request.body),
    ));

  app.post<{
    Params: { requestId: string };
    Body: RetryProcessingJobRequest;
  }>("/api/processing-job-requests/:requestId/retry", async (request) =>
    processingJobCommands.retryRequest(
      await getCurrentUser(repository, request),
      requireString(request.params.requestId, "requestId"),
      requireProcessingJobRetryBody(request.body),
    ));

  // 评论与反馈默认隐藏已撤回记录；分页参数在服务层继续绑定文件和筛选上下文。
  app.get<{
    Params: { resourceId: string };
    Querystring: { cursor?: string; limit?: string; includeWithdrawn?: string };
  }>("/api/annotation-files/:resourceId/range-comments", async (request) => {
    const includeWithdrawn = request.query.includeWithdrawn === "true";
    if (
      request.query.includeWithdrawn !== undefined &&
      request.query.includeWithdrawn !== "true" &&
      request.query.includeWithdrawn !== "false"
    ) throw badRequest("includeWithdrawn 必须是 true 或 false。");
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    if (limit !== undefined && (
      !Number.isInteger(limit) || limit < 1 || limit > ANNOTATION_REVIEW_PAGE_MAX_LIMIT
    )) {
      throw badRequest(`limit 必须是 1 到 ${ANNOTATION_REVIEW_PAGE_MAX_LIMIT} 的整数。`);
    }
    return resources.listAnnotationRangeComments(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      { cursor: request.query.cursor, limit, includeWithdrawn },
    );
  });

  app.post<{
    Params: { resourceId: string };
    Body: { commentedRevision?: unknown; scope?: unknown; kind?: unknown; body?: unknown };
  }>("/api/annotation-files/:resourceId/range-comments", async (request) => {
    const body = requireObject(request.body);
    if (!Number.isInteger(body.commentedRevision) || Number(body.commentedRevision) < 1) {
      throw badRequest("commentedRevision 必须是正整数。");
    }
    if (typeof body.body !== "string") throw badRequest("范围评论正文必须是字符串。");
    return resources.createAnnotationRangeComment(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      {
        commentedRevision: Number(body.commentedRevision),
        scope: parseAnnotationReviewScope(body.scope),
        kind: parseAnnotationRangeCommentKind(body.kind),
        body: body.body,
      },
    );
  });

  app.post<{
    Params: { resourceId: string; commentId: string };
    Body: { reason?: unknown };
  }>("/api/annotation-files/:resourceId/range-comments/:commentId/withdraw", async (request) => {
    const body = requireObject(request.body);
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
      throw badRequest("撤回原因必须是字符串或 null。");
    }
    return resources.withdrawAnnotationRangeComment(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      request.params.commentId,
      body.reason as string | null | undefined,
    );
  });

  // 审核包先预检再建立独立关联；两条入口都在服务层执行相同来源、目标和权限验证。
  app.post<{
    Params: { resourceId: string };
    Body: { targetRevision?: unknown; reviewPackage?: unknown };
  }>("/api/annotation-files/:resourceId/review-links/dry-run", async (request) => {
    const body = requireObject(request.body);
    if (!Number.isInteger(body.targetRevision) || Number(body.targetRevision) < 1) {
      throw badRequest("targetRevision 必须是正整数。");
    }
    return annotationReviewLinks.dryRun(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      Number(body.targetRevision),
      body.reviewPackage,
    );
  });

  app.get<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId/review-links",
    async (request) => annotationReviewLinks.list(
      await getCurrentUser(repository, request),
      request.params.resourceId,
    ),
  );

  app.post<{
    Params: { resourceId: string };
    Body: { targetRevision?: unknown; reviewPackage?: unknown };
  }>("/api/annotation-files/:resourceId/review-links", async (request) => {
    const body = requireObject(request.body);
    if (!Number.isInteger(body.targetRevision) || Number(body.targetRevision) < 1) {
      throw badRequest("targetRevision 必须是正整数。");
    }
    return annotationReviewLinks.create(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      Number(body.targetRevision),
      body.reviewPackage,
    );
  });

  app.post<{
    Params: { resourceId: string; linkId: string };
    Body: { reason?: unknown };
  }>("/api/annotation-files/:resourceId/review-links/:linkId/revoke", async (request) => {
    const body = requireObject(request.body);
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
      throw badRequest("撤销关联原因必须是字符串或 null。");
    }
    return annotationReviewLinks.revoke(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      request.params.linkId,
      body.reason as string | null | undefined,
    );
  });
  app.get("/api/auth/me", async (request) =>
    getCurrentUser(repository, request));

  app.get<{ Querystring: { query?: string } }>("/api/users", async (request) =>
    repository.listDirectoryUsers(
      await getCurrentUser(repository, request),
      normalizedString(request.query.query),
    ));

  app.get<{
    Querystring: { query?: string; cursor?: string; limit?: string };
  }>("/api/admin/accounts", async (request) => accounts.listAccounts(
    await getCurrentUser(repository, request),
    {
      query: normalizedString(request.query.query),
      cursor: normalizedString(request.query.cursor),
      limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
    },
  ));

  app.post<{ Body: unknown }>("/api/admin/accounts", async (request) => {
    const body = requireObject(request.body);
    return accounts.createAccount(await getCurrentUser(repository, request), {
      accountName: requireString(body.accountName, "账号名"),
      displayName: requireString(body.displayName, "显示名称"),
      password: requireString(body.password, "密码"),
      roles: parsePlatformRoles(body.roles),
    });
  });

  app.patch<{ Params: { userId: string }; Body: unknown }>(
    "/api/admin/accounts/:userId",
    async (request) => {
      const body = requireObject(request.body);
      return accounts.updateAccount(
        await getCurrentUser(repository, request),
        request.params.userId,
        {
          ...(body.displayName !== undefined
            ? { displayName: requireString(body.displayName, "显示名称") }
            : {}),
          ...(body.roles !== undefined ? { roles: parsePlatformRoles(body.roles) } : {}),
          ...(body.isActive !== undefined
            ? { isActive: requireBoolean(body.isActive, "账号状态") }
            : {}),
        },
      );
    },
  );

  app.post<{ Params: { userId: string }; Body: unknown }>(
    "/api/admin/accounts/:userId/reset-password",
    async (request) => {
      const body = requireObject(request.body);
      await accounts.resetPassword(
        await getCurrentUser(repository, request),
        request.params.userId,
        requireString(body.password, "新密码"),
      );
      return { ok: true };
    },
  );

  app.post<{ Body: unknown }>("/api/auth/change-password", async (request) => {
    const body = requireObject(request.body);
    await accounts.changeOwnPassword(
      await getCurrentUser(repository, request),
      requireString(body.currentPassword, "当前密码"),
      requireString(body.newPassword, "新密码"),
    );
    return { ok: true };
  });

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

  // 项目权限管理使用独立跨目录分页，不能改变资源管理器 all_projects 只列根项目的既有语义。
  app.get<{
    Querystring: { query?: string; cursor?: string; limit?: string };
  }>("/api/permission-management/projects", async (request) => {
    const limit = parseOptionalInteger(request.query.limit, "limit", 1, 100);
    return resources.listPermissionManagementProjects(
      await getCurrentUser(repository, request),
      {
        query: normalizedString(request.query.query),
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

  app.get<{
    Params: { resourceId: string };
    Querystring: { access_token?: string };
  }>("/api/resources/:resourceId/download", async (request, reply) => {
    const user = await getCurrentUser(
      repository,
      request,
      request.query.access_token ?? null,
    );
    const download = await resources.getDownloadableResource(
      user,
      request.params.resourceId,
    );
    reply.header("Content-Type", download.mimeType);
    reply.header(
      "Content-Disposition",
      buildAttachmentContentDisposition(download.fileName),
    );
    if (download.kind === "annotation") {
      reply.header("Content-Length", Buffer.byteLength(download.content, "utf8"));
      return reply.send(download.content);
    }
    reply.header("Content-Length", download.size);
    return reply.send(await openAbortableResponseStream(
      request.raw,
      reply.raw,
      () => storage.getObjectStream(download.storageKey),
    ));
  });

  app.patch<{ Params: { resourceId: string }; Body: unknown }>(
    "/api/annotation-files/:resourceId/media",
    async (request) => {
      const body = requireObject(request.body);
      return resources.updateAnnotationMedia(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        { mediaResourceId: optionalStringOrNull(body.mediaResourceId) ?? null },
      );
    },
  );

  app.patch<{ Params: { resourceId: string }; Body: unknown }>(
    "/api/annotation-files/:resourceId/workflow-status",
    async (request) => {
      const body = requireObject(request.body);
      return resources.updateAnnotationWorkflowStatus(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        {
          expectedStatus: parseAnnotationWorkflowStatus(
            body.expectedStatus,
            "当前标注状态",
          ),
          status: parseAnnotationWorkflowStatus(body.status, "目标标注状态"),
        },
      );
    },
  );

  app.get<{ Params: { resourceId: string } }>(
    "/api/projects/:resourceId/workflow-groups",
    async (request) => resources.getProjectWorkflowGroups(
      await getCurrentUser(repository, request),
      request.params.resourceId,
    ),
  );

  app.get<{
    Params: { resourceId: string };
    Querystring: { query?: string };
  }>(
    "/api/projects/:resourceId/workflow-group-candidates",
    async (request) => resources.listProjectWorkflowCandidates(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      normalizedString(request.query.query),
    ),
  );

  app.put<{ Params: { resourceId: string }; Body: unknown }>(
    "/api/projects/:resourceId/workflow-groups",
    async (request) => {
      const body = requireObject(request.body);
      return resources.updateProjectWorkflowGroups(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        {
          annotationUserIds: parseAccountIdArray(
            body.annotationUserIds,
            "标注组账号",
          ),
          reviewUserIds: parseAccountIdArray(
            body.reviewUserIds,
            "审核组账号",
          ),
        },
      );
    },
  );

  app.get<{ Params: { resourceId: string } }>(
    "/api/media-files/:resourceId/audio-tracks",
    async (request) => mediaAudioTracks.listTracks(
      await getCurrentUser(repository, request),
      request.params.resourceId,
    ),
  );

  app.get<{ Params: { resourceId: string } }>(
    "/api/media-files/:resourceId/audio-renditions",
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return mediaAudioTracks.listVodAudioRenditions(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      );
    },
  );

  app.post<{ Params: { resourceId: string }; Body: unknown }>(
    "/api/media-files/:resourceId/audio-tracks",
    async (request) => {
      const body = requireObject(request.body);
      return mediaAudioTracks.createTrack(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        {
          source: body.source as CreateMediaAudioTrackRequest["source"],
          name: body.name as string,
          kind: body.kind as CreateMediaAudioTrackRequest["kind"],
          offsetSeconds: body.offsetSeconds as number | undefined,
        },
      );
    },
  );

  app.post<{ Params: { resourceId: string; runId: string }; Body: unknown }>(
    "/api/annotation-files/:resourceId/alignment-runs/:runId/applications",
    async (request) => {
      const parsed = parseApplyAlignmentRunRequest(request.body);
      if (!parsed.success) throw badRequest(parsed.message);
      return alignmentApplications.apply(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.runId,
        parsed.data,
      );
    },
  );

  app.get<{ Params: { resourceId: string; applicationId: string } }>(
    "/api/annotation-files/:resourceId/alignment-applications/:applicationId/quality-assessments",
    MAINTENANCE_READ_ROUTE,
    async (request) => alignmentQualityAssessments.listCurrent(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      request.params.applicationId,
    ),
  );

  app.put<{ Params: { resourceId: string; applicationId: string }; Body: unknown }>(
    "/api/annotation-files/:resourceId/alignment-applications/:applicationId/quality-assessment",
    async (request) => {
      const parsed = parseUpsertAlignmentQualityAssessmentRequest(request.body);
      if (!parsed.success) throw badRequest(parsed.message);
      return alignmentQualityAssessments.upsert(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.applicationId,
        parsed.data,
      );
    },
  );

  app.get<{
    Params: { resourceId: string; runId: string; artifactId: string };
  }>(
    "/api/annotation-files/:resourceId/alignment-runs/:runId/artifacts/:artifactId",
    MAINTENANCE_READ_ROUTE,
    async (request, reply) => {
      const artifact = await alignmentRuns.getArtifactForRead(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.runId,
        request.params.artifactId,
      );
      reply.header("Content-Type", artifact.mimeType);
      reply.header("Content-Encoding", "gzip");
      reply.header("Content-Length", artifact.size);
      reply.header("ETag", `\"sha256-${artifact.checksum}\"`);
      reply.header("Cache-Control", "private, no-store");
      return reply.send(await openAbortableResponseStream(
        request.raw,
        reply.raw,
        () => storage.getObjectStream(artifact.storageKey),
      ));
    },
  );

  app.patch<{ Params: { resourceId: string; trackId: string }; Body: unknown }>(
    "/api/media-files/:resourceId/audio-tracks/:trackId",
    async (request) => {
      const body = requireObject(request.body);
      return mediaAudioTracks.updateTrack(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.trackId,
        {
          name: body.name as string | undefined,
          kind: body.kind as Exclude<MediaAudioTrackKind, "original"> | undefined,
          offsetSeconds: body.offsetSeconds as number | undefined,
          enabled: body.enabled as boolean | undefined,
        },
      );
    },
  );

  app.delete<{ Params: { resourceId: string; trackId: string } }>(
    "/api/media-files/:resourceId/audio-tracks/:trackId",
    async (request, reply) => {
      await mediaAudioTracks.deleteTrack(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.trackId,
      );
      reply.status(204);
    },
  );

  app.post<{ Params: { resourceId: string }; Body: unknown }>(
    "/api/media-files/:resourceId/audio-tracks/reorder",
    async (request) => {
      const body = requireObject(request.body);
      return mediaAudioTracks.reorderTracks(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        { trackIds: body.trackIds as string[] },
      );
    },
  );

  app.get<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId/audio-preference",
    async (request) => mediaAudioTracks.getAnnotationPreference(
      await getCurrentUser(repository, request),
      request.params.resourceId,
    ),
  );

  app.get<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId/audio-playback-options",
    async (request, reply) => {
      // 可试听状态包含当前 ACL 事实；禁止缓存，撤权后刷新必须立即生效。
      reply.header("Cache-Control", "no-store");
      return mediaAudioTracks.getAnnotationPlaybackOptions(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      );
    },
  );

  app.put<{ Params: { resourceId: string }; Body: unknown }>(
    "/api/annotation-files/:resourceId/audio-preference",
    async (request) => {
      const body = requireObject(request.body);
      const defaultAudioTrackId = optionalStringOrNull(body.defaultAudioTrackId);
      if (defaultAudioTrackId === undefined) {
        throw badRequest("defaultAudioTrackId 必须是字符串或 null。");
      }
      return mediaAudioTracks.updateAnnotationPreference(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        { defaultAudioTrackId },
      );
    },
  );

  app.post<{ Params: { resourceId: string; trackId: string } }>(
    "/api/annotation-files/:resourceId/audio-tracks/:trackId/playback-session",
    MAINTENANCE_READ_ROUTE,
    async (request, reply) => {
      // 成功凭据与权限/供应商错误都不应被浏览器或反向代理复用到后续切换请求。
      reply.header("Cache-Control", "no-store");
      const session = await mediaAudioPlaybackSessions.createSession(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        request.params.trackId,
      );
      return session;
    },
  );

  app.get<{
    Params: { resourceId: string };
    Querystring: { audioTrackId: string };
  }>(
    "/api/annotation-files/:resourceId/media-analysis",
    async (request) => mediaAnalysis.getStatus(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      requireString(request.query.audioTrackId, "audioTrackId"),
    ),
  );

  app.post<{ Params: { resourceId: string }; Body: unknown }>(
    "/api/annotation-files/:resourceId/media-analysis",
    async (request) => {
      const body = request.body === undefined ? {} : requireObject(request.body);
      if (body.force !== undefined && typeof body.force !== "boolean") {
        throw badRequest("force 必须是布尔值。");
      }
      if (!isValidProcessingJobClientRequestId(body.clientRequestId)) {
        throw badRequest("clientRequestId 必须是有效的 UUID。");
      }
      return mediaAnalysis.createAnalysis(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        {
          force: body.force as boolean | undefined,
          audioTrackId: requireString(body.audioTrackId, "audioTrackId"),
          clientRequestId: body.clientRequestId,
        },
      );
    },
  );

  app.get<{
    Params: { resourceId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/annotation-files/:resourceId/alignment-runs", async (request) => {
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    return alignmentRuns.list(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      { cursor: normalizedString(request.query.cursor), limit },
    );
  });

  app.get<{ Params: { resourceId: string; runId: string } }>(
    "/api/annotation-files/:resourceId/alignment-runs/:runId",
    async (request) => alignmentRuns.detail(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      request.params.runId,
    ),
  );

  app.post<{ Params: { resourceId: string }; Body: unknown }>(
    "/api/annotation-files/:resourceId/alignment-runs",
    async (request) => {
      const parsed = parseCreateAlignmentRunRequest(request.body);
      if (!parsed.success) throw badRequest(parsed.message);
      return alignmentRuns.create(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        parsed.data,
      );
    },
  );

  app.get<{
    Params: { resourceId: string };
    Querystring: {
      runId?: string;
      kind?: string;
      preset?: string;
      level?: string;
      startTime?: string;
      endTime?: string;
      audioTrackId: string;
    };
  }>("/api/annotation-files/:resourceId/media-analysis/assets", async (request) => {
    const kind = normalizedString(request.query.kind);
    if (kind !== "waveform" && kind !== "spectrogram" && kind !== "pitch") {
      throw badRequest("分析资产种类不正确。");
    }
    return mediaAnalysis.listAssets(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      {
        audioTrackId: requireString(request.query.audioTrackId, "audioTrackId"),
        runId: requireString(request.query.runId, "runId"),
        kind,
        preset: requireString(request.query.preset, "preset"),
        level: request.query.level === undefined
          ? undefined
          : Number(request.query.level),
        startTime: Number(request.query.startTime),
        endTime: Number(request.query.endTime),
      },
    );
  });

  app.get<{
    Params: { resourceId: string; assetId: string };
    Querystring: { audioTrackId: string };
  }>("/api/annotation-files/:resourceId/media-analysis/assets/:assetId", async (request, reply) => {
    const asset = await mediaAnalysis.getAssetForRead(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      request.params.assetId,
      requireString(request.query.audioTrackId, "audioTrackId"),
    );
    reply.header("Content-Type", asset.mimeType);
    reply.header("Content-Length", asset.size);
    reply.header("ETag", `\"sha256-${asset.checksum}\"`);
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(await openAbortableResponseStream(
      request.raw,
      reply.raw,
      () => storage.getObjectStream(asset.storageKey),
    ));
  });

  // 批量端点减少远程窗口的 HTTP/ACL 扇出，仍由业务服务统一复核整批归属。
  app.post<{
    Params: { resourceId: string };
    Body: unknown;
  }>(
    "/api/annotation-files/:resourceId/media-analysis/assets/batch",
    MAINTENANCE_READ_ROUTE,
    async (request, reply) => {
      const disconnect = bindHttpDisconnectSignal(request.raw, reply.raw);
      try {
        const body = requireObject(request.body);
        const runId = requireString(body.runId, "runId").trim();
        const assetIds = parseMediaAnalysisAssetIds(body.assetIds);
        const assets = await mediaAnalysis.getAssetsForBatchRead(
          await getCurrentUser(repository, request),
          request.params.resourceId,
          runId,
          assetIds,
          requireString(body.audioTrackId, "audioTrackId"),
        );
        const header = encodeMediaAnalysisTileBatchHeader(assets.map((asset) => ({
          id: asset.id,
          byteLength: Number(asset.size),
        })));
        const contentLength = header.byteLength + assets.reduce(
          (sum, asset) => sum + Number(asset.size),
          0,
        );

        // 先发送有界 manifest，再逐项透传对象流；客户端跳转后立即停止当前及后续对象读取。
        const stream = createAbortableObjectBatchStream({
          header,
          assets,
          storage,
          signal: disconnect.signal,
        });
        stream.once("close", disconnect.dispose);
        reply.header("Content-Type", "application/vnd.xiqu.media-analysis-batch");
        reply.header("Content-Length", contentLength);
        reply.header("Cache-Control", "private, max-age=300");
        return reply.send(stream);
      } catch (error) {
        disconnect.dispose();
        throw error;
      }
    },
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
      name?: unknown;
      payload?: unknown;
      mediaResourceId?: unknown;
    };
  }>("/api/annotation-files/batch-import-item", async (request) => {
    const body = requireObject(request.body);
    if (typeof body.parentId !== "string" || typeof body.name !== "string") {
      throw badRequest("创建标注文件需要 parentId 和 name。");
    }
    return resources.createBatchImportedAnnotationFile(
      await getCurrentUser(repository, request),
      {
        parentId: body.parentId,
        name: body.name,
        payload: body.payload ?? {},
        mediaResourceId: optionalStringOrNull(body.mediaResourceId),
      },
    );
  });

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

  app.post<{
    Params: { resourceId: string };
    Body: {
      clientBackupId?: unknown;
      sourceRevision?: unknown;
      failureCount?: unknown;
      payload?: unknown;
    };
  }>("/api/annotation-files/:resourceId/recovery-backups", async (request) => {
    const body = requireObject(request.body);
    if (
      typeof body.clientBackupId !== "string" ||
      !Number.isInteger(body.sourceRevision) ||
      !Number.isInteger(body.failureCount) ||
      body.payload === undefined
    ) {
      throw badRequest("创建恢复备份需要有效的失败周期、版本、失败次数和标注文档。");
    }
    const user = await getCurrentUser(repository, request);
    const created = await annotationRecoveryBackups.create(
      user,
      request.params.resourceId,
      {
        clientBackupId: body.clientBackupId,
        sourceRevision: Number(body.sourceRevision),
        failureCount: Number(body.failureCount),
        payload: body.payload,
      },
    );
    const [file, folder] = await Promise.all([
      resources.getAnnotationFile(user, created.backupResourceId),
      resources.getResource(user, created.folderId),
    ]);
    return { file, folder, replayed: created.replayed };
  });

  app.get<{ Params: { resourceId: string } }>(
    "/api/annotation-files/:resourceId/mutation-lease",
    async (request) => resources.getAnnotationMutationLease(
      await getCurrentUser(repository, request),
      request.params.resourceId,
    ),
  );

  app.post<{
    Params: { resourceId: string };
    Body: { baseRevision?: unknown; purpose?: unknown };
  }>("/api/annotation-files/:resourceId/mutation-lease", async (request) => {
    const body = requireObject(request.body);
    const purpose = parseAnnotationMutationPurpose(body.purpose);
    if (!Number.isInteger(body.baseRevision) || Number(body.baseRevision) < 1 || !purpose) {
      throw badRequest("结构变更租约的 baseRevision 或 purpose 无效。");
    }
    return resources.acquireAnnotationMutationLease(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      { baseRevision: Number(body.baseRevision), purpose },
    );
  });

  app.patch<{
    Params: { resourceId: string };
    Body: { token?: unknown };
  }>("/api/annotation-files/:resourceId/mutation-lease", async (request) => {
    const body = requireObject(request.body);
    if (!isValidAnnotationMutationLeaseToken(body.token)) throw badRequest("结构变更租约 token 无效。");
    return resources.renewAnnotationMutationLease(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      body.token,
    );
  });

  app.delete<{
    Params: { resourceId: string };
    Body: { token?: unknown };
  }>("/api/annotation-files/:resourceId/mutation-lease", async (request, reply) => {
    const body = requireObject(request.body);
    if (!isValidAnnotationMutationLeaseToken(body.token)) throw badRequest("结构变更租约 token 无效。");
    await resources.releaseAnnotationMutationLease(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      body.token,
    );
    return reply.status(204).send();
  });

  app.put<{
    Params: { resourceId: string };
    Body: { baseRevision?: unknown; payload?: unknown; clientOperationIds?: unknown; mutationLeaseToken?: unknown };
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
        clientOperationIds: parseSaveClientOperationIds(body.clientOperationIds),
        mutationLeaseToken: parseOptionalMutationLeaseToken(body.mutationLeaseToken),
      },
    );
    return saved;
  });

  app.get<{
    Params: { resourceId: string };
    Querystring: { cursor?: unknown; limit?: unknown };
  }>(
    "/api/annotation-files/:resourceId/recovery-snapshots",
    async (request) =>
      resources.listRecoverySnapshots(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        { cursor: request.query.cursor, limit: request.query.limit },
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
    Body: { baseRevision?: unknown; mutationLeaseToken?: unknown };
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
        {
          baseRevision: Number(body.baseRevision),
          mutationLeaseToken: parseOptionalMutationLeaseToken(body.mutationLeaseToken),
        },
      );
    },
  );

  // 确认列表使用服务端 opaque cursor；limit 只控制页面大小，不改变权限与排序。
  app.get<{
    Params: { resourceId: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/api/annotation-files/:resourceId/confirmations",
    async (request) => {
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      if (limit !== undefined && (
        !Number.isInteger(limit) || limit < 1 || limit > ANNOTATION_REVIEW_PAGE_MAX_LIMIT
      )) {
        throw badRequest(`limit 必须是 1 到 ${ANNOTATION_REVIEW_PAGE_MAX_LIMIT} 的整数。`);
      }
      return resources.listAnnotationConfirmations(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        { cursor: request.query.cursor, limit },
      );
    },
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

  // 供应商能力、VOD 创建和临时播放会话共用登录鉴权，但各自保留业务权限复核。
  app.get("/api/media-providers", async (request) => {
    await getCurrentUser(repository, request);
    return resources.getMediaProviderCapabilities();
  });

  app.post<{ Body: unknown }>("/api/media-files/aliyun-vod", async (request) => {
    const body = requireObject(request.body);
    return resources.createAliyunVodMedia(
      await getCurrentUser(repository, request),
      {
        parentId: requireString(body.parentId, "目标目录"),
        name: requireString(body.name, "资源名称"),
        videoId: requireString(body.videoId, "阿里云 VOD ID"),
      },
    );
  });

  app.post<{ Params: { resourceId: string } }>(
    "/api/media-files/:resourceId/playback-session",
    MAINTENANCE_READ_ROUTE,
    async (request, reply) => {
      const session = await resources.createAliyunVodPlaybackSession(
        await getCurrentUser(repository, request),
        request.params.resourceId,
      );
      // playauth 只允许当前响应短暂存在，代理/CDN/浏览器不得缓存。
      reply.header("Cache-Control", "no-store");
      return session;
    },
  );

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
      return reply.send(await openAbortableResponseStream(
        request.raw,
        reply.raw,
        () => storage.getObjectStream(file.storageKey, range),
      ));
    }
    reply.header("Content-Length", file.size);
    return reply.send(await openAbortableResponseStream(
      request.raw,
      reply.raw,
      () => storage.getObjectStream(file.storageKey),
    ));
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

  app.get<{
    Params: { resourceId: string };
    Querystring: { cursor?: unknown; limit?: unknown };
  }>(
    "/api/annotation-files/:resourceId/operations",
    async (request) =>
      repository.listAnnotationOperations(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        { cursor: request.query.cursor, limit: request.query.limit },
      ),
  );

  app.get<{
    Params: { resourceId: string };
    Querystring: { cursor?: unknown; limit?: unknown };
  }>(
    "/api/annotation-files/:resourceId/committed-operations",
    async (request) =>
      repository.listCommittedAnnotationOperations(
        await getCurrentUser(repository, request),
        request.params.resourceId,
        { cursor: request.query.cursor, limit: request.query.limit },
      ),
  );

  app.post<{
    Params: { resourceId: string };
    Body: {
      clientOperationId?: unknown;
      baseRevision?: unknown;
      localRevision?: unknown;
      action?: unknown;
      payload?: unknown;
      mutationLeaseToken?: unknown;
    };
  }>("/api/annotation-files/:resourceId/operations", async (request) => {
    const body = requireObject(request.body);
    // operation 入库前同时校验 revision 元数据和共享 action/envelope 合同，未知命令不得进入审计事实。
    if (
      !isValidClientOperationId(body.clientOperationId) ||
      !Number.isInteger(body.baseRevision) ||
      Number(body.baseRevision) < 0 ||
      Number(body.baseRevision) > 2_147_483_647 ||
      (body.localRevision !== undefined &&
        body.localRevision !== null &&
        (!Number.isInteger(body.localRevision) ||
          Number(body.localRevision) < 0 ||
          Number(body.localRevision) > 2_147_483_647)) ||
      typeof body.action !== "string" ||
      !body.action.trim() ||
      !isValidAnnotationOperationPayload(body.action, body.payload ?? {})
    ) {
      throw badRequest("标注操作参数不正确。");
    }
    return repository.createAnnotationOperation(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      {
        clientOperationId: body.clientOperationId,
        baseRevision: Number(body.baseRevision),
        localRevision: body.localRevision === null ||
          body.localRevision === undefined
          ? null
          : Number(body.localRevision),
        action: body.action,
        payload: body.payload ?? {},
        mutationLeaseToken: parseOptionalMutationLeaseToken(body.mutationLeaseToken),
      },
    );
  });

  app.post<{
    Params: { resourceId: string };
    Body: unknown;
  }>("/api/annotation-files/:resourceId/command-batches", async (request) => {
    // shared parser 同时约束批次数量、命令 envelope、action 对应关系和幂等 id；路由不复制领域规则。
    const parsed = parseAnnotationCommandBatchRequest(request.body);
    if (!parsed.success) {
      throw badRequest("原子标注命令批次参数不正确。", {
        code: "invalid_annotation_command_batch",
        issues: parsed.issues.slice(0, 20),
      });
    }
    if (
      parsed.data.mutationLeaseToken !== undefined &&
      !isValidAnnotationMutationLeaseToken(parsed.data.mutationLeaseToken)
    ) {
      throw badRequest("结构变更租约凭据格式不正确。", {
        code: "invalid_annotation_mutation_lease_token",
      });
    }
    return annotationCommandCommits.commitBatch(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      parsed.data,
    );
  });

  app.post<{
    Params: { resourceId: string };
    Body: unknown;
  }>("/api/annotation-files/:resourceId/sync-failures", async (request) =>
    resources.recordAnnotationClientSyncFailure(
      await getCurrentUser(repository, request),
      request.params.resourceId,
      parseAnnotationClientSyncFailureReport(request.body),
    ));

  app.post<{ Body: unknown }>("/api/annotation-tool-attempts/batch", async (request) => {
    const parsed = parseAnnotationToolAttemptBatchRequest(request.body);
    if (!parsed.success) {
      throw badRequest("工具尝试批次参数不正确。", {
        code: parsed.code,
        ...(parsed.attemptIndex === undefined ? {} : { attemptIndex: parsed.attemptIndex }),
      });
    }
    return annotationToolAttempts.submitBatch(
      await getCurrentUser(repository, request),
      parsed.data,
    );
  });

  app.get<{ Querystring: { from?: unknown; to?: unknown } }>(
    "/api/admin/annotation-tool-attempts/summary",
    async (request) => {
      const to = parseSummaryTimestamp(request.query.to, new Date());
      const from = parseSummaryTimestamp(
        request.query.from,
        new Date(to.getTime() - 7 * 24 * 60 * 60 * 1_000),
      );
      return annotationToolAttempts.summarize(
        await getCurrentUser(repository, request),
        { from, to },
      );
    },
  );

  app.get<{ Querystring: { from?: unknown; to?: unknown } }>(
    "/api/admin/annotation-tool-attempts/export",
    async (request, reply) => {
      const to = parseSummaryTimestamp(request.query.to, new Date());
      const from = parseSummaryTimestamp(
        request.query.from,
        new Date(to.getTime() - 7 * 24 * 60 * 60 * 1_000),
      );
      // CSV 必须由服务端重新查询并授权；浏览器不能用局部汇总结果拼接跨账号事实。
      const result = await annotationToolAttempts.exportAttempts(
        await getCurrentUser(repository, request),
        { from, to },
      );
      const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="xiqu-annotation-tool-attempts-${timestamp}.csv"`,
      );
      reply.header("X-Tool-Attempt-Export-Count", String(result.exportedCount));
      reply.header("X-Tool-Attempt-Export-Truncated", String(result.truncated));
      return result.csv;
    },
  );
}

function parseSummaryTimestamp(value: unknown, fallback: Date) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > 40) throw badRequest("汇总时间参数不正确。");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw badRequest("汇总时间参数不正确。");
  }
  return parsed;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("请求体必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string") throw badRequest(`${label}必须是字符串。`);
  return value;
}

function requireBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw badRequest(`${label}必须是布尔值。`);
  return value;
}

function parsePlatformRoles(value: unknown): PlatformRole[] {
  const allowed = new Set<PlatformRole>([
    "super_admin",
    "admin",
    "teacher",
    "annotator",
    "reviewer",
    "service",
  ]);
  if (!Array.isArray(value) || value.some((role) => typeof role !== "string" || !allowed.has(role as PlatformRole))) {
    throw badRequest("账号角色列表无效。");
  }
  return value as PlatformRole[];
}

function normalizedString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseProcessingJobScope(value: unknown) {
  return parseOptionalSetValue(value, PROCESSING_JOB_SCOPE_NAMES, "后台任务范围");
}

function parseProcessingJobStatus(value: unknown) {
  return parseOptionalSetValue(value, PROCESSING_JOB_STATUS_NAMES, "后台任务状态");
}

function parseProcessingJobType(value: unknown) {
  return parseOptionalSetValue(value, PROCESSING_JOB_TYPE_NAMES, "后台任务类型");
}

function requireProcessingJobCancellationBody(value: unknown): CancelProcessingJobRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("后台任务取消参数不正确。");
  }
  const body = value as Record<string, unknown>;
  return {
    clientCommandId: requireString(body.clientCommandId, "clientCommandId"),
    reason: body.reason === undefined ? undefined : requireString(body.reason, "reason"),
  };
}

function requireProcessingJobRetryBody(value: unknown): RetryProcessingJobRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("后台任务重试参数不正确。");
  }
  return {
    clientCommandId: requireString(
      (value as Record<string, unknown>).clientCommandId,
      "clientCommandId",
    ),
  };
}

const MAX_SYNC_FAILURE_REPORT_BYTES = 256 * 1024;

// 诊断接口只接受有界白名单结构，并对调试 payload 再脱敏一次；浏览器不能直接向 audit detail 注入任意 JSON。
function parseAnnotationClientSyncFailureReport(value: unknown): AnnotationClientSyncFailureReport {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > MAX_SYNC_FAILURE_REPORT_BYTES) {
    throw badRequest("客户端同步诊断超过大小限制。");
  }
  const input = requireObject(value);
  if (input.schemaVersion !== 1) throw badRequest("客户端同步诊断版本无效。");
  const category = parseBoundedDiagnosticEnum(
    input.category,
    ANNOTATION_SYNC_FAILURE_CATEGORIES,
    "同步失败分类",
  );
  const pendingOperations = parseSyncFailureOperations(input.pendingOperations);
  return {
    schemaVersion: 1,
    clientRuntimeId: parseDiagnosticString(input.clientRuntimeId, "客户端运行标识", 128),
    clientOccurredAt: parseDiagnosticDate(input.clientOccurredAt, "客户端失败时间"),
    category,
    reason: parseDiagnosticString(input.reason, "同步失败原因", 160),
    // 兼容修复前已打开的页面：旧报告没有 errorMessage 时至少保留稳定 reason，不能让诊断请求反向失败。
    errorMessage: parseDiagnosticString(
      input.errorMessage ?? input.reason,
      "同步失败消息",
      4_000,
    ),
    localRevision: parseDiagnosticInteger(input.localRevision, "本地 revision"),
    savedLocalRevision: parseDiagnosticInteger(input.savedLocalRevision, "已保存本地 revision"),
    documentRemoteRevision: input.documentRemoteRevision === null
      ? null
      : parseDiagnosticInteger(input.documentRemoteRevision, "文档远端 revision"),
    appRemoteRevision: parseDiagnosticInteger(input.appRemoteRevision, "应用远端 revision"),
    observedRemoteRevision: parseDiagnosticInteger(input.observedRemoteRevision, "已观察远端 revision"),
    pendingOperationCount: parseDiagnosticInteger(input.pendingOperationCount, "pending 数量"),
    hasUnsavedChanges: parseDiagnosticBoolean(input.hasUnsavedChanges, "未保存状态"),
    saveInFlight: parseDiagnosticBoolean(input.saveInFlight, "保存进行状态"),
    online: parseDiagnosticBoolean(input.online, "在线状态"),
    mismatchFields: parseDiagnosticStringArray(input.mismatchFields, "不一致字段", 32, 128),
    mismatchDetails: parseSyncFailureMismatchDetails(input.mismatchDetails),
    ...(input.plannerFailure === undefined
      ? {}
      : { plannerFailure: parseSyncFailurePlannerFailure(input.plannerFailure) }),
    pendingOperations,
    pendingOperationsTruncated: parseDiagnosticBoolean(
      input.pendingOperationsTruncated,
      "pending 截断状态",
    ),
  };
}

function parseSyncFailurePlannerFailure(
  value: unknown,
): NonNullable<AnnotationClientSyncFailureReport["plannerFailure"]> {
  const input = requireObject(value);
  return {
    operationId: input.operationId === null
      ? null
      : parseDiagnosticString(input.operationId, "失败 operationId", 160),
    operationIndex: input.operationIndex === null
      ? null
      : parseDiagnosticInteger(input.operationIndex, "失败 operation 索引"),
    // planner issue 来自可信客户端代码但仍按任意 JSON 对待，服务端继续执行第二层脱敏和深度限制。
    issues: sanitizeServerDiagnosticValue(input.issues),
  };
}

function parseSyncFailureMismatchDetails(
  value: unknown,
): AnnotationClientSyncFailureReport["mismatchDetails"] {
  if (!Array.isArray(value) || value.length > 64) throw badRequest("同步诊断差异数量无效。");
  return value.map((item, index) => {
    const detail = requireObject(item);
    return {
      path: parseDiagnosticString(detail.path, `第 ${index + 1} 条差异路径`, 512),
      savedValue: sanitizeServerDiagnosticValue(detail.savedValue),
      replayedValue: sanitizeServerDiagnosticValue(detail.replayedValue),
      currentValue: sanitizeServerDiagnosticValue(detail.currentValue),
    };
  });
}

function parseSyncFailureOperations(value: unknown): AnnotationClientSyncFailureOperation[] {
  if (!Array.isArray(value) || value.length > 20) throw badRequest("同步诊断 pending 命令数量无效。");
  return value.map((item, index) => {
    const operation = requireObject(item);
    return {
      operationId: parseDiagnosticString(operation.operationId, `第 ${index + 1} 条 operationId`, 160),
      action: parseDiagnosticString(operation.action, `第 ${index + 1} 条 action`, 160),
      commandType: parseDiagnosticString(operation.commandType, `第 ${index + 1} 条命令类型`, 160),
      baseRevision: parseDiagnosticInteger(operation.baseRevision, `第 ${index + 1} 条 baseRevision`),
      localRevision: parseDiagnosticInteger(operation.localRevision, `第 ${index + 1} 条 localRevision`),
      createdAt: parseDiagnosticDate(operation.createdAt, `第 ${index + 1} 条创建时间`),
      targets: parseDiagnosticStringArray(operation.targets, `第 ${index + 1} 条目标`, 32, 320),
      ...(operation.commandPayload === undefined
        ? {}
        : { commandPayload: sanitizeServerDiagnosticValue(operation.commandPayload) }),
    };
  });
}

function parseDiagnosticString(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    throw badRequest(`${label}无效。`);
  }
  return sanitizeDiagnosticString(value.trim());
}

function parseDiagnosticDate(value: unknown, label: string) {
  const normalized = parseDiagnosticString(value, label, 64);
  if (Number.isNaN(Date.parse(normalized))) throw badRequest(`${label}无效。`);
  return new Date(normalized).toISOString();
}

function parseDiagnosticInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2_147_483_647) {
    throw badRequest(`${label}无效。`);
  }
  return Number(value);
}

function parseDiagnosticBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw badRequest(`${label}无效。`);
  return value;
}

function parseDiagnosticStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
) {
  if (!Array.isArray(value) || value.length > maximumItems) throw badRequest(`${label}无效。`);
  return value.map((item) => parseDiagnosticString(item, label, maximumLength));
}

function parseBoundedDiagnosticEnum<T extends string>(
  value: unknown,
  allowed: Set<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw badRequest(`${label}无效。`);
  return value as T;
}

function sanitizeServerDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return sanitizeDiagnosticString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeServerDiagnosticValue(item, depth + 1));
  if (!value || typeof value !== "object") return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    output[key] = /(token|secret|password|authorization|playauth|access.?key|credential|url)/i.test(key)
      ? "[REDACTED]"
      : sanitizeServerDiagnosticValue(item, depth + 1);
  }
  return output;
}

function sanitizeDiagnosticString(value: string) {
  return value
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\bbearer\s+[^\s,;]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\bLTAI[A-Za-z0-9]{12,}\b/g, "[REDACTED_ACCESS_KEY_ID]")
    .replace(/\b(?:access.?key.?secret|playauth|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 4_000);
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

function parseOptionalMutationLeaseToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isValidAnnotationMutationLeaseToken(value)) throw badRequest("结构变更租约 token 无效。");
  return value;
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
      REVIEW_DOMAINS.has(domain as AnnotationConfirmationDomain))
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

// 确认与评论共享同一作用域 parser；别名保留确认路由的语义化调用点。
const parseAnnotationReviewScope = (value: unknown): AnnotationReviewScope =>
  parseAnnotationConfirmationScope(value);

// kind 是权限门禁的一部分，路由必须在进入事务前拒绝缺失或未知值。
function parseAnnotationRangeCommentKind(value: unknown): AnnotationRangeCommentKind {
  if (
    typeof value !== "string" ||
    !ANNOTATION_RANGE_COMMENT_KINDS.includes(value as AnnotationRangeCommentKind)
  ) {
    throw badRequest("范围记录类型必须是 review_comment 或 editor_feedback。");
  }
  return value as AnnotationRangeCommentKind;
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

function parseAnnotationWorkflowStatus(
  value: unknown,
  label: string,
): AnnotationWorkflowStatus {
  if (
    typeof value !== "string" ||
    !ANNOTATION_WORKFLOW_STATUSES.has(value as AnnotationWorkflowStatus)
  ) {
    throw badRequest(`${label}无效。`);
  }
  return value as AnnotationWorkflowStatus;
}

function parseAccountIdArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((item) =>
      typeof item !== "string" || !item.trim() || item.length > 160)
  ) {
    throw badRequest(`${label}必须是最多 500 个有效账号编号组成的数组。`);
  }
  const normalized = value.map((item) => item.trim()) as string[];
  if (new Set(normalized).size !== normalized.length) {
    throw badRequest(`${label}不能包含重复账号。`);
  }
  return normalized;
}

/** 分析批次中的顺序决定响应分段顺序，重复项不能像普通资源选择一样被静默去重。 */
function parseMediaAnalysisAssetIds(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MEDIA_ANALYSIS_BATCH_ASSETS ||
    value.some((item) => typeof item !== "string" || !item.trim() || item.length > 128)
  ) {
    throw badRequest("assetIds 必须是有界的非空资产 ID 数组。");
  }
  const normalized = value.map((item) => item.trim()) as string[];
  if (new Set(normalized).size !== normalized.length) {
    throw badRequest("assetIds 不能包含重复资产 ID。");
  }
  return normalized;
}

// 保存事务只接受当前账号的稳定 operation 幂等键；重复项不能被静默去重后形成含糊确认数量。
function parseSaveClientOperationIds(value: unknown) {
  // 早期内部调用没有 operation 时等价为空数组；正式 PlatformClient 始终显式发送该字段。
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((item) => !isValidClientOperationId(item))
  ) {
    throw badRequest("clientOperationIds 必须是最多 500 个有效操作编号组成的数组。");
  }
  if (new Set(value).size !== value.length) {
    throw badRequest("clientOperationIds 不能包含重复操作编号。");
  }
  return value as string[];
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

// 同时提供 ASCII fallback 与 RFC 5987 UTF-8 文件名，保证中文资源名在主流浏览器中正确显示。
function buildAttachmentContentDisposition(fileName: string) {
  const asciiFallback = fileName
    .replace(/[\x00-\x1f\x7f"\\/]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim() || "download";
  const encoded = encodeURIComponent(fileName)
    .replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

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
