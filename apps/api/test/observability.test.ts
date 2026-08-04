import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { HealthService } from "../src/healthService.js";
import {
  ApiObservability,
  isValidMetricsToken,
} from "../src/observability.js";
import {
  loadOperationalMetricsTimeout,
  OperationalMetricsCollector,
} from "../src/operationalMetricsCollector.js";

test("独立 Registry 可重复创建且只记录规范化路由", async () => {
  const first = new ApiObservability();
  const second = new ApiObservability();
  const app = Fastify({ logger: false });
  first.registerHttpHooks(app);
  // 带参数请求必须按 route pattern 聚合，不能把具体资源 id 写入 label。
  app.get<{ Params: { resourceId: string } }>(
    "/resources/:resourceId",
    async (request) => ({ id: request.params.resourceId }),
  );
  await app.inject({ method: "GET", url: "/resources/secret-resource-id" });
  const metrics = await first.registry.metrics();
  assert.match(metrics, /route="\/resources\/:resourceId"/);
  assert.doesNotMatch(metrics, /secret-resource-id/);
  assert.ok((await second.registry.metrics()).includes("xiqu_process_cpu"));
  await app.close();
});

test("监控 token 使用完整 Bearer 值验证", () => {
  assert.equal(isValidMetricsToken("monitor-secret", undefined), false);
  assert.equal(isValidMetricsToken("monitor-secret", "Bearer wrong"), false);
  assert.equal(
    isValidMetricsToken("monitor-secret", "Bearer monitor-secret"),
    true,
  );
});

test("上传和清理指标只接受稳定类别与计数", async () => {
  const observability = new ApiObservability();
  observability.recordUpload("success", 24);
  observability.recordUpload("quota");
  observability.recordCompensationFailure("final");
  observability.recordStorageCleanup("success", 2, 1);
  const metrics = await observability.registry.metrics();
  assert.match(metrics, /xiqu_media_uploads_total\{result="success"\} 1/);
  assert.match(metrics, /xiqu_media_upload_bytes_total 24/);
  assert.match(metrics, /result="quota"\} 1/);
  assert.match(metrics, /stage="final"\} 1/);
  assert.match(metrics, /kind="binary"\} 2/);
});

test("跨实例 revision bus 指标只使用固定低基数类别", async () => {
  const observability = new ApiObservability();
  observability.setAnnotationRevisionBusConnected(true);
  observability.setAnnotationRevisionBusPendingFiles(2);
  observability.recordAnnotationRevisionBusPublish("queued");
  observability.recordAnnotationRevisionBusPublish("coalesced");
  observability.recordAnnotationRevisionBusInbound("accepted");
  observability.recordAnnotationRevisionBusInbound("invalid");
  observability.recordAnnotationRevisionBusReconnect();
  const metrics = await observability.registry.metrics();
  assert.match(metrics, /xiqu_annotation_revision_bus_connected 1/);
  assert.match(metrics, /xiqu_annotation_revision_bus_pending_files 2/);
  assert.match(metrics, /publish_total\{result="queued"\} 1/);
  assert.match(metrics, /publish_total\{result="coalesced"\} 1/);
  assert.match(metrics, /inbound_total\{result="accepted"\} 1/);
  assert.match(metrics, /xiqu_annotation_revision_bus_reconnect_total 1/);
  assert.doesNotMatch(metrics, /annotationFileId|sourceInstanceId|accountName/);
});

test("对象存储故障只降低 readiness，不影响进程 liveness", async () => {
  const health = new HealthService(
    {
      $queryRaw: async () => [{ "?column?": 1 }],
    } as unknown as PrismaClient,
    {
      checkReadiness: async () => {
        throw new Error("测试存储故障");
      },
    },
  );
  assert.equal(health.getLiveness().status, "ok");
  const readiness = await health.getReadiness();
  assert.equal(readiness.status, "unavailable");
  assert.equal(readiness.components?.database.status, "ok");
  assert.equal(readiness.components?.storage.status, "unavailable");
  assert.equal(readiness.components?.storage.message, "依赖当前不可用。");
});

test("运维指标采集补齐固定状态并写入低基数 Gauge", async () => {
  const collector = new OperationalMetricsCollector(
    {
      fileObject: { aggregate: async () => ({ _sum: { size: 125 } }) },
      processingJob: {
        groupBy: async () => [{ status: "queued", _count: { _all: 3 } }],
      },
    } as unknown as PrismaClient,
    {
      getReadiness: async () => ({
        status: "unavailable",
        service: "xiqu-platform-api",
        time: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        components: {
          database: { status: "ok", latencyMs: 1 },
          storage: { status: "unavailable", latencyMs: 2 },
        },
      }),
    } as unknown as HealthService,
    1_000,
  );
  const snapshot = await collector.collect();
  assert.deepEqual(snapshot.dependencies, { database: 1, storage: 0 });
  assert.deepEqual(snapshot.jobs, {
    queued: 3,
    running: 0,
    succeeded: 0,
    failed: 0,
  });
  const observability = new ApiObservability();
  observability.recordOperationalSnapshot(snapshot);
  const metrics = await observability.registry.metrics();
  assert.match(metrics, /xiqu_dependency_available\{dependency="storage"\} 0/);
  assert.match(metrics, /xiqu_platform_storage_used_bytes 125/);
  assert.match(metrics, /xiqu_processing_jobs\{status="failed"\} 0/);
  assert.doesNotMatch(metrics, /resourceId|accountName|storageKey/);
  // 失败只改变采集状态，上一份真实容量不能被伪造成零。
  observability.recordOperationalCollectionFailure();
  const failedMetrics = await observability.registry.metrics();
  assert.match(failedMetrics, /xiqu_operational_metrics_collection_success 0/);
  assert.match(failedMetrics, /xiqu_platform_storage_used_bytes 125/);
});

test("重叠 scrape 复用采集且超时不启动第二份查询", async () => {
  let aggregateCalls = 0;
  let releaseAggregate!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseAggregate = resolve;
  });
  const collector = new OperationalMetricsCollector(
    {
      fileObject: {
        aggregate: async () => {
          aggregateCalls += 1;
          await blocked;
          return { _sum: { size: 0 } };
        },
      },
      processingJob: { groupBy: async () => [] },
    } as unknown as PrismaClient,
    {
      getReadiness: async () => ({
        status: "ready",
        service: "xiqu-platform-api",
        time: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        components: {
          database: { status: "ok", latencyMs: 1 },
          storage: { status: "ok", latencyMs: 1 },
        },
      }),
    } as unknown as HealthService,
    1_000,
    5,
  );
  await assert.rejects(Promise.all([collector.collect(), collector.collect()]), /超时/);
  assert.equal(aggregateCalls, 1);
  await assert.rejects(collector.collect(), /超时/);
  assert.equal(aggregateCalls, 1);
  releaseAggregate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await collector.collect();
  assert.equal(aggregateCalls, 2);
});

test("运维采集超时配置拒绝无效或过大的值", () => {
  assert.equal(loadOperationalMetricsTimeout(undefined), 5_000);
  assert.equal(loadOperationalMetricsTimeout("1200"), 1_200);
  for (const value of ["0", "1.5", "60001", "bad"]) {
    assert.throws(() => loadOperationalMetricsTimeout(value));
  }
});
