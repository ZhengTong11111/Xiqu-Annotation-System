import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import type { PrismaClient } from "@prisma/client";
import {
  ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL,
  type AliyunVodWebPlayerLicense,
} from "@xiqu/shared";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";
import { AuditLogService } from "./auditLogService.js";
import { PrismaPlatformRepository } from "./repository.js";
import { ResourceAccessService } from "./resourceAccess.js";
import { ResourceService } from "./resourceService.js";
import { registerApiRoutes } from "./router.js";
import { AnnotationRecoveryBackupService } from "./annotationRecoveryBackupService.js";
import { AnnotationReviewLinkService } from "./annotationReviewLinkService.js";
import type { ObjectStorage } from "./objectStorage.js";
import { createObjectStorageFromEnvironment } from "./objectStorageFactory.js";
import { MediaUploadService } from "./mediaUploadService.js";
import { MaintenanceCoordinator } from "./maintenanceCoordinator.js";
import { ObjectLifecycleService } from "./objectLifecycleService.js";
import { ApiObservability } from "./observability.js";
import {
  loadOperationalMetricsTimeout,
  OperationalMetricsCollector,
} from "./operationalMetricsCollector.js";
import { HealthService } from "./healthService.js";
import { SystemDiagnosticsService } from "./systemDiagnosticsService.js";
import { loadUploadPolicy, type UploadPolicy } from "./uploadPolicy.js";
import { AnnotationCollaborationTicketService } from "./annotationCollaborationTicketService.js";
import { AnnotationCollaborationHub } from "./annotationCollaborationHub.js";
import { registerAnnotationCollaborationRoutes } from "./annotationCollaborationRoutes.js";
import { createAnnotationRevisionChannel } from "./annotationRevisionEventEnvelope.js";
import {
  createPostgresAnnotationRevisionTransport,
  PostgresAnnotationRevisionEventBus,
} from "./postgresAnnotationRevisionEventBus.js";
import { AnnotationPresenceService } from "./annotationPresenceService.js";
import { AnnotationPresenceCoordinator } from "./annotationPresenceCoordinator.js";
import { createAnnotationPresenceChannel } from "./annotationPresenceEventEnvelope.js";
import { PostgresAnnotationPresenceEventBus } from "./postgresAnnotationPresenceEventBus.js";
import { createPostgresEventTransport } from "./postgresCoalescedEventBus.js";
import { createAnnotationRemoteActivityChannel } from "./annotationRemoteActivityEventEnvelope.js";
import { PostgresAnnotationRemoteActivityEventBus } from "./postgresAnnotationRemoteActivityEventBus.js";
import { AnnotationCommandCommitService } from "./annotationCommandCommitService.js";
import type { ApiCorsOriginPolicy } from "./serverConfig.js";
import { AccountAdminService } from "./accountAdminService.js";
import type { AliyunVodProvider } from "./aliyunVodGateway.js";
import { MediaAnalysisJobService } from "./mediaAnalysisJobService.js";
import { MediaAudioTrackService } from "./mediaAudioTrackService.js";
import { MediaAudioPlaybackSessionService } from "./mediaAudioPlaybackSessionService.js";
import { createAnnotationReviewChannel } from "./annotationReviewEventEnvelope.js";
import { PostgresAnnotationReviewEventBus } from "./postgresAnnotationReviewEventBus.js";
import { ProcessingJobQueryService } from "./processingJobQueryService.js";
import { ProcessingJobCommandService } from "./processingJobCommandService.js";
import { createSafeFastifyLoggerConfiguration } from "./requestLogSanitizer.js";
import { AnnotationToolAttemptService } from "./annotationToolAttemptService.js";
import { AlignmentRunService } from "./alignmentRunService.js";

export type BuildApiAppOptions = {
  prisma: PrismaClient;
  maintenancePool: Pool;
  collaborationPool: Pool;
  databaseSchema: string;
  storage?: ObjectStorage;
  logger?: FastifyServerOptions["logger"] | FastifyBaseLogger;
  seed?: boolean;
  uploadPolicy?: Partial<UploadPolicy>;
  metricsToken?: string | null;
  operationalMetricsTimeoutMs?: number;
  corsOrigin?: ApiCorsOriginPolicy;
  aliyunVod?: AliyunVodProvider | null;
  aliyunVodWebPlayerLicense?: AliyunVodWebPlayerLicense | null;
  forceAlignmentRequestsEnabled?: boolean;
};

/**
 * 构建一个尚未监听端口的 Fastify 应用。
 *
 * 生产入口和集成测试共用这一个装配函数，避免测试复制路由、错误处理或权限依赖。
 * 数据库和对象存储由调用方持有，因此调用方也负责在 app.close() 后释放它们。
 */
