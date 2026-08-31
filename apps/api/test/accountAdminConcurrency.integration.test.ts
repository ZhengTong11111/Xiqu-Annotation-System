import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformUser } from "@xiqu/shared";
import { AccountAdminService } from "../src/accountAdminService.js";
import {
  createTestPrisma,
  truncateTestDatabase,
} from "./testEnvironment.js";

// 两个管理员交叉撤权必须共享 bootstrap advisory lock，并由后进入者看到最新角色事实。
test("并发停用系统管理员时始终保留一个活动系统管理员", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  try {
    await truncateTestDatabase(prisma);
    const [first, second] = await Promise.all([
      createSuperAdministrator(prisma, "concurrent-admin-a"),
      createSuperAdministrator(prisma, "concurrent-admin-b"),
    ]);
    const service = new AccountAdminService(prisma);
    const outcomes = await Promise.allSettled([
      service.updateAccount(asPlatformUser(first), second.id, { isActive: false }),
      service.updateAccount(asPlatformUser(second), first.id, { isActive: false }),
    ]);

    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
    assert.equal(await prisma.user.count({
      where: {
        isActive: true,
        roles: { some: { role: "super_admin" } },
      },
    }), 1);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

// 角色或活动状态变化必须取得资源树独占锁，不能越过已经在提交阶段的资源写事务。
test("账号授权治理等待资源内容共享锁", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  const blocker = await pool.connect();
  let lockHeld = false;
  let pendingUpdate: ReturnType<AccountAdminService["updateAccount"]> | null = null;
  try {
    await truncateTestDatabase(prisma);
    const [first, second] = await Promise.all([
      createSuperAdministrator(prisma, "resource-lock-admin-a"),
      createSuperAdministrator(prisma, "resource-lock-admin-b"),
    ]);
    const service = new AccountAdminService(prisma);
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock_shared(hashtext('xiqu:resource-tree:mutation'))",
    );
    lockHeld = true;
    pendingUpdate = service.updateAccount(asPlatformUser(first), second.id, {
      roles: ["annotator"],
    });
    await waitForCondition(async () => {
      const result = await pool.query<{ waiting: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE wait_event = 'advisory'
            AND query LIKE '%xiqu:resource-tree:mutation%'
        ) AS waiting
      `);
      return result.rows[0]?.waiting === true;
    }, "账号角色变更没有等待资源内容共享锁");

    await blocker.query("COMMIT");
    lockHeld = false;
    const updated = await pendingUpdate;
    assert.deepEqual(updated.roles, ["annotator"]);
  } finally {
    if (lockHeld) await blocker.query("ROLLBACK");
    blocker.release();
    await pendingUpdate?.catch(() => undefined);
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

/** 创建只用于治理竞态的最小系统管理员，不生成登录会话或无关审计事实。 */
async function createSuperAdministrator(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  accountName: string,
) {
  return prisma.user.create({
    data: {
      accountName,
      displayName: accountName,
      passwordHash: "not-used-by-this-test",
      roles: { create: { role: "super_admin" } },
    },
    include: { roles: true },
  });
}

/** 把刚创建的权威账号行映射为服务层 actor，测试不伪造额外角色。 */
function asPlatformUser(user: Awaited<ReturnType<typeof createSuperAdministrator>>): PlatformUser {
  return {
    id: user.id,
    accountName: user.accountName,
    displayName: user.displayName,
    roles: ["super_admin"],
  };
}

/** 有界等待 PostgreSQL 暴露目标锁等待，失败时给出比超时更直接的竞态诊断。 */
async function waitForCondition(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
