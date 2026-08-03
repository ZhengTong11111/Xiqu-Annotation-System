import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApiApp } from "../src/app.js";
import { LocalObjectStorage } from "../src/storage.js";
import {
  createTestPrisma,
  truncateTestDatabase,
} from "./testEnvironment.js";

type JsonObject = Record<string, unknown>;

test("平台资源 API 集成测试", async (suite) => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "xiqu-api-test-"));
  const { prisma, pool, maintenancePool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(storageRoot);
  const app = await buildApiApp({
    prisma,
    maintenancePool,
    storage,
    logger: false,
    seed: true,
    uploadPolicy: {
      maxUploadBytes: 64,
      userQuotaBytes: 80,
      platformQuotaBytes: 200,
      orphanGraceMs: 1_000,
    },
    metricsToken: "integration-metrics-token",
  });
  await app.ready();

  let adminToken = "";
  let studentToken = "";
  let taToken = "";
  let projectId = "";
  let childFolderId = "";
  let annotationFileId = "";

  try {
    await suite.test("认证、会话和健康检查", async () => {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.equal(health.statusCode, 200);
      assert.equal(dataOf(health.json()).status, "ready");

      const live = await app.inject({ method: "GET", url: "/api/health/live" });
      assert.equal(live.statusCode, 200);
      assert.equal(dataOf(live.json()).status, "ok");
      const ready = await app.inject({ method: "GET", url: "/api/health/ready" });
      assert.equal(ready.statusCode, 200);
      const readyComponents = dataOf(ready.json()).components as JsonObject;
      assert.equal((readyComponents.database as JsonObject).status, "ok");
      assert.equal((readyComponents.storage as JsonObject).status, "ok");

      const missingMetricsToken = await app.inject({
        method: "GET",
        url: "/metrics",
      });
      assert.equal(missingMetricsToken.statusCode, 401);
      const metrics = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer integration-metrics-token" },
      });
      assert.equal(metrics.statusCode, 200);
      assert.match(metrics.body, /xiqu_http_requests_total/);
      assert.match(metrics.body, /xiqu_dependency_available\{dependency="database"\} 1/);
      assert.match(metrics.body, /xiqu_dependency_available\{dependency="storage"\} 1/);
      assert.match(metrics.body, /xiqu_platform_storage_quota_bytes 200/);
      assert.match(metrics.body, /xiqu_operational_metrics_collection_success 1/);

      // 显式 null 必须覆盖环境变量并关闭指标入口，便于内嵌或测试实例采用最小暴露面。
      const metricsDisabledApp = await buildApiApp({
        prisma,
        maintenancePool,
        storage,
        logger: false,
        seed: false,
        metricsToken: null,
        uploadPolicy: {
          maxUploadBytes: 64,
          userQuotaBytes: 80,
          platformQuotaBytes: 200,
          orphanGraceMs: 1_000,
        },
      });
      await metricsDisabledApp.ready();
      const disabledMetrics = await metricsDisabledApp.inject({
        method: "GET",
        url: "/metrics",
      });
      assert.equal(disabledMetrics.statusCode, 404);
      await metricsDisabledApp.close();

      const adminLogin = await login(app, "admin", "admin123");
      adminToken = adminLogin.accessToken;
      assert.equal(adminLogin.user.accountName, "admin");
      studentToken = (await login(app, "student", "student123")).accessToken;
      taToken = (await login(app, "ta", "ta123")).accessToken;

      const invalid = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { accountName: "admin", password: "wrong" },
      });
      assert.equal(invalid.statusCode, 401);

      const anonymous = await app.inject({ method: "GET", url: "/api/auth/me" });
      assert.equal(anonymous.statusCode, 401);
      const sessions = await prisma.session.findMany();
      assert.ok(sessions.every(({ tokenHash }) => !tokenHash.includes("xiqu_")));

      const forbiddenDiagnostics = await jsonRequest(app, studentToken, {
        method: "GET",
        url: "/api/admin/diagnostics",
      });
      assert.equal(forbiddenDiagnostics.statusCode, 403);
      const diagnostics = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/admin/diagnostics",
      });
      assert.equal(diagnostics.statusCode, 200, diagnostics.body);
      const diagnosticData = dataOf(diagnostics.json());
      assert.equal((diagnosticData.health as JsonObject).status, "ready");
      assert.equal(
        (diagnosticData.capacity as JsonObject).platformQuotaBytes,
        200,
      );
      assert.ok(Array.isArray(diagnosticData.alerts));
    });

    await suite.test("资源创建、名称校验和层级循环保护", async () => {
      const project = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "集成测试项目" },
      });
      assert.equal(project.statusCode, 200, project.body);
      projectId = String(dataOf(project.json()).id);

      const child = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: projectId, type: "folder", name: "子目录" },
      });
      childFolderId = String(dataOf(child.json()).id);

      const grandchild = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: childFolderId, type: "folder", name: "孙目录" },
      });
      const grandchildId = String(dataOf(grandchild.json()).id);
      const cycle = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${projectId}/move`,
        payload: { parentId: grandchildId },
      });
      assert.equal(cycle.statusCode, 400);

      const invalidName = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "folder", name: "bad/name" },
      });
      assert.equal(invalidName.statusCode, 400);

      const duplicate = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: projectId, type: "folder", name: "子目录" },
      });
      assert.equal(duplicate.statusCode, 409);

      const concurrentCreates = await Promise.all([
        jsonRequest(app, adminToken, {
          method: "POST",
          url: "/api/resources",
          payload: { parentId: projectId, type: "folder", name: "并发同名" },
        }),
        jsonRequest(app, adminToken, {
          method: "POST",
          url: "/api/resources",
          payload: { parentId: projectId, type: "folder", name: "并发同名" },
        }),
      ]);
      assert.deepEqual(
        concurrentCreates.map(({ statusCode }) => statusCode).sort(),
        [200, 409],
        "并发创建同名资源时只能有一个成功",
      );
    });

    await suite.test("维护模式排空写入并保留管理员恢复通道", async () => {
      // 先准备维护期读取样本；进入维护后不能再借助 mutation 构造测试数据。
      const readableAnnotation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "维护期只读标注.json",
          payload: { marker: "maintenance-readable" },
        },
      });
      assert.equal(readableAnnotation.statusCode, 200, readableAnnotation.body);
      const readableAnnotationId = String(
        (dataOf(readableAnnotation.json()).resource as JsonObject).id,
      );
      const forbiddenToggle = await jsonRequest(app, studentToken, {
        method: "POST",
        url: "/api/admin/maintenance",
        payload: { enabled: true, reason: "越权维护" },
      });
      assert.equal(forbiddenToggle.statusCode, 403);

      const enabled = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/admin/maintenance",
        payload: { enabled: true, reason: "集成测试维护" },
      });
      assert.equal(enabled.statusCode, 200, enabled.body);
      assert.equal(dataOf(enabled.json()).enabled, true);

      const readsRemainAvailable = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/resources?view=all_projects",
      });
      assert.equal(readsRemainAvailable.statusCode, 200);
      const annotationRead = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${readableAnnotationId}`,
      });
      assert.equal(annotationRead.statusCode, 200, annotationRead.body);
      assert.equal(
        await prisma.resourceUserState.count({
          where: { resourceId: readableAnnotationId, userId: "user-admin" },
        }),
        0,
        "标注文件 GET 在维护期间必须保持无副作用",
      );
      const blockedRecentWrite = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${readableAnnotationId}/opened`,
      });
      assert.equal(blockedRecentWrite.statusCode, 503);
      const blockedWrite = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "维护中不应创建" },
      });
      assert.equal(blockedWrite.statusCode, 503);
      assert.equal((blockedWrite.json() as JsonObject).error instanceof Object, true);
      assert.equal(
        ((blockedWrite.json() as JsonObject).error as JsonObject).details,
        undefined,
        "维护拒绝不能向匿名或未授权 mutation 泄漏运维原因",
      );
      const blockedLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { accountName: "admin", password: "admin123" },
      });
      assert.equal(blockedLogin.statusCode, 503);

      const diagnostics = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/admin/diagnostics",
      });
      assert.equal(
        (dataOf(diagnostics.json()).maintenance as JsonObject).enabled,
        true,
      );
      const stillForbidden = await jsonRequest(app, studentToken, {
        method: "POST",
        url: "/api/admin/maintenance",
        payload: { enabled: false },
      });
      assert.equal(stillForbidden.statusCode, 403);

      const disabled = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/admin/maintenance",
        payload: { enabled: false },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      assert.equal(dataOf(disabled.json()).enabled, false);
      const resumed = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "维护后恢复创建" },
      });
      assert.equal(resumed.statusCode, 200, resumed.body);
      const resumedRecentWrite = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${readableAnnotationId}/opened`,
      });
      assert.equal(resumedRecentWrite.statusCode, 204);
      assert.equal(
        await prisma.resourceUserState.count({
          where: { resourceId: readableAnnotationId, userId: "user-admin" },
        }),
        1,
        "解除维护后最近打开状态应恢复写入",
      );
    });

    await suite.test("资源分页保持稳定顺序、查询绑定和 ACL 后填页", async () => {
      const paginationProject = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "分页查询项目" },
      });
      const paginationProjectId = String(dataOf(paginationProject.json()).id);
      const childIds: string[] = [];
      // 创建多于一页的同时间资源，强制验证 id tie-break，而不是依赖自然产生的时间差。
      for (const name of ["分页甲", "分页乙", "分页丙", "分页丁", "分页戊", "分页己", "分页庚"]) {
        const response = await jsonRequest(app, adminToken, {
          method: "POST",
          url: "/api/resources",
          payload: { parentId: paginationProjectId, type: "folder", name },
        });
        childIds.push(String(dataOf(response.json()).id));
      }
      const fixedTime = new Date("2026-08-02T06:00:00.000Z");
      await prisma.resourceEntry.updateMany({
        where: { id: { in: childIds } },
        data: { updatedAt: fixedTime },
      });

      const collected: string[] = [];
      let cursor: string | null = null;
      // 连续消费 opaque cursor，所有页面合并后必须无重复、无遗漏且顺序确定。
      do {
        const params = new URLSearchParams({
          parentId: paginationProjectId,
          sortBy: "updatedAt",
          direction: "desc",
          limit: "3",
        });
        if (cursor) params.set("cursor", cursor);
        const response = await jsonRequest(app, adminToken, {
          method: "GET",
          url: `/api/resources?${params}`,
        });
        assert.equal(response.statusCode, 200, response.body);
        const page = dataOf(response.json());
        collected.push(...(page.items as JsonObject[]).map(({ id }) => String(id)));
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
      } while (cursor);
      assert.deepEqual(collected, [...childIds].sort().reverse());
      assert.equal(new Set(collected).size, childIds.length);

      const firstPage = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/resources?parentId=${paginationProjectId}&sortBy=updatedAt&direction=desc&limit=3`,
      });
      const firstCursor = String(dataOf(firstPage.json()).nextCursor);
      const mismatchedCursor = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/resources?parentId=${paginationProjectId}&sortBy=name&direction=asc&limit=3&cursor=${encodeURIComponent(firstCursor)}`,
      });
      assert.equal(mismatchedCursor.statusCode, 400, "cursor 不能跨排序上下文复用");

      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${paginationProjectId}/permissions/user-student`,
        payload: { capabilities: ["read"], inheritToChildren: true },
      });
      // 前两项截断继承后不可读；服务端仍应继续扫描并填满两个可见资源，而不是返回短页。
      for (const hiddenId of childIds.slice(0, 2)) {
        await jsonRequest(app, adminToken, {
          method: "PATCH",
          url: `/api/resources/${hiddenId}/permission-inheritance`,
          payload: { breakPermissionInheritance: true },
        });
      }
      const studentPage = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/resources?parentId=${paginationProjectId}&sortBy=updatedAt&direction=desc&limit=2`,
      });
      assert.equal(studentPage.statusCode, 200, studentPage.body);
      assert.equal((dataOf(studentPage.json()).items as JsonObject[]).length, 2);
      assert.ok(dataOf(studentPage.json()).nextCursor, "仍有可见资源时必须返回下一页 cursor");
      assert.ok((dataOf(studentPage.json()).items as JsonObject[]).every(({ id }) =>
        !childIds.slice(0, 2).includes(String(id))), "不可读资源不能泄漏到分页结果");
    });

    await suite.test("ACL 继承、截断、直接授权和输入校验", async () => {
      const grant = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${projectId}/permissions/user-student`,
        payload: {
          capabilities: ["read", "create_child", "copy", "download"],
          inheritToChildren: true,
        },
      });
      assert.equal(grant.statusCode, 200);

      const inherited = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/resources/${childFolderId}`,
      });
      assert.equal(inherited.statusCode, 200);
      assert.deepEqual(
        dataOf(inherited.json()).permission &&
          (dataOf(inherited.json()).permission as JsonObject).source,
        "inherited",
      );

      const breakInheritance = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/resources/${childFolderId}/permission-inheritance`,
        payload: { breakPermissionInheritance: true },
      });
      assert.equal(breakInheritance.statusCode, 200);
      const hidden = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/resources/${childFolderId}`,
      });
      assert.equal(hidden.statusCode, 403);

      const direct = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${childFolderId}/permissions/user-student`,
        payload: { capabilities: ["read"], inheritToChildren: false },
      });
      assert.equal(direct.statusCode, 200);
      assert.equal((dataOf(direct.json()).capabilities as string[])[0], "read");

      const invalidCapability = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${childFolderId}/permissions/user-student`,
        payload: { capabilities: ["become_admin"] },
      });
      assert.equal(invalidCapability.statusCode, 400);
      const invalidDate = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${childFolderId}/permissions/user-student`,
        payload: { capabilities: ["read"], expiresAt: "not-a-date" },
      });
      assert.equal(invalidDate.statusCode, 400);

      const limitedManager = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${childFolderId}/permissions/user-student`,
        payload: {
          capabilities: ["read", "manage_permissions"],
          inheritToChildren: false,
        },
      });
      assert.equal(limitedManager.statusCode, 200);
      const overDelegation = await jsonRequest(app, studentToken, {
        method: "PUT",
        url: `/api/resources/${childFolderId}/permissions/user-ta`,
        payload: { capabilities: ["write"] },
      });
      assert.equal(overDelegation.statusCode, 403);
    });

    await suite.test("移动后重新计算继承权限并保留直接 ACL", async () => {
      const privateProject = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "未授权项目" },
      });
      const privateProjectId = String(dataOf(privateProject.json()).id);
      const movable = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: projectId, type: "folder", name: "待移动目录" },
      });
      const movableId = String(dataOf(movable.json()).id);
      assert.equal((await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/resources/${movableId}`,
      })).statusCode, 200);

      const movedPrivate = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${movableId}/move`,
        payload: { parentId: privateProjectId },
      });
      assert.equal(movedPrivate.statusCode, 200);
      assert.equal((await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/resources/${movableId}`,
      })).statusCode, 403);

      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${movableId}/permissions/user-student`,
        payload: { capabilities: ["read"], inheritToChildren: false },
      });
      assert.equal((await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/resources/${movableId}`,
      })).statusCode, 200);

      await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${movableId}/move`,
        payload: { parentId: projectId },
      });
      const directRow = await prisma.resourcePermission.findUnique({
        where: {
          resourceId_userId: { resourceId: movableId, userId: "user-student" },
        },
      });
      assert.deepEqual(directRow?.capabilities, ["read"]);

      const expired = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${privateProjectId}/permissions/user-student`,
        payload: {
          capabilities: ["read"],
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      });
      assert.equal(expired.statusCode, 200);
      assert.equal((await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/resources/${privateProjectId}`,
      })).statusCode, 403);
      const visibleProjects = await jsonRequest(app, studentToken, {
        method: "GET",
        url: "/api/resources?view=all_projects",
      });
      assert.ok(
        !(dataOf(visibleProjects.json()).items as JsonObject[])
          .some(({ id }) => id === privateProjectId),
      );
    });

    await suite.test("批量移动保持原子性并压缩父子选择", async () => {
      const sourceResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "批量移动源" },
      });
      const sourceId = String(dataOf(sourceResponse.json()).id);
      const targetResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "批量移动目标" },
      });
      const targetId = String(dataOf(targetResponse.json()).id);
      const parentResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: sourceId, type: "folder", name: "父目录" },
      });
      const parentId = String(dataOf(parentResponse.json()).id);
      const childResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId, type: "folder", name: "随父移动的子目录" },
      });
      const childId = String(dataOf(childResponse.json()).id);
      const siblingResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: sourceId, type: "folder", name: "同批兄弟目录" },
      });
      const siblingId = String(dataOf(siblingResponse.json()).id);

      const moved = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: {
          resourceIds: [parentId, childId, siblingId, siblingId],
          parentId: targetId,
        },
      });
      assert.equal(moved.statusCode, 200, moved.body);
      const moveData = dataOf(moved.json());
      assert.deepEqual(moveData.collapsedDescendantIds, [childId]);
      assert.deepEqual(
        (moveData.moved as JsonObject[]).map(({ id }) => id).sort(),
        [parentId, siblingId].sort(),
      );
      assert.equal(
        (await prisma.resourceEntry.findUnique({ where: { id: childId } }))
          ?.parentId,
        parentId,
        "选中的后代必须保持在父目录内，不能被第二次改写 parentId",
      );

      const nestedProjectResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "待嵌套项目" },
      });
      const nestedProjectId = String(dataOf(nestedProjectResponse.json()).id);
      const nestedProjectMove = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: { resourceIds: [nestedProjectId], parentId: targetId },
      });
      assert.equal(nestedProjectMove.statusCode, 200, nestedProjectMove.body);
      assert.equal(
        (await prisma.resourceEntry.findUnique({ where: { id: nestedProjectId } }))
          ?.parentId,
        targetId,
        "项目移动后数据库中必须只有新的父级关系",
      );
      const rootProjectsAfterMove = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/resources?view=all_projects",
      });
      assert.ok(
        !(dataOf(rootProjectsAfterMove.json()).items as JsonObject[])
          .some(({ id }) => id === nestedProjectId),
        "嵌套项目不能继续穿透显示在资源管理器根视图",
      );
      const targetChildrenAfterMove = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/resources?parentId=${encodeURIComponent(targetId)}`,
      });
      assert.ok(
        (dataOf(targetChildrenAfterMove.json()).items as JsonObject[])
          .some(({ id }) => id === nestedProjectId),
        "嵌套项目只能显示在移动后的目标项目内",
      );

      const auditCountBeforeNoop = await prisma.auditLog.count({
        where: { action: "resource_move", resourceId: parentId },
      });
      const unchanged = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: { resourceIds: [parentId], parentId: targetId },
      });
      assert.equal(unchanged.statusCode, 200);
      assert.equal((dataOf(unchanged.json()).moved as unknown[]).length, 0);
      assert.equal((dataOf(unchanged.json()).unchanged as unknown[]).length, 1);
      assert.equal(await prisma.auditLog.count({
        where: { action: "resource_move", resourceId: parentId },
      }), auditCountBeforeNoop, "同目录 no-op 不应伪造移动审计");

      const duplicateSource = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: sourceId, type: "folder", name: "冲突名称" },
      });
      const duplicateSourceId = String(dataOf(duplicateSource.json()).id);
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: targetId, type: "folder", name: "冲突名称" },
      });
      const rollbackCandidate = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: sourceId, type: "folder", name: "必须回滚" },
      });
      const rollbackCandidateId = String(dataOf(rollbackCandidate.json()).id);
      const conflictMove = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: {
          resourceIds: [rollbackCandidateId, duplicateSourceId],
          parentId: targetId,
        },
      });
      assert.equal(conflictMove.statusCode, 409);
      assert.equal(
        (await prisma.resourceEntry.findUnique({
          where: { id: rollbackCandidateId },
        }))?.parentId,
        sourceId,
        "任一名称冲突时，已经处理的同批资源也必须回滚",
      );

      const sameNameParentA = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: sourceId, type: "folder", name: "同名来源甲" },
      });
      const sameNameParentAId = String(dataOf(sameNameParentA.json()).id);
      const sameNameParentB = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: sourceId, type: "folder", name: "同名来源乙" },
      });
      const sameNameParentBId = String(dataOf(sameNameParentB.json()).id);
      const sameNameA = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: sameNameParentAId, type: "folder", name: "批内同名" },
      });
      const sameNameAId = String(dataOf(sameNameA.json()).id);
      const sameNameB = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: sameNameParentBId, type: "folder", name: "批内同名" },
      });
      const sameNameBId = String(dataOf(sameNameB.json()).id);
      const internalConflict = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: {
          resourceIds: [sameNameAId, sameNameBId],
          parentId: targetId,
        },
      });
      assert.equal(internalConflict.statusCode, 409);
      assert.equal(
        (await prisma.resourceEntry.findUnique({ where: { id: sameNameAId } }))
          ?.parentId,
        sameNameParentAId,
      );
      assert.equal(
        (await prisma.resourceEntry.findUnique({ where: { id: sameNameBId } }))
          ?.parentId,
        sameNameParentBId,
      );

      const cycleMove = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: { resourceIds: [parentId], parentId: childId },
      });
      assert.equal(cycleMove.statusCode, 400);

      const invalidBatch = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: { resourceIds: [], parentId: targetId },
      });
      assert.equal(invalidBatch.statusCode, 400);

      const restrictedSource = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "批量权限源" },
      });
      const restrictedSourceId = String(dataOf(restrictedSource.json()).id);
      const allowedItem = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: restrictedSourceId, type: "folder", name: "允许移动" },
      });
      const allowedItemId = String(dataOf(allowedItem.json()).id);
      const deniedItem = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: restrictedSourceId, type: "folder", name: "拒绝移动" },
      });
      const deniedItemId = String(dataOf(deniedItem.json()).id);
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${allowedItemId}/permissions/user-student`,
        payload: { capabilities: ["read", "move"] },
      });
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${deniedItemId}/permissions/user-student`,
        payload: { capabilities: ["read"] },
      });
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${targetId}/permissions/user-student`,
        payload: { capabilities: ["read", "create_child"] },
      });
      const deniedBatch = await jsonRequest(app, studentToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: {
          resourceIds: [allowedItemId, deniedItemId],
          parentId: targetId,
        },
      });
      assert.equal(deniedBatch.statusCode, 403);
      assert.equal(
        (await prisma.resourceEntry.findUnique({ where: { id: allowedItemId } }))
          ?.parentId,
        restrictedSourceId,
        "权限预检失败时不能移动同批中已授权的资源",
      );

      const inaccessibleTarget = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "无新建权限目标" },
      });
      const inaccessibleTargetId = String(dataOf(inaccessibleTarget.json()).id);
      const deniedTarget = await jsonRequest(app, studentToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: {
          resourceIds: [allowedItemId],
          parentId: inaccessibleTargetId,
        },
      });
      assert.equal(deniedTarget.statusCode, 403);
      assert.equal(
        (await prisma.resourceEntry.findUnique({ where: { id: allowedItemId } }))
          ?.parentId,
        restrictedSourceId,
      );

      const trashedTargetParent = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "已回收目标祖先" },
      });
      const trashedTargetParentId = String(dataOf(trashedTargetParent.json()).id);
      const hiddenTarget = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: trashedTargetParentId,
          type: "folder",
          name: "隐藏目标",
        },
      });
      const hiddenTargetId = String(dataOf(hiddenTarget.json()).id);
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${trashedTargetParentId}/trash`,
      });
      const hiddenTargetMove = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/move-batch",
        payload: { resourceIds: [rollbackCandidateId], parentId: hiddenTargetId },
      });
      assert.equal(hiddenTargetMove.statusCode, 400);
      assert.equal(
        (await prisma.resourceEntry.findUnique({
          where: { id: rollbackCandidateId },
        }))?.parentId,
        sourceId,
      );
    });

    await suite.test("标注文件复制产生独立 owner 和 revision", async () => {
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "原始标注.json",
          payload: { marker: "original" },
        },
      });
      assert.equal(created.statusCode, 200);
      annotationFileId = String((dataOf(created.json()).resource as JsonObject).id);

      const sourceGrant = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${annotationFileId}/permissions/user-student`,
        payload: { capabilities: ["read", "copy"], inheritToChildren: false },
      });
      assert.equal(sourceGrant.statusCode, 200);

      const copied = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/resources/${annotationFileId}/copy`,
        payload: { parentId: projectId },
      });
      assert.equal(copied.statusCode, 200);
      const copiedResource = dataOf(copied.json());
      const copiedId = String(copiedResource.id);
      assert.equal((copiedResource.owner as JsonObject).id, "user-student");
      assert.equal(copiedResource.revision, 1);

      const copiedFile = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${copiedId}`,
      });
      assert.deepEqual(dataOf(copiedFile.json()).payload, { marker: "original" });
      const directAclCount = await prisma.resourcePermission.count({
        where: { resourceId: copiedId },
      });
      assert.equal(directAclCount, 0);

      const ownerSave = await jsonRequest(app, studentToken, {
        method: "PUT",
        url: `/api/annotation-files/${copiedId}`,
        payload: { baseRevision: 1, payload: { marker: "student-copy" } },
      });
      assert.equal(ownerSave.statusCode, 200);
      assert.equal(dataOf(ownerSave.json()).revision, 2);
    });

    await suite.test("项目递归复制复用媒体对象并重映射内部引用", async () => {
      const sourceProjectResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          type: "project",
          name: "递归复制源项目",
          description: "需要保留的项目说明",
        },
      });
      const sourceProjectId = String(dataOf(sourceProjectResponse.json()).id);
      const sourceFolderResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: sourceProjectId,
          type: "folder",
          name: "素材与标注",
        },
      });
      const sourceFolderId = String(dataOf(sourceFolderResponse.json()).id);
      const targetProjectResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "递归复制目标项目" },
      });
      const targetProjectId = String(dataOf(targetProjectResponse.json()).id);

      const upload = await multipartUpload(
        app,
        adminToken,
        sourceFolderId,
        "shared-copy.mp4",
        "video/mp4",
        minimalMp4(),
      );
      assert.equal(upload.statusCode, 200, upload.body);
      const sourceMediaResponse = upload;
      const sourceMediaId = String(dataOf(sourceMediaResponse.json()).id);
      const sourceMedia = await prisma.mediaFile.findUniqueOrThrow({
        where: { resourceId: sourceMediaId },
      });
      const sourceFileId = sourceMedia.fileId;
      const sourceAnnotationResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: sourceFolderId,
          name: "关联视频的标注.json",
          mediaResourceId: sourceMediaId,
          payload: { marker: "recursive-source" },
        },
      });
      const sourceAnnotationId = String(
        (dataOf(sourceAnnotationResponse.json()).resource as JsonObject).id,
      );
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${sourceAnnotationId}`,
        payload: {
          baseRevision: 1,
          payload: { marker: "recursive-source-saved" },
        },
      });

      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${sourceProjectId}/permissions/user-student`,
        payload: {
          capabilities: ["read", "copy"],
          inheritToChildren: true,
        },
      });
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${targetProjectId}/permissions/user-student`,
        payload: {
          capabilities: ["read", "create_child"],
          inheritToChildren: true,
        },
      });

      const copiedResponse = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/resources/${sourceProjectId}/copy`,
        payload: { parentId: targetProjectId },
      });
      assert.equal(copiedResponse.statusCode, 200, copiedResponse.body);
      const copiedProjectId = String(dataOf(copiedResponse.json()).id);
      const copiedProject = await prisma.resourceEntry.findUniqueOrThrow({
        where: { id: copiedProjectId },
        include: { projectMetadata: true },
      });
      assert.equal(copiedProject.ownerUserId, "user-student");
      assert.equal(copiedProject.projectMetadata?.description, "需要保留的项目说明");

      const copiedFolder = await prisma.resourceEntry.findFirstOrThrow({
        where: { parentId: copiedProjectId, name: "素材与标注" },
      });
      const copiedChildren = await prisma.resourceEntry.findMany({
        where: { parentId: copiedFolder.id },
        include: { annotationFile: true, mediaFile: true },
      });
      const copiedMedia = copiedChildren.find(({ type }) => type === "media_file");
      const copiedAnnotation = copiedChildren.find(({ type }) =>
        type === "annotation_file");
      assert.ok(copiedMedia?.mediaFile);
      assert.ok(copiedAnnotation?.annotationFile);
      assert.equal(copiedMedia.mediaFile.fileId, sourceFileId);
      assert.equal(
        copiedAnnotation.annotationFile.mediaResourceId,
        copiedMedia.id,
        "副本标注必须引用副本树内的媒体资源",
      );
      assert.equal(copiedAnnotation.annotationFile.revision, 1);
      assert.deepEqual(
        copiedAnnotation.annotationFile.payload,
        { marker: "recursive-source-saved" },
      );
      assert.equal(await prisma.fileObject.count({ where: { id: sourceFileId } }), 1);
      assert.equal(await prisma.mediaFile.count({ where: { fileId: sourceFileId } }), 2);
      assert.equal(await prisma.annotationRecoverySnapshot.count({
        where: { annotationFileId: copiedAnnotation.id },
      }), 0);
      assert.equal(await prisma.resourcePermission.count({
        where: { resourceId: { in: [
          copiedProjectId,
          copiedFolder.id,
          copiedMedia.id,
          copiedAnnotation.id,
        ] } },
      }), 0);

      const copiedMediaRead = await app.inject({
        method: "GET",
        url: `/api/files/${sourceFileId}/content`,
        headers: { authorization: `Bearer ${studentToken}` },
      });
      assert.equal(copiedMediaRead.statusCode, 200);
      assert.deepEqual(
        copiedMediaRead.rawPayload,
        minimalMp4(),
      );

      const standaloneMediaCopy = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/resources/${sourceMediaId}/copy`,
        payload: { parentId: targetProjectId },
      });
      assert.equal(standaloneMediaCopy.statusCode, 200);
      const standaloneMediaId = String(dataOf(standaloneMediaCopy.json()).id);
      assert.equal((await prisma.mediaFile.findUniqueOrThrow({
        where: { resourceId: standaloneMediaId },
      })).fileId, sourceFileId);

      const standaloneAnnotationCopy = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/resources/${sourceAnnotationId}/copy`,
        payload: { parentId: targetProjectId },
      });
      assert.equal(standaloneAnnotationCopy.statusCode, 200);
      const standaloneAnnotationId = String(
        dataOf(standaloneAnnotationCopy.json()).id,
      );
      assert.equal((await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: standaloneAnnotationId },
      })).mediaResourceId, sourceMediaId, "单独复制标注时保留外部媒体引用");
      assert.equal(await prisma.fileObject.count({ where: { id: sourceFileId } }), 1);
      assert.equal(await prisma.mediaFile.count({ where: { fileId: sourceFileId } }), 3);

      const copyIntoDescendant = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${sourceProjectId}/copy`,
        payload: { parentId: sourceFolderId },
      });
      assert.equal(copyIntoDescendant.statusCode, 400);

      const restrictedChildResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: sourceProjectId,
          type: "folder",
          name: "受限后代",
        },
      });
      const restrictedChildId = String(dataOf(restrictedChildResponse.json()).id);
      await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/resources/${restrictedChildId}/permission-inheritance`,
        payload: { breakPermissionInheritance: true },
      });
      const targetChildCountBefore = await prisma.resourceEntry.count({
        where: { parentId: targetProjectId },
      });
      const deniedTreeCopy = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/resources/${sourceProjectId}/copy`,
        payload: { parentId: targetProjectId },
      });
      assert.equal(deniedTreeCopy.statusCode, 403);
      assert.equal(await prisma.resourceEntry.count({
        where: { parentId: targetProjectId },
      }), targetChildCountBefore, "无权复制后代时不能留下半棵副本");

      const copyAudit = await prisma.auditLog.findFirst({
        where: { action: "resource_copy", resourceId: copiedProjectId },
      });
      assert.deepEqual(copyAudit?.detail, {
        sourceResourceId: sourceProjectId,
        copiedNodeCount: 4,
        copiedAnnotationCount: 1,
        reusedFileObjectCount: 1,
      });
    });

    await suite.test("标注保存并发、恢复快照和只读拒绝", async () => {
      const forbiddenSave = await jsonRequest(app, studentToken, {
        method: "PUT",
        url: `/api/annotation-files/${annotationFileId}`,
        payload: { baseRevision: 1, payload: { marker: "forbidden" } },
      });
      assert.equal(forbiddenSave.statusCode, 403);

      const [left, right] = await Promise.all([
        jsonRequest(app, adminToken, {
          method: "PUT",
          url: `/api/annotation-files/${annotationFileId}`,
          payload: { baseRevision: 1, payload: { winner: "left" } },
        }),
        jsonRequest(app, adminToken, {
          method: "PUT",
          url: `/api/annotation-files/${annotationFileId}`,
          payload: { baseRevision: 1, payload: { winner: "right" } },
        }),
      ]);
      assert.deepEqual(
        [left.statusCode, right.statusCode].sort((a, b) => a - b),
        [200, 409],
      );
      const stored = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: annotationFileId },
      });
      assert.equal(stored.revision, 2);
      const snapshots = await prisma.annotationRecoverySnapshot.findMany({
        where: { annotationFileId },
      });
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]?.revision, 1);
      assert.deepEqual(snapshots[0]?.payload, { marker: "original" });

      const invalidRevision = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${annotationFileId}`,
        payload: { baseRevision: -1, payload: {} },
      });
      assert.equal(invalidRevision.statusCode, 400);
    });

    await suite.test("恢复快照列表轻量化、详情归属与权限边界", async () => {
      // 再保存一次以形成两个历史 revision，并保留 revision 2 的真实 payload 供详情核对。
      const beforeSecondSave = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: annotationFileId },
      });
      const secondSave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${annotationFileId}`,
        payload: {
          baseRevision: 2,
          payload: { marker: "current-after-history-test" },
        },
      });
      assert.equal(secondSave.statusCode, 200, secondSave.body);

      // 列表必须按 revision 倒序返回摘要，任何条目都不应意外携带大体积 payload。
      const listResponse = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots`,
      });
      assert.equal(listResponse.statusCode, 200, listResponse.body);
      const listBody = listResponse.json() as { data: JsonObject[] };
      assert.deepEqual(
        listBody.data.map(({ revision }) => revision),
        [2, 1],
      );
      assert.ok(listBody.data.every((summary) => !("payload" in summary)));
      assert.ok(listBody.data.every((summary) =>
        typeof summary.createdAt === "string" &&
        typeof (summary.creator as JsonObject).displayName === "string"));

      // 单条详情按需返回旧 payload，读取动作不能改变当前标注 revision 或内容。
      const revisionTwoSummary = listBody.data.find(({ revision }) =>
        revision === 2);
      assert.ok(revisionTwoSummary);
      const detailResponse = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/${revisionTwoSummary.id}`,
      });
      assert.equal(detailResponse.statusCode, 200, detailResponse.body);
      assert.deepEqual(
        dataOf(detailResponse.json()).payload,
        beforeSecondSave.payload,
      );
      const currentAfterRead = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: annotationFileId },
      });
      assert.equal(currentAfterRead.revision, 3);
      assert.deepEqual(
        currentAfterRead.payload,
        { marker: "current-after-history-test" },
      );

      // 只有 read/copy 的学生不能读取内部事故恢复历史，前端隐藏入口不是安全边界。
      const forbiddenList = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots`,
      });
      assert.equal(forbiddenList.statusCode, 403);
      const forbiddenDetail = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/${revisionTwoSummary.id}`,
      });
      assert.equal(forbiddenDetail.statusCode, 403);

      // 创建另一份有快照的文件，验证 snapshot id 不能跨 annotation file 路径读取。
      const otherCreated = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "快照归属校验.json",
          payload: { marker: "other-original" },
        },
      });
      const otherFileId = String(
        (dataOf(otherCreated.json()).resource as JsonObject).id,
      );
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${otherFileId}`,
        payload: {
          baseRevision: 1,
          payload: { marker: "other-current" },
        },
      });
      const otherSnapshot = await prisma.annotationRecoverySnapshot
        .findFirstOrThrow({ where: { annotationFileId: otherFileId } });
      const crossFileRead = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/${otherSnapshot.id}`,
      });
      assert.equal(crossFileRead.statusCode, 404);

      // 不存在的文件或快照都返回明确 404，而不是伪装为空历史。
      const missingFile = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/annotation-files/missing-file/recovery-snapshots",
      });
      assert.equal(missingFile.statusCode, 404);
      const missingSnapshot = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/missing-snapshot`,
      });
      assert.equal(missingSnapshot.statusCode, 404);
    });

    await suite.test("恢复快照生成新修订并原子保留当前内容", async () => {
      const sourceSnapshot = await prisma.annotationRecoverySnapshot
        .findUniqueOrThrow({
          where: {
            annotationFileId_revision: {
              annotationFileId,
              revision: 1,
            },
          },
        });
      const saveAuditCountBefore = await prisma.auditLog.count({
        where: {
          action: "annotation_file_save",
          resourceId: annotationFileId,
        },
      });
      assert.equal(saveAuditCountBefore, 2, "两次成功保存应各有且仅有一条审计");

      // 路由必须拒绝所有非正整数 revision，且坏请求不能创建保护快照或审计。
      const snapshotsBeforeInvalidInput = await prisma
        .annotationRecoverySnapshot.count({ where: { annotationFileId } });
      const auditsBeforeInvalidInput = await prisma.auditLog.count({
        where: { resourceId: annotationFileId },
      });
      for (const baseRevision of [undefined, -1, 0, 1.5, "3"]) {
        const invalid = await jsonRequest(app, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/${sourceSnapshot.id}/restore`,
          payload: baseRevision === undefined ? {} : { baseRevision },
        });
        assert.equal(invalid.statusCode, 400);
      }
      assert.equal(await prisma.annotationRecoverySnapshot.count({
        where: { annotationFileId },
      }), snapshotsBeforeInvalidInput);
      assert.equal(await prisma.auditLog.count({
        where: { resourceId: annotationFileId },
      }), auditsBeforeInvalidInput);

      // 只读账号不能绕过 Inspector 直接调用恢复 mutation。
      const forbiddenRestore = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/${sourceSnapshot.id}/restore`,
        payload: { baseRevision: 3 },
      });
      assert.equal(forbiddenRestore.statusCode, 403);

      // snapshot id 必须属于路径中的 annotation file，不匹配时统一返回 404。
      const foreignSnapshot = await prisma.annotationRecoverySnapshot
        .findFirstOrThrow({
          where: { annotationFileId: { not: annotationFileId } },
        });
      const crossFileRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/${foreignSnapshot.id}/restore`,
        payload: { baseRevision: 3 },
      });
      assert.equal(crossFileRestore.statusCode, 404);

      // 恢复 revision 1 后当前 revision 单调增加到 4，旧快照不被消费。
      const restored = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/${sourceSnapshot.id}/restore`,
        payload: { baseRevision: 3 },
      });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(dataOf(restored.json()).revision, 4);
      assert.deepEqual(dataOf(restored.json()).payload, { marker: "original" });
      const current = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: annotationFileId },
      });
      assert.equal(current.revision, 4);
      assert.deepEqual(current.payload, { marker: "original" });
      assert.ok(await prisma.annotationRecoverySnapshot.findUnique({
        where: { id: sourceSnapshot.id },
      }));

      // 恢复前 revision 3 的当前内容必须成为可再次找回的保护快照。
      const protectionSnapshot = await prisma.annotationRecoverySnapshot
        .findUniqueOrThrow({
          where: {
            annotationFileId_revision: {
              annotationFileId,
              revision: 3,
            },
          },
        });
      assert.deepEqual(
        protectionSnapshot.payload,
        { marker: "current-after-history-test" },
      );
      assert.equal(protectionSnapshot.reason, "before_snapshot_restore");

      // 恢复审计只记录定位信息，不泄漏历史或当前 payload。
      const restoreAudits = await prisma.auditLog.findMany({
        where: {
          action: "annotation_snapshot_restore",
          resourceId: annotationFileId,
        },
      });
      assert.equal(restoreAudits.length, 1);
      assert.deepEqual(restoreAudits[0]?.detail, {
        sourceSnapshotId: sourceSnapshot.id,
        sourceRevision: 1,
        previousRevision: 3,
        revision: 4,
      });

      // 相同请求重试时旧 baseRevision 必须 409，且不得产生第二条审计或新快照。
      const snapshotCountAfterRestore = await prisma
        .annotationRecoverySnapshot.count({ where: { annotationFileId } });
      const staleRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/${sourceSnapshot.id}/restore`,
        payload: { baseRevision: 3 },
      });
      assert.equal(staleRestore.statusCode, 409);
      assert.equal(await prisma.annotationRecoverySnapshot.count({
        where: { annotationFileId },
      }), snapshotCountAfterRestore);
      assert.equal(await prisma.auditLog.count({
        where: {
          action: "annotation_snapshot_restore",
          resourceId: annotationFileId,
        },
      }), 1);

      // 不存在的文件和快照保持明确 404，不把归属信息暴露为其他错误。
      const missingFile = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/missing-file/recovery-snapshots/${sourceSnapshot.id}/restore`,
        payload: { baseRevision: 1 },
      });
      assert.equal(missingFile.statusCode, 404);
      const missingSnapshot = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/recovery-snapshots/missing-snapshot/restore`,
        payload: { baseRevision: 4 },
      });
      assert.equal(missingSnapshot.statusCode, 404);
    });

    await suite.test("标注确认权限、作用域、撤销和资源生命周期", async () => {
      // 使用当前格式 payload 建立独立审核夹具，确保轨道校验不会误借旧测试的 marker 对象。
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "标注确认合同.json",
          payload: {
            builtinTracks: [{ id: "character-track" }],
            customTracks: [{ id: "custom-action-1" }],
            activeTrackOrder: [
              "character-track",
              "branch-lane:custom-action-1:branch-1",
            ],
          },
        },
      });
      const confirmationFileId = String(
        (dataOf(created.json()).resource as JsonObject).id,
      );

      // 普通 write 不能代替 review；列表仍只要求 read，便于只读账号查看治理结果。
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${confirmationFileId}/permissions/user-student`,
        payload: {
          capabilities: ["read", "write", "copy"],
          inheritToChildren: false,
        },
      });
      const deniedWithoutReview = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
        payload: {
          confirmedRevision: 1,
          scope: { startTime: 0, endTime: 10, targets: { mode: "all" } },
        },
      });
      assert.equal(deniedWithoutReview.statusCode, 403);
      const readableEmptyList = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
      });
      assert.equal(readableEmptyList.statusCode, 200);

      // 学生和助教分别取得逐资源 review；角色名称本身不绕过资源 ACL。
      for (const userId of ["user-student", "user-ta"]) {
        const grant = await jsonRequest(app, adminToken, {
          method: "PUT",
          url: `/api/resources/${confirmationFileId}/permissions/${userId}`,
          payload: {
            capabilities: ["read", "review", "copy"],
            inheritToChildren: false,
          },
        });
        assert.equal(grant.statusCode, 200, grant.body);
      }

      // 路由坏输入、过期 revision 和派生轨道必须在落库前失败且不产生审计。
      const invalidBodies = [
        {
          confirmedRevision: 0,
          scope: { startTime: 0, endTime: 1, targets: { mode: "all" } },
        },
        {
          confirmedRevision: 1,
          scope: { startTime: 2, endTime: 1, targets: { mode: "all" } },
        },
        {
          confirmedRevision: 1,
          scope: {
            startTime: 0,
            endTime: 1,
            targets: { mode: "domains", domains: ["unknown-domain"] },
          },
        },
      ];
      for (const payload of invalidBodies) {
        const invalid = await jsonRequest(app, studentToken, {
          method: "POST",
          url: `/api/annotation-files/${confirmationFileId}/confirmations`,
          payload,
        });
        assert.equal(invalid.statusCode, 400);
      }
      const stale = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
        payload: {
          confirmedRevision: 2,
          scope: { startTime: 0, endTime: 1, targets: { mode: "all" } },
        },
      });
      assert.equal(stale.statusCode, 409);
      const derivedTrack = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
        payload: {
          confirmedRevision: 1,
          scope: {
            startTime: 0,
            endTime: 1,
            targets: {
              mode: "tracks",
              trackIds: ["branch-lane:custom-action-1:branch-1"],
            },
          },
        },
      });
      assert.equal(derivedTrack.statusCode, 400);
      assert.equal(await prisma.annotationConfirmation.count({
        where: { annotationFileId: confirmationFileId },
      }), 0);

      // 领域和持久轨道两种确认均绑定 revision 1，备注会 trim 但不会进入审计 detail。
      const domainCreated = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
        payload: {
          confirmedRevision: 1,
          scope: {
            startTime: 10,
            endTime: 20,
            targets: {
              mode: "domains",
              domains: ["subtitle_lines", "gongche_annotations"],
            },
          },
          note: "  已核对唱段  ",
        },
      });
      assert.equal(domainCreated.statusCode, 200, domainCreated.body);
      const domainConfirmation = dataOf(domainCreated.json());
      assert.equal(domainConfirmation.note, "已核对唱段");
      const trackCreated = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
        payload: {
          confirmedRevision: 1,
          scope: {
            startTime: 20,
            endTime: 30,
            targets: {
              mode: "tracks",
              trackIds: ["character-track", "custom-action-1"],
            },
          },
        },
      });
      assert.equal(trackCreated.statusCode, 200, trackCreated.body);
      const trackConfirmation = dataOf(trackCreated.json());

      // 列表只返回治理元数据和服务器当前 revision，不泄漏标注 payload。
      const listed = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
      });
      assert.equal(listed.statusCode, 200, listed.body);
      const listedBody = dataOf(listed.json());
      assert.equal(listedBody.currentRevision, 1);
      const confirmations = listedBody.confirmations as JsonObject[];
      assert.equal(confirmations.length, 2);
      assert.ok(confirmations.every((record) => !("payload" in record)));

      // 其他 reviewer 不能撤销学生记录；创建者撤销幂等且只写一条撤销审计。
      const trackConfirmationId = String(trackConfirmation.id);
      const deniedOtherReviewer = await jsonRequest(app, taToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations/${trackConfirmationId}/revoke`,
        payload: { reason: "非创建者尝试撤销" },
      });
      assert.equal(deniedOtherReviewer.statusCode, 403);
      const revokedByCreator = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations/${trackConfirmationId}/revoke`,
        payload: { reason: "  范围选择错误  " },
      });
      assert.equal(revokedByCreator.statusCode, 200, revokedByCreator.body);
      assert.equal(dataOf(revokedByCreator.json()).revokeReason, "范围选择错误");
      const repeatedRevoke = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations/${trackConfirmationId}/revoke`,
        payload: { reason: "重复请求不应覆盖原原因" },
      });
      assert.equal(repeatedRevoke.statusCode, 200);
      assert.equal(
        await prisma.auditLog.count({
          where: {
            action: "annotation_confirmation_revoke",
            resourceId: confirmationFileId,
          },
        }),
        1,
      );

      // 管理员可以撤销任意创建者的记录；路径绑定阻止用其他文件 id 操作同一确认。
      const domainConfirmationId = String(domainConfirmation.id);
      const crossFileRevoke = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/confirmations/${domainConfirmationId}/revoke`,
        payload: {},
      });
      assert.equal(crossFileRevoke.statusCode, 404);
      const revokedByAdmin = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/confirmations/${domainConfirmationId}/revoke`,
        payload: {},
      });
      assert.equal(revokedByAdmin.statusCode, 200, revokedByAdmin.body);

      // 普通保存只推进当前 revision；历史确认保留并由调用方派生为 stale。
      const saved = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${confirmationFileId}`,
        payload: {
          baseRevision: 1,
          payload: {
            builtinTracks: [{ id: "character-track" }],
            customTracks: [{ id: "custom-action-1" }],
          },
        },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const staleList = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
      });
      assert.equal(dataOf(staleList.json()).currentRevision, 2);
      assert.ok((dataOf(staleList.json()).confirmations as JsonObject[])
        .every(({ confirmedRevision }) => confirmedRevision === 1));

      // 文件复制是独立标注工作副本，不复制确认事实、恢复历史或治理审计。
      const copied = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${confirmationFileId}/copy`,
        payload: { parentId: projectId, name: "标注确认合同副本.json" },
      });
      assert.equal(copied.statusCode, 200, copied.body);
      const copiedId = String(dataOf(copied.json()).id);
      assert.equal(await prisma.annotationConfirmation.count({
        where: { annotationFileId: copiedId },
      }), 0);

      // 审计 detail 只包含定位数据，备注和 payload 均不得进入治理日志。
      const confirmationAudits = await prisma.auditLog.findMany({
        where: { resourceId: confirmationFileId },
      });
      assert.ok(confirmationAudits
        .filter(({ action }) => action.startsWith("annotation_confirmation"))
        .every(({ detail }) => {
          const value = detail as JsonObject;
          return !("note" in value) && !("payload" in value);
        }));

      // 回收站中的标注文件不能再列出或创建确认，恢复资源后仍保留历史确认事实。
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${confirmationFileId}/trash`,
      });
      const trashedList = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
      });
      assert.equal(trashedList.statusCode, 404);
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${confirmationFileId}/restore`,
      });
      assert.equal(await prisma.annotationConfirmation.count({
        where: { annotationFileId: confirmationFileId },
      }), 2);
    });

    await suite.test("标注保存与确认并发保持 revision 原子性", async () => {
      // 两种操作共享固定锁序：保存必定成功，确认只能绑定保存前 revision 或得到 409。
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "确认并发测试.json",
          payload: {
            builtinTracks: [{ id: "character-track" }],
            customTracks: [],
          },
        },
      });
      const concurrentFileId = String(
        (dataOf(created.json()).resource as JsonObject).id,
      );
      const [confirmation, save] = await Promise.all([
        jsonRequest(app, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${concurrentFileId}/confirmations`,
          payload: {
            confirmedRevision: 1,
            scope: { startTime: 0, endTime: 2, targets: { mode: "all" } },
          },
        }),
        jsonRequest(app, adminToken, {
          method: "PUT",
          url: `/api/annotation-files/${concurrentFileId}`,
          payload: {
            baseRevision: 1,
            payload: {
              builtinTracks: [{ id: "character-track" }],
              customTracks: [],
              marker: "saved",
            },
          },
        }),
      ]);
      assert.equal(save.statusCode, 200, save.body);
      assert.ok(
        confirmation.statusCode === 200 || confirmation.statusCode === 409,
        `确认并发结果应为 200 或 409，实际为 ${confirmation.statusCode}`,
      );
      const stored = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: concurrentFileId },
      });
      assert.equal(stored.revision, 2);
      const records = await prisma.annotationConfirmation.findMany({
        where: { annotationFileId: concurrentFileId },
      });
      assert.equal(records.length, confirmation.statusCode === 200 ? 1 : 0);
      assert.ok(records.every(({ confirmedRevision }) => confirmedRevision === 1));
    });

    await suite.test("回收站祖先阻止普通保存与快照恢复", async () => {
      // 独立测试树避免回收主测试文件影响后续 operation 用例。
      const container = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "标注写入活动状态测试" },
      });
      const containerId = String(dataOf(container.json()).id);
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: containerId,
          name: "祖先回收后不可写.json",
          payload: { marker: "before-trash" },
        },
      });
      const hiddenFileId = String(
        (dataOf(created.json()).resource as JsonObject).id,
      );
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${hiddenFileId}`,
        payload: { baseRevision: 1, payload: { marker: "current" } },
      });
      const snapshot = await prisma.annotationRecoverySnapshot
        .findFirstOrThrow({ where: { annotationFileId: hiddenFileId } });
      const trashed = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/trash-batch",
        payload: { resourceIds: [containerId] },
      });
      assert.equal(trashed.statusCode, 200, trashed.body);

      // 子文件自身未写 trashedAt，但已被回收祖先隐藏，内容 mutation 必须 fail closed。
      const deniedSave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${hiddenFileId}`,
        payload: { baseRevision: 2, payload: { marker: "must-not-save" } },
      });
      assert.equal(deniedSave.statusCode, 404);
      const deniedRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${hiddenFileId}/recovery-snapshots/${snapshot.id}/restore`,
        payload: { baseRevision: 2 },
      });
      assert.equal(deniedRestore.statusCode, 404);
      const unchanged = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: hiddenFileId },
      });
      assert.equal(unchanged.revision, 2);
      assert.deepEqual(unchanged.payload, { marker: "current" });
    });

    await suite.test("批量移入回收站保持原子性并压缩父子选择", async () => {
      const trashProject = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "批量回收站测试" },
      });
      const trashProjectId = String(dataOf(trashProject.json()).id);
      const parent = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: trashProjectId,
          type: "folder",
          name: "待删除父目录",
        },
      });
      const parentId = String(dataOf(parent.json()).id);
      const child = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId, type: "folder", name: "随父隐藏的子目录" },
      });
      const childId = String(dataOf(child.json()).id);
      const sibling = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: trashProjectId,
          type: "folder",
          name: "同批兄弟目录",
        },
      });
      const siblingId = String(dataOf(sibling.json()).id);

      for (const payload of [
        {},
        { resourceIds: [] },
        { resourceIds: "not-an-array" },
        { resourceIds: [""] },
        { resourceIds: Array.from({ length: 201 }, (_, index) => `id-${index}`) },
      ]) {
        const invalid = await jsonRequest(app, adminToken, {
          method: "POST",
          url: "/api/resources/trash-batch",
          payload,
        });
        assert.equal(invalid.statusCode, 400, invalid.body);
      }

      const missingRollback = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/trash-batch",
        payload: { resourceIds: [siblingId, "missing-resource"] },
      });
      assert.equal(missingRollback.statusCode, 404);
      assert.equal((await prisma.resourceEntry.findUniqueOrThrow({
        where: { id: siblingId },
      })).trashedAt, null, "任一资源不存在时整批必须保持不变");

      const permitted = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: trashProjectId,
          type: "folder",
          name: "学生可删除",
        },
      });
      const permittedId = String(dataOf(permitted.json()).id);
      const denied = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: trashProjectId,
          type: "folder",
          name: "学生不可删除",
        },
      });
      const deniedId = String(dataOf(denied.json()).id);
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${permittedId}/permissions/user-student`,
        payload: {
          capabilities: ["read", "delete"],
          inheritToChildren: false,
        },
      });
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${deniedId}/permissions/user-student`,
        payload: { capabilities: ["read"], inheritToChildren: false },
      });
      const forbiddenBatch = await jsonRequest(app, studentToken, {
        method: "POST",
        url: "/api/resources/trash-batch",
        payload: { resourceIds: [permittedId, deniedId] },
      });
      assert.equal(forbiddenBatch.statusCode, 403, forbiddenBatch.body);
      const permissionRollbackRows = await prisma.resourceEntry.findMany({
        where: { id: { in: [permittedId, deniedId] } },
        select: { id: true, trashedAt: true },
      });
      assert.ok(permissionRollbackRows.every(({ trashedAt }) => !trashedAt));

      const trashed = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/trash-batch",
        payload: {
          resourceIds: [parentId, childId, siblingId, siblingId],
        },
      });
      assert.equal(trashed.statusCode, 200, trashed.body);
      const trashData = dataOf(trashed.json());
      assert.deepEqual(trashData.collapsedDescendantIds, [childId]);
      assert.deepEqual(
        (trashData.trashed as JsonObject[]).map(({ id }) => id).sort(),
        [parentId, siblingId].sort(),
      );
      const storedTree = await prisma.resourceEntry.findMany({
        where: { id: { in: [parentId, childId, siblingId] } },
        select: { id: true, parentId: true, trashedAt: true },
      });
      const storedById = new Map(storedTree.map((row) => [row.id, row]));
      assert.ok(storedById.get(parentId)?.trashedAt);
      assert.ok(storedById.get(siblingId)?.trashedAt);
      assert.equal(storedById.get(childId)?.trashedAt, null);
      assert.equal(
        storedById.get(childId)?.parentId,
        parentId,
        "折叠后代必须保留原父子关系，不能被重复标记或重挂载",
      );

      const activeChildren = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/resources?parentId=${encodeURIComponent(trashProjectId)}`,
      });
      const activeIds = (dataOf(activeChildren.json()).items as JsonObject[])
        .map(({ id }) => id);
      assert.ok(!activeIds.includes(parentId));
      assert.ok(!activeIds.includes(siblingId));
      const trashView = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/resources?view=trash",
      });
      const trashIds = (dataOf(trashView.json()).items as JsonObject[])
        .map(({ id }) => id);
      assert.ok(trashIds.includes(parentId));
      assert.ok(trashIds.includes(siblingId));
      assert.ok(!trashIds.includes(childId));

      const audits = await prisma.auditLog.findMany({
        where: {
          action: "resource_trash",
          resourceId: { in: [parentId, childId, siblingId] },
        },
        orderBy: { resourceId: "asc" },
      });
      assert.equal(audits.length, 2);
      assert.ok(audits.every(({ actorUserId, detail }) =>
        actorUserId === "user-admin" &&
        (detail as JsonObject).batchSize === 3 &&
        (detail as JsonObject).logicalRootCount === 2 &&
        (detail as JsonObject).collapsedSelectionCount === 1));

      const auditCountBeforeDuplicate = audits.length;
      const duplicateTrash = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources/trash-batch",
        payload: { resourceIds: [parentId] },
      });
      assert.equal(duplicateTrash.statusCode, 400);
      assert.equal(await prisma.auditLog.count({
        where: {
          action: "resource_trash",
          resourceId: { in: [parentId, childId, siblingId] },
        },
      }), auditCountBeforeDuplicate);

      // 单项恢复仍使用原恢复不变量；先父后子无需改写未直接 trashed 的后代。
      assert.equal((await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${parentId}/restore`,
      })).statusCode, 200);
      assert.equal((await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${siblingId}/restore`,
      })).statusCode, 200);
    });

    await suite.test("回收站隐藏与恢复", async () => {
      const nestedProject = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: childFolderId,
          type: "project",
          name: "不应穿透显示的项目",
        },
      });
      const nestedProjectId = String(dataOf(nestedProject.json()).id);
      const trashed = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${childFolderId}/trash`,
      });
      assert.equal(trashed.statusCode, 200);
      const children = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/resources?parentId=${encodeURIComponent(projectId)}`,
      });
      const items = dataOf(children.json()).items as JsonObject[];
      assert.ok(!items.some(({ id }) => id === childFolderId));
      const allProjects = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/resources?view=all_projects",
      });
      const projectItems = dataOf(allProjects.json()).items as JsonObject[];
      assert.ok(
        !projectItems.some(({ id }) => id === nestedProjectId),
        "已进入回收站的祖先不能让后代项目穿透到全项目视图",
      );

      const replacement = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: projectId, type: "folder", name: "子目录" },
      });
      assert.equal(replacement.statusCode, 200);
      const replacementId = String(dataOf(replacement.json()).id);
      const conflictingRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${childFolderId}/restore`,
      });
      assert.equal(conflictingRestore.statusCode, 409);
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${replacementId}/trash`,
      });

      const restored = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${childFolderId}/restore`,
      });
      assert.equal(restored.statusCode, 200);
      assert.equal(dataOf(restored.json()).trashedAt, null);

      const directlyTrashedChild = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: childFolderId,
          type: "folder",
          name: "单独删除的子目录",
        },
      });
      const directlyTrashedChildId = String(
        dataOf(directlyTrashedChild.json()).id,
      );
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${directlyTrashedChildId}/trash`,
      });
      const unauthorizedRestore = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/resources/${directlyTrashedChildId}/restore`,
      });
      assert.equal(unauthorizedRestore.statusCode, 403);
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${childFolderId}/trash`,
      });

      // 子项不能越过仍在回收站的父目录恢复，否则 API 虽然返回成功，普通资源视图仍看不到它。
      const hiddenChildRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${directlyTrashedChildId}/restore`,
      });
      assert.equal(hiddenChildRestore.statusCode, 409);
      const childAfterRejectedRestore = await prisma.resourceEntry.findUnique({
        where: { id: directlyTrashedChildId },
        select: { trashedAt: true },
      });
      assert.ok(childAfterRejectedRestore?.trashedAt);
      assert.equal(await prisma.auditLog.count({
        where: {
          action: "resource_restore",
          resourceId: directlyTrashedChildId,
        },
      }), 0);

      const parentRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${childFolderId}/restore`,
      });
      assert.equal(parentRestore.statusCode, 200);
      const childRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${directlyTrashedChildId}/restore`,
      });
      assert.equal(childRestore.statusCode, 200);
      assert.equal(await prisma.auditLog.count({
        where: {
          action: "resource_restore",
          resourceId: directlyTrashedChildId,
        },
      }), 1);

      const rootProject = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "根级恢复测试" },
      });
      const rootProjectId = String(dataOf(rootProject.json()).id);
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${rootProjectId}/trash`,
      });
      const rootRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${rootProjectId}/restore`,
      });
      assert.equal(rootRestore.statusCode, 200);
      const duplicateRootRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${rootProjectId}/restore`,
      });
      assert.equal(duplicateRootRestore.statusCode, 400);
      assert.equal(await prisma.auditLog.count({
        where: { action: "resource_restore", resourceId: rootProjectId },
      }), 1);
    });

    await suite.test("统一媒体上传、校验、配额补偿和受保护 Range", async () => {
      const content = minimalMp4();
      const initialFileCount = await prisma.fileObject.count();
      const upload = await multipartUpload(
        app,
        adminToken,
        projectId,
        "sample.mp4",
        "video/mp4",
        content,
      );
      assert.equal(upload.statusCode, 200, upload.body);
      const mediaResourceId = String(dataOf(upload.json()).id);
      const media = await prisma.mediaFile.findUniqueOrThrow({
        where: { resourceId: mediaResourceId },
        include: { file: true },
      });
      const fileId = media.fileId;
      assert.equal(media.file.mimeType, "video/mp4");
      assert.equal(media.file.size, content.length);
      assert.equal(await prisma.fileObject.count(), initialFileCount + 1);

      // 旧两段式入口必须消失，防止浏览器或第三方继续制造无资源引用的 FileObject。
      const legacyUpload = await app.inject({
        method: "POST",
        url: "/api/files/upload",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(legacyUpload.statusCode, 404);
      const legacyImport = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/media-files",
        payload: { parentId: projectId, fileId },
      });
      assert.equal(legacyImport.statusCode, 404);

      const range = await app.inject({
        method: "GET",
        url: `/api/files/${fileId}/content`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          range: "bytes=2-5",
        },
      });
      assert.equal(range.statusCode, 206);
      assert.equal(
        range.headers["content-range"],
        `bytes 2-5/${content.length}`,
      );
      assert.deepEqual(range.rawPayload, content.subarray(2, 6));

      const suffixRange = await app.inject({
        method: "GET",
        url: `/api/files/${fileId}/content`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          range: "bytes=-4",
        },
      });
      assert.equal(suffixRange.statusCode, 206);
      assert.deepEqual(suffixRange.rawPayload, content.subarray(-4));

      const invalidRange = await app.inject({
        method: "GET",
        url: `/api/files/${fileId}/content`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          range: "bytes=99-100",
        },
      });
      assert.equal(invalidRange.statusCode, 416);

      const denied = await app.inject({
        method: "GET",
        url: `/api/files/${fileId}/content`,
        headers: { authorization: `Bearer ${taToken}` },
      });
      assert.equal(denied.statusCode, 403);

      const storedPath = path.join(storageRoot, media.file.storageKey);
      assert.deepEqual(await readFile(storedPath), content);

      // 无权限必须在读取流和落盘前失败；存储对象与数据库行均保持不变。
      const storedBeforeDenied = await storage.listStoredObjects();
      const privateProject = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "媒体上传私有目标" },
      });
      const privateProjectId = String(dataOf(privateProject.json()).id);
      const deniedUpload = await multipartUpload(
        app,
        studentToken,
        privateProjectId,
        "denied.mp4",
        "video/mp4",
        content,
      );
      assert.equal(deniedUpload.statusCode, 403);
      assert.equal((await storage.listStoredObjects()).length, storedBeforeDenied.length);
      assert.equal(await prisma.fileObject.count(), initialFileCount + 1);

      // 空文件、文本伪装和签名扩展冲突都不能留下暂存或最终对象。
      for (const invalid of [
        { name: "empty.mp4", content: Buffer.alloc(0) },
        { name: "fake.mp4", content: Buffer.from("not-media") },
        { name: "wrong.wav", content },
      ]) {
        const response = await multipartUpload(
          app,
          adminToken,
          projectId,
          invalid.name,
          "video/mp4",
          invalid.content,
        );
        assert.equal(response.statusCode, 400, response.body);
      }
      assert.equal((await storage.listStoredObjects()).length, storedBeforeDenied.length);

      // multipart 与存储层共享单文件上限；超限响应稳定为 413 且无残留。
      const oversized = await multipartUpload(
        app,
        adminToken,
        projectId,
        "large.mp4",
        "video/mp4",
        Buffer.concat([content, Buffer.alloc(41)]),
      );
      assert.equal(oversized.statusCode, 413, oversized.body);
      assert.equal((oversized.json() as JsonObject).error instanceof Object, true);
      assert.equal((await storage.listStoredObjects()).length, storedBeforeDenied.length);

      // 第二个合法对象会超过账号配额；二进制已发布但事务拒绝后必须被补偿删除。
      const quotaExceeded = await multipartUpload(
        app,
        adminToken,
        projectId,
        "quota.mp4",
        "video/mp4",
        Buffer.concat([content, Buffer.alloc(40)]),
      );
      assert.equal(quotaExceeded.statusCode, 409, quotaExceeded.body);
      assert.equal(await prisma.fileObject.count(), initialFileCount + 1);
      assert.equal((await storage.listStoredObjects()).length, storedBeforeDenied.length);

      // 两个并发上传都基于同一旧使用量时，配额 advisory lock 必须只允许其中一个提交。
      const concurrentUploads = await Promise.all([
        multipartUpload(
          app,
          adminToken,
          projectId,
          "concurrent-a.mp4",
          "video/mp4",
          content,
        ),
        multipartUpload(
          app,
          adminToken,
          projectId,
          "concurrent-b.mp4",
          "video/mp4",
          content,
        ),
      ]);
      assert.deepEqual(
        concurrentUploads.map((response) => response.statusCode).sort(),
        [200, 409],
      );
      assert.equal(await prisma.fileObject.count(), initialFileCount + 2);
      assert.equal(
        (await storage.listStoredObjects()).length,
        storedBeforeDenied.length + 1,
      );
    });

    await suite.test("对象生命周期审计只清理过期确定孤儿", async () => {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { accountName: "admin" },
      });
      const oldDate = new Date(Date.now() - 10_000);
      const writeStoredObject = async (storageKey: string, content: Buffer, old: boolean) => {
        const absolutePath = path.join(storageRoot, storageKey);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content);
        if (old) await utimes(absolutePath, oldDate, oldDate);
      };

      await writeStoredObject("orphan/old.mp4", minimalMp4(), true);
      await writeStoredObject("orphan/fresh.mp4.upload-test", minimalMp4(), false);
      await writeStoredObject("orphan/unreferenced.mp4", minimalMp4(), true);
      const unreferenced = await prisma.fileObject.create({
        data: {
          name: "unreferenced.mp4",
          mimeType: "video/mp4",
          size: 24,
          storageKey: "orphan/unreferenced.mp4",
          ownerUserId: admin.id,
          createdAt: oldDate,
        },
      });
      const missing = await prisma.fileObject.create({
        data: {
          name: "missing.mp4",
          mimeType: "video/mp4",
          size: 24,
          storageKey: "orphan/missing.mp4",
          ownerUserId: admin.id,
          createdAt: oldDate,
        },
      });
      const missingResource = await prisma.resourceEntry.create({
        data: {
          parentId: projectId,
          type: "media_file",
          name: "缺失二进制.mp4",
          ownerUserId: admin.id,
          mediaFile: {
            create: { fileId: missing.id, mimeType: "video/mp4", size: 24 },
          },
        },
      });

      const denied = await jsonRequest(app, taToken, {
        method: "GET",
        url: "/api/admin/storage/orphans",
      });
      assert.equal(denied.statusCode, 403);
      const reportResponse = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/admin/storage/orphans",
      });
      assert.equal(reportResponse.statusCode, 200, reportResponse.body);
      const report = dataOf(reportResponse.json());
      const items = report.items as JsonObject[];
      assert.ok(items.some((item) =>
        item.category === "orphan_binary" && item.cleanupEligible === true));
      assert.ok(items.some((item) =>
        item.category === "staged_binary" && item.cleanupEligible === false));
      assert.ok(items.some((item) =>
        item.category === "unreferenced_file" && item.fileId === unreferenced.id));
      assert.ok(items.some((item) =>
        item.category === "missing_binary" && item.fileId === missing.id));

      const missingConfirm = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/admin/storage/orphans/cleanup",
        payload: { confirm: false },
      });
      assert.equal(missingConfirm.statusCode, 400);
      const cleanup = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/admin/storage/orphans/cleanup",
        payload: { confirm: true },
      });
      assert.equal(cleanup.statusCode, 200, cleanup.body);
      assert.equal(await prisma.fileObject.findUnique({
        where: { id: unreferenced.id },
      }), null);
      assert.ok(await prisma.fileObject.findUnique({ where: { id: missing.id } }));
      assert.ok(await prisma.resourceEntry.findUnique({ where: { id: missingResource.id } }));
      await assert.rejects(access(path.join(storageRoot, "orphan/old.mp4")));
      await assert.rejects(access(path.join(storageRoot, "orphan/unreferenced.mp4")));
      await access(path.join(storageRoot, "orphan/fresh.mp4.upload-test"));
      assert.equal(await prisma.auditLog.count({
        where: { action: "storage_orphan_cleanup" },
      }), 1);
    });

    await suite.test("审计日志分页、筛选、授权与 CSV 导出", async () => {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { accountName: "admin" },
      });
      const student = await prisma.user.findUniqueOrThrow({
        where: { accountName: "student" },
      });
      const auditProject = await prisma.resourceEntry.create({
        data: {
          id: "audit-filter-project",
          name: "=审计公式测试",
          type: "project",
          ownerUserId: admin.id,
        },
      });
      const sharedTime = new Date("2026-08-03T06:00:00.000Z");
      await prisma.auditLog.createMany({
        data: ["a", "b", "c"].map((suffix, index) => ({
          id: `audit-page-${suffix}`,
          action: "permission_denied" as const,
          actorUserId: admin.id,
          resourceId: auditProject.id,
          targetUserId: student.id,
          detail: { formula: "=SUM(A1)", order: index },
          createdAt: sharedTime,
        })),
      });

      // 普通账号既不能读取全局审计，也不能在尚未授权时读取资源范围审计。
      const forbiddenGlobal = await jsonRequest(app, studentToken, {
        method: "GET",
        url: "/api/audit-logs",
      });
      assert.equal(forbiddenGlobal.statusCode, 403);
      const forbiddenResource = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/audit-logs?resourceId=${auditProject.id}`,
      });
      assert.equal(forbiddenResource.statusCode, 403);

      const query = new URLSearchParams({
        resourceId: auditProject.id,
        actorUserId: admin.id,
        targetUserId: student.id,
        action: "permission_denied",
        createdFrom: sharedTime.toISOString(),
        createdTo: sharedTime.toISOString(),
        limit: "2",
      });
      const firstPageResponse = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/audit-logs?${query}`,
      });
      assert.equal(firstPageResponse.statusCode, 200, firstPageResponse.body);
      const firstPage = dataOf(firstPageResponse.json());
      assert.deepEqual(
        (firstPage.items as JsonObject[]).map(({ id }) => id),
        ["audit-page-c", "audit-page-b"],
      );
      assert.equal(
        ((firstPage.items as JsonObject[])[0]!.actor as JsonObject).accountName,
        "admin",
      );
      assert.equal(
        ((firstPage.items as JsonObject[])[0]!.targetUser as JsonObject).accountName,
        "student",
      );
      assert.equal(
        ((firstPage.items as JsonObject[])[0]!.resource as JsonObject).name,
        "=审计公式测试",
      );
      assert.equal(
        "passwordHash" in ((firstPage.items as JsonObject[])[0]!.actor as JsonObject),
        false,
      );

      // 同毫秒日志依靠 id 倒序稳定续页，跨筛选 cursor 则必须拒绝。
      const cursor = String(firstPage.nextCursor);
      const secondPageResponse = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/audit-logs?${query}&cursor=${encodeURIComponent(cursor)}`,
      });
      assert.deepEqual(
        (dataOf(secondPageResponse.json()).items as JsonObject[]).map(({ id }) => id),
        ["audit-page-a"],
      );
      assert.equal(dataOf(secondPageResponse.json()).nextCursor, null);
      const mismatchedCursor = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/audit-logs?action=resource_move&cursor=${encodeURIComponent(cursor)}`,
      });
      assert.equal(mismatchedCursor.statusCode, 400);

      // 直接资源授权后，非全局管理员只能读取该资源范围的同一结果集。
      await prisma.resourcePermission.create({
        data: {
          resourceId: auditProject.id,
          userId: student.id,
          capabilities: ["manage_permissions"],
          createdBy: admin.id,
        },
      });
      const scopedAllowed = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/audit-logs?${query}`,
      });
      assert.equal(scopedAllowed.statusCode, 200, scopedAllowed.body);

      // CSV 与列表共用筛选，返回导出元数据并把资源名公式前缀转为纯文本。
      const exportResponse = await app.inject({
        method: "GET",
        url: `/api/audit-logs/export?${query}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(exportResponse.statusCode, 200, exportResponse.body);
      assert.match(exportResponse.headers["content-type"] ?? "", /text\/csv/);
      assert.match(exportResponse.headers["content-disposition"] ?? "", /attachment/);
      assert.equal(exportResponse.headers["x-audit-export-count"], "3");
      assert.equal(exportResponse.headers["x-audit-export-truncated"], "false");
      assert.ok(exportResponse.body.startsWith("\uFEFF\"时间\""));
      assert.match(exportResponse.body, /"'=审计公式测试"/);
    });

    await suite.test("治理接口坏输入和 operation revision 冲突", async () => {
      const badLimit = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/audit-logs?limit=1.5",
      });
      assert.equal(badLimit.statusCode, 400);

      // 审计筛选必须在 Router/Repository 边界拒绝未知动作、宽松日期和倒置范围。
      const badAuditAction = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/audit-logs?action=unknown_action",
      });
      assert.equal(badAuditAction.statusCode, 400);
      const badAuditTime = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/audit-logs?createdFrom=2026-08-03",
      });
      assert.equal(badAuditTime.statusCode, 400);
      const reversedAuditTime = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/audit-logs?createdFrom=2026-08-03T02%3A00%3A00.000Z&createdTo=2026-08-03T01%3A00%3A00.000Z",
      });
      assert.equal(reversedAuditTime.statusCode, 400);

      const badOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: { baseRevision: -1, action: "" },
      });
      assert.equal(badOperation.statusCode, 400);

      // 未知 action、损坏领域 envelope 和 legacy action 夹带 envelope 均在写库前 fail closed。
      const validTimingEnvelope = {
        version: 1,
        command: {
          type: "timeline.items.timing.update",
          items: [{
            entityType: "character",
            entityId: "char-1",
            before: { startTime: 1, endTime: 2 },
            after: { startTime: 2, endTime: 3 },
          }],
        },
      };
      for (const invalidPayload of [
        { action: "unknown.action", payload: validTimingEnvelope },
        {
          action: "timeline.items.timing.update",
          payload: { ...validTimingEnvelope, version: 2 },
        },
        { action: "project.commit", payload: validTimingEnvelope },
        {
          action: "timeline.items.timing.update",
          payload: {
            version: 1,
            command: {
              type: "annotation.items.content.update",
              items: [{
                entityType: "character",
                entityId: "char-1",
                field: "char",
                before: "甲",
                after: "乙",
              }],
            },
          },
        },
      ]) {
        const invalidOperation = await jsonRequest(app, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${annotationFileId}/operations`,
          payload: {
            clientOperationId: `op-invalid-${invalidPayload.action}`,
            baseRevision: 1,
            localRevision: 2,
            ...invalidPayload,
          },
        });
        assert.equal(invalidOperation.statusCode, 400);
      }

      const staleOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          clientOperationId: "op-stale-revision",
          baseRevision: 1,
          localRevision: 2,
          action: "project.commit",
          payload: { historyAction: "edit" },
        },
      });
      assert.equal(staleOperation.statusCode, 409);
      assert.equal(
        await prisma.annotationOperation.count({
          where: { annotationFileId },
        }),
        0,
      );

      // 首次 operation 使用当前 revision；相同请求重放必须返回同一服务端 id，不能重复落行。
      const currentFile = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: annotationFileId },
      });
      const replayRequest = {
        clientOperationId: "op-idempotent-replay",
        baseRevision: currentFile.revision,
        localRevision: 10,
        action: "timeline.items.timing.update",
        payload: validTimingEnvelope,
      };
      const firstOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: replayRequest,
      });
      const replayedOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: replayRequest,
      });
      assert.equal(firstOperation.statusCode, 200, firstOperation.body);
      assert.equal(replayedOperation.statusCode, 200, replayedOperation.body);
      assert.equal(dataOf(firstOperation.json()).id, dataOf(replayedOperation.json()).id);
      assert.equal(dataOf(firstOperation.json()).clientOperationId, replayRequest.clientOperationId);
      assert.equal(dataOf(firstOperation.json()).sequence, 1);
      assert.equal(dataOf(replayedOperation.json()).sequence, 1);
      assert.equal(dataOf(firstOperation.json()).replayability, "domain_command");
      assert.equal(await prisma.annotationOperation.count({
        where: { annotationFileId },
      }), 1);

      // 完整保存推进服务器 revision 后，已接受 operation 的迟到重放仍返回原事实。
      const revisionAdvance = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${annotationFileId}`,
        payload: {
          baseRevision: currentFile.revision,
          payload: currentFile.payload,
        },
      });
      assert.equal(revisionAdvance.statusCode, 200, revisionAdvance.body);
      const replayAfterSave = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: replayRequest,
      });
      assert.equal(replayAfterSave.statusCode, 200, replayAfterSave.body);
      assert.equal(dataOf(replayAfterSave.json()).id, dataOf(firstOperation.json()).id);
      assert.equal(dataOf(replayAfterSave.json()).sequence, 1);

      // 同 key 但 payload 不同属于幂等冲突；新 key 使用旧 revision 则仍是普通 revision 冲突。
      const mismatchedReplay = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          ...replayRequest,
          payload: {
            ...replayRequest.payload,
            command: {
              ...replayRequest.payload.command,
              items: [{
                ...replayRequest.payload.command.items[0],
                after: { startTime: 3, endTime: 4 },
              }],
            },
          },
        },
      });
      assert.equal(mismatchedReplay.statusCode, 409);
      const mismatchError = (mismatchedReplay.json() as JsonObject).error as JsonObject;
      assert.equal((mismatchError.details as JsonObject).code, "idempotency_conflict");
      const staleNewKey = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: { ...replayRequest, clientOperationId: "op-new-but-stale" },
      });
      assert.equal(staleNewKey.statusCode, 409);

      // 数据库唯一约束让两个并发相同请求收敛为一行并返回相同 id。
      const latestRevision = Number(dataOf(revisionAdvance.json()).revision);
      const concurrentRequest = {
        ...replayRequest,
        clientOperationId: "op-concurrent-replay",
        baseRevision: latestRevision,
        localRevision: 11,
      };
      const [concurrentLeft, concurrentRight] = await Promise.all([
        jsonRequest(app, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${annotationFileId}/operations`,
          payload: concurrentRequest,
        }),
        jsonRequest(app, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${annotationFileId}/operations`,
          payload: concurrentRequest,
        }),
      ]);
      assert.equal(concurrentLeft.statusCode, 200, concurrentLeft.body);
      assert.equal(concurrentRight.statusCode, 200, concurrentRight.body);
      assert.equal(dataOf(concurrentLeft.json()).id, dataOf(concurrentRight.json()).id);
      assert.equal(dataOf(concurrentLeft.json()).sequence, 2);
      assert.equal(dataOf(concurrentRight.json()).sequence, 2);

      // 幂等作用域包含 actor；给学生临时 write 后，相同 client key 生成其自己的 operation。
      await prisma.resourcePermission.update({
        where: {
          resourceId_userId: {
            resourceId: annotationFileId,
            userId: "user-student",
          },
        },
        data: { capabilities: ["read", "copy", "write"] },
      });
      const studentOperation = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: concurrentRequest,
      });
      assert.equal(studentOperation.statusCode, 200, studentOperation.body);
      assert.notEqual(dataOf(studentOperation.json()).id, dataOf(concurrentLeft.json()).id);
      assert.equal(dataOf(studentOperation.json()).sequence, 3);

      // 同一文件的不同并发请求必须在文件行锁内顺序分配游标，不能得到重复或跳号序列。
      const concurrentDistinctRequests = ["left", "right"].map((suffix, index) => ({
        ...replayRequest,
        clientOperationId: `op-concurrent-distinct-${suffix}`,
        baseRevision: latestRevision,
        localRevision: 20 + index,
      }));
      const concurrentDistinctResults = await Promise.all(
        concurrentDistinctRequests.map((payload) => jsonRequest(app, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${annotationFileId}/operations`,
          payload,
        })),
      );
      for (const response of concurrentDistinctResults) {
        assert.equal(response.statusCode, 200, response.body);
      }
      assert.deepEqual(
        concurrentDistinctResults
          .map((response) => Number(dataOf(response.json()).sequence))
          .sort((left, right) => left - right),
        [4, 5],
      );

      // 旧式 project.commit 仍可审计，但服务端必须声明它不能作为领域命令重放。
      const legacyOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          clientOperationId: "op-legacy-snapshot-only",
          baseRevision: latestRevision,
          localRevision: 30,
          action: "project.commit",
          payload: { historyAction: "legacy edit" },
        },
      });
      assert.equal(legacyOperation.statusCode, 200, legacyOperation.body);
      assert.equal(dataOf(legacyOperation.json()).sequence, 6);
      assert.equal(dataOf(legacyOperation.json()).replayability, "requires_snapshot");

      // 顺序游标按固定页长追赶操作，跨页不得重复、漏项或改变文件作用域。
      const firstOperationPage = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/operations?limit=2`,
      });
      assert.equal(firstOperationPage.statusCode, 200, firstOperationPage.body);
      const firstPageData = dataOf(firstOperationPage.json());
      assert.deepEqual(
        (firstPageData.items as JsonObject[]).map((item) => item.sequence),
        [1, 2],
      );
      assert.equal(firstPageData.hasMore, true);
      assert.equal(typeof firstPageData.nextCursor, "string");

      const secondOperationPage = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/operations?limit=2&cursor=${encodeURIComponent(String(firstPageData.nextCursor))}`,
      });
      assert.equal(secondOperationPage.statusCode, 200, secondOperationPage.body);
      const secondPageData = dataOf(secondOperationPage.json());
      assert.deepEqual(
        (secondPageData.items as JsonObject[]).map((item) => item.sequence),
        [3, 4],
      );
      assert.equal(secondPageData.hasMore, true);

      const thirdOperationPage = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/operations?limit=2&cursor=${encodeURIComponent(String(secondPageData.nextCursor))}`,
      });
      assert.equal(thirdOperationPage.statusCode, 200, thirdOperationPage.body);
      const thirdPageData = dataOf(thirdOperationPage.json());
      assert.deepEqual(
        (thirdPageData.items as JsonObject[]).map((item) => item.sequence),
        [5, 6],
      );
      assert.equal(thirdPageData.hasMore, false);
      assert.equal((thirdPageData.items as JsonObject[])[1]?.replayability, "requires_snapshot");

      // 游标损坏与权限撤销都必须 fail closed，不能泄露同文件的操作历史。
      const badOperationCursor = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/operations?cursor=not-a-cursor`,
      });
      assert.equal(badOperationCursor.statusCode, 400);
      await prisma.resourcePermission.update({
        where: {
          resourceId_userId: {
            resourceId: annotationFileId,
            userId: "user-student",
          },
        },
        data: { capabilities: [] },
      });
      await prisma.resourceEntry.update({
        where: { id: annotationFileId },
        data: { breakPermissionInheritance: true },
      });
      const forbiddenOperationPage = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${annotationFileId}/operations`,
      });
      assert.equal(forbiddenOperationPage.statusCode, 403);
      await prisma.resourceEntry.update({
        where: { id: annotationFileId },
        data: { breakPermissionInheritance: false },
      });
      assert.equal(await prisma.annotationOperation.count({
        where: { annotationFileId },
      }), 6);

      // 新的内容命令与 timing 命令使用同一严格 envelope/action 合同，并可被 committed feed 声明为可重放。
      const contentOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          clientOperationId: "op-content-domain-command",
          baseRevision: latestRevision,
          localRevision: 31,
          action: "annotation.items.content.update",
          payload: {
            version: 1,
            command: {
              type: "annotation.items.content.update",
              items: [{
                entityType: "character",
                entityId: "char-content-api",
                field: "char",
                before: "甲",
                after: "乙",
              }],
            },
          },
        },
      });
      assert.equal(contentOperation.statusCode, 200, contentOperation.body);
      assert.equal(dataOf(contentOperation.json()).sequence, 7);
      assert.equal(dataOf(contentOperation.json()).replayability, "domain_command");

      // 生命周期命令通过同一 parser 进入日志；实体快照和位置事实完整合法时才标记可重放。
      const lifecycleOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          clientOperationId: "op-lifecycle-domain-command",
          baseRevision: latestRevision,
          localRevision: 32,
          action: "annotation.items.lifecycle.update",
          payload: {
            version: 1,
            command: {
              type: "annotation.items.lifecycle.update",
              items: [{
                entityType: "attached-point",
                entityId: "point-api-created",
                trackId: "point-track-api",
                before: null,
                after: {
                  entity: { id: "point-api-created", time: 2, label: "呼吸" },
                  position: {
                    index: 0,
                    collectionLength: 1,
                    previousEntityId: null,
                    nextEntityId: null,
                  },
                },
              }],
            },
          },
        },
      });
      assert.equal(lifecycleOperation.statusCode, 200, lifecycleOperation.body);
      assert.equal(dataOf(lifecycleOperation.json()).sequence, 8);
      assert.equal(dataOf(lifecycleOperation.json()).replayability, "domain_command");

      // 事务 action 只包装严格叶命令；服务端按一个 operation 接受并等待完整 payload 保存时绑定 revision。
      const transactionOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          clientOperationId: "op-transaction-domain-command",
          baseRevision: latestRevision,
          localRevision: 33,
          action: "annotation.transaction.apply",
          payload: {
            version: 1,
            command: {
              type: "annotation.transaction.apply",
              commands: [{
                type: "annotation.items.content.update",
                items: [{
                  entityType: "sentence",
                  entityId: "line-transaction-api",
                  field: "text",
                  before: "甲",
                  after: "甲乙",
                }],
              }],
            },
          },
        },
      });
      assert.equal(transactionOperation.statusCode, 200, transactionOperation.body);
      assert.equal(dataOf(transactionOperation.json()).sequence, 9);
      assert.equal(dataOf(transactionOperation.json()).replayability, "domain_command");

      // 复合状态命令与其他领域命令共用幂等接收链；服务端严格校验完整 before/after 快照。
      const stateOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          clientOperationId: "op-state-domain-command",
          baseRevision: latestRevision,
          localRevision: 34,
          action: "annotation.items.state.update",
          payload: {
            version: 1,
            command: {
              type: "annotation.items.state.update",
              items: [{
                entityType: "gongche-symbol",
                entityId: "symbol-state-api",
                trackId: "gongche-state-api",
                before: {
                  id: "symbol-state-api", label: "上", notation: null, rawText: "上", parenthesized: false,
                  startTime: 1, endTime: 2, assetUrl: null,
                },
                after: {
                  id: "symbol-state-api", label: "尺", notation: "4/", rawText: "尺4/", parenthesized: false,
                  startTime: 1, endTime: 2, assetUrl: null,
                },
              }],
            },
          },
        },
      });
      assert.equal(stateOperation.statusCode, 200, stateOperation.body);
      assert.equal(dataOf(stateOperation.json()).sequence, 10);
      assert.equal(dataOf(stateOperation.json()).replayability, "domain_command");

      const invalidStateOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          clientOperationId: "op-state-invalid",
          baseRevision: latestRevision,
          localRevision: 35,
          action: "annotation.items.state.update",
          payload: {
            version: 1,
            command: {
              type: "annotation.items.state.update",
              items: [{
                entityType: "gongche-symbol",
                entityId: "symbol-state-api",
                trackId: "gongche-state-api",
                before: {
                  id: "symbol-state-api", label: "上", notation: null, rawText: "上", parenthesized: false,
                  startTime: 1, endTime: 2, assetUrl: null,
                },
                after: {
                  id: "different-symbol", label: "尺", notation: null, rawText: "尺", parenthesized: false,
                  startTime: 1, endTime: 2, assetUrl: null,
                },
              }],
            },
          },
        },
      });
      assert.equal(invalidStateOperation.statusCode, 400);

      const invalidLifecycleOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          clientOperationId: "op-lifecycle-invalid",
          baseRevision: latestRevision,
          localRevision: 36,
          action: "annotation.items.lifecycle.update",
          payload: {
            version: 1,
            command: {
              type: "annotation.items.lifecycle.update",
              items: [{
                entityType: "attached-point",
                entityId: "point-api-created",
                trackId: "point-track-api",
                before: null,
                after: null,
              }],
            },
          },
        },
      });
      assert.equal(invalidLifecycleOperation.statusCode, 400);

      const invalidJob = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/processing-jobs",
        payload: { type: "unknown_job", inputFileIds: [] },
      });
      assert.equal(invalidJob.statusCode, 400);
      const missingInput = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/processing-jobs",
        payload: {
          type: "pitch_extraction",
          inputFileIds: ["missing-file"],
        },
      });
      assert.equal(missingInput.statusCode, 404);

      const auditLogs = await prisma.auditLog.findMany();
      assert.ok(auditLogs.length > 0);
      assert.ok(auditLogs.every(({ detail }) =>
        !detail || !("payload" in (detail as JsonObject))));
    });

    await suite.test("结构变更租约跨账号阻断写入并在成功保存时原子释放", async () => {
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "mutation-lease-test.json",
          payload: { marker: "revision-1" },
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const fileId = String((dataOf(created.json()).resource as JsonObject).id);
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${fileId}/permissions/user-student`,
        payload: { capabilities: ["read", "write"], inheritToChildren: false },
      });

      const acquired = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { baseRevision: 1, purpose: "track_structure" },
      });
      assert.equal(acquired.statusCode, 200, acquired.body);
      const grant = dataOf(acquired.json());
      const leaseToken = String(grant.token);
      assert.match(leaseToken, /^xiqu_lease_/);
      assert.equal(grant.purpose, "track_structure");

      const visibleToStudent = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
      });
      assert.equal(visibleToStudent.statusCode, 200, visibleToStudent.body);
      assert.equal(dataOf(visibleToStudent.json()).holder instanceof Object, true);
      assert.equal("token" in dataOf(visibleToStudent.json()), false);

      const competingAcquire = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { baseRevision: 1, purpose: "bulk_import" },
      });
      assert.equal(competingAcquire.statusCode, 409);

      const operationWithoutToken = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-op-without-token",
          baseRevision: 1,
          action: "project.commit",
          payload: { historyAction: "track-structure" },
        },
      });
      assert.equal(operationWithoutToken.statusCode, 409);
      assert.equal((errorOf(operationWithoutToken.json()).details as JsonObject).code, "annotation_mutation_lease_required");

      const wrongUserOperation = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-op-wrong-user",
          baseRevision: 1,
          action: "project.commit",
          payload: { historyAction: "track-structure" },
          mutationLeaseToken: leaseToken,
        },
      });
      assert.equal(wrongUserOperation.statusCode, 409);

      const renewed = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { token: leaseToken },
      });
      assert.equal(renewed.statusCode, 200, renewed.body);
      assert.equal(String(dataOf(renewed.json()).token), leaseToken);

      const structureBefore = {
        id: "custom-track-one",
        trackType: "action",
        name: "动作轨",
        color: null,
        typeOptions: ["动作"],
        attachedPointTracksExpanded: null,
        snapToWaveformKeypoints: null,
        autoSetLoopRangeOnSelect: null,
        branching: null,
        blocks: [],
      };
      const acceptedOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-op-accepted",
          baseRevision: 1,
          action: "annotation.track.structure.update",
          payload: {
            version: 1,
            command: {
              type: "annotation.track.structure.update",
              items: [{
                trackId: "custom-track-one",
                before: structureBefore,
                after: { ...structureBefore, name: "动作轨（已改名）" },
              }],
            },
          },
          mutationLeaseToken: leaseToken,
        },
      });
      assert.equal(acceptedOperation.statusCode, 200, acceptedOperation.body);

      const blockedSave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${fileId}`,
        payload: { baseRevision: 1, payload: { marker: "blocked" }, clientOperationIds: [] },
      });
      assert.equal(blockedSave.statusCode, 409);
      assert.equal(await prisma.annotationMutationLease.count({ where: { annotationFileId: fileId } }), 1);

      const failedControlledSave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${fileId}`,
        payload: {
          baseRevision: 1,
          payload: { marker: "must-roll-back" },
          clientOperationIds: ["missing-lease-operation"],
          mutationLeaseToken: leaseToken,
        },
      });
      assert.equal(failedControlledSave.statusCode, 409);
      assert.equal(await prisma.annotationMutationLease.count({ where: { annotationFileId: fileId } }), 1);
      assert.equal((await prisma.annotationFile.findUniqueOrThrow({ where: { resourceId: fileId } })).revision, 1);

      const saved = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${fileId}`,
        payload: {
          baseRevision: 1,
          payload: { marker: "revision-2" },
          clientOperationIds: ["lease-op-accepted"],
          mutationLeaseToken: leaseToken,
        },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(dataOf(saved.json()).revision, 2);
      assert.equal(await prisma.annotationMutationLease.count({ where: { annotationFileId: fileId } }), 0);

      // 普通内容操作在没有活动租约时保持旧行为；结构命令则必须主动取得租约，不能偷偷降级为普通写入。
      const normalOperationWithoutLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-normal-operation-without-token",
          baseRevision: 2,
          action: "project.commit",
          payload: { historyAction: "ordinary-content" },
        },
      });
      assert.equal(normalOperationWithoutLease.statusCode, 200, normalOperationWithoutLease.body);
      const structureOperationWithoutLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-structure-operation-without-token",
          baseRevision: 2,
          action: "annotation.track.structure.update",
          payload: {
            version: 1,
            command: {
              type: "annotation.track.structure.update",
              items: [{
                trackId: "custom-track-one",
                before: structureBefore,
                after: { ...structureBefore, name: "动作轨（已改名）" },
              }],
            },
          },
        },
      });
      assert.equal(structureOperationWithoutLease.statusCode, 409, structureOperationWithoutLease.body);
      assert.equal(
        (errorOf(structureOperationWithoutLease.json()).details as JsonObject).code,
        "annotation_mutation_lease_required",
      );

      const secondLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { baseRevision: 2, purpose: "bulk_repair" },
      });
      const secondToken = String(dataOf(secondLease.json()).token);
      const recoverySnapshot = await prisma.annotationRecoverySnapshot.findFirstOrThrow({
        where: { annotationFileId: fileId, revision: 1 },
      });
      const blockedRestore = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/recovery-snapshots/${recoverySnapshot.id}/restore`,
        payload: { baseRevision: 2 },
      });
      assert.equal(blockedRestore.statusCode, 409);
      const released = await jsonRequest(app, adminToken, {
        method: "DELETE",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { token: secondToken },
      });
      assert.equal(released.statusCode, 204, released.body);

      const thirdLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { baseRevision: 2, purpose: "bulk_import" },
      });
      const thirdToken = String(dataOf(thirdLease.json()).token);
      await prisma.annotationMutationLease.update({
        where: { annotationFileId: fileId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      const takeover = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { baseRevision: 2, purpose: "track_structure" },
      });
      assert.equal(takeover.statusCode, 200, takeover.body);
      assert.notEqual(String(dataOf(takeover.json()).token), thirdToken);
      const staleTokenWrite = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-op-stale-token",
          baseRevision: 2,
          action: "project.commit",
          payload: { historyAction: "track-structure" },
          mutationLeaseToken: thirdToken,
        },
      });
      assert.equal(staleTokenWrite.statusCode, 409);

      const leaseAudits = await prisma.auditLog.findMany({
        where: {
          resourceId: fileId,
          action: { in: [
            "annotation_mutation_lease_acquire",
            "annotation_mutation_lease_renew",
            "annotation_mutation_lease_release",
          ] },
        },
      });
      assert.ok(leaseAudits.length >= 5);
      assert.ok(leaseAudits.every((row) => !JSON.stringify(row.detail).includes("xiqu_lease_")));
    });

    await suite.test("operation 与快照 revision 原子绑定并按提交顺序续读", async () => {
      // 独立文件避免前一组 acceptance-feed 测试的历史行影响 committed 游标断言。
      const createdFileResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "operation-commit-test.json",
          payload: { marker: "revision-1" },
        },
      });
      assert.equal(createdFileResponse.statusCode, 200, createdFileResponse.body);
      const createdFile = dataOf(createdFileResponse.json());
      const commitFileId = String((createdFile.resource as JsonObject).id);
      const revisionOneCursor = String(createdFile.operationCursor);

      const timingEnvelope = {
        version: 1,
        command: {
          type: "timeline.items.timing.update",
          items: [{
            entityType: "character",
            entityId: "commit-char-1",
            before: { startTime: 1, endTime: 2 },
            after: { startTime: 2, endTime: 3 },
          }],
        },
      };
      const createOperation = (token: string, clientOperationId: string, baseRevision: number, legacy = false) =>
        jsonRequest(app, token, {
          method: "POST",
          url: `/api/annotation-files/${commitFileId}/operations`,
          payload: {
            clientOperationId,
            baseRevision,
            localRevision: baseRevision + 10,
            action: legacy ? "project.commit" : "timeline.items.timing.update",
            payload: legacy ? { historyAction: "edit" } : timingEnvelope,
          },
        });

      // POST 只表示日志接收；没有成功保存前不得伪装成 committed。
      const operationA = await createOperation(adminToken, "commit-op-a", 1);
      const orphanOperation = await createOperation(adminToken, "commit-op-orphan", 1);
      assert.equal(operationA.statusCode, 200, operationA.body);
      assert.equal(orphanOperation.statusCode, 200, orphanOperation.body);
      assert.equal(dataOf(operationA.json()).commitState, "accepted");
      assert.equal(dataOf(operationA.json()).committedRevision, null);

      // 保存只绑定明确声明的 A；同 base 的未声明 operation 保持 accepted，形成合法 sequence 空洞。
      const revisionTwoSave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${commitFileId}`,
        payload: {
          baseRevision: 1,
          payload: { marker: "revision-2" },
          clientOperationIds: ["commit-op-a"],
        },
      });
      assert.equal(revisionTwoSave.statusCode, 200, revisionTwoSave.body);
      assert.equal(dataOf(revisionTwoSave.json()).revision, 2);
      const storedA = await prisma.annotationOperation.findFirstOrThrow({
        where: { annotationFileId: commitFileId, clientOperationId: "commit-op-a" },
      });
      const storedOrphan = await prisma.annotationOperation.findFirstOrThrow({
        where: { annotationFileId: commitFileId, clientOperationId: "commit-op-orphan" },
      });
      assert.equal(storedA.committedRevision, 2);
      assert.ok(storedA.committedAt);
      assert.equal(storedOrphan.committedRevision, null);

      // 从 revision 1 的快照 cursor 可读到 A；revision 2 cursor 则应跳过已包含在 payload 中的 A。
      const fromRevisionOne = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${commitFileId}/committed-operations?cursor=${encodeURIComponent(revisionOneCursor)}`,
      });
      assert.equal(fromRevisionOne.statusCode, 200, fromRevisionOne.body);
      assert.deepEqual(
        (dataOf(fromRevisionOne.json()).items as JsonObject[]).map((item) => item.clientOperationId),
        ["commit-op-a"],
      );
      const revisionTwoCursor = String(dataOf(revisionTwoSave.json()).operationCursor);
      const afterRevisionTwo = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${commitFileId}/committed-operations?cursor=${encodeURIComponent(revisionTwoCursor)}`,
      });
      assert.deepEqual(dataOf(afterRevisionTwo.json()).items, []);
      assert.equal(dataOf(afterRevisionTwo.json()).currentRevision, 2);

      // 旧 base 的 orphan 不能被塞进新 revision；失败事务也不能改写 payload 或 revision。
      const staleOrphanSave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${commitFileId}`,
        payload: {
          baseRevision: 2,
          payload: { marker: "must-not-save" },
          clientOperationIds: ["commit-op-orphan"],
        },
      });
      assert.equal(staleOrphanSave.statusCode, 409);
      const afterStaleSave = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${commitFileId}`,
      });
      assert.equal(dataOf(afterStaleSave.json()).revision, 2);
      assert.equal((dataOf(afterStaleSave.json()).payload as JsonObject).marker, "revision-2");

      // sequence 3 的 legacy operation 提交到 revision 3；committed feed 必须越过未提交的 sequence 2。
      const operationC = await createOperation(adminToken, "commit-op-c", 2, true);
      assert.equal(operationC.statusCode, 200, operationC.body);
      const revisionThreeSave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${commitFileId}`,
        payload: {
          baseRevision: 2,
          payload: { marker: "revision-3" },
          clientOperationIds: ["commit-op-c"],
        },
      });
      assert.equal(revisionThreeSave.statusCode, 200, revisionThreeSave.body);
      const afterA = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${commitFileId}/committed-operations?cursor=${encodeURIComponent(String(dataOf(fromRevisionOne.json()).nextCursor))}`,
      });
      const afterAItems = dataOf(afterA.json()).items as JsonObject[];
      assert.deepEqual(afterAItems.map((item) => item.clientOperationId), ["commit-op-c"]);
      assert.equal(afterAItems[0]?.replayability, "requires_snapshot");
      assert.equal(afterAItems[0]?.committedRevision, 3);

      // 账号作用域属于绑定合同：管理员不能把学生的 operation 声明为自己的保存依据。
      await prisma.resourcePermission.upsert({
        where: {
          resourceId_userId: {
            resourceId: commitFileId,
            userId: "user-student",
          },
        },
        update: { capabilities: ["read", "write"] },
        create: {
          resourceId: commitFileId,
          userId: "user-student",
          capabilities: ["read", "write"],
          createdBy: "user-admin",
        },
      });
      const studentOperation = await createOperation(studentToken, "commit-op-student", 3);
      assert.equal(studentOperation.statusCode, 200, studentOperation.body);
      const foreignBinding = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${commitFileId}`,
        payload: {
          baseRevision: 3,
          payload: { marker: "must-not-bind-foreign" },
          clientOperationIds: ["commit-op-student"],
        },
      });
      assert.equal(foreignBinding.statusCode, 409);
      const studentSave = await jsonRequest(app, studentToken, {
        method: "PUT",
        url: `/api/annotation-files/${commitFileId}`,
        payload: {
          baseRevision: 3,
          payload: { marker: "revision-4" },
          clientOperationIds: ["commit-op-student"],
        },
      });
      assert.equal(studentSave.statusCode, 200, studentSave.body);

      // 声明缺失 id 的保存整体失败；相同 operation 随后用同一 base 可成功重试绑定。
      const retryOperation = await createOperation(adminToken, "commit-op-retry", 4);
      assert.equal(retryOperation.statusCode, 200, retryOperation.body);
      const failedRetrySave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${commitFileId}`,
        payload: {
          baseRevision: 4,
          payload: { marker: "must-rollback" },
          clientOperationIds: ["commit-op-retry", "commit-op-missing"],
        },
      });
      assert.equal(failedRetrySave.statusCode, 409);
      const retryRowBefore = await prisma.annotationOperation.findFirstOrThrow({
        where: { annotationFileId: commitFileId, clientOperationId: "commit-op-retry" },
      });
      assert.equal(retryRowBefore.committedRevision, null);
      const successfulRetrySave = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${commitFileId}`,
        payload: {
          baseRevision: 4,
          payload: { marker: "revision-5" },
          clientOperationIds: ["commit-op-retry"],
        },
      });
      assert.equal(successfulRetrySave.statusCode, 200, successfulRetrySave.body);

      // 一项一页按 `(committedRevision, sequence)` 读取 A/C/student/retry，未提交 orphan 永远不混入。
      const committedIds: string[] = [];
      let cursor: string | null = null;
      let hasMore = true;
      while (hasMore) {
        const page = await jsonRequest(app, adminToken, {
          method: "GET",
          url: `/api/annotation-files/${commitFileId}/committed-operations?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        });
        assert.equal(page.statusCode, 200, page.body);
        const pageData = dataOf(page.json());
        committedIds.push(...(pageData.items as JsonObject[]).map((item) => String(item.clientOperationId)));
        cursor = pageData.nextCursor === null ? null : String(pageData.nextCursor);
        hasMore = Boolean(pageData.hasMore);
      }
      assert.deepEqual(committedIds, [
        "commit-op-a",
        "commit-op-c",
        "commit-op-student",
        "commit-op-retry",
      ]);

      // 输入与 ACL 继续 fail closed；关闭继承后学生不能读取 committed feed。
      const duplicateIds = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${commitFileId}`,
        payload: {
          baseRevision: 5,
          payload: {},
          clientOperationIds: ["same-id", "same-id"],
        },
      });
      assert.equal(duplicateIds.statusCode, 400);
      const badCursor = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${commitFileId}/committed-operations?cursor=bad-cursor`,
      });
      assert.equal(badCursor.statusCode, 400);
      await prisma.resourcePermission.update({
        where: {
          resourceId_userId: {
            resourceId: commitFileId,
            userId: "user-student",
          },
        },
        data: { capabilities: [] },
      });
      await prisma.resourceEntry.update({
        where: { id: commitFileId },
        data: { breakPermissionInheritance: true },
      });
      const forbiddenFeed = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${commitFileId}/committed-operations`,
      });
      assert.equal(forbiddenFeed.statusCode, 403);
    });
  } finally {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

async function login(app: FastifyInstance, accountName: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { accountName, password },
  });
  assert.equal(response.statusCode, 200);
  return dataOf(response.json()) as {
    accessToken: string;
    user: { accountName: string };
  };
}

function jsonRequest(
  app: FastifyInstance,
  token: string,
  options: InjectOptions,
) {
  return app.inject({
    ...options,
    headers: {
      ...options.headers,
      authorization: `Bearer ${token}`,
    },
  });
}

function dataOf(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok("data" in value);
  const data = (value as { data: unknown }).data;
  assert.ok(data && typeof data === "object" && !Array.isArray(data));
  return data as JsonObject;
}

function errorOf(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok("error" in value);
  const error = (value as { error: unknown }).error;
  assert.ok(error && typeof error === "object" && !Array.isArray(error));
  return error as JsonObject;
}

function multipartUpload(
  app: FastifyInstance,
  token: string,
  parentId: string,
  filename: string,
  mimeType: string,
  content: Buffer,
) {
  const boundary = "----xiqu-integration-test-boundary";
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return app.inject({
    method: "POST",
    url: `/api/media-files/upload?${new URLSearchParams({
      parentId,
      name: filename,
    }).toString()}`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([prefix, content, suffix]),
  });
}

// 最小 MP4 ftyp box 足以让 file-type 识别容器，同时让 Range 断言保持可控。
function minimalMp4() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(4),
    Buffer.from("isomiso2"),
  ]);
}
