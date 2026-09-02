import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import {
  OPERATIONAL_DEPENDENCIES,
  OPERATIONAL_JOB_STATUSES,
  type OperationalMetricsSnapshot,
} from "./operationalMetricsCollector.js";
import {
  ANNOTATION_HISTORY_COVERAGE_STATES,
  ANNOTATION_HISTORY_GROWTH_WINDOWS,
  ANNOTATION_HISTORY_STORAGE_MODES,
} from "./annotationHistoryCapacityMetrics.js";
import type { MaintenancePermitDiagnostics } from "./maintenanceCoordinator.js";

export type UploadMetricResult =
  | "success"
  | "too_large"
  | "unsupported_media"
  | "validation"
  | "quota"
  | "forbidden"
  | "conflict"
  | "internal";

export type AnnotationRevisionBusPublishResult =
  | "queued"
  | "coalesced"
  | "dropped"
  | "failed";

export type AnnotationRevisionBusInboundResult =
  | "accepted"
  | "duplicate"
  | "invalid";

// 每个 Fastify 实例拥有独立 Registry，集成测试可反复构建 app 而不会发生指标重名。
export class ApiObservability {
  readonly registry = new Registry();
  private readonly httpRequests: Counter;
  private readonly httpDuration: Histogram;
  private readonly mediaUploads: Counter;
  private readonly mediaUploadBytes: Counter;
  private readonly compensationFailures: Counter;
  private readonly storageCleanup: Counter;
  private readonly storageCleanupDeleted: Counter;
  private readonly dependencyAvailable: Gauge;
  private readonly platformStorageUsedBytes: Gauge;
  private readonly platformStorageQuotaBytes: Gauge;
  private readonly annotationRecoverySnapshotRelationBytes: Gauge;
  private readonly annotationRecoverySnapshots: Gauge;
  private readonly annotationRecoverySnapshotPayloads: Gauge;
  private readonly annotationRecoverySnapshotHashes: Gauge;
  private readonly annotationRecoverySnapshotRecentCreated: Gauge;
  private readonly processingJobs: Gauge;
  private readonly processingJobOldestAge: Gauge;
  private readonly processingJobStaleClaims: Gauge;
  private readonly processingJobRecentOutcomes: Gauge;
  private readonly processingJobAverageDuration: Gauge;
  private readonly maintenanceWritePermitsActive: Gauge;
  private readonly maintenanceWritePermitsWaiting: Gauge;
  private readonly maintenanceOldestPermitAge: Gauge;
  private readonly maintenancePermitAcquireFailures: Counter;
  private readonly maintenancePermitReleaseFailures: Counter;
  private readonly maintenancePermitHoldDuration: Histogram;
  private readonly operationalCollectionSuccess: Gauge;
  private readonly operationalCollectionTimestamp: Gauge;
  private readonly annotationRevisionBusConnected: Gauge;
  private readonly annotationRevisionBusPendingFiles: Gauge;
  private readonly annotationRevisionBusPublishes: Counter;
  private readonly annotationRevisionBusInbound: Counter;
  private readonly annotationRevisionBusReconnects: Counter;
  private readonly annotationPresenceBusConnected: Gauge;
  private readonly annotationPresenceBusPendingFiles: Gauge;
  private readonly annotationPresenceBusPublishes: Counter;
  private readonly annotationPresenceBusInbound: Counter;
  private readonly annotationPresenceBusReconnects: Counter;
  private readonly annotationRemoteActivityBusConnected: Gauge;
  private readonly annotationRemoteActivityBusPendingSessions: Gauge;
  private readonly annotationRemoteActivityBusPublishes: Counter;
  private readonly annotationRemoteActivityBusInbound: Counter;
  private readonly annotationRemoteActivityBusReconnects: Counter;
  private readonly annotationRemoteActivityClientMessages: Counter;
  private maintenancePermitSnapshot: () => MaintenancePermitDiagnostics = () => ({
    active: 0,
    waiting: 0,
    oldestActiveAgeMs: 0,
  });

