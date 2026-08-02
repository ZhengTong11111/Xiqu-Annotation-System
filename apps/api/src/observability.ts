import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Registry,
} from "prom-client";

export type UploadMetricResult =
  | "success"
  | "too_large"
  | "unsupported_media"
  | "validation"
  | "quota"
  | "forbidden"
  | "conflict"
  | "internal";

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
