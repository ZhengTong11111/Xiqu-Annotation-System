import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { ProjectData } from "@xiqu/document-model";
import { buildApiApp } from "../src/app.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

type JsonObject = Record<string, unknown>;

test("保存失败恢复备份使用源文件权限、项目目录、媒体关联和幂等资源", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "xiqu-recovery-backup-"));
  const { prisma, pool, maintenancePool, collaborationPool, schema } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const app = await buildApiApp({
    prisma,
    maintenancePool,
    collaborationPool,
    databaseSchema: schema,
    storage: new LocalObjectStorage(storageRoot),
    logger: false,
    seed: true,
  });
  await app.ready();

  try {
    const adminToken = (await login(app, "admin", "admin123")).accessToken;
    const studentToken = (await login(app, "student", "student123")).accessToken;
    const admin = await prisma.user.findUniqueOrThrow({ where: { accountName: "admin" } });
    const student = await prisma.user.findUniqueOrThrow({ where: { accountName: "student" } });

    const project = await prisma.resourceEntry.create({
      data: {
        type: "project",
        name: "恢复备份项目",
        ownerUserId: admin.id,
        projectMetadata: { create: { description: "integration" } },
      },
    });
    const media = await prisma.resourceEntry.create({
      data: {
        parentId: project.id,
        type: "media_file",
        name: "主视频",
        ownerUserId: admin.id,
        mediaFile: {
          create: {
            sourceType: "aliyun_vod",
            mediaKind: "video",
            duration: 120,
            aliyunVodVideoId: "00000000000000000000000000000000",
            aliyunVodRegion: "cn-shanghai",
          },
        },
      },
    });
    const sourceResponse = await jsonRequest(app, adminToken, {
      method: "POST",
      url: "/api/annotation-files",
      payload: {
        parentId: project.id,
        name: "寻梦标注.json",
        payload: createProjectFixture(),
        mediaResourceId: media.id,
      },
    });
    assert.equal(sourceResponse.statusCode, 200, sourceResponse.body);
    const sourceId = String(recordOf(dataOf(sourceResponse.json()).resource).id);
    await prisma.resourcePermission.create({
      data: {
        resourceId: sourceId,
        userId: student.id,
        capabilities: ["read", "write"],
        inheritToChildren: false,
        createdBy: admin.id,
      },
    });

    const unsavedProject = createProjectFixture();
    unsavedProject.video.name = "浏览器中尚未保存的视频名";
    const clientBackupId = "00000000-0000-8000-8000-000000000123";
    const first = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${sourceId}/recovery-backups`,
      payload: {
        clientBackupId,
        sourceRevision: 1,
        failureCount: 3,
        payload: unsavedProject,
      },
    });
    assert.equal(first.statusCode, 200, first.body);
    const firstData = dataOf(first.json());
    const firstFile = recordOf(firstData.file);
    const firstResource = recordOf(firstFile.resource);
    const folder = recordOf(firstData.folder);
    assert.equal(firstData.replayed, false);
    assert.equal(folder.name, "backup");
    assert.equal(folder.parentId, project.id);
    assert.equal(recordOf(firstResource.owner).accountName, "student");
    assert.match(String(firstResource.name), /^寻梦标注\.backup\.student\.\d{8}-\d{6}-\d{3}(?:-\d+)?\.json$/);
    assert.equal(firstFile.mediaResourceId, media.id);
    assert.equal(
      recordOf(recordOf(firstFile.payload).video).name,
      "浏览器中尚未保存的视频名",
    );

    const second = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${sourceId}/recovery-backups`,
      payload: {
        clientBackupId,
        sourceRevision: 1,
        failureCount: 4,
        payload: unsavedProject,
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(dataOf(second.json()).replayed, true);
    assert.equal(
      await prisma.resourceEntry.count({ where: { parentId: String(folder.id) } }),
      1,
    );

    const folderPermission = await prisma.resourcePermission.findUnique({
      where: { resourceId_userId: { resourceId: String(folder.id), userId: student.id } },
    });
    assert.deepEqual(folderPermission?.capabilities, ["read"]);
    assert.equal(folderPermission?.inheritToChildren, false);
    const audit = await prisma.auditLog.findFirst({
      where: { resourceId: String(firstResource.id), action: "resource_create" },
    });
    assert.equal(recordOf(audit?.detail).reason, "automatic_recovery_backup");
    assert.doesNotMatch(JSON.stringify(audit?.detail), /浏览器中尚未保存的内容/);

    const changedPayload = structuredClone(unsavedProject);
    changedPayload.video.name = "同一幂等键下的不同内容";
    const mismatch = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${sourceId}/recovery-backups`,
      payload: {
        clientBackupId,
        sourceRevision: 1,
        failureCount: 5,
        payload: changedPayload,
      },
    });
    assert.equal(mismatch.statusCode, 409, mismatch.body);

    await prisma.resourcePermission.delete({
      where: { resourceId_userId: { resourceId: sourceId, userId: student.id } },
    });
    const revoked = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${sourceId}/recovery-backups`,
      payload: {
        clientBackupId: "00000000-0000-8000-8000-000000000124",
        sourceRevision: 1,
        failureCount: 3,
        payload: unsavedProject,
      },
    });
    assert.equal(revoked.statusCode, 403, revoked.body);
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
  assert.equal(response.statusCode, 200, response.body);
  return dataOf(response.json()) as { accessToken: string };
}

function jsonRequest(app: FastifyInstance, token: string, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: { ...options.headers, authorization: `Bearer ${token}` },
  });
}

function dataOf(value: unknown): JsonObject {
  const envelope = recordOf(value);
  assert.ok("data" in envelope);
  return recordOf(envelope.data);
}

function recordOf(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

// 后端集成测试只需要一份严格的当前格式，不引入依赖浏览器构建配置的前端演示数据。
function createProjectFixture(): ProjectData {
  return {
    video: {
      url: "",
      name: "主视频",
      source: "url",
      filePath: null,
      requiresManualImport: false,
    },
    sentenceAnnotationConfig: { roleOptions: [] },
    subtitleLines: [],
    characterAnnotations: [],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字",
      type: "character",
      attachedPointTracks: [],
    }],
    customTracks: [],
    activeTrackOrder: ["character-track"],
  };
}
