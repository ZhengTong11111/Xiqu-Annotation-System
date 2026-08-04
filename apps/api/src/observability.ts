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
  private readonly processingJobs: Gauge;
  private readonly operationalCollectionSuccess: Gauge;
  private readonly operationalCollectionTimestamp: Gauge;
  private readonly annotationRevisionBusConnected: Gauge;
  private readonly annotationRevisionBusPendingFiles: Gauge;
  private readonly annotationRevisionBusPublishes: Counter;
  private readonly annotationRevisionBusInbound: Counter;
  private readonly annotationRevisionBusReconnects: Counter;

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
    this.processingJobs = new Gauge({
      name: "xiqu_processing_jobs",
      help: "Current processing jobs by stable status.",
      labelNames: ["status"],
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
    for (const status of OPERATIONAL_JOB_STATUSES) {
      this.processingJobs.set({ status }, snapshot.jobs[status]);
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
