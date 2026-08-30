import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { Readable, Writable } from "node:stream";
import test from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import {
  buildProjectCustomTrackStructureCommand,
  type ProjectData,
} from "@xiqu/document-model";
import {
  ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX,
  ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL,
  buildTimelineTimingUpdateEnvelope,
  decodeMediaAnalysisTileBatch,
} from "@xiqu/shared";
import { buildApiApp } from "../src/app.js";
import type { AliyunVodProvider } from "../src/aliyunVodGateway.js";
import { hashToken } from "../src/auth.js";
import { LocalObjectStorage } from "../src/storage.js";
import {
  createTestPrisma,
  truncateTestDatabase,
} from "./testEnvironment.js";

type JsonObject = Record<string, unknown>;

// 集成测试只注入稳定的供应商合同，不读取宿主机阿里云凭据，也不访问公网。
const fakeAliyunVodProvider: AliyunVodProvider = {
  region: "cn-shanghai",
  gateway: {
    inspectVideo: async (videoId) => ({
      videoId,
      title: "VOD 集成测试媒资",
      status: "Normal",
      mediaKind: "video",
      duration: 321.5,
    }),
    createPlaybackCredential: async (videoId) => ({
      videoId,
      status: "Normal",
      playAuth: "integration-temporary-play-auth",
      expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    }),
    createAnalysisAudioStream: async () => ({
      url: "https://vod.example.test/audio.mp3?temporary=1",
      expiresAt: new Date("2030-01-01T00:15:00.000Z"),
      format: "mp3",
      duration: 321.5,
      bitrate: 128,
    }),
    listAudioRenditions: async () => [],
    createAudioRenditionStream: async () => {
      throw new Error("本测试不应请求音频转码");
    },
  },
};

