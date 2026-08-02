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
  const { prisma, pool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(storageRoot);
  const app = await buildApiApp({
    prisma,
    storage,
    logger: false,
    seed: true,
    uploadPolicy: {
      maxUploadBytes: 64,
      userQuotaBytes: 80,
      platformQuotaBytes: 200,
      orphanGraceMs: 1_000,
    },
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
      assert.equal(dataOf(health.json()).status, "ok");

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

    await suite.test("治理接口坏输入和 operation revision 冲突", async () => {
      const badLimit = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/audit-logs?limit=1.5",
      });
      assert.equal(badLimit.statusCode, 400);

      const badOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: { baseRevision: -1, action: "" },
      });
      assert.equal(badOperation.statusCode, 400);

      const staleOperation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${annotationFileId}/operations`,
        payload: {
          baseRevision: 1,
          localRevision: 2,
          action: "character.updateText",
          payload: { entityId: "char-1" },
        },
      });
      assert.equal(staleOperation.statusCode, 409);
      assert.equal(
        await prisma.annotationOperation.count({
          where: { annotationFileId },
        }),
        0,
      );

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
  } finally {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
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