  constructor() {
    // 默认进程指标与平台业务指标注册到同一个实例级 Registry，便于一次抓取和测试隔离。
    collectDefaultMetrics({ register: this.registry, prefix: "xiqu_" });
    this.httpRequests = new Counter({
      name: "xiqu_http_requests_total",
      help: "API HTTP requests by normalized route and response status.",
      labelNames: ["method", "route", "status_code"],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: "xiqu_http_request_duration_seconds",
      help: "API HTTP request duration by normalized route and response status.",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.mediaUploads = new Counter({
      name: "xiqu_media_uploads_total",
      help: "Media upload attempts by stable outcome category.",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.mediaUploadBytes = new Counter({
      name: "xiqu_media_upload_bytes_total",
      help: "Bytes from media uploads committed successfully.",
      registers: [this.registry],
    });
    this.compensationFailures = new Counter({
      name: "xiqu_media_upload_compensation_failures_total",
      help: "Failed upload object compensation attempts.",
      labelNames: ["stage"],
      registers: [this.registry],
    });
    this.storageCleanup = new Counter({
      name: "xiqu_storage_cleanup_total",
      help: "Storage orphan cleanup runs by outcome.",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.storageCleanupDeleted = new Counter({
      name: "xiqu_storage_cleanup_deleted_total",
      help: "Objects removed by storage lifecycle cleanup.",
      labelNames: ["kind"],
      registers: [this.registry],
    });
    // 运维 Gauge 仅使用固定 label，供 Prometheus/Alertmanager 判断依赖、容量和任务状态。
    this.dependencyAvailable = new Gauge({
      name: "xiqu_dependency_available",
      help: "Whether each required API dependency is currently available.",
      labelNames: ["dependency"],
      registers: [this.registry],
    });
    this.platformStorageUsedBytes = new Gauge({
      name: "xiqu_platform_storage_used_bytes",
      help: "Logical bytes used by unique platform file objects.",
      registers: [this.registry],
    });
    this.platformStorageQuotaBytes = new Gauge({
      name: "xiqu_platform_storage_quota_bytes",
      help: "Configured logical platform storage quota in bytes.",
      registers: [this.registry],
    });
    // 恢复历史容量只使用固定枚举标签，不能把文件、快照或 revision 身份写入时序数据库。
    this.annotationRecoverySnapshotRelationBytes = new Gauge({
      name: "xiqu_annotation_recovery_snapshot_relation_bytes",
      help: "PostgreSQL total relation bytes for annotation recovery snapshots, including indexes and TOAST.",
      registers: [this.registry],
    });
    this.annotationRecoverySnapshots = new Gauge({
      name: "xiqu_annotation_recovery_snapshots",
      help: "Annotation recovery snapshot rows by fixed storage mode.",
      labelNames: ["storage_mode"],
      registers: [this.registry],
    });
    this.annotationRecoverySnapshotPayloads = new Gauge({
      name: "xiqu_annotation_recovery_snapshot_payloads",
      help: "Annotation recovery snapshot rows by payload coverage state.",
      labelNames: ["state"],
      registers: [this.registry],
    });
    this.annotationRecoverySnapshotHashes = new Gauge({
      name: "xiqu_annotation_recovery_snapshot_hashes",
      help: "Annotation recovery snapshot rows by canonical hash coverage state.",
      labelNames: ["state"],
      registers: [this.registry],
    });
    this.annotationRecoverySnapshotRecentCreated = new Gauge({
      name: "xiqu_annotation_recovery_snapshot_recent_created",
      help: "Annotation recovery snapshots created in fixed recent windows.",
      labelNames: ["window"],
      registers: [this.registry],
    });
    this.processingJobs = new Gauge({
      name: "xiqu_processing_jobs",
      help: "Current processing jobs by stable status.",
      labelNames: ["status"],
      registers: [this.registry],
    });
    // 任务时效指标只使用固定阶段/状态标签，具体任务身份仍留在受权限控制的任务中心。
    this.processingJobOldestAge = new Gauge({
      name: "xiqu_processing_job_oldest_age_seconds",
      help: "Age of the oldest processing job fact by stable phase.",
      labelNames: ["phase"],
      registers: [this.registry],
    });
    this.processingJobStaleClaims = new Gauge({
      name: "xiqu_processing_job_stale_claims",
      help: "Current stale processing job claims by active status.",
      labelNames: ["status"],
      registers: [this.registry],
    });
    this.processingJobRecentOutcomes = new Gauge({
      name: "xiqu_processing_job_recent_outcomes",
      help: "Processing job terminal outcomes in the fixed recent window.",
      labelNames: ["status"],
      registers: [this.registry],
    });
    this.processingJobAverageDuration = new Gauge({
      name: "xiqu_processing_job_recent_average_duration_seconds",
      help: "Average processing job duration by stable phase in the recent window.",
      labelNames: ["phase"],
      registers: [this.registry],
    });
    // 维护许可指标只按当前 API 实例聚合，不使用 route、用户或资源 id 形成高基数标签。
    this.maintenanceWritePermitsActive = new Gauge({
      name: "xiqu_maintenance_write_permits_active",
      help: "Active maintenance write permits held by this API instance.",
      registers: [this.registry],
      collect: () => {
        this.maintenanceWritePermitsActive.set(this.maintenancePermitSnapshot().active);
      },
    });
    this.maintenanceWritePermitsWaiting = new Gauge({
      name: "xiqu_maintenance_write_permits_waiting",
      help: "Requests waiting for a maintenance write permit connection on this API instance.",
      registers: [this.registry],
      collect: () => {
        this.maintenanceWritePermitsWaiting.set(this.maintenancePermitSnapshot().waiting);
      },
    });
    this.maintenanceOldestPermitAge = new Gauge({
      name: "xiqu_maintenance_write_permit_oldest_age_seconds",
      help: "Age in seconds of the oldest active write permit on this API instance.",
      registers: [this.registry],
      collect: () => {
        this.maintenanceOldestPermitAge.set(
          this.maintenancePermitSnapshot().oldestActiveAgeMs / 1_000,
        );
      },
    });
    this.maintenancePermitAcquireFailures = new Counter({
      name: "xiqu_maintenance_write_permit_acquire_failures_total",
      help: "Maintenance write permit acquisition failures by bounded stage.",
      labelNames: ["stage"],
      registers: [this.registry],
    });
    this.maintenancePermitReleaseFailures = new Counter({
      name: "xiqu_maintenance_write_permit_release_failures_total",
      help: "Maintenance write permit release failures.",
      registers: [this.registry],
    });
    this.maintenancePermitHoldDuration = new Histogram({
      name: "xiqu_maintenance_write_permit_hold_duration_seconds",
      help: "Server-side business duration of maintenance write permits.",
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });
    this.operationalCollectionSuccess = new Gauge({
      name: "xiqu_operational_metrics_collection_success",
      help: "Whether the latest operational metric collection succeeded.",
      registers: [this.registry],
    });
    this.operationalCollectionTimestamp = new Gauge({
      name: "xiqu_operational_metrics_collection_timestamp_seconds",
      help: "Unix time of the latest successful operational metric collection.",
      registers: [this.registry],
    });
    // 协作通知指标只使用固定结果标签，禁止文件 id、账号或实例 id 形成高基数时序。
    this.annotationRevisionBusConnected = new Gauge({
      name: "xiqu_annotation_revision_bus_connected",
      help: "Whether this API instance currently has an active PostgreSQL LISTEN connection.",
      registers: [this.registry],
    });
    this.annotationRevisionBusPendingFiles = new Gauge({
      name: "xiqu_annotation_revision_bus_pending_files",
      help: "Annotation files currently waiting for a coalesced PostgreSQL revision notification.",
      registers: [this.registry],
    });
    this.annotationRevisionBusPublishes = new Counter({
      name: "xiqu_annotation_revision_bus_publish_total",
      help: "Revision notification publish queue outcomes.",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.annotationRevisionBusInbound = new Counter({
      name: "xiqu_annotation_revision_bus_inbound_total",
      help: "Local and PostgreSQL revision notification delivery outcomes.",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.annotationRevisionBusReconnects = new Counter({
      name: "xiqu_annotation_revision_bus_reconnect_total",
      help: "PostgreSQL LISTEN reconnect attempts scheduled by this API instance.",
      registers: [this.registry],
    });
    // Presence 使用独立 channel；固定结果标签避免成员或文件身份形成高基数时序。
    this.annotationPresenceBusConnected = new Gauge({
      name: "xiqu_annotation_presence_bus_connected",
      help: "Whether this API instance has an active PostgreSQL presence LISTEN connection.",
      registers: [this.registry],
    });
    this.annotationPresenceBusPendingFiles = new Gauge({
      name: "xiqu_annotation_presence_bus_pending_files",
      help: "Annotation files waiting for a coalesced presence invalidation.",
      registers: [this.registry],
    });
    this.annotationPresenceBusPublishes = new Counter({
      name: "xiqu_annotation_presence_bus_publish_total",
      help: "Presence invalidation publish queue outcomes.",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.annotationPresenceBusInbound = new Counter({
      name: "xiqu_annotation_presence_bus_inbound_total",
      help: "Presence invalidation delivery outcomes.",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.annotationPresenceBusReconnects = new Counter({
      name: "xiqu_annotation_presence_bus_reconnect_total",
      help: "PostgreSQL presence LISTEN reconnect attempts.",
      registers: [this.registry],
    });
    // 播放头活动是可丢失高频提示；独立指标避免与 revision/presence 的可靠性语义混淆。
    this.annotationRemoteActivityBusConnected = new Gauge({
      name: "xiqu_annotation_remote_activity_bus_connected",
      help: "Whether this API instance has an active PostgreSQL remote activity LISTEN connection.",
      registers: [this.registry],
    });
    this.annotationRemoteActivityBusPendingSessions = new Gauge({
      name: "xiqu_annotation_remote_activity_bus_pending_sessions",
      help: "Connection sessions waiting for a coalesced remote activity notification.",
      registers: [this.registry],
    });
    this.annotationRemoteActivityBusPublishes = new Counter({
      name: "xiqu_annotation_remote_activity_bus_publish_total",
      help: "Remote activity publish queue outcomes.",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.annotationRemoteActivityBusInbound = new Counter({
      name: "xiqu_annotation_remote_activity_bus_inbound_total",
      help: "Remote activity delivery outcomes.",
      labelNames: ["result"],
      registers: [this.registry],
    });
    this.annotationRemoteActivityBusReconnects = new Counter({
      name: "xiqu_annotation_remote_activity_bus_reconnect_total",
      help: "PostgreSQL remote activity LISTEN reconnect attempts.",
      registers: [this.registry],
    });
    this.annotationRemoteActivityClientMessages = new Counter({
      name: "xiqu_annotation_remote_activity_client_messages_total",
      help: "Inbound playhead messages by bounded outcome.",
      labelNames: ["result"],
      registers: [this.registry],
    });
  }

  // Fastify 的 routeOptions.url 是规范化模板；404 固定为 unknown，禁止 URL id 进入标签。
  registerHttpHooks(app: FastifyInstance) {
    app.addHook("onResponse", async (request, reply) => {
      const labels = {
        method: request.method,
        route: request.routeOptions.url ?? "unknown",
        status_code: String(reply.statusCode),
      };
      this.httpRequests.inc(labels);
      this.httpDuration.observe(labels, reply.elapsedTime / 1_000);
    });
  }

  recordUpload(result: UploadMetricResult, committedBytes = 0) {
    this.mediaUploads.inc({ result });
    if (result === "success" && committedBytes > 0) {
      this.mediaUploadBytes.inc(committedBytes);
    }
  }

  recordCompensationFailure(stage: "staged" | "final") {
    this.compensationFailures.inc({ stage });
  }

  recordStorageCleanup(
    result: "success" | "failure",
    deletedBinaryCount = 0,
    deletedFileObjectCount = 0,
  ) {
    this.storageCleanup.inc({ result });
    if (deletedBinaryCount) {
      this.storageCleanupDeleted.inc({ kind: "binary" }, deletedBinaryCount);
    }
    if (deletedFileObjectCount) {
      this.storageCleanupDeleted.inc(
        { kind: "file_object" },
        deletedFileObjectCount,
      );
    }
  }

  // 成功 snapshot 一次覆盖所有固定类别，避免任务归零后仍残留旧 Gauge 数值。
  recordOperationalSnapshot(snapshot: OperationalMetricsSnapshot) {
    for (const dependency of OPERATIONAL_DEPENDENCIES) {
      this.dependencyAvailable.set(
        { dependency },
        snapshot.dependencies[dependency],
      );
    }
    this.platformStorageUsedBytes.set(snapshot.platformStorageUsedBytes);
    this.platformStorageQuotaBytes.set(snapshot.platformStorageQuotaBytes);
    const annotationHistory = snapshot.annotationHistory;
    this.annotationRecoverySnapshotRelationBytes.set(annotationHistory.relationTotalBytes);
    for (const storageMode of ANNOTATION_HISTORY_STORAGE_MODES) {
      this.annotationRecoverySnapshots.set(
        { storage_mode: storageMode },
        annotationHistory.snapshotsByStorageMode[storageMode],
      );
    }
    for (const state of ANNOTATION_HISTORY_COVERAGE_STATES) {
      this.annotationRecoverySnapshotPayloads.set(
        { state },
        annotationHistory.payloadsByState[state],
      );
      this.annotationRecoverySnapshotHashes.set(
        { state },
        annotationHistory.hashesByState[state],
      );
    }
    for (const window of ANNOTATION_HISTORY_GROWTH_WINDOWS) {
      this.annotationRecoverySnapshotRecentCreated.set(
        { window },
        annotationHistory.recentCreated[window],
      );
    }
    for (const status of OPERATIONAL_JOB_STATUSES) {
      this.processingJobs.set({ status }, snapshot.jobs[status]);
    }
    const reliability = snapshot.reliability;
    this.processingJobOldestAge.set(
      { phase: "queued" },
      millisecondsToSeconds(reliability.oldestQueuedAgeMs),
    );
    this.processingJobOldestAge.set(
      { phase: "heartbeat" },
      millisecondsToSeconds(reliability.oldestActiveHeartbeatAgeMs),
    );
    this.processingJobOldestAge.set(
      { phase: "cancelling" },
      millisecondsToSeconds(reliability.oldestCancellingAgeMs),
    );
    for (const status of ["running", "cancelling"] as const) {
      this.processingJobStaleClaims.set(
        { status },
        reliability.staleClaims[status],
      );
    }
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      this.processingJobRecentOutcomes.set(
        { status },
        reliability.recentOutcomes[status],
      );
    }
    for (const phase of ["queueWait", "run", "cancellation"] as const) {
      this.processingJobAverageDuration.set(
        { phase: phase === "queueWait" ? "queue_wait" : phase },
        millisecondsToSeconds(reliability.averageDurationsMs[phase]),
      );
    }
    this.operationalCollectionSuccess.set(1);
    this.operationalCollectionTimestamp.set(
      snapshot.collectedAt.getTime() / 1_000,
    );
  }

  // 采集失败只标记失败，不把上一次真实容量和任务值伪造为零。
  recordOperationalCollectionFailure() {
    this.operationalCollectionSuccess.set(0);
  }

  // Gauge 在 scrape 时读取实时快照，因此 oldest age 会随时间增长，而不是停留在最近一次 acquire/release。
  bindMaintenancePermitDiagnostics(
    provider: () => MaintenancePermitDiagnostics,
  ) {
    this.maintenancePermitSnapshot = provider;
  }

  recordMaintenancePermitAcquireFailure(stage: "pool" | "exclusive") {
    this.maintenancePermitAcquireFailures.inc({ stage });
  }

  recordMaintenancePermitReleaseFailure() {
    this.maintenancePermitReleaseFailures.inc();
  }

  observeMaintenancePermitHold(durationMs: number) {
    this.maintenancePermitHoldDuration.observe(Math.max(0, durationMs) / 1_000);
  }

  setAnnotationRevisionBusConnected(connected: boolean) {
    this.annotationRevisionBusConnected.set(connected ? 1 : 0);
  }

  setAnnotationRevisionBusPendingFiles(count: number) {
    this.annotationRevisionBusPendingFiles.set(count);
  }

  recordAnnotationRevisionBusPublish(result: AnnotationRevisionBusPublishResult) {
    this.annotationRevisionBusPublishes.inc({ result });
  }

  recordAnnotationRevisionBusInbound(result: AnnotationRevisionBusInboundResult) {
    this.annotationRevisionBusInbound.inc({ result });
  }

  recordAnnotationRevisionBusReconnect() {
    this.annotationRevisionBusReconnects.inc();
  }

  setAnnotationPresenceBusConnected(connected: boolean) {
    this.annotationPresenceBusConnected.set(connected ? 1 : 0);
  }

  setAnnotationPresenceBusPendingFiles(count: number) {
    this.annotationPresenceBusPendingFiles.set(count);
  }

  recordAnnotationPresenceBusPublish(result: AnnotationRevisionBusPublishResult) {
    this.annotationPresenceBusPublishes.inc({ result });
  }

  recordAnnotationPresenceBusInbound(result: AnnotationRevisionBusInboundResult) {
    this.annotationPresenceBusInbound.inc({ result });
  }

  recordAnnotationPresenceBusReconnect() {
    this.annotationPresenceBusReconnects.inc();
  }

  setAnnotationRemoteActivityBusConnected(connected: boolean) {
    this.annotationRemoteActivityBusConnected.set(connected ? 1 : 0);
  }

  setAnnotationRemoteActivityBusPendingSessions(count: number) {
    this.annotationRemoteActivityBusPendingSessions.set(count);
  }

  recordAnnotationRemoteActivityBusPublish(result: AnnotationRevisionBusPublishResult) {
    this.annotationRemoteActivityBusPublishes.inc({ result });
  }

  recordAnnotationRemoteActivityBusInbound(result: AnnotationRevisionBusInboundResult) {
    this.annotationRemoteActivityBusInbound.inc({ result });
  }

  recordAnnotationRemoteActivityBusReconnect() {
    this.annotationRemoteActivityBusReconnects.inc();
  }

  recordAnnotationRemoteActivityClientMessage(
    result: "accepted" | "duplicate" | "rate_limited" | "invalid",
  ) {
    this.annotationRemoteActivityClientMessages.inc({ result });
  }
}

// 空样本统一写 0，成功快照能清除上一轮 Gauge；是否存在样本由对应任务计数判断。
function millisecondsToSeconds(value: number | null) {
  return value === null ? 0 : value / 1_000;
}

// 运维 token 使用恒定时间比较；长度不同先拒绝，避免 timingSafeEqual 抛错。
export function isValidMetricsToken(expected: string, authorization?: string) {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const received = Buffer.from(authorization.slice(prefix.length));
  const configured = Buffer.from(expected);
  return received.length === configured.length &&
    timingSafeEqual(received, configured);
}
