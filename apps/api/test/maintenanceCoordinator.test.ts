import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../src/errors.js";
import { MaintenanceCoordinator } from "../src/maintenanceCoordinator.js";
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