test("平台资源 API 集成测试", async (suite) => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "xiqu-api-test-"));
  const { prisma, pool, maintenancePool, collaborationPool, schema } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(storageRoot);
  const serverErrorLogs: string[] = [];
  const errorLogStream = new Writable({
    write(chunk, _encoding, callback) {
      serverErrorLogs.push(String(chunk));
      callback();
    },
  });
  const app = await buildApiApp({
    prisma,
    maintenancePool,
    collaborationPool,
    databaseSchema: schema,
    storage,
    // 正常请求保持安静；意外 500 写入内存，并只在对应断言失败时附上最近的服务端根因。
    logger: { level: "error", stream: errorLogStream },
    seed: true,
    uploadPolicy: {
      maxUploadBytes: 64,
      userQuotaBytes: 80,
      platformQuotaBytes: 200,
      orphanGraceMs: 1_000,
    },
    metricsToken: "integration-metrics-token",
    aliyunVod: fakeAliyunVodProvider,
    aliyunVodWebPlayerLicense: {
      domain: "example.test",
      key: "integration-web-license-key",
    },
  });
  await app.ready();

  let adminToken = "";
  let studentToken = "";
  let teacherToken = "";
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
        collaborationPool,
        databaseSchema: schema,
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
      teacherToken = (await login(app, "ta", "ta123")).accessToken;

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

    await suite.test("账号生命周期仅由系统管理员治理并立即撤销失效会话", async () => {
      const forbiddenList = await jsonRequest(app, teacherToken, {
        method: "GET",
        url: "/api/admin/accounts",
      });
      assert.equal(forbiddenList.statusCode, 403);

      // admin 保留资源与运维全权，但不能枚举或修改账号；该边界必须由 API 而非前端隐藏保证。
      const resourceAdmin = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/admin/accounts",
        payload: {
          accountName: "integration_admin",
          displayName: "集成测试管理员",
          password: "adminRolePass123",
          roles: ["admin"],
        },
      });
      assert.equal(resourceAdmin.statusCode, 200, resourceAdmin.body);
      const resourceAdminLogin = await login(app, "integration_admin", "adminRolePass123");
      assert.equal((await jsonRequest(app, resourceAdminLogin.accessToken, {
        method: "GET",
        url: "/api/admin/accounts",
      })).statusCode, 403);
      assert.equal((await jsonRequest(app, resourceAdminLogin.accessToken, {
        method: "GET",
        url: "/api/admin/diagnostics",
      })).statusCode, 200);

      const teacherDirectory = await jsonRequest(app, teacherToken, {
        method: "GET",
        url: "/api/users",
      });
      assert.equal(teacherDirectory.statusCode, 200, teacherDirectory.body);

      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/admin/accounts",
        payload: {
          accountName: "integration_editor",
          displayName: "集成测试标注员",
          password: "editorPass123",
          roles: ["annotator"],
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const createdAccount = dataOf(created.json());
      const accountId = String(createdAccount.id);
      assert.deepEqual(createdAccount.roles, ["annotator"]);

      const updated = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/admin/accounts/${accountId}`,
        payload: { displayName: "集成测试审核员", roles: ["annotator", "reviewer"] },
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.equal(dataOf(updated.json()).displayName, "集成测试审核员");
      assert.deepEqual(
        [...dataOf(updated.json()).roles as string[]].sort(),
        ["annotator", "reviewer"],
      );

      const initialLogin = await login(app, "integration_editor", "editorPass123");
      const reset = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/admin/accounts/${accountId}/reset-password`,
        payload: { password: "replacementPass456" },
      });
      assert.equal(reset.statusCode, 200, reset.body);
      const revokedSession = await jsonRequest(app, initialLogin.accessToken, {
        method: "GET",
        url: "/api/auth/me",
      });
      assert.equal(revokedSession.statusCode, 401, "重置密码必须立即撤销旧会话");
      const replacementLogin = await login(app, "integration_editor", "replacementPass456");
      const ownPasswordChange = await jsonRequest(app, replacementLogin.accessToken, {
        method: "POST",
        url: "/api/auth/change-password",
        payload: {
          currentPassword: "replacementPass456",
          newPassword: "selfChangedPass789",
        },
      });
      assert.equal(ownPasswordChange.statusCode, 200, ownPasswordChange.body);
      const changedSession = await jsonRequest(app, replacementLogin.accessToken, {
        method: "GET",
        url: "/api/auth/me",
      });
      assert.equal(changedSession.statusCode, 401);
      await login(app, "integration_editor", "selfChangedPass789");

      const deactivate = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/admin/accounts/${accountId}`,
        payload: { isActive: false },
      });
      assert.equal(deactivate.statusCode, 200, deactivate.body);
      const inactiveLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { accountName: "integration_editor", password: "selfChangedPass789" },
      });
      assert.equal(inactiveLogin.statusCode, 401);

      const adminAccount = await prisma.user.findUniqueOrThrow({
        where: { accountName: "admin" },
      });
      const selfDeactivate = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/admin/accounts/${adminAccount.id}`,
        payload: { isActive: false },
      });
      assert.equal(selfDeactivate.statusCode, 409, "当前管理员不能停用自己");
      assert.equal(await prisma.auditLog.count({
        where: { targetUserId: accountId, action: { in: [
          "account_create",
          "account_update",
          "account_password_reset",
          "account_password_change",
        ] } },
      }), 5);
    });

    await suite.test("项目权限管理分页覆盖嵌套项目并拒绝非管理员", async () => {
      const resourceAdminToken = (
        await login(app, "integration_admin", "adminRolePass123")
      ).accessToken;
      const root = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "权限项目-根" },
      });
      assert.equal(root.statusCode, 200, root.body);
      const rootId = String(dataOf(root.json()).id);
      const nested = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: rootId, type: "project", name: "权限项目-嵌套" },
      });
      assert.equal(nested.statusCode, 200, nested.body);
      const nestedId = String(dataOf(nested.json()).id);
      await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: rootId, type: "folder", name: "权限项目-文件夹" },
      });

      // 子项目本身保持活动，但归档或回收祖先必须让整棵子树退出集中权限面板。
      const archivedParent = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "权限项目-归档父级" },
      });
      const archivedParentId = String(dataOf(archivedParent.json()).id);
      const archivedChild = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: archivedParentId,
          type: "project",
          name: "权限项目-归档子级",
        },
      });
      const archivedChildId = String(dataOf(archivedChild.json()).id);
      assert.equal((await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/resources/${archivedParentId}`,
        payload: { archived: true },
      })).statusCode, 200);

      const trashedParent = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "权限项目-回收父级" },
      });
      const trashedParentId = String(dataOf(trashedParent.json()).id);
      const trashedChild = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: {
          parentId: trashedParentId,
          type: "project",
          name: "权限项目-回收子级",
        },
      });
      const trashedChildId = String(dataOf(trashedChild.json()).id);
      assert.equal((await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${trashedParentId}/trash`,
      })).statusCode, 200);

      for (const token of [teacherToken, studentToken]) {
        const forbiddenProjects = await jsonRequest(app, token, {
          method: "GET",
          url: "/api/permission-management/projects",
        });
        assert.equal(forbiddenProjects.statusCode, 403);
      }

      const firstPage = await jsonRequest(app, resourceAdminToken, {
        method: "GET",
        url: "/api/permission-management/projects?query=权限项目&limit=1",
      });
      assert.equal(firstPage.statusCode, 200, firstPage.body);
      const firstPageData = dataOf(firstPage.json());
      assert.equal((firstPageData.items as JsonObject[]).length, 1);
      assert.equal(typeof firstPageData.nextCursor, "string");
      const secondPage = await jsonRequest(app, resourceAdminToken, {
        method: "GET",
        url: `/api/permission-management/projects?query=权限项目&limit=10&cursor=${encodeURIComponent(String(firstPageData.nextCursor))}`,
      });
      assert.equal(secondPage.statusCode, 200, secondPage.body);
      const allVisibleItems = [
        ...(firstPageData.items as JsonObject[]),
        ...(dataOf(secondPage.json()).items as JsonObject[]),
      ];
      assert.deepEqual(
        new Set(allVisibleItems.map(({ id }) => id)),
        new Set([rootId, nestedId]),
        "集中权限面板只能返回活动项目，且不能遗漏嵌套项目",
      );
      const nestedItem = allVisibleItems.find(({ id }) => id === nestedId);
      assert.deepEqual(
        (nestedItem?.path as JsonObject[]).map(({ name }) => name),
        ["权限项目-根", "权限项目-嵌套"],
      );
      assert.ok(!allVisibleItems.some(({ id }) => [
        archivedParentId,
        archivedChildId,
        trashedParentId,
        trashedChildId,
      ].includes(String(id))));

      const searched = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/permission-management/projects?query=权限项目-嵌套",
      });
      assert.deepEqual(
        (dataOf(searched.json()).items as JsonObject[]).map(({ id }) => id),
        [nestedId],
      );
      const mismatchedCursor = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/permission-management/projects?query=其他项目&cursor=${encodeURIComponent(String(firstPageData.nextCursor))}`,
      });
      assert.equal(mismatchedCursor.statusCode, 400);
      const overlongSearch = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/permission-management/projects?query=${"长".repeat(121)}`,
      });
      assert.equal(overlongSearch.statusCode, 400);
    });

    await suite.test("资源创建、名称校验和层级循环保护", async () => {
      const project = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/resources",
        payload: { type: "project", name: "集成测试项目" },
      });
      assert.equal(project.statusCode, 200, project.body);
      projectId = String(dataOf(project.json()).id);

      // teacher 自动看到全部资源并可下载，但不能因此编辑内容、创建子项或管理 ACL。
      const teacherRead = await jsonRequest(app, teacherToken, {
        method: "GET",
        url: `/api/resources/${projectId}`,
      });
      assert.equal(teacherRead.statusCode, 200, teacherRead.body);
      const teacherPermission = dataOf(teacherRead.json()).permission as JsonObject;
      assert.equal(teacherPermission.source, "role");
      assert.deepEqual(teacherPermission.capabilities, ["read", "download"]);
      assert.equal((await jsonRequest(app, teacherToken, {
        method: "PATCH",
        url: `/api/resources/${projectId}`,
        payload: { name: "教师不应改名" },
      })).statusCode, 403);
      assert.equal((await jsonRequest(app, teacherToken, {
        method: "POST",
        url: "/api/resources",
        payload: { parentId: projectId, type: "folder", name: "教师不应创建" },
      })).statusCode, 403);
      assert.equal((await jsonRequest(app, teacherToken, {
        method: "PUT",
        url: `/api/resources/${projectId}/permissions/user-student`,
        payload: { capabilities: ["read"] },
      })).statusCode, 403);

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

    await suite.test("标注文件媒体关系可绑定、改绑、解绑并受资源权限约束", async () => {
      const firstUpload = await multipartUpload(
        app,
        adminToken,
        projectId,
        "binding-a.mp4",
        "video/mp4",
        minimalMp4(),
      );
      const secondUpload = await multipartUpload(
        app,
        adminToken,
        projectId,
        "binding-b.mp4",
        "video/mp4",
        minimalMp4(),
      );
      assert.equal(firstUpload.statusCode, 200, firstUpload.body);
      assert.equal(secondUpload.statusCode, 200, secondUpload.body);
      const firstMediaId = String(dataOf(firstUpload.json()).id);
      const secondMediaId = String(dataOf(secondUpload.json()).id);

      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "媒体绑定合同.json",
          payload: { marker: "media-binding" },
          mediaResourceId: firstMediaId,
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const annotationId = String((dataOf(created.json()).resource as JsonObject).id);
      assert.equal((dataOf(created.json()).media as JsonObject).resourceId, firstMediaId);

      const rebound = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/annotation-files/${annotationId}/media`,
        payload: { mediaResourceId: secondMediaId },
      });
      assert.equal(rebound.statusCode, 200, rebound.body);
      assert.equal((dataOf(rebound.json()).media as JsonObject).resourceId, secondMediaId);

      const unbound = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/annotation-files/${annotationId}/media`,
        payload: { mediaResourceId: null },
      });
      assert.equal(unbound.statusCode, 200, unbound.body);
      assert.equal(dataOf(unbound.json()).media, null);

      // 只有标注写权限不能借关联动作绕过媒体下载权限。
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${annotationId}/permissions/user-student`,
        payload: { capabilities: ["read", "write"], inheritToChildren: false },
      });
      const deniedBinding = await jsonRequest(app, studentToken, {
        method: "PATCH",
        url: `/api/annotation-files/${annotationId}/media`,
        payload: { mediaResourceId: firstMediaId },
      });
      assert.equal(deniedBinding.statusCode, 403);

      const reboundBeforeDelete = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/annotation-files/${annotationId}/media`,
        payload: { mediaResourceId: firstMediaId },
      });
      assert.equal(reboundBeforeDelete.statusCode, 200, reboundBeforeDelete.body);
      // 外键以媒体资源为目标；媒体资源被删除时必须自动解绑，不能留下打不开的悬空字符串。
      await prisma.resourceEntry.delete({ where: { id: firstMediaId } });
      const storedAfterMediaDelete = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: annotationId },
      });
      assert.equal(storedAfterMediaDelete.mediaResourceId, null);
      assert.equal(await prisma.auditLog.count({
        where: { resourceId: annotationId, action: { in: [
          "annotation_media_bind",
          "annotation_media_unbind",
        ] } },
      }), 3);
      // 本用例在配额测试之前运行；清除专用媒体及确定孤儿对象，避免测试夹具之间共享容量。
      await prisma.resourceEntry.delete({ where: { id: secondMediaId } });
      await prisma.fileObject.deleteMany({
        where: { ownerUserId: "user-admin", mediaFiles: { none: {} } },
      });
    });

    await suite.test("阿里云 VOD 资源保存稳定身份、按需签发播放会话且不伪装下载", async () => {
      const providers = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/media-providers",
      });
      assert.equal(providers.statusCode, 200, providers.body);
      assert.deepEqual(dataOf(providers.json()).aliyunVod, {
        enabled: true,
        region: "cn-shanghai",
      });

      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/media-files/aliyun-vod",
        payload: {
          parentId: projectId,
          name: "寻梦 VOD",
          videoId: "00cf8df6907871f1b31f5017e1f80102",
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const vodResource = dataOf(created.json());
      const vodResourceId = String(vodResource.id);
      assert.equal(vodResource.mediaSourceType, "aliyun_vod");
      assert.equal(vodResource.mediaKind, "video");
      assert.equal(vodResource.duration, 321.5);
      assert.equal(vodResource.fileId, undefined);

      const duplicate = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/media-files/aliyun-vod",
        payload: {
          parentId: projectId,
          name: "寻梦 VOD",
          videoId: "another_video_123",
        },
      });
      assert.equal(duplicate.statusCode, 409);
      const deniedCreate = await jsonRequest(app, studentToken, {
        method: "POST",
        url: "/api/media-files/aliyun-vod",
        payload: {
          parentId: projectId,
          name: "无权创建 VOD",
          videoId: "student_video_123",
        },
      });
      assert.equal(deniedCreate.statusCode, 403);

      const annotation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "VOD 媒体绑定.json",
          payload: { marker: "vod-binding" },
          mediaResourceId: vodResourceId,
        },
      });
      assert.equal(annotation.statusCode, 200, annotation.body);
      const media = dataOf(annotation.json()).media as JsonObject;
      assert.equal(media.sourceType, "aliyun_vod");
      assert.equal(media.videoId, "00cf8df6907871f1b31f5017e1f80102");
      assert.equal(media.region, "cn-shanghai");
      assert.equal(media.playAuth, undefined);

      const playback = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/media-files/${vodResourceId}/playback-session`,
      });
      assert.equal(playback.statusCode, 200, playback.body);
      assert.equal(playback.headers["cache-control"], "no-store");
      assert.equal(dataOf(playback.json()).playAuth, "integration-temporary-play-auth");
      assert.deepEqual(dataOf(playback.json()).webPlayerLicense, {
        domain: "example.test",
        key: "integration-web-license-key",
      });
      const deniedPlayback = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/media-files/${vodResourceId}/playback-session`,
      });
      assert.equal(deniedPlayback.statusCode, 403);

      const download = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/resources/${vodResourceId}/download`,
      });
      assert.equal(download.statusCode, 400);

      const copied = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/resources/${vodResourceId}/copy`,
        payload: { parentId: childFolderId },
      });
      assert.equal(copied.statusCode, 200, copied.body);
      const copiedResourceId = String(dataOf(copied.json()).id);
      const copiedMedia = await prisma.mediaFile.findUniqueOrThrow({
        where: { resourceId: copiedResourceId },
      });
      assert.equal(copiedMedia.sourceType, "aliyun_vod");
      assert.equal(copiedMedia.fileId, null);
      assert.equal(copiedMedia.aliyunVodVideoId, "00cf8df6907871f1b31f5017e1f80102");
      const copyAudit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "resource_copy", resourceId: copiedResourceId },
      });
      assert.equal((copyAudit.detail as JsonObject).reusedFileObjectCount, 0);
      const createAudit = await prisma.auditLog.findFirstOrThrow({
        where: { action: "aliyun_vod_media_create", resourceId: vodResourceId },
      });
      const createDetail = createAudit.detail as JsonObject;
      assert.equal(createDetail.sourceType, "aliyun_vod");
      assert.equal(createDetail.videoId, undefined);
      assert.equal(createDetail.playAuth, undefined);
    });

    await suite.test("媒体分析强制使用音轨关系并逐次复核来源权限", async () => {
      const vod = await prisma.mediaFile.findFirstOrThrow({
        where: { sourceType: "aliyun_vod", aliyunVodVideoId: "00cf8df6907871f1b31f5017e1f80102" },
      });
      const audioUpload = await multipartUpload(
        app,
        adminToken,
        projectId,
        "analysis-override.wav",
        "audio/wav",
        minimalWav(),
      );
      assert.equal(audioUpload.statusCode, 200, audioUpload.body);
      const audioResourceId = String(dataOf(audioUpload.json()).id);
      const videoUpload = await multipartUpload(
        app,
        adminToken,
        projectId,
        "analysis-invalid-video.mp4",
        "video/mp4",
        minimalMp4(),
      );
      assert.equal(videoUpload.statusCode, 200, videoUpload.body);
      const videoResourceId = String(dataOf(videoUpload.json()).id);

      const annotation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "分析音频来源.json",
          payload: { marker: "analysis-audio" },
          mediaResourceId: vod.resourceId,
        },
      });
      assert.equal(annotation.statusCode, 200, annotation.body);
      const fileId = String((dataOf(annotation.json()).resource as JsonObject).id);
      const originalAudioTrack = await prisma.mediaAudioTrack.findFirstOrThrow({
        where: { primaryMediaResourceId: vod.resourceId, kind: "original" },
      });

      const missingTrackStatus = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/media-analysis`,
      });
      assert.equal(missingTrackStatus.statusCode, 400, missingTrackStatus.body);
      const originalStatus = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/media-analysis?${new URLSearchParams({
          audioTrackId: originalAudioTrack.id,
        })}`,
      });
      assert.equal(originalStatus.statusCode, 200, originalStatus.body);
      assert.equal(dataOf(originalStatus.json()).audioTrackId, originalAudioTrack.id);
      assert.equal(dataOf(originalStatus.json()).setting, undefined);
      const originalSource = dataOf(originalStatus.json()).resolvedSource as JsonObject;
      assert.equal(originalSource.status, "ready");
      assert.equal(originalSource.sourceType, "aliyun_vod");
      assert.equal(originalSource.mode, undefined);
      assert.equal(originalSource.videoId, undefined);
      assert.equal(originalSource.playAuth, undefined);

      const firstRun = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/media-analysis`,
        payload: { audioTrackId: originalAudioTrack.id, clientRequestId: randomUUID() },
      });
      assert.equal(firstRun.statusCode, 200, firstRun.body);
      assert.equal(dataOf(firstRun.json()).status, "queued");
      assert.equal(dataOf(firstRun.json()).tileDurationSeconds, 10);
      assert.equal(await prisma.processingJob.count({
        where: { analysisRunId: String(dataOf(firstRun.json()).id) },
      }), 1);
      const createdAnalysisJob = await prisma.processingJob.findFirstOrThrow({
        where: { analysisRunId: String(dataOf(firstRun.json()).id) },
      });
      const ownJobs = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/processing-jobs?scope=mine&limit=10",
      });
      assert.equal(ownJobs.statusCode, 200, ownJobs.body);
      const ownJobItems = dataOf(ownJobs.json()).items as JsonObject[];
      assert.equal(ownJobItems.length, 1);
      assert.equal((ownJobItems[0]?.job as JsonObject).id, createdAnalysisJob.id);
      assert.equal(ownJobItems[0]?.deduplicationKey, undefined);
      assert.equal((ownJobItems[0]?.job as JsonObject).result, undefined);
      const ownJobSummary = await jsonRequest(app, adminToken, {
        method: "GET",
        url: "/api/processing-jobs/summary?scope=mine",
      });
      assert.equal(ownJobSummary.statusCode, 200, ownJobSummary.body);
      assert.equal(dataOf(ownJobSummary.json()).visibleRequestCount, 1);
      const ownJobDetail = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/processing-jobs/${createdAnalysisJob.id}`,
      });
      assert.equal(ownJobDetail.statusCode, 200, ownJobDetail.body);
      assert.equal((dataOf(ownJobDetail.json()).job as JsonObject).id, createdAnalysisJob.id);
      const forbiddenAllJobs = await jsonRequest(app, studentToken, {
        method: "GET",
        url: "/api/processing-jobs?scope=all",
      });
      assert.equal(forbiddenAllJobs.statusCode, 403, forbiddenAllJobs.body);
      const activeRetry = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/processing-job-requests/${String(ownJobItems[0]?.requestId)}/retry`,
        payload: { clientCommandId: randomUUID() },
      });
      assert.equal(activeRetry.statusCode, 409, activeRetry.body);
      const forbiddenForceCancel = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/processing-jobs/${createdAnalysisJob.id}/force-cancel`,
        payload: { clientCommandId: randomUUID() },
      });
      assert.equal(forbiddenForceCancel.statusCode, 403, forbiddenForceCancel.body);
      const analysisAssetKey = storage.createStorageKey("xqa");
      const stagedAnalysisAsset = await storage.putStagedObject(
        analysisAssetKey,
        Readable.from([Buffer.from("analysis-tile")]),
        64,
      );
      await storage.promoteStagedObject(stagedAnalysisAsset);
      await prisma.mediaAnalysisRun.update({
        where: { id: String(dataOf(firstRun.json()).id) },
        data: { status: "succeeded", progress: 1 },
      });
      const storedAsset = await prisma.mediaAnalysisAsset.create({
        data: {
          runId: String(dataOf(firstRun.json()).id),
          kind: "waveform",
          preset: "default",
          level: 0,
          tileIndex: 0,
          startTime: 0,
          endTime: 10,
          mimeType: "application/vnd.xiqu.waveform-tile",
          size: stagedAnalysisAsset.size,
          checksum: stagedAnalysisAsset.checksum,
          storageKey: stagedAnalysisAsset.finalStorageKey,
        },
      });
      const secondAnalysisAssetKey = storage.createStorageKey("xqa");
      const secondStagedAnalysisAsset = await storage.putStagedObject(
        secondAnalysisAssetKey,
        Readable.from([Buffer.from("second-tile")]),
        64,
      );
      await storage.promoteStagedObject(secondStagedAnalysisAsset);
      const secondStoredAsset = await prisma.mediaAnalysisAsset.create({
        data: {
          runId: String(dataOf(firstRun.json()).id),
          kind: "waveform",
          preset: "default",
          level: 0,
          tileIndex: 1,
          startTime: 10,
          endTime: 20,
          mimeType: "application/vnd.xiqu.waveform-tile",
          size: secondStagedAnalysisAsset.size,
          checksum: secondStagedAnalysisAsset.checksum,
          storageKey: secondStagedAnalysisAsset.finalStorageKey,
        },
      });
      const trackScopedStatus = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/media-analysis?${new URLSearchParams({
          audioTrackId: originalAudioTrack.id,
        })}`,
      });
      assert.equal(trackScopedStatus.statusCode, 200, trackScopedStatus.body);
      assert.equal(dataOf(trackScopedStatus.json()).audioTrackId, originalAudioTrack.id);
      assert.equal(
        (dataOf(trackScopedStatus.json()).currentRun as JsonObject).id,
        dataOf(firstRun.json()).id,
      );
      const assetList = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/media-analysis/assets?${new URLSearchParams({
          audioTrackId: originalAudioTrack.id,
          runId: String(dataOf(firstRun.json()).id),
          kind: "waveform",
          preset: "default",
          level: "0",
          startTime: "0",
          endTime: "10",
        })}`,
      });
      assert.equal(assetList.statusCode, 200, assetList.body);
      const listedAsset = (dataOf(assetList.json()).assets as JsonObject[])[0];
      assert.equal(listedAsset.id, storedAsset.id);
      assert.equal(listedAsset.storageKey, undefined);
      assert.equal(listedAsset.checksum, undefined);
      const assetContent = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/media-analysis/assets/${storedAsset.id}?${new URLSearchParams({
          audioTrackId: originalAudioTrack.id,
        })}`,
      });
      assert.equal(assetContent.statusCode, 200, assetContent.body);
      assert.equal(assetContent.body, "analysis-tile");
      const assetBatch = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/media-analysis/assets/batch`,
        payload: {
          audioTrackId: originalAudioTrack.id,
          runId: String(dataOf(firstRun.json()).id),
          assetIds: [secondStoredAsset.id, storedAsset.id],
        },
      });
      assert.equal(assetBatch.statusCode, 200, assetBatch.body);
      assert.match(String(assetBatch.headers["content-type"]), /media-analysis-batch/);
      const decodedBatch = decodeMediaAnalysisTileBatch(new Uint8Array(assetBatch.rawPayload));
      assert.deepEqual([...decodedBatch.keys()], [secondStoredAsset.id, storedAsset.id]);
      assert.equal(Buffer.from(decodedBatch.get(secondStoredAsset.id) ?? []).toString(), "second-tile");
      assert.equal(Buffer.from(decodedBatch.get(storedAsset.id) ?? []).toString(), "analysis-tile");

      const foreignAudioTrack = await prisma.mediaAudioTrack.findFirstOrThrow({
        where: { primaryMediaResourceId: videoResourceId, kind: "original" },
      });
      const crossTrackAssetBatch = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/media-analysis/assets/batch`,
        payload: {
          audioTrackId: foreignAudioTrack.id,
          runId: String(dataOf(firstRun.json()).id),
          assetIds: [storedAsset.id],
        },
      });
      assert.equal(crossTrackAssetBatch.statusCode, 404);

      const missingAssetBatch = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/media-analysis/assets/batch`,
        payload: {
          runId: String(dataOf(firstRun.json()).id),
          assetIds: [storedAsset.id, "missing-asset"],
        },
      });
      assert.equal(missingAssetBatch.statusCode, 400);

      const duplicateAssetBatch = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/media-analysis/assets/batch`,
        payload: {
          runId: String(dataOf(firstRun.json()).id),
          assetIds: [storedAsset.id, storedAsset.id],
        },
      });
      assert.equal(duplicateAssetBatch.statusCode, 400);

      const siblingAnnotation = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "共享媒体分析.json",
          payload: { marker: "shared-analysis" },
          mediaResourceId: vod.resourceId,
        },
      });
      const siblingFileId = String(
        (dataOf(siblingAnnotation.json()).resource as JsonObject).id,
      );
      const siblingStatus = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${siblingFileId}/media-analysis?${new URLSearchParams({
          audioTrackId: originalAudioTrack.id,
        })}`,
      });
      assert.equal(
        (dataOf(siblingStatus.json()).currentRun as JsonObject).id,
        dataOf(firstRun.json()).id,
      );
      const uploadedTrack = await prisma.mediaAudioTrack.create({
        data: {
          primaryMediaResourceId: vod.resourceId,
          audioMediaResourceId: audioResourceId,
          name: "独立分析音轨",
          kind: "reference",
          offsetSeconds: 0.25,
          sortOrder: 1,
          createdBy: "user-admin",
        },
      });
      const offsetStatus = await jsonRequest(app, adminToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/media-analysis?${new URLSearchParams({
          audioTrackId: uploadedTrack.id,
        })}`,
      });
      assert.equal(offsetStatus.statusCode, 200, offsetStatus.body);
      assert.equal(dataOf(offsetStatus.json()).currentRun, null);
      assert.equal(
        (dataOf(offsetStatus.json()).resolvedSource as JsonObject).offsetSeconds,
        0.25,
      );

      const forbiddenAssetBatch = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/media-analysis/assets/batch`,
        payload: {
          audioTrackId: originalAudioTrack.id,
          runId: String(dataOf(firstRun.json()).id),
          assetIds: [storedAsset.id],
        },
      });
      assert.equal(forbiddenAssetBatch.statusCode, 403);

      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${fileId}/permissions/user-student`,
        payload: { capabilities: ["read", "write"], inheritToChildren: false },
      });
      const studentAssetRead = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/media-analysis/assets/${storedAsset.id}?${new URLSearchParams({
          audioTrackId: uploadedTrack.id,
        })}`,
      });
      // 音轨来源没有下载权限时，不能借 annotation ACL 读取其他媒体的既有 run。
      assert.equal(studentAssetRead.statusCode, 404, studentAssetRead.body);
      const forbiddenStatus = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}/media-analysis?${new URLSearchParams({
          audioTrackId: uploadedTrack.id,
        })}`,
      });
      assert.equal(forbiddenStatus.statusCode, 200, forbiddenStatus.body);
      assert.equal(
        (dataOf(forbiddenStatus.json()).resolvedSource as JsonObject).code,
        "analysis_audio_forbidden",
      );
      const forbiddenStart = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/media-analysis`,
        payload: { audioTrackId: uploadedTrack.id, clientRequestId: randomUUID() },
      });
      assert.equal(forbiddenStart.statusCode, 403);
      assert.equal(errorOf(forbiddenStart.json()).code, "analysis_audio_forbidden");

      const analysisAuditDetails = (await prisma.auditLog.findMany({
        where: {
          resourceId: fileId,
          action: "media_analysis_create",
        },
        select: { detail: true },
      })).map(({ detail }) => JSON.stringify(detail));
      assert.ok(analysisAuditDetails.every((detail) =>
        !detail.includes("playAuth") && !detail.includes("storageKey")));
      // 专项夹具不占用后续上传/配额用例的共享容量。
      await prisma.mediaAudioTrack.delete({ where: { id: uploadedTrack.id } });
      await prisma.resourceEntry.deleteMany({
        where: { id: { in: [audioResourceId, videoResourceId] } },
      });
      await prisma.fileObject.deleteMany({
        where: { ownerUserId: "user-admin", mediaFiles: { none: {} } },
      });
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

      // 审核可以作为独立 ACL 能力保存，但不会隐式附加 read；审核动作仍由领域门禁要求 read + review。
      const reviewOnly = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${childFolderId}/permissions/user-student`,
        payload: { capabilities: ["review"], inheritToChildren: false },
      });
      assert.equal(reviewOnly.statusCode, 200);
      assert.deepEqual(dataOf(reviewOnly.json()).capabilities, ["review"]);
      assert.equal((await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/resources/${childFolderId}`,
      })).statusCode, 403);

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

    await suite.test("协作票据一次性消费并在权威保存后推送 revision", async () => {
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "协作通知测试.json",
          payload: { marker: "collaboration-base" },
        },
      });
      const collaborationFileId = String((dataOf(created.json()).resource as JsonObject).id);
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${collaborationFileId}/permissions/user-student`,
        payload: { capabilities: ["read"], inheritToChildren: false },
      });
      await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/resources/${collaborationFileId}/permission-inheritance`,
        payload: { breakPermissionInheritance: true },
      });

      const anonymous = await app.inject({
        method: "POST",
        url: `/api/annotation-files/${collaborationFileId}/collaboration-ticket`,
      });
      assert.equal(anonymous.statusCode, 401);
      const issued = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${collaborationFileId}/collaboration-ticket`,
      });
      assert.equal(issued.statusCode, 200, issued.body);
      const ticket = dataOf(issued.json());
      const plaintext = String(ticket.ticket);
      const storedTicket = await prisma.annotationCollaborationTicket.findFirstOrThrow({
        where: { annotationFileId: collaborationFileId },
      });
      assert.notEqual(storedTicket.tokenHash, plaintext);
      assert.equal(storedTicket.consumedAt, null);

      let resolveReady!: (message: JsonObject) => void;
      let resolveAdvanced!: (message: JsonObject) => void;
      const readyMessage = new Promise<JsonObject>((resolve) => {
        resolveReady = resolve;
      });
      const advancedMessage = new Promise<JsonObject>((resolve) => {
        resolveAdvanced = resolve;
      });
      const socket = await app.injectWS(
        String(ticket.websocketPath),
        { headers: collaborationWsHeaders(plaintext) },
        {
          onInit: (openedSocket) => {
            openedSocket.on("message", (payload: unknown) => {
              const message = JSON.parse(String(payload)) as JsonObject;
              if (message.type === "session.ready") resolveReady(message);
              if (message.type === "annotation.revision.advanced") resolveAdvanced(message);
            });
          },
        },
      );
      const ready = await withTimeout(readyMessage, "等待协作 session.ready 超时");
      assert.equal(ready.annotationFileId, collaborationFileId);
      assert.equal(ready.revision, 1);
      assert.equal(
        (await prisma.annotationCollaborationTicket.findUniqueOrThrow({
          where: { id: storedTicket.id },
        })).consumedAt instanceof Date,
        true,
      );

      const saved = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${collaborationFileId}`,
        payload: { baseRevision: 1, payload: { marker: "collaboration-saved" } },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const advanced = await withTimeout(advancedMessage, "等待 revision 推送超时");
      assert.equal(advanced.annotationFileId, collaborationFileId);
      assert.equal(advanced.revision, 2);

      // 同一票据再次 upgrade 仍会建立底层 socket，但应用会话必须以 4401 立即拒绝。
      let resolveRejected!: (code: number) => void;
      const rejected = new Promise<number>((resolve) => {
        resolveRejected = resolve;
      });
      const replaySocket = await app.injectWS(
        String(ticket.websocketPath),
        { headers: collaborationWsHeaders(plaintext) },
        { onInit: (openedSocket) => openedSocket.once("close", resolveRejected) },
      );
      assert.equal(await withTimeout(rejected, "等待重复票据拒绝超时"), 4401);
      replaySocket.close();

      const secondTicketResponse = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${collaborationFileId}/collaboration-ticket`,
      });
      const secondTicket = dataOf(secondTicketResponse.json());
      let resolveActiveRevoked!: (code: number) => void;
      const activeRevoked = new Promise<number>((resolve) => {
        resolveActiveRevoked = resolve;
      });
      socket.once("close", resolveActiveRevoked);
      await jsonRequest(app, adminToken, {
        method: "DELETE",
        url: `/api/resources/${collaborationFileId}/permissions/user-student`,
      });
      let resolveRevoked!: (code: number) => void;
      const revoked = new Promise<number>((resolve) => {
        resolveRevoked = resolve;
      });
      const revokedSocket = await app.injectWS(
        String(secondTicket.websocketPath),
        { headers: collaborationWsHeaders(String(secondTicket.ticket)) },
        { onInit: (openedSocket) => openedSocket.once("close", resolveRevoked) },
      );
      assert.equal(await withTimeout(revoked, "等待撤权票据拒绝超时"), 4403);
      const savedAfterRevoke = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${collaborationFileId}`,
        payload: { baseRevision: 2, payload: { marker: "after-revoke" } },
      });
      assert.equal(savedAfterRevoke.statusCode, 200, savedAfterRevoke.body);
      assert.equal(
        await withTimeout(activeRevoked, "等待既有连接响应撤权超时"),
        4403,
      );
      await waitForCondition(
        async () => await prisma.annotationCollaborationPresence.count({
          where: { annotationFileId: collaborationFileId, userId: "user-student" },
        }) === 0,
        "等待撤权连接清理 presence 超时",
      );
      socket.close();
      revokedSocket.close();

      const deniedTicket = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${collaborationFileId}/collaboration-ticket`,
      });
      assert.equal(deniedTicket.statusCode, 403);

      const wrongFileTicketResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${collaborationFileId}/collaboration-ticket`,
      });
      const wrongFileTicket = dataOf(wrongFileTicketResponse.json());
      let resolveWrongFile!: (code: number) => void;
      const wrongFile = new Promise<number>((resolve) => {
        resolveWrongFile = resolve;
      });
      const wrongFileSocket = await app.injectWS(
        `/api/annotation-files/${annotationFileId}/collaboration`,
        { headers: collaborationWsHeaders(String(wrongFileTicket.ticket)) },
        { onInit: (openedSocket) => openedSocket.once("close", resolveWrongFile) },
      );
      assert.equal(await withTimeout(wrongFile, "等待跨文件票据拒绝超时"), 4401);
      wrongFileSocket.close();

      const expiredTicketResponse = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${collaborationFileId}/collaboration-ticket`,
      });
      const expiredTicket = dataOf(expiredTicketResponse.json());
      const newestTicket = await prisma.annotationCollaborationTicket.findFirstOrThrow({
        where: { annotationFileId: collaborationFileId, consumedAt: null },
        orderBy: { createdAt: "desc" },
      });
      await prisma.annotationCollaborationTicket.update({
        where: { id: newestTicket.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      let resolveExpired!: (code: number) => void;
      const expired = new Promise<number>((resolve) => {
        resolveExpired = resolve;
      });
      const expiredSocket = await app.injectWS(
        String(expiredTicket.websocketPath),
        { headers: collaborationWsHeaders(String(expiredTicket.ticket)) },
        { onInit: (openedSocket) => openedSocket.once("close", resolveExpired) },
      );
      assert.equal(await withTimeout(expired, "等待过期票据拒绝超时"), 4401);
      expiredSocket.close();

      // 该账号没有文件 ACL 或所有权，只依靠当前全局角色读取；角色撤销后旧连接也必须失效。
      const roleOnlyToken = "collaboration-role-only-token";
      await prisma.user.create({
        data: {
          id: "user-collaboration-role-only",
          accountName: "collaboration_role_only",
          displayName: "协作角色复核账号",
          passwordHash: "not-used-by-this-test",
          roles: { create: { role: "super_admin" } },
          sessions: {
            create: {
              tokenHash: hashToken(roleOnlyToken),
              expiresAt: new Date(Date.now() + 60_000),
            },
          },
        },
      });
      const roleTicketResponse = await jsonRequest(app, roleOnlyToken, {
        method: "POST",
        url: `/api/annotation-files/${collaborationFileId}/collaboration-ticket`,
      });
      assert.equal(roleTicketResponse.statusCode, 200, roleTicketResponse.body);
      const roleTicket = dataOf(roleTicketResponse.json());
      let resolveRoleReady!: () => void;
      let resolveRoleRevoked!: (code: number) => void;
      const roleReady = new Promise<void>((resolve) => {
        resolveRoleReady = resolve;
      });
      const roleRevoked = new Promise<number>((resolve) => {
        resolveRoleRevoked = resolve;
      });
      const roleSocket = await app.injectWS(
        String(roleTicket.websocketPath),
        { headers: collaborationWsHeaders(String(roleTicket.ticket)) },
        {
          onInit: (openedSocket) => {
            openedSocket.on("message", (payload: unknown) => {
              const message = JSON.parse(String(payload)) as JsonObject;
              if (message.type === "session.ready") resolveRoleReady();
            });
            openedSocket.once("close", resolveRoleRevoked);
          },
        },
      );
      await withTimeout(roleReady, "等待角色账号 session.ready 超时");
      await prisma.userRole.deleteMany({
        where: { userId: "user-collaboration-role-only", role: "super_admin" },
      });
      const savedAfterRoleRevoke = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/annotation-files/${collaborationFileId}`,
        payload: { baseRevision: 3, payload: { marker: "after-role-revoke" } },
      });
      assert.equal(savedAfterRoleRevoke.statusCode, 200, savedAfterRoleRevoke.body);
      assert.equal(
        await withTimeout(roleRevoked, "等待既有连接响应角色撤销超时"),
        4403,
      );
      await waitForCondition(
        async () => await prisma.annotationCollaborationPresence.count({
          where: {
            annotationFileId: collaborationFileId,
            userId: "user-collaboration-role-only",
          },
        }) === 0,
        "等待角色撤销连接清理 presence 超时",
      );
      roleSocket.close();
    });

    await suite.test("协作播放头对坏 JSON、二进制和超大帧 fail closed", async () => {
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "协作播放头协议边界.json",
          payload: { marker: "activity-protocol" },
        },
      });
      const fileId = String((dataOf(created.json()).resource as JsonObject).id);

      const openAndSend = async (payload: string | Buffer, binary = false) => {
        const issued = await jsonRequest(app, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${fileId}/collaboration-ticket`,
        });
        const ticket = dataOf(issued.json());
        let resolveClosed!: (code: number) => void;
        const closed = new Promise<number>((resolve) => {
          resolveClosed = resolve;
        });
        const socket = await app.injectWS(
          String(ticket.websocketPath),
          { headers: collaborationWsHeaders(String(ticket.ticket)) },
          {
            onInit: (openedSocket) => {
              openedSocket.on("message", (raw: unknown) => {
                const message = JSON.parse(String(raw)) as JsonObject;
                if (message.type !== "session.ready") return;
                openedSocket.send(payload, binary ? { binary: true } : undefined);
              });
              openedSocket.once("close", resolveClosed);
            },
          },
        );
        assert.equal(await withTimeout(closed, "等待非法播放头帧关闭超时"), 4400);
        socket.terminate();
      };

      await openAndSend("not-json");
      await openAndSend(Buffer.from(JSON.stringify({
        version: 1,
        type: "presence.timeline_activity.update",
        sequence: 1,
        activity: { playhead: { time: 1, playing: false }, pointer: null, selection: null },
      })), true);
      await openAndSend(JSON.stringify({
        version: 1,
        type: "presence.timeline_activity.update",
        sequence: 1,
        activity: { playhead: { time: 1, playing: false }, pointer: null, selection: null },
        padding: "x".repeat(2_000),
      }));
    });

    await suite.test("不同 API 实例通过 PostgreSQL 转发保存与恢复 revision", async () => {
      const secondConnections = createTestPrisma();
      const secondApp = await buildApiApp({
        prisma: secondConnections.prisma,
        maintenancePool: secondConnections.maintenancePool,
        collaborationPool: secondConnections.collaborationPool,
        databaseSchema: secondConnections.schema,
        storage,
        logger: false,
        seed: false,
        uploadPolicy: {
          maxUploadBytes: 64,
          userQuotaBytes: 80,
          platformQuotaBytes: 200,
          orphanGraceMs: 1_000,
        },
        metricsToken: null,
      });
      await secondApp.ready();
      let socket: Awaited<ReturnType<typeof app.injectWS>> | null = null;
      try {
        const created = await jsonRequest(app, adminToken, {
          method: "POST",
          url: "/api/annotation-files",
          payload: {
            parentId: projectId,
            name: "跨实例 revision 通知.json",
            payload: { marker: "cross-instance-base" },
          },
        });
        const fileId = String((dataOf(created.json()).resource as JsonObject).id);
        const issued = await jsonRequest(app, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${fileId}/collaboration-ticket`,
        });
        const ticket = dataOf(issued.json());
        let resolveReady!: () => void;
        let resolveRevisionTwo!: (message: JsonObject) => void;
        let resolveRevisionThree!: (message: JsonObject) => void;
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        const revisionTwo = new Promise<JsonObject>((resolve) => {
          resolveRevisionTwo = resolve;
        });
        const revisionThree = new Promise<JsonObject>((resolve) => {
          resolveRevisionThree = resolve;
        });
        socket = await app.injectWS(
          String(ticket.websocketPath),
          { headers: collaborationWsHeaders(String(ticket.ticket)) },
          {
            onInit: (openedSocket) => {
              openedSocket.on("message", (payload: unknown) => {
                const message = JSON.parse(String(payload)) as JsonObject;
                if (message.type === "session.ready") resolveReady();
                if (message.type === "annotation.revision.advanced" && message.revision === 2) {
                  resolveRevisionTwo(message);
                }
                if (message.type === "annotation.revision.advanced" && message.revision === 3) {
                  resolveRevisionThree(message);
                }
              });
            },
          },
        );
        await withTimeout(ready, "等待跨实例测试 session.ready 超时");

        // 保存请求落到第二个 Fastify 实例，连接在第一个实例的浏览器仍应立即收到 revision 2。
        const saved = await jsonRequest(secondApp, adminToken, {
          method: "PUT",
          url: `/api/annotation-files/${fileId}`,
          payload: { baseRevision: 1, payload: { marker: "saved-by-instance-b" } },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        const savedEvent = await withTimeout(revisionTwo, "等待跨实例保存 revision 超时");
        assert.equal(savedEvent.annotationFileId, fileId);
        assert.equal(savedEvent.revision, 2);

        const sourceSnapshot = await secondConnections.prisma.annotationRecoverySnapshot
          .findFirstOrThrow({ where: { annotationFileId: fileId, revision: 1 } });
        const restored = await jsonRequest(secondApp, adminToken, {
          method: "POST",
          url: `/api/annotation-files/${fileId}/recovery-snapshots/${sourceSnapshot.id}/restore`,
          payload: { baseRevision: 2 },
        });
        assert.equal(restored.statusCode, 200, restored.body);
        const restoredEvent = await withTimeout(
          revisionThree,
          "等待跨实例恢复 revision 超时",
        );
        assert.equal(restoredEvent.annotationFileId, fileId);
        assert.equal(restoredEvent.revision, 3);
      } finally {
        socket?.close();
        await secondApp.close();
        await secondConnections.prisma.$disconnect();
        await secondConnections.pool.end();
        await secondConnections.maintenancePool.end();
        await secondConnections.collaborationPool.end();
      }
    });

    await suite.test("不同 API 实例共享在线成员并聚合同账号多窗口", async () => {
      const secondConnections = createTestPrisma();
      const secondApp = await buildApiApp({
        prisma: secondConnections.prisma,
        maintenancePool: secondConnections.maintenancePool,
        collaborationPool: secondConnections.collaborationPool,
        databaseSchema: secondConnections.schema,
        storage,
        logger: false,
        seed: false,
        metricsToken: null,
      });
      await secondApp.ready();
      const sockets: Array<Awaited<ReturnType<typeof app.injectWS>>> = [];
      try {
        const created = await jsonRequest(app, adminToken, {
          method: "POST",
          url: "/api/annotation-files",
          payload: {
            parentId: projectId,
            name: "跨实例在线成员.json",
            payload: { marker: "presence" },
          },
        });
        const fileId = String((dataOf(created.json()).resource as JsonObject).id);
        await jsonRequest(app, adminToken, {
          method: "PUT",
          url: `/api/resources/${fileId}/permissions/user-student`,
          payload: { capabilities: ["read"], inheritToChildren: false },
        });

        const openPresenceSocket = async (
          targetApp: FastifyInstance,
          token: string,
          observer: ReturnType<typeof createSocketMessageObserver>,
        ) => {
          const issued = await jsonRequest(targetApp, token, {
            method: "POST",
            url: `/api/annotation-files/${fileId}/collaboration-ticket`,
          });
          assert.equal(issued.statusCode, 200, issued.body);
          const ticket = dataOf(issued.json());
          const socket = await targetApp.injectWS(
            String(ticket.websocketPath),
            { headers: collaborationWsHeaders(String(ticket.ticket)) },
            { onInit: (openedSocket) => openedSocket.on("message", observer.onMessage) },
          );
          sockets.push(socket);
          await observer.waitFor(
            (message) => message.type === "session.ready",
            0,
            "等待 presence session.ready 超时",
          );
          return socket;
        };

        const adminObserver = createSocketMessageObserver();
        const adminSocket = await openPresenceSocket(app, adminToken, adminObserver);
        await adminObserver.waitFor(
          (message) => presenceMembers(message)?.length === 1,
          0,
          "等待管理员单人 presence 快照超时",
        );

        const studentObserver = createSocketMessageObserver();
        const firstStudentSocket = await openPresenceSocket(secondApp, studentToken, studentObserver);
        await adminObserver.waitFor(
          (message) => presenceMembers(message)?.length === 2,
          0,
          "等待跨实例双账号 presence 快照超时",
        );
        await studentObserver.waitFor(
          (message) => presenceMembers(message)?.length === 2,
          0,
          "等待学生收到双账号 presence 快照超时",
        );

        const beforeRemoteActivity = adminObserver.mark();
        firstStudentSocket.send(JSON.stringify({
          version: 1,
          type: "presence.timeline_activity.update",
          sequence: 1,
          activity: {
            playhead: { time: 12.5, playing: true },
            pointer: { time: 13 },
            selection: { start: 10, end: 14, itemCount: 2, laneCount: 1, kinds: ["character"] },
          },
        }));
        const remoteActivity = await adminObserver.waitFor(
          (message) => message.type === "presence.timeline_activity.changed" &&
            ((message.activity as JsonObject | null)?.playhead as JsonObject | null)?.time === 12.5,
          beforeRemoteActivity,
          "等待跨实例远端时间轴活动超时",
        );
        assert.equal(remoteActivity.userId, "user-student");

        const beforeSecondTab = adminObserver.mark();
        const secondStudentObserver = createSocketMessageObserver();
        const secondStudentSocket = await openPresenceSocket(
          secondApp,
          studentToken,
          secondStudentObserver,
        );
        await adminObserver.waitFor(
          (message) => presenceMembers(message)?.some((member) =>
            member.userId === "user-student" && member.connectionCount === 2
          ) === true,
          beforeSecondTab,
          "等待同账号多窗口聚合超时",
        );

        const beforeSecondTabClose = adminObserver.mark();
        // injectWS 的内存双工流不保证 close handshake 推进；terminate 可确定性模拟浏览器异常离开。
        secondStudentSocket.terminate();
        await waitForCondition(
          async () => await prisma.annotationCollaborationPresence.count({
            where: { annotationFileId: fileId, userId: "user-student" },
          }) === 1,
          "等待第二窗口 presence 行删除超时",
        );
        await adminObserver.waitFor(
          (message) => presenceMembers(message)?.some((member) =>
            member.userId === "user-student" && member.connectionCount === 1
          ) === true,
          beforeSecondTabClose,
          "等待第二窗口离开后的 presence 快照超时",
        );

        const beforeStudentLeave = adminObserver.mark();
        firstStudentSocket.terminate();
        await adminObserver.waitFor(
          (message) => message.type === "presence.timeline_activity.changed" && message.activity === null,
          beforeStudentLeave,
          "等待远端播放头 clear 超时",
        );
        await adminObserver.waitFor(
          (message) => {
            const members = presenceMembers(message);
            return members?.length === 1 && members[0]?.userId === "user-admin";
          },
          beforeStudentLeave,
          "等待学生完全离开后的 presence 快照超时",
        );
        adminSocket.terminate();
        await waitForCondition(
          async () => await prisma.annotationCollaborationPresence.count({
            where: { annotationFileId: fileId },
          }) === 0,
          "等待 presence 行清理超时",
        );
      } finally {
        for (const socket of sockets) socket.terminate();
        await secondApp.close();
        await secondConnections.prisma.$disconnect();
        await secondConnections.pool.end();
        await secondConnections.maintenancePool.end();
        await secondConnections.collaborationPool.end();
      }
    });

    await suite.test("过期 presence 不会被迟到连接复活并由后续 join 有界清理", async () => {
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "在线成员过期清理.json",
          payload: { marker: "presence-expiry" },
        },
      });
      const fileId = String((dataOf(created.json()).resource as JsonObject).id);
      await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${fileId}/permissions/user-student`,
        payload: { capabilities: ["read"], inheritToChildren: false },
      });

      const openSocket = async (
        token: string,
        observer: ReturnType<typeof createSocketMessageObserver>,
      ) => {
        const issued = await jsonRequest(app, token, {
          method: "POST",
          url: `/api/annotation-files/${fileId}/collaboration-ticket`,
        });
        const ticket = dataOf(issued.json());
        const socket = await app.injectWS(
          String(ticket.websocketPath),
          { headers: collaborationWsHeaders(String(ticket.ticket)) },
          { onInit: (openedSocket) => openedSocket.on("message", observer.onMessage) },
        );
        await observer.waitFor(
          (message) => message.type === "session.ready",
          0,
          "等待过期清理测试 session.ready 超时",
        );
        return socket;
      };

      const studentObserver = createSocketMessageObserver();
      const studentSocket = await openSocket(studentToken, studentObserver);
      const studentPresence = await prisma.annotationCollaborationPresence.findFirstOrThrow({
        where: { annotationFileId: fileId, userId: "user-student" },
      });
      await prisma.annotationCollaborationPresence.update({
        where: { id: studentPresence.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const adminObserver = createSocketMessageObserver();
      const adminSocket = await openSocket(adminToken, adminObserver);
      await adminObserver.waitFor(
        (message) => {
          const members = presenceMembers(message);
          return members?.length === 1 && members[0]?.userId === "user-admin";
        },
        0,
        "等待过期 presence 从权威快照消失超时",
      );
      assert.equal(await prisma.annotationCollaborationPresence.count({
        where: { annotationFileId: fileId, userId: "user-student" },
      }), 0);

      studentSocket.terminate();
      adminSocket.terminate();
      await waitForCondition(
        async () => await prisma.annotationCollaborationPresence.count({
          where: { annotationFileId: fileId },
        }) === 0,
        "等待过期清理测试 presence 收口超时",
      );
    });

    await suite.test("项目递归复制复用媒体对象并重映射内部引用", async () => {
      serverErrorLogs.length = 0;
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
      assert.ok(sourceFileId, "服务器上传媒体必须关联 FileObject");
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

      // 标注导出必须返回当前权威 payload，并独立检查 download，而不是把 read 当作下载权限。
      const annotationDownload = await app.inject({
        method: "GET",
        url: `/api/resources/${sourceAnnotationId}/download`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(annotationDownload.statusCode, 200, annotationDownload.body);
      assert.match(
        String(annotationDownload.headers["content-disposition"]),
        /attachment;.*filename\*=UTF-8''/,
      );
      assert.deepEqual(JSON.parse(annotationDownload.body), {
        marker: "recursive-source-saved",
      });
      const annotationDownloadDenied = await app.inject({
        method: "GET",
        url: `/api/resources/${sourceAnnotationId}/download`,
        headers: { authorization: `Bearer ${studentToken}` },
      });
      assert.equal(annotationDownloadDenied.statusCode, 403);

      const copiedResponse = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/resources/${sourceProjectId}/copy`,
        payload: { parentId: targetProjectId },
      });
      assert.equal(
        copiedResponse.statusCode,
        200,
        `${copiedResponse.body}\n${serverErrorLogs.slice(-3).join("")}`,
      );
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
      const deniedCommentWithoutReview = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/range-comments`,
        payload: {
          commentedRevision: 1,
          scope: { startTime: 0, endTime: 10, targets: { mode: "all" } },
          body: "没有审核权限时不能评论",
        },
      });
      assert.equal(deniedCommentWithoutReview.statusCode, 403);
      const readableEmptyList = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${confirmationFileId}/confirmations`,
      });
      assert.equal(readableEmptyList.statusCode, 200);

      // 学生和教师分别取得逐资源 review；角色名称本身不绕过资源 ACL。
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

      // 评论是独立治理事实：正文必填、绑定 revision，其他 reviewer 不能撤回作者记录。
      const blankComment = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/range-comments`,
        payload: {
          commentedRevision: 1,
          scope: { startTime: 5, endTime: 8, targets: { mode: "all" } },
          body: "   ",
        },
      });
      assert.equal(blankComment.statusCode, 400);
      const commentCreated = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/range-comments`,
        payload: {
          commentedRevision: 1,
          scope: {
            startTime: 5,
            endTime: 8,
            targets: { mode: "tracks", trackIds: ["custom-action-1"] },
          },
          body: "  此处动作与唱词衔接需要复核。  ",
        },
      });
      assert.equal(commentCreated.statusCode, 200, commentCreated.body);
      const comment = dataOf(commentCreated.json());
      assert.equal(comment.body, "此处动作与唱词衔接需要复核。");
      const deniedCommentWithdraw = await jsonRequest(app, teacherToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/range-comments/${String(comment.id)}/withdraw`,
        payload: {},
      });
      assert.equal(deniedCommentWithdraw.statusCode, 403);
      const withdrawn = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/range-comments/${String(comment.id)}/withdraw`,
        payload: { reason: "  意见表述有误  " },
      });
      assert.equal(withdrawn.statusCode, 200, withdrawn.body);
      assert.equal(dataOf(withdrawn.json()).withdrawReason, "意见表述有误");
      const repeatedWithdraw = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/range-comments/${String(comment.id)}/withdraw`,
        payload: { reason: "不能覆盖原原因" },
      });
      assert.equal(repeatedWithdraw.statusCode, 200);
      assert.equal(await prisma.auditLog.count({
        where: { action: "annotation_range_comment_withdraw", resourceId: confirmationFileId },
      }), 1);

      const activeComment = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${confirmationFileId}/range-comments`,
        payload: {
          commentedRevision: 1,
          scope: { startTime: 8, endTime: 12, targets: { mode: "all" } },
          body: "保留为历史意见",
        },
      });
      assert.equal(activeComment.statusCode, 200, activeComment.body);
      const firstPage = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${confirmationFileId}/range-comments?includeWithdrawn=true&limit=1`,
      });
      assert.equal(firstPage.statusCode, 200, firstPage.body);
      const firstPageBody = dataOf(firstPage.json());
      assert.equal((firstPageBody.items as JsonObject[]).length, 1);
      assert.equal(typeof firstPageBody.nextCursor, "string");
      const secondPage = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${confirmationFileId}/range-comments?includeWithdrawn=true&limit=1&cursor=${encodeURIComponent(String(firstPageBody.nextCursor))}`,
      });
      assert.equal(secondPage.statusCode, 200, secondPage.body);
      assert.equal((dataOf(secondPage.json()).items as JsonObject[]).length, 1);

      // 其他 reviewer 不能撤销学生记录；创建者撤销幂等且只写一条撤销审计。
      const trackConfirmationId = String(trackConfirmation.id);
      const deniedOtherReviewer = await jsonRequest(app, teacherToken, {
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
      assert.equal(await prisma.annotationRangeComment.count({
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
      assert.ok(confirmationAudits
        .filter(({ action }) => action.startsWith("annotation_range_comment"))
        .every(({ detail }) => {
          const value = detail as JsonObject;
          return !("body" in value) && !("trackIds" in value) && !("payload" in value);
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
      assert.ok(fileId, "服务器上传媒体必须关联 FileObject");
      assert.ok(media.file, "服务器上传媒体必须能读取 FileObject 关系");
      assert.equal(media.file.mimeType, "video/mp4");
      // size 列已迁 BigInt，直接读 Prisma 得到 bigint，转回 number 再比较。
      assert.equal(Number(media.file.size), content.length);
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

      // 教师的全局浏览能力包含下载媒体原件，但不包含向目标目录上传或创建资源。
      const teacherDownload = await app.inject({
        method: "GET",
        url: `/api/files/${fileId}/content`,
        headers: { authorization: `Bearer ${teacherToken}` },
      });
      assert.equal(teacherDownload.statusCode, 200);
      assert.deepEqual(teacherDownload.rawPayload, content);

      // 资源管理器下载路由按资源 id 流式返回媒体，并支持按钮使用的一次性查询参数鉴权。
      const mediaResourceDownload = await app.inject({
        method: "GET",
        url: `/api/resources/${mediaResourceId}/download?access_token=${encodeURIComponent(teacherToken)}`,
      });
      assert.equal(mediaResourceDownload.statusCode, 200);
      assert.equal(mediaResourceDownload.headers["content-type"], "video/mp4");
      assert.match(
        String(mediaResourceDownload.headers["content-disposition"]),
        /attachment;.*filename\*=UTF-8''sample\.mp4/,
      );
      assert.deepEqual(mediaResourceDownload.rawPayload, content);

      const containerDownload = await app.inject({
        method: "GET",
        url: `/api/resources/${projectId}/download`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(containerDownload.statusCode, 400);

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
          size: 24n,
          storageKey: "orphan/unreferenced.mp4",
          ownerUserId: admin.id,
          createdAt: oldDate,
        },
      });
      const missing = await prisma.fileObject.create({
        data: {
          name: "missing.mp4",
          mimeType: "video/mp4",
          size: 24n,
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
            create: {
              sourceType: "uploaded",
              mediaKind: "video",
              fileId: missing.id,
              mimeType: "video/mp4",
              size: 24n,
            },
          },
        },
      });
      const referencedAnalysisAsset = await prisma.mediaAnalysisAsset.findFirstOrThrow({
        orderBy: { createdAt: "asc" },
      });
      const referencedAnalysisPath = path.join(storageRoot, referencedAnalysisAsset.storageKey);
      await utimes(referencedAnalysisPath, oldDate, oldDate);
      const missingAnalysisAsset = await prisma.mediaAnalysisAsset.create({
        data: {
          runId: referencedAnalysisAsset.runId,
          kind: "waveform",
          preset: "lifecycle-missing",
          level: 0,
          tileIndex: 0,
          startTime: 0,
          endTime: 1,
          mimeType: "application/vnd.xiqu.waveform-tile",
          size: 24n,
          checksum: "0".repeat(64),
          storageKey: "orphan/missing-analysis.xqa",
          createdAt: oldDate,
        },
      });

      const denied = await jsonRequest(app, teacherToken, {
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
      assert.ok(items.some((item) =>
        item.category === "missing_binary" &&
        item.analysisAssetId === missingAnalysisAsset.id));
      assert.equal(items.some((item) =>
        item.category === "orphan_binary" &&
        item.storageKey === referencedAnalysisAsset.storageKey), false);

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
      await access(referencedAnalysisPath);
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
      const acceptedStructureTransaction = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-structure-transaction-accepted",
          baseRevision: 1,
          action: "annotation.track.structure.transaction.apply",
          payload: {
            version: 1,
            command: {
              type: "annotation.track.structure.transaction.apply",
              commands: [{
                type: "annotation.track.order.update",
                before: ["character-track", "custom-track-one"],
                after: ["custom-track-one", "character-track"],
              }],
            },
          },
          mutationLeaseToken: leaseToken,
        },
      });
      assert.equal(acceptedStructureTransaction.statusCode, 200, acceptedStructureTransaction.body);

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
          clientOperationIds: ["lease-op-accepted", "lease-structure-transaction-accepted"],
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
      const structureTransactionWithoutLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-structure-transaction-without-token",
          baseRevision: 2,
          action: "annotation.track.structure.transaction.apply",
          payload: {
            version: 1,
            command: {
              type: "annotation.track.structure.transaction.apply",
              commands: [{
                type: "annotation.track.order.update",
                before: ["character-track", "custom-track-one"],
                after: ["custom-track-one", "character-track"],
              }],
            },
          },
        },
      });
      assert.equal(structureTransactionWithoutLease.statusCode, 409, structureTransactionWithoutLease.body);
      assert.equal(
        (errorOf(structureTransactionWithoutLease.json()).details as JsonObject).code,
        "annotation_mutation_lease_required",
      );

      const snapshotBoundaryPayload = {
        version: 1,
        command: {
          type: "annotation.project.snapshot.boundary",
          boundaryId: "api-boundary-repair-one",
          kind: "repair_sentence_character_track",
          direction: "forward",
        },
      };
      const boundaryWithoutLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-snapshot-boundary-without-token",
          baseRevision: 2,
          action: "annotation.project.snapshot.boundary",
          payload: snapshotBoundaryPayload,
        },
      });
      assert.equal(boundaryWithoutLease.statusCode, 409, boundaryWithoutLease.body);

      const secondLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { baseRevision: 2, purpose: "bulk_repair" },
      });
      const secondToken = String(dataOf(secondLease.json()).token);
      const acceptedBoundary = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/operations`,
        payload: {
          clientOperationId: "lease-snapshot-boundary-accepted",
          baseRevision: 2,
          action: "annotation.project.snapshot.boundary",
          payload: snapshotBoundaryPayload,
          mutationLeaseToken: secondToken,
        },
      });
      assert.equal(acceptedBoundary.statusCode, 200, acceptedBoundary.body);
      assert.equal(dataOf(acceptedBoundary.json()).replayability, "requires_snapshot");
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

    await suite.test("原子领域命令批次按序应用、幂等确认并在失败时完整回滚", async () => {
      const project = createAtomicCommandProject();
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "atomic-command-commit.json",
          payload: project,
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const fileId = String((dataOf(created.json()).resource as JsonObject).id);
      const firstEnvelope = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-1",
        before: { startTime: 1, endTime: 2 },
        after: { startTime: 2, endTime: 3 },
      }]);
      const dependentEnvelope = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-1",
        before: { startTime: 2, endTime: 3 },
        after: { startTime: 3, endTime: 4 },
      }]);
      assert.ok(firstEnvelope && dependentEnvelope);
      const request = {
        baseRevision: 1,
        operations: [{
          clientOperationId: "atomic-op-1",
          localRevision: 11,
          action: firstEnvelope.command.type,
          payload: firstEnvelope,
        }, {
          clientOperationId: "atomic-op-2",
          localRevision: 12,
          action: dependentEnvelope.command.type,
          payload: dependentEnvelope,
        }],
      };

      const committed = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: request,
      });
      assert.equal(committed.statusCode, 200, committed.body);
      const committedData = dataOf(committed.json());
      assert.equal(committedData.committedRevision, 2);
      const committedOperations = committedData.operations as JsonObject[];
      assert.deepEqual(
        committedOperations.map((operation) => operation.clientOperationId),
        ["atomic-op-1", "atomic-op-2"],
      );
      assert.deepEqual(
        committedOperations.map((operation) => operation.committedRevision),
        [2, 2],
      );
      assert.ok(Number(committedOperations[0]?.sequence) < Number(committedOperations[1]?.sequence));

      const storedAfterCommit = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: fileId },
      });
      const storedProject = storedAfterCommit.payload as ReturnType<typeof createAtomicCommandProject>;
      assert.equal(storedAfterCommit.revision, 2);
      assert.equal(storedProject.characterAnnotations[0]?.startTime, 3);
      assert.equal(storedProject.characterAnnotations[0]?.endTime, 4);
      assert.equal(await prisma.annotationRecoverySnapshot.count({
        where: { annotationFileId: fileId, revision: 1 },
      }), 1);
      assert.equal(await prisma.auditLog.count({
        where: {
          resourceId: fileId,
          action: "annotation_file_save",
          detail: { path: ["commitMode"], equals: "domain_command_batch" },
        },
      }), 1);

      // 完全相同的网络重试返回原确认，不能再次推进 revision、创建快照或写审计。
      const replayed = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: request,
      });
      assert.equal(replayed.statusCode, 200, replayed.body);
      assert.deepEqual(
        (dataOf(replayed.json()).operations as JsonObject[]).map((operation) => operation.id),
        committedOperations.map((operation) => operation.id),
      );
      assert.equal((await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: fileId },
      })).revision, 2);
      assert.equal(await prisma.auditLog.count({
        where: { resourceId: fileId, action: "annotation_file_save" },
      }), 1);

      const changedIdempotentRequest = structuredClone(request);
      changedIdempotentRequest.operations[0]!.payload.command.items[0]!.after.startTime = 2.25;
      const changedReplay = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: changedIdempotentRequest,
      });
      assert.equal(changedReplay.statusCode, 409);
      assert.equal(
        (errorOf(changedReplay.json()).details as JsonObject).code,
        "idempotency_conflict",
      );

      const reorderedReplay = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: { ...request, operations: [...request.operations].reverse() },
      });
      assert.equal(reorderedReplay.statusCode, 409);
      assert.equal(
        (errorOf(reorderedReplay.json()).details as JsonObject).code,
        "annotation_command_batch_replay_ambiguous",
      );
      const subsetReplay = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: { baseRevision: 1, operations: [request.operations[0]] },
      });
      assert.equal(subsetReplay.statusCode, 409);
      assert.equal(
        (errorOf(subsetReplay.json()).details as JsonObject).code,
        "annotation_command_batch_replay_ambiguous",
      );
      const partialReplay = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 1,
          operations: [request.operations[0], {
            ...request.operations[1],
            clientOperationId: "atomic-op-new",
          }],
        },
      });
      assert.equal(partialReplay.statusCode, 409);
      assert.equal(
        (errorOf(partialReplay.json()).details as JsonObject).code,
        "annotation_command_batch_partial_replay",
      );

      const validBeforeBlocked = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-1",
        before: { startTime: 3, endTime: 4 },
        after: { startTime: 4, endTime: 5 },
      }]);
      const blockedSecond = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-1",
        before: { startTime: 99, endTime: 100 },
        after: { startTime: 100, endTime: 101 },
      }]);
      assert.ok(validBeforeBlocked && blockedSecond);
      const operationsBeforeBlocked = await prisma.annotationOperation.count({
        where: { annotationFileId: fileId },
      });
      const blocked = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 2,
          operations: [{
            clientOperationId: "atomic-blocked-1",
            action: validBeforeBlocked.command.type,
            payload: validBeforeBlocked,
          }, {
            clientOperationId: "atomic-blocked-2",
            action: blockedSecond.command.type,
            payload: blockedSecond,
          }],
        },
      });
      assert.equal(blocked.statusCode, 409, blocked.body);
      const blockedDetails = errorOf(blocked.json()).details as JsonObject;
      assert.equal(blockedDetails.code, "annotation_command_precondition_failed");
      assert.equal(blockedDetails.operationIndex, 1);
      const storedAfterBlocked = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: fileId },
      });
      assert.equal(storedAfterBlocked.revision, 2);
      assert.equal(
        (storedAfterBlocked.payload as ReturnType<typeof createAtomicCommandProject>)
          .characterAnnotations[0]?.startTime,
        3,
      );
      assert.equal(await prisma.annotationOperation.count({
        where: { annotationFileId: fileId },
      }), operationsBeforeBlocked);
    });

    await suite.test("双账号旧基线冲突、无交集重提与撤权均保持原子边界", async () => {
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "atomic-two-account-rebase.json",
          payload: createAtomicCommandProject(),
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const fileId = String((dataOf(created.json()).resource as JsonObject).id);
      const grant = await jsonRequest(app, adminToken, {
        method: "PUT",
        url: `/api/resources/${fileId}/permissions/user-student`,
        payload: { capabilities: ["read", "write"], inheritToChildren: false },
      });
      assert.equal(grant.statusCode, 200, grant.body);

      // 两个账号必须确实从同一 revision/payload 起步，不能用测试内变量冒充真实读取。
      const [adminRead, studentRead] = await Promise.all([
        jsonRequest(app, adminToken, {
          method: "GET",
          url: `/api/annotation-files/${fileId}`,
        }),
        jsonRequest(app, studentToken, {
          method: "GET",
          url: `/api/annotation-files/${fileId}`,
        }),
      ]);
      assert.equal(adminRead.statusCode, 200, adminRead.body);
      assert.equal(studentRead.statusCode, 200, studentRead.body);
      assert.equal(dataOf(adminRead.json()).revision, 1);
      assert.equal(dataOf(studentRead.json()).revision, 1);
      assert.deepEqual(dataOf(adminRead.json()).payload, dataOf(studentRead.json()).payload);

      const adminEnvelope = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-1",
        before: { startTime: 1, endTime: 2 },
        after: { startTime: 1.25, endTime: 2.25 },
      }]);
      const studentEnvelope = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-2",
        before: { startTime: 2, endTime: 3 },
        after: { startTime: 2.5, endTime: 3.5 },
      }]);
      assert.ok(adminEnvelope && studentEnvelope);
      const adminCommit = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 1,
          operations: [{
            clientOperationId: "two-account-admin-a",
            localRevision: 1,
            action: adminEnvelope.command.type,
            payload: adminEnvelope,
          }],
        },
      });
      assert.equal(adminCommit.statusCode, 200, adminCommit.body);
      assert.equal(dataOf(adminCommit.json()).committedRevision, 2);

      const factsAfterAdmin = await readAnnotationCommitFacts(prisma, fileId);
      const staleStudentCommit = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 1,
          operations: [{
            clientOperationId: "two-account-student-b",
            localRevision: 1,
            action: studentEnvelope.command.type,
            payload: studentEnvelope,
          }],
        },
      });
      assert.equal(staleStudentCommit.statusCode, 409, staleStudentCommit.body);
      assert.equal(
        (errorOf(staleStudentCommit.json()).details as JsonObject).code,
        "annotation_command_batch_revision_conflict",
      );
      assert.deepEqual(
        await readAnnotationCommitFacts(prisma, fileId),
        factsAfterAdmin,
        "旧 revision 冲突不能写 operation、快照、审计或推进 revision",
      );

      // Web 纯 rebase planner 已证明无交集 envelope 可重放；服务端仍以最新 revision 和原 operation id 权威提交。
      const latestForStudent = await jsonRequest(app, studentToken, {
        method: "GET",
        url: `/api/annotation-files/${fileId}`,
      });
      assert.equal(dataOf(latestForStudent.json()).revision, 2);
      const rebasedStudentCommit = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 2,
          operations: [{
            clientOperationId: "two-account-student-b",
            localRevision: 1,
            action: studentEnvelope.command.type,
            payload: studentEnvelope,
          }],
        },
      });
      assert.equal(rebasedStudentCommit.statusCode, 200, rebasedStudentCommit.body);
      assert.equal(dataOf(rebasedStudentCommit.json()).committedRevision, 3);
      const storedAfterRebase = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: fileId },
      });
      const rebasedProject = storedAfterRebase.payload as ReturnType<typeof createAtomicCommandProject>;
      assert.equal(rebasedProject.characterAnnotations[0]?.startTime, 1.25);
      assert.equal(rebasedProject.characterAnnotations[1]?.startTime, 2.5);

      // 同目标旧基线仍只能得到 revision conflict；客户端纯判定发现 before mismatch 后不会发第二次写。
      const sameTargetEnvelope = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-1",
        before: { startTime: 1.25, endTime: 2.25 },
        after: { startTime: 4, endTime: 5 },
      }]);
      const winningEnvelope = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-1",
        before: { startTime: 1.25, endTime: 2.25 },
        after: { startTime: 5, endTime: 6 },
      }]);
      assert.ok(sameTargetEnvelope && winningEnvelope);
      const winningCommit = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 3,
          operations: [{
            clientOperationId: "two-account-admin-conflict",
            action: winningEnvelope.command.type,
            payload: winningEnvelope,
          }],
        },
      });
      assert.equal(winningCommit.statusCode, 200, winningCommit.body);
      const factsBeforeSameTarget = await readAnnotationCommitFacts(prisma, fileId);
      const staleSameTarget = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 3,
          operations: [{
            clientOperationId: "two-account-student-conflict",
            action: sameTargetEnvelope.command.type,
            payload: sameTargetEnvelope,
          }],
        },
      });
      assert.equal(staleSameTarget.statusCode, 409, staleSameTarget.body);
      assert.deepEqual(await readAnnotationCommitFacts(prisma, fileId), factsBeforeSameTarget);

      // 本地可重放判定从来不是授权证明；撤权后即使 envelope 内容无冲突，服务端仍必须拒绝且零副作用。
      const revokedEnvelope = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-2",
        before: { startTime: 2.5, endTime: 3.5 },
        after: { startTime: 3, endTime: 4 },
      }]);
      assert.ok(revokedEnvelope);
      const revoke = await jsonRequest(app, adminToken, {
        method: "DELETE",
        url: `/api/resources/${fileId}/permissions/user-student`,
      });
      assert.equal(revoke.statusCode, 200, revoke.body);
      const breakInheritance = await jsonRequest(app, adminToken, {
        method: "PATCH",
        url: `/api/resources/${fileId}/permission-inheritance`,
        payload: { breakPermissionInheritance: true },
      });
      assert.equal(breakInheritance.statusCode, 200, breakInheritance.body);
      const factsBeforeForbidden = await readAnnotationCommitFacts(prisma, fileId);
      const forbidden = await jsonRequest(app, studentToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 4,
          operations: [{
            clientOperationId: "two-account-student-revoked",
            action: revokedEnvelope.command.type,
            payload: revokedEnvelope,
          }],
        },
      });
      assert.equal(forbidden.statusCode, 403, forbidden.body);
      assert.deepEqual(await readAnnotationCommitFacts(prisma, fileId), factsBeforeForbidden);
    });

    await suite.test("原子领域命令批次拒绝畸形文档并串行化同 revision 并发", async () => {
      const malformed = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "atomic-malformed.json",
          payload: { marker: "legacy" },
        },
      });
      const malformedId = String((dataOf(malformed.json()).resource as JsonObject).id);
      const envelope = buildTimelineTimingUpdateEnvelope([{
        entityType: "character",
        entityId: "atomic-char-1",
        before: { startTime: 1, endTime: 2 },
        after: { startTime: 2, endTime: 3 },
      }]);
      assert.ok(envelope);
      const malformedCommit = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${malformedId}/command-batches`,
        payload: {
          baseRevision: 1,
          operations: [{
            clientOperationId: "atomic-malformed-op",
            action: envelope.command.type,
            payload: envelope,
          }],
        },
      });
      assert.equal(malformedCommit.statusCode, 409, malformedCommit.body);
      assert.equal(
        (errorOf(malformedCommit.json()).details as JsonObject).code,
        "annotation_payload_invalid",
      );
      assert.equal(await prisma.annotationOperation.count({
        where: { annotationFileId: malformedId },
      }), 0);

      const concurrent = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "atomic-concurrent.json",
          payload: createAtomicCommandProject(),
        },
      });
      const concurrentId = String((dataOf(concurrent.json()).resource as JsonObject).id);
      const makeRequest = (clientOperationId: string) => jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${concurrentId}/command-batches`,
        payload: {
          baseRevision: 1,
          operations: [{
            clientOperationId,
            action: envelope.command.type,
            payload: envelope,
          }],
        },
      });
      const responses = await Promise.all([
        makeRequest("atomic-concurrent-a"),
        makeRequest("atomic-concurrent-b"),
      ]);
      assert.deepEqual(
        responses.map((response) => response.statusCode).sort(),
        [200, 409],
      );
      assert.equal((await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: concurrentId },
      })).revision, 2);
      assert.equal(await prisma.annotationOperation.count({
        where: { annotationFileId: concurrentId },
      }), 1);
    });

    await suite.test("原子结构命令要求用途匹配的租约并在提交后释放", async () => {
      const project = createAtomicCommandProject();
      const nextProject = structuredClone(project);
      nextProject.customTracks[0]!.name = "已重命名轨道";
      const envelope = buildProjectCustomTrackStructureCommand(
        project,
        nextProject,
        ["atomic-custom-track"],
      );
      assert.ok(envelope);
      const created = await jsonRequest(app, adminToken, {
        method: "POST",
        url: "/api/annotation-files",
        payload: {
          parentId: projectId,
          name: "atomic-structure-command.json",
          payload: project,
        },
      });
      const fileId = String((dataOf(created.json()).resource as JsonObject).id);
      const operation = {
        clientOperationId: "atomic-structure-op",
        action: envelope.command.type,
        payload: envelope,
      };

      const withoutLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: { baseRevision: 1, operations: [operation] },
      });
      assert.equal(withoutLease.statusCode, 409);
      assert.equal(
        (errorOf(withoutLease.json()).details as JsonObject).code,
        "annotation_mutation_lease_required",
      );

      const wrongLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { baseRevision: 1, purpose: "bulk_import" },
      });
      const wrongToken = String(dataOf(wrongLease.json()).token);
      const wrongPurpose = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 1,
          mutationLeaseToken: wrongToken,
          operations: [operation],
        },
      });
      assert.equal(wrongPurpose.statusCode, 409);
      assert.equal(
        (errorOf(wrongPurpose.json()).details as JsonObject).code,
        "annotation_mutation_lease_purpose_mismatch",
      );
      await jsonRequest(app, adminToken, {
        method: "DELETE",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { token: wrongToken },
      });

      const matchingLease = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/mutation-lease`,
        payload: { baseRevision: 1, purpose: "track_structure" },
      });
      const matchingToken = String(dataOf(matchingLease.json()).token);
      const committed = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 1,
          mutationLeaseToken: matchingToken,
          operations: [operation],
        },
      });
      assert.equal(committed.statusCode, 200, committed.body);
      assert.equal(await prisma.annotationMutationLease.count({
        where: { annotationFileId: fileId },
      }), 0);
      const stored = await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: fileId },
      });
      assert.equal(
        (stored.payload as ReturnType<typeof createAtomicCommandProject>)
          .customTracks[0]?.name,
        "已重命名轨道",
      );

      // snapshot/legacy action 不属于可重放批次，必须在路由 parser 阶段返回 400。
      const legacy = await jsonRequest(app, adminToken, {
        method: "POST",
        url: `/api/annotation-files/${fileId}/command-batches`,
        payload: {
          baseRevision: 2,
          operations: [{
            clientOperationId: "atomic-legacy-op",
            action: "project.commit",
            payload: { historyAction: "edit" },
          }],
        },
      });
      assert.equal(legacy.statusCode, 400);
    });
  } finally {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
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

function collaborationWsHeaders(ticket: string) {
  return {
    "sec-websocket-protocol": [
      ANNOTATION_COLLABORATION_WEBSOCKET_PROTOCOL,
      `${ANNOTATION_COLLABORATION_TICKET_PROTOCOL_PREFIX}${ticket}`,
    ].join(", "),
  };
}

function dataOf(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok("data" in value);
  const data = (value as { data: unknown }).data;
  assert.ok(data && typeof data === "object" && !Array.isArray(data));
  return data as JsonObject;
}

type TestPrisma = ReturnType<typeof createTestPrisma>["prisma"];

// 冲突矩阵统一读取四类提交事实，避免只检查 HTTP 状态而漏掉事务中的半写入。
async function readAnnotationCommitFacts(prisma: TestPrisma, annotationFileId: string) {
  const [file, operationCount, snapshotCount, saveAuditCount] = await Promise.all([
    prisma.annotationFile.findUniqueOrThrow({ where: { resourceId: annotationFileId } }),
    prisma.annotationOperation.count({ where: { annotationFileId } }),
    prisma.annotationRecoverySnapshot.count({ where: { annotationFileId } }),
    prisma.auditLog.count({
      where: {
        resourceId: annotationFileId,
        action: "annotation_file_save",
        detail: { path: ["commitMode"], equals: "domain_command_batch" },
      },
    }),
  ]);
  return {
    revision: file.revision,
    operationCount,
    snapshotCount,
    saveAuditCount,
  };
}

// 原子命令集成测试只保留最小当前格式，但所有必填领域集合都存在，避免测试绕过生产 schema。
function createAtomicCommandProject(): ProjectData {
  return {
    video: { url: "", name: null, source: "url" as const },
    sentenceAnnotationConfig: { roleOptions: ["闺门旦"] },
    subtitleLines: [{
      id: "atomic-line-1",
      text: "那",
      startTime: 1,
      endTime: 4,
      deliveryMode: "sung",
      roleType: "闺门旦",
    }],
    characterAnnotations: [{
      id: "atomic-char-1",
      lineId: "atomic-line-1",
      char: "那",
      startTime: 1,
      endTime: 2,
    }, {
      id: "atomic-char-2",
      lineId: "atomic-line-1",
      char: "一",
      startTime: 2,
      endTime: 3,
    }],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [{
      id: "character-track" as const,
      name: "逐字文字轨",
      type: "character" as const,
      attachedPointTracks: [],
    }],
    customTracks: [{
      id: "atomic-custom-track",
      name: "测试轨道",
      trackType: "text" as const,
      typeOptions: ["动作"],
      blocks: [],
      attachedPointTracks: [],
    }],
    activeTrackOrder: ["character-track", "atomic-custom-track"],
  };
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createSocketMessageObserver() {
  const messages: JsonObject[] = [];
  const waiters = new Set<{
    predicate: (message: JsonObject) => boolean;
    afterIndex: number;
    resolve: (message: JsonObject) => void;
  }>();
  return {
    onMessage(payload: unknown) {
      const message = JSON.parse(String(payload)) as JsonObject;
      messages.push(message);
      const messageIndex = messages.length - 1;
      for (const waiter of [...waiters]) {
        if (messageIndex >= waiter.afterIndex && waiter.predicate(message)) {
          waiters.delete(waiter);
          waiter.resolve(message);
        }
      }
    },
    mark: () => messages.length,
    waitFor(
      predicate: (message: JsonObject) => boolean,
      afterIndex: number,
      timeoutMessage: string,
    ) {
      const existing = messages.slice(afterIndex).find(predicate);
      if (existing) return Promise.resolve(existing);
      return withTimeout(new Promise<JsonObject>((resolve) => {
        waiters.add({ predicate, afterIndex, resolve });
      }), timeoutMessage);
    },
  };
}

function presenceMembers(message: JsonObject) {
  if (message.type !== "presence.snapshot" || !Array.isArray(message.members)) return null;
  return message.members as Array<JsonObject & { userId: string; connectionCount: number }>;
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

// 44 字节 PCM WAV 头足以通过上传签名校验，分析 worker 测试会使用独立的真实音频夹具。
function minimalWav() {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(0, 40);
  return buffer;
}
