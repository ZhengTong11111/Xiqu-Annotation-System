import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Pool } from "pg";
import { HttpError } from "../src/errors.js";
import { MaintenanceCoordinator } from "../src/maintenanceCoordinator.js";
import {
  MAINTENANCE_CONTROL_ROUTE,
  MAINTENANCE_READ_ROUTE,
  resolveMaintenanceAccess,
} from "../src/maintenanceRouteAccess.js";
import { PrismaPlatformRepository } from "../src/repository.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import {
  createTestPrisma,
  truncateTestDatabase,
} from "./testEnvironment.js";

test("维护独占锁等待在途写许可并跨 coordinator 持久生效", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const access = new ResourceAccessService(prisma);
  const repository = new PrismaPlatformRepository(prisma, access);
  await repository.ensureSeedData();
  const admin = (await repository.login("admin", "admin123")).user;
  const student = (await repository.login("student", "student123")).user;
  const first = new MaintenanceCoordinator(prisma, maintenancePool, access);
  const second = new MaintenanceCoordinator(prisma, maintenancePool, access);

  try {
    // 业务层必须独立维护原因约束，不能依赖 HTTP route 才保证有效状态。
    await assert.rejects(
      first.setMaintenance(admin, { enabled: true }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 400,
    );
    await assert.rejects(
      first.setMaintenance(admin, { enabled: true, reason: "长".repeat(241) }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 400,
    );
    const permit = await first.acquireWritePermit();
    let enableCompleted = false;
    const enabling = second.setMaintenance(admin, {
      enabled: true,
      reason: "维护并发测试",
    }).then((status) => {
      enableCompleted = true;
      return status;
    });

    // 独占锁必须等待既有共享 permit；短暂让出事件循环后仍不能提前完成。
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(enableCompleted, false);
    await permit.release();
    await permit.release();
    const enabled = await enabling;
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.reason, "维护并发测试");
    assert.equal((await first.getStatus(admin)).enabled, true);

    await assert.rejects(
      first.acquireWritePermit(),
      (error: unknown) => error instanceof HttpError &&
        error.statusCode === 503 &&
        error.code === "maintenance_mode",
    );
    await assert.rejects(
      second.getStatus(student),
      (error: unknown) => error instanceof HttpError &&
        error.statusCode === 403,
    );

    const disabled = await second.setMaintenance(admin, { enabled: false });
    assert.equal(disabled.enabled, false);
    const nextPermit = await first.acquireWritePermit();
    await nextPermit.release();

    const audits = await prisma.auditLog.findMany({
      where: { action: { in: ["maintenance_enable", "maintenance_disable"] } },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(audits.map(({ action }) => action), [
      "maintenance_enable",
      "maintenance_disable",
    ]);
  } finally {
    // 测试失败也尽力恢复正常写入，避免后续 API 测试继承 active 状态。
    await first.setMaintenance(admin, { enabled: false }).catch(() => undefined);
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

test("路由维护语义默认 fail closed，并允许审计后的只读 POST", async () => {
  assert.equal(resolveMaintenanceAccess("GET"), "read");
  assert.equal(resolveMaintenanceAccess(["HEAD", "OPTIONS"]), "read");
  assert.equal(resolveMaintenanceAccess("POST"), "write");
  assert.equal(resolveMaintenanceAccess("POST", MAINTENANCE_READ_ROUTE.config), "read");

  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const access = new ResourceAccessService(prisma);
  const repository = new PrismaPlatformRepository(prisma, access);
  await repository.ensureSeedData();
  const admin = (await repository.login("admin", "admin123")).user;
  const coordinator = new MaintenanceCoordinator(prisma, maintenancePool, access);
  const app = Fastify({ logger: false });
  coordinator.registerRequestGate(app);
  let writes = 0;
  app.post("/read-batch", MAINTENANCE_READ_ROUTE, async () => ({ ok: true }));
  app.post("/write", async () => {
    writes += 1;
    return { ok: true };
  });
  app.post("/maintenance-control", MAINTENANCE_CONTROL_ROUTE, async () =>
    coordinator.setMaintenance(admin, { enabled: false }));

  try {
    await app.ready();
    await coordinator.setMaintenance(admin, { enabled: true, reason: "路由分类测试" });
    const readResponse = await app.inject({ method: "POST", url: "/read-batch" });
    assert.equal(readResponse.statusCode, 200);
    const blockedWrite = await app.inject({ method: "POST", url: "/write" });
    assert.equal(blockedWrite.statusCode, 503);
    assert.equal(writes, 0);

    const disabled = await app.inject({ method: "POST", url: "/maintenance-control" });
    assert.equal(disabled.statusCode, 200);
    const successfulWrite = await app.inject({ method: "POST", url: "/write" });
    assert.equal(successfulWrite.statusCode, 200);
    assert.equal(writes, 1);
    assert.deepEqual(coordinator.getPermitDiagnostics(), {
      active: 0,
      waiting: 0,
      oldestActiveAgeMs: 0,
    });
  } finally {
    await coordinator.setMaintenance(admin, { enabled: false }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

test("写 handler 未结束时客户端响应状态不能提前释放维护许可", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const access = new ResourceAccessService(prisma);
  const repository = new PrismaPlatformRepository(prisma, access);
  await repository.ensureSeedData();
  const admin = (await repository.login("admin", "admin123")).user;
  const coordinator = new MaintenanceCoordinator(prisma, maintenancePool, access);
  const app = Fastify({ logger: false });
  coordinator.registerRequestGate(app);
  let finishHandler!: () => void;
  const handlerBlocked = new Promise<void>((resolve) => {
    finishHandler = resolve;
  });
  app.post("/slow-write", async () => {
    await handlerBlocked;
    return { ok: true };
  });

  try {
    await app.ready();
    const writeResponse = app.inject({ method: "POST", url: "/slow-write" });
    await waitFor(() => coordinator.getPermitDiagnostics().active === 1);
    let maintenanceFinished = false;
    const maintenance = coordinator.setMaintenance(admin, {
      enabled: true,
      reason: "等待真实写 handler",
    }).then((status) => {
      maintenanceFinished = true;
      return status;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(maintenanceFinished, false);
    finishHandler();
    assert.equal((await writeResponse).statusCode, 200);
    assert.equal((await maintenance).enabled, true);
    assert.equal(coordinator.getPermitDiagnostics().active, 0);
  } finally {
    finishHandler();
    await coordinator.setMaintenance(admin, { enabled: false }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

test("维护排空超时返回稳定可重试错误且不改变维护状态", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const access = new ResourceAccessService(prisma);
  const repository = new PrismaPlatformRepository(prisma, access);
  await repository.ensureSeedData();
  const admin = (await repository.login("admin", "admin123")).user;
  const failures: string[] = [];
  const coordinator = new MaintenanceCoordinator(
    prisma,
    maintenancePool,
    access,
    {
      recordMaintenancePermitAcquireFailure: (stage) => failures.push(stage),
      recordMaintenancePermitReleaseFailure: () => undefined,
      observeMaintenancePermitHold: () => undefined,
    },
    { exclusiveWaitMs: 20 },
  );
  const permit = await coordinator.acquireWritePermit();
  try {
    await assert.rejects(
      coordinator.setMaintenance(admin, { enabled: true, reason: "预期超时" }),
      (error: unknown) => error instanceof HttpError &&
        error.statusCode === 503 &&
        error.code === "write_gate_busy",
    );
    assert.deepEqual(failures, ["exclusive"]);
    assert.equal((await coordinator.getStatus(admin)).enabled, false);
  } finally {
    await permit.release();
    await coordinator.setMaintenance(admin, { enabled: false }).catch(() => undefined);
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

test("维护连接池不可用时快速返回 write_gate_busy 并清零等待计数", async () => {
  const failures: string[] = [];
  const coordinator = new MaintenanceCoordinator(
    {} as PrismaClient,
    {
      connect: async () => {
        throw new Error("pool exhausted");
      },
    } as unknown as Pool,
    {} as ResourceAccessService,
    {
      recordMaintenancePermitAcquireFailure: (stage) => failures.push(stage),
      recordMaintenancePermitReleaseFailure: () => undefined,
      observeMaintenancePermitHold: () => undefined,
    },
  );
  await assert.rejects(
    coordinator.acquireWritePermit(),
    (error: unknown) => error instanceof HttpError &&
      error.statusCode === 503 &&
      error.code === "write_gate_busy",
  );
  assert.deepEqual(failures, ["pool"]);
  assert.equal(coordinator.getPermitDiagnostics().waiting, 0);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待维护许可状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
