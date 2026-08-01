import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const app = await buildApiApp({
    prisma,
    storage: new LocalObjectStorage(storageRoot),
    logger: false,
    seed: true,
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
    });

    await suite.test("媒体上传、受保护读取和 Range", async () => {
      const content = Buffer.from("0123456789abcdef", "utf8");
      const upload = await multipartUpload(
        app,
        adminToken,
        "sample.mp4",
        "video/mp4",
        content,
      );
      assert.equal(upload.statusCode, 200);
      const file = dataOf(upload.json()).file as JsonObject;
      const fileId = String(file.id);

      const media = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/media-files",
        payload: { parentId: projectId, fileId, name: "测试视频.mp4" },
      });
      assert.equal(media.statusCode, 200);

      const range = await app.inject({
        method: "GET",
        url: `/api/files/${fileId}/content`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          range: "bytes=2-5",
        },
      });
      assert.equal(range.statusCode, 206);
      assert.equal(range.headers["content-range"], "bytes 2-5/16");
      assert.deepEqual(range.rawPayload, Buffer.from("2345"));

      const suffixRange = await app.inject({
        method: "GET",
        url: `/api/files/${fileId}/content`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          range: "bytes=-4",
        },
      });
      assert.equal(suffixRange.statusCode, 206);
      assert.deepEqual(suffixRange.rawPayload, Buffer.from("cdef"));

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

      const storedPath = path.join(storageRoot, String(file.storageKey));
      assert.deepEqual(await readFile(storedPath), content);
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
    url: "/api/files/upload",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([prefix, content, suffix]),
  });
}
