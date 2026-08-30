import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { buildApiApp } from "../src/app.js";
import {
  attachMaintenanceRouteManifest,
  getMaintenanceRouteManifest,
  MAINTENANCE_READ_ROUTE,
} from "../src/maintenanceRouteAccess.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

test("维护路由清单稳定规范化 method 并拒绝同路由冲突语义", async () => {
  const app = Fastify({ logger: false });
  const record = attachMaintenanceRouteManifest(app);
  record(["post", "GET", "post"], "/mixed", MAINTENANCE_READ_ROUTE.config);
  assert.deepEqual(getMaintenanceRouteManifest(app), [
    { method: "GET", path: "/mixed", access: "read", explicit: true },
    { method: "POST", path: "/mixed", access: "read", explicit: true },
  ]);
  assert.throws(
    () => record("POST", "/mixed"),
    /冲突的维护访问语义/,
  );
  assert.throws(
    () => attachMaintenanceRouteManifest(app),
    /不能重复注册维护路由清单/,
  );
  await app.close();
});

test("真实 API 非安全路由默认 fail closed 且显式例外保持有限", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "xiqu-route-manifest-"));
  const { prisma, pool, maintenancePool, collaborationPool, schema } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const app = await buildApiApp({
    prisma,
    maintenancePool,
    collaborationPool,
    databaseSchema: schema,
    storage: new LocalObjectStorage(storageRoot),
    logger: false,
    seed: false,
    corsOrigin: false,
    metricsToken: null,
  });

  try {
    await app.ready();
    const manifest = getMaintenanceRouteManifest(app).filter(({ path: routePath }) =>
      routePath.startsWith("/api") || routePath === "/metrics");
    assert.ok(manifest.length > 50, "完整 API 路由清单不应意外为空或只覆盖少量路由");
    assert.equal(
      manifest.every((entry) =>
        Object.keys(entry).sort().join(",") === "access,explicit,method,path"),
      true,
      "清单不得携带 handler、schema、请求参数或其他运行时内部事实",
    );

    const implicitUnsafe = manifest.filter((entry) =>
      !SAFE_METHODS.has(entry.method) && !entry.explicit);
    assert.ok(implicitUnsafe.length > 20, "应存在由默认 fail-closed 规则保护的 mutation 路由");
    assert.equal(implicitUnsafe.every(({ access }) => access === "write"), true);

    // 显式非安全例外必须逐项审计；新增 POST 读取/控制入口时测试会要求同步说明其维护语义。
    const explicitUnsafe = manifest
      .filter((entry) => !SAFE_METHODS.has(entry.method) && entry.explicit)
      .map(({ method, path: routePath, access }) => `${method} ${routePath} ${access}`);
    assert.deepEqual(explicitUnsafe, [
      "POST /api/admin/maintenance control",
      "POST /api/annotation-files/:resourceId/audio-tracks/:trackId/playback-session read",
      "POST /api/annotation-files/:resourceId/collaboration-ticket read",
      "POST /api/annotation-files/:resourceId/media-analysis/assets/batch read",
      "POST /api/media-files/:resourceId/playback-session read",
    ]);
  } finally {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(storageRoot, { recursive: true, force: true });
  }
});
