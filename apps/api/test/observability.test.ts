import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { HealthService } from "../src/healthService.js";
import {
  ApiObservability,
  isValidMetricsToken,
} from "../src/observability.js";

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