export async function buildApiApp(
  options: BuildApiAppOptions,
): Promise<FastifyInstance> {
  const access = new ResourceAccessService(options.prisma);
  const repository = new PrismaPlatformRepository(options.prisma, access);
  // 审计读取拥有独立授权、分页和导出边界，不把治理查询重新塞回通用资源仓储。
  const auditLogs = new AuditLogService(options.prisma, access);
  const accounts = new AccountAdminService(options.prisma);
  const collaborationHub = new AnnotationCollaborationHub();
  const collaborationTickets = new AnnotationCollaborationTicketService(options.prisma, access);
  // 生产默认只通过工厂装配一次；测试可注入 typed adapter，不读取宿主环境。
  const storage = options.storage ?? createObjectStorageFromEnvironment();
  const uploadPolicy = loadUploadPolicy(options.uploadPolicy);
  const observability = new ApiObservability();
  // 默认生产日志和测试注入配置共用脱敏装配，避免自定义 level/stream 绕过请求 URL 凭据清理。
  const app = Fastify({
    ...createSafeFastifyLoggerConfiguration(
      options.logger,
      process.env.LOG_LEVEL ?? "info",
    ),
    bodyLimit: uploadPolicy.maxUploadBytes + 1024 * 1024,
  });
  // 跨实例总线只发布有损 revision 提示；ResourceService 不感知 PostgreSQL 或 WebSocket 实现。
  const collaborationEvents = new PostgresAnnotationRevisionEventBus({
    transport: createPostgresAnnotationRevisionTransport(options.collaborationPool),
    channel: createAnnotationRevisionChannel(options.databaseSchema),
    deliver: (event) => collaborationHub.deliverRevisionAdvanced(event),
    observability,
    logger: app.log,
  });
  const annotationPresence = new AnnotationPresenceService(options.prisma, access);
  const presenceCoordinator = new AnnotationPresenceCoordinator(
    annotationPresence,
    collaborationHub,
    app.log,
  );
  const presenceEvents = new PostgresAnnotationPresenceEventBus({
    transport: createPostgresEventTransport(options.collaborationPool),
    channel: createAnnotationPresenceChannel(options.databaseSchema),
    deliver: (event) => presenceCoordinator.requestRefresh(event.annotationFileId),
    observability,
    logger: app.log,
  });
  const remoteActivityEvents = new PostgresAnnotationRemoteActivityEventBus({
    transport: createPostgresEventTransport(options.collaborationPool),
    channel: createAnnotationRemoteActivityChannel(options.databaseSchema),
    deliver: (event) => collaborationHub.deliverRemoteActivity(event),
    observability,
    logger: app.log,
  });
  const reviewEvents = new PostgresAnnotationReviewEventBus({
    transport: createPostgresEventTransport(options.collaborationPool),
    channel: createAnnotationReviewChannel(options.databaseSchema),
    deliver: (event) => collaborationHub.deliverReviewChanged(event),
    logger: app.log,
  });
  const resources = new ResourceService(
    options.prisma,
    access,
    collaborationEvents,
    options.aliyunVod ?? null,
    options.aliyunVodWebPlayerLicense ?? null,
    reviewEvents,
  );
  const annotationRecoveryBackups = new AnnotationRecoveryBackupService(
    options.prisma,
    access,
  );
  const annotationReviewLinks = new AnnotationReviewLinkService(
    options.prisma,
    access,
    reviewEvents,
  );
  const mediaAnalysis = new MediaAnalysisJobService(options.prisma, access);
  const alignmentRuns = new AlignmentRunService(
    options.prisma,
    access,
    options.forceAlignmentRequestsEnabled === true,
  );
  const processingJobs = new ProcessingJobQueryService(options.prisma, access);
  const processingJobCommands = new ProcessingJobCommandService(
    options.prisma,
    access,
    mediaAnalysis,
    alignmentRuns,
  );
  const mediaAudioTracks = new MediaAudioTrackService(
    options.prisma,
    access,
    options.aliyunVod ?? null,
  );
  const mediaAudioPlaybackSessions = new MediaAudioPlaybackSessionService(
    options.prisma,
    access,
    options.aliyunVod ?? null,
    options.aliyunVodWebPlayerLicense ?? null,
  );
  // 原子领域命令拥有独立事务服务，但与完整保存共用同一个跨实例 revision 发布器。
  const annotationCommandCommits = new AnnotationCommandCommitService(
    options.prisma,
    access,
    collaborationEvents,
  );
  const annotationToolAttempts = new AnnotationToolAttemptService(options.prisma, access);
  const health = new HealthService(options.prisma, storage);
  // 外部监控采集使用有限只读聚合，并与管理员诊断的重型对象审计保持分离。
  const operationalMetrics = new OperationalMetricsCollector(
    options.prisma,
    health,
    uploadPolicy.platformQuotaBytes,
    options.operationalMetricsTimeoutMs ?? loadOperationalMetricsTimeout(
      process.env.XIQU_OPERATIONAL_METRICS_TIMEOUT_MS,
    ),
  );
  const maintenance = new MaintenanceCoordinator(
    options.prisma,
    options.maintenancePool,
    access,
    observability,
  );
  observability.bindMaintenancePermitDiagnostics(() =>
    maintenance.getPermitDiagnostics());
  const mediaUploads = new MediaUploadService(
    resources,
    storage,
    uploadPolicy,
    observability,
  );
  const objectLifecycle = new ObjectLifecycleService(
    options.prisma,
    access,
    storage,
    uploadPolicy,
  );
  observability.registerHttpHooks(app);
  maintenance.registerRequestGate(app);
  const diagnostics = new SystemDiagnosticsService(
    options.prisma,
    access,
    storage,
    objectLifecycle,
    health,
    maintenance,
    uploadPolicy,
  );

  // 同源生产部署无需 CORS；只有经过启动配置严格校验的跨源策略才注册响应头。
  if (options.corsOrigin !== false) {
    await app.register(cors, {
      origin: options.corsOrigin ?? true,
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // 审计 CSV 下载需要读取服务端给出的文件名、条数和截断状态。
      exposedHeaders: [
        "Content-Disposition",
        "X-Audit-Export-Count",
        "X-Audit-Export-Truncated",
        "X-Tool-Attempt-Export-Count",
        "X-Tool-Attempt-Export-Truncated",
      ],
    });
  }
  await app.register(multipart, {
    limits: { fileSize: uploadPolicy.maxUploadBytes, files: 1 },
  });
  // WebSocket plugin 必须先于 websocket route 注册；payload 上限防止通知通道被当成大消息入口。
  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024,
      // 只回显稳定协议名，绝不能把客户端排列在前的一次性票据写回响应头。
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL)
          ? ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL
          : false,
    },
  });

  app.setErrorHandler((error, _request, response) => {
    if (error instanceof HttpError) {
      void response.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }
    if (isMultipartSizeError(error)) {
      void response.status(413).send({
        error: {
          code: "upload_too_large",
          message: "媒体文件超过单文件上传限制。",
          details: { maxBytes: uploadPolicy.maxUploadBytes },
        },
      });
      return;
    }
    if (hasClientErrorStatus(error)) {
      void response.status(error.statusCode).send({
        error: {
          code: "bad_request",
          message: error.statusCode === 413
            ? "请求内容过大。"
            : "请求格式不正确。",
        },
      });
      return;
    }
    app.log.error(error);
    void response.status(500).send({
      error: { code: "internal_error", message: "服务端内部错误。" },
    });
  });

  app.addHook("preSerialization", async (_request, _response, payload) => {
    if (
      payload === null ||
      payload === undefined ||
      typeof payload !== "object" ||
      isStreamLike(payload) ||
      "error" in payload
    ) return payload;
    return { data: payload };
  });

  registerApiRoutes(
    app,
    repository,
    accounts,
    auditLogs,
    resources,
    annotationRecoveryBackups,
    annotationReviewLinks,
    mediaAnalysis,
    alignmentRuns,
    processingJobs,
    processingJobCommands,
    mediaAudioTracks,
    mediaAudioPlaybackSessions,
    annotationCommandCommits,
    annotationToolAttempts,
    storage,
    mediaUploads,
    objectLifecycle,
    health,
    maintenance,
    diagnostics,
    observability,
    operationalMetrics,
    options.metricsToken === undefined
      ? process.env.XIQU_METRICS_TOKEN ?? null
      : options.metricsToken,
  );
  const collaborationRoutes = registerAnnotationCollaborationRoutes(
    app,
    repository,
    collaborationTickets,
    collaborationHub,
    annotationPresence,
    presenceCoordinator,
    presenceEvents,
    remoteActivityEvents,
    observability,
  );
  app.addHook("onClose", async () => {
    // 先关闭 socket 并删除在线行，再停止跨实例发布；异常退出仍由数据库 TTL 兜底。
    collaborationHub.closeAll();
    await collaborationRoutes.close();
    await remoteActivityEvents.close();
    await presenceEvents.close();
    await reviewEvents.close();
    await collaborationEvents.close();
    await presenceCoordinator.close();
  });
  if (options.seed) await repository.ensureSeedData();
  try {
    // 初次 LISTEN 失败必须阻止应用启动；运行期断线由 event bus 自己有界重连。
    await collaborationEvents.start();
    await presenceEvents.start();
    await remoteActivityEvents.start();
    await reviewEvents.start();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

// multipart 在消费流时使用稳定 Fastify code 报超限，统一映射为平台上传错误合同。
function isMultipartSizeError(error: unknown) {
  return error instanceof Error && "code" in error &&
    error.code === "FST_REQ_FILE_TOO_LARGE";
}

function isStreamLike(payload: object) {
  return "pipe" in payload && typeof payload.pipe === "function";
}

function hasClientErrorStatus(
  error: unknown,
): error is { statusCode: number } {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return false;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" &&
    statusCode >= 400 &&
    statusCode < 500;
}
