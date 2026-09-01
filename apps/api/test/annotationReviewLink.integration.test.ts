import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApiApp } from "../src/app.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

type JsonObject = Record<string, unknown>;

test("审核包预检、关联与撤销不修改来源审核事实", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "xiqu-review-link-test-"));
  const connections = createTestPrisma();
  const { prisma, pool, maintenancePool, collaborationPool, schema } = connections;
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
        name: "审核链接测试",
        ownerUserId: admin.id,
        projectMetadata: { create: {} },
      },
    });
    const media = await prisma.resourceEntry.create({
      data: {
        parentId: project.id,
        type: "media_file",
        name: "目标视频",
        ownerUserId: admin.id,
        mediaFile: {
          create: {
            sourceType: "aliyun_vod",
            mediaKind: "video",
            duration: 20,
            aliyunVodVideoId: "test-video",
            aliyunVodRegion: "cn-test",
          },
        },
      },
    });
    const source = await createAnnotationFile(prisma, {
      parentId: project.id,
      ownerUserId: admin.id,
      name: "来源.json",
    });
    const target = await createAnnotationFile(prisma, {
      parentId: project.id,
      ownerUserId: admin.id,
      name: "目标.json",
      mediaResourceId: media.id,
    });
    await prisma.resourcePermission.createMany({
      data: [
        {
          resourceId: source.id,
          userId: student.id,
          capabilities: ["read"],
          inheritToChildren: false,
          createdBy: admin.id,
        },
        {
          resourceId: target.id,
          userId: student.id,
          capabilities: ["read"],
          inheritToChildren: false,
          createdBy: admin.id,
        },
      ],
    });
    await prisma.annotationConfirmation.create({
      data: {
        annotationFileId: source.id,
        confirmedRevision: 1,
        startTime: 1,
        endTime: 2,
        targetMode: "tracks",
        trackIds: ["character-track"],
        note: "已核对",
        createdBy: admin.id,
      },
    });
    await prisma.annotationRangeComment.create({
      data: {
        annotationFileId: source.id,
        commentedRevision: 1,
        startTime: 3,
        endTime: 4,
        targetMode: "all",
        kind: "review_comment",
        body: "需要关注",
        createdBy: admin.id,
      },
    });

    const reviewPackage = await exportPackage(app, adminToken, source.id, "来源.json");
    const sourceBefore = await sourceReviewSnapshot(prisma, source.id);

    // read 不能代替 review；服务端不能因为客户端已经生成审核包就跳过目标权限。
    const forbidden = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/dry-run`,
      payload: { targetRevision: 1, reviewPackage },
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);

    const dryRun = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/dry-run`,
      payload: { targetRevision: 1, reviewPackage },
    });
    assert.equal(dryRun.statusCode, 200, dryRun.body);
    assert.equal(dataOf(dryRun.json()).status, "ready");
    assert.deepEqual(dataOf(dryRun.json()).matchedTrackIds, ["character-track"]);

    // 目标 revision 和来源事实都必须在服务端重新核验，不能信任客户端曾经通过的预检结果。
    const staleTarget = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/dry-run`,
      payload: { targetRevision: 2, reviewPackage },
    });
    assert.equal(staleTarget.statusCode, 409, staleTarget.body);

    const tamperedPackage = structuredClone(reviewPackage) as JsonObject;
    const tamperedRecords = tamperedPackage.records as JsonObject;
    const tamperedComments = tamperedRecords.rangeRecords as JsonObject[];
    tamperedComments[0].body = "客户端篡改后的正文";
    const tamperedSource = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/dry-run`,
      payload: { targetRevision: 1, reviewPackage: tamperedPackage },
    });
    assert.equal(tamperedSource.statusCode, 409, tamperedSource.body);

    const missingTrackSource = await createAnnotationFile(prisma, {
      parentId: project.id,
      ownerUserId: admin.id,
      name: "缺失轨道来源.json",
    });
    await prisma.annotationConfirmation.create({
      data: {
        annotationFileId: missingTrackSource.id,
        confirmedRevision: 1,
        startTime: 5,
        endTime: 6,
        targetMode: "tracks",
        trackIds: ["source-only-track"],
        createdBy: admin.id,
      },
    });
    const missingTrackPackage = await exportPackage(
      app,
      adminToken,
      missingTrackSource.id,
      "缺失轨道来源.json",
    );
    const missingTrack = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/dry-run`,
      payload: { targetRevision: 1, reviewPackage: missingTrackPackage },
    });
    assert.equal(missingTrack.statusCode, 400, missingTrack.body);

    const outOfRangeSource = await createAnnotationFile(prisma, {
      parentId: project.id,
      ownerUserId: admin.id,
      name: "越界范围来源.json",
    });
    await prisma.annotationConfirmation.create({
      data: {
        annotationFileId: outOfRangeSource.id,
        confirmedRevision: 1,
        startTime: 19,
        endTime: 21,
        targetMode: "all",
        createdBy: admin.id,
      },
    });
    const outOfRangePackage = await exportPackage(
      app,
      adminToken,
      outOfRangeSource.id,
      "越界范围来源.json",
    );
    const outOfRange = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/dry-run`,
      payload: { targetRevision: 1, reviewPackage: outOfRangePackage },
    });
    assert.equal(outOfRange.statusCode, 400, outOfRange.body);

    const created = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links`,
      payload: { targetRevision: 1, reviewPackage },
    });
    assert.equal(created.statusCode, 200, created.body);
    const link = dataOf(created.json());
    assert.equal(link.targetAnnotationFileId, target.id);
    assert.equal((link.source as JsonObject).annotationFileId, source.id);
    assert.deepEqual(await sourceReviewSnapshot(prisma, source.id), sourceBefore);

    const duplicate = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links`,
      payload: { targetRevision: 1, reviewPackage },
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(await prisma.annotationReviewLink.count(), 1);

    const revoked = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/${String(link.id)}/revoke`,
      payload: { reason: "目标文件不再需要该来源" },
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.ok(dataOf(revoked.json()).revokedAt);
    assert.deepEqual(await sourceReviewSnapshot(prisma, source.id), sourceBefore);

    // 模糊重试撤销必须幂等，不重复写审计，也不改变第一次撤销的生命周期事实。
    const repeatedRevoke = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/${String(link.id)}/revoke`,
      payload: { reason: "重复请求不应覆盖原原因" },
    });
    assert.equal(repeatedRevoke.statusCode, 200, repeatedRevoke.body);
    assert.equal(dataOf(repeatedRevoke.json()).revokedAt, dataOf(revoked.json()).revokedAt);
    assert.equal(dataOf(repeatedRevoke.json()).revokeReason, "目标文件不再需要该来源");

    const duplicateAfterRevoke = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${target.id}/review-links/dry-run`,
      payload: { targetRevision: 1, reviewPackage },
    });
    assert.equal(dataOf(duplicateAfterRevoke.json()).status, "duplicate");
    assert.equal(dataOf(duplicateAfterRevoke.json()).duplicateLifecycle, "revoked");

    const audits = await prisma.auditLog.findMany({
      where: { resourceId: target.id, action: { in: [
        "annotation_review_link_create",
        "annotation_review_link_revoke",
      ] } },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(audits.map(({ action }) => action), [
      "annotation_review_link_create",
      "annotation_review_link_revoke",
    ]);
    assert.doesNotMatch(JSON.stringify(audits), /已核对|需要关注/);
  } finally {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

async function createAnnotationFile(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  input: {
    parentId: string;
    ownerUserId: string;
    name: string;
    mediaResourceId?: string;
  },
) {
  return prisma.resourceEntry.create({
    data: {
      parentId: input.parentId,
      type: "annotation_file",
      name: input.name,
      ownerUserId: input.ownerUserId,
      annotationFile: {
        create: {
          payload: {
            builtinTracks: [{ id: "character-track" }],
            customTracks: [],
          },
          mediaResourceId: input.mediaResourceId,
          lastEditedBy: input.ownerUserId,
        },
      },
    },
  });
}

async function exportPackage(
  app: FastifyInstance,
  token: string,
  sourceId: string,
  sourceName: string,
) {
  const confirmations = dataOf((await jsonRequest(app, token, {
    method: "GET",
    url: `/api/annotation-files/${sourceId}/confirmations?limit=500`,
  })).json());
  const rangeRecords = dataOf((await jsonRequest(app, token, {
    method: "GET",
    url: `/api/annotation-files/${sourceId}/range-comments?limit=500&includeWithdrawn=true`,
  })).json());
  return {
    format: "xiqu.annotation-review-package",
    version: 1,
    exportedAt: new Date().toISOString(),
    source: { annotationFileId: sourceId, annotationFileName: sourceName, revision: 1 },
    counts: {
      confirmations: (confirmations.confirmations as unknown[]).length,
      rangeRecords: (rangeRecords.items as unknown[]).length,
    },
    records: {
      confirmations: confirmations.confirmations,
      rangeRecords: rangeRecords.items,
    },
  };
}

function sourceReviewSnapshot(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  sourceId: string,
) {
  return Promise.all([
    prisma.annotationConfirmation.findMany({ where: { annotationFileId: sourceId }, orderBy: { id: "asc" } }),
    prisma.annotationRangeComment.findMany({ where: { annotationFileId: sourceId }, orderBy: { id: "asc" } }),
  ]).then((rows) => JSON.parse(JSON.stringify(rows)) as unknown);
}

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
  const envelope = value as JsonObject;
  assert.ok(envelope && typeof envelope === "object" && "data" in envelope);
  return envelope.data as JsonObject;
}
