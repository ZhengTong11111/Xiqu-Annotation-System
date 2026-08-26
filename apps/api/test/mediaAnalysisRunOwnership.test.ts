import assert from "node:assert/strict";
import test from "node:test";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("删除发起分析的标注文件不会级联删除媒体级分析 run", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  try {
    const owner = await prisma.user.create({
      data: {
        accountName: "analysis-ownership-owner",
        displayName: "分析归属测试账号",
        passwordHash: "unused",
      },
    });
    const media = await prisma.resourceEntry.create({
      data: {
        type: "media_file",
        name: "共享分析媒体",
        ownerUserId: owner.id,
        mediaFile: {
          create: {
            sourceType: "aliyun_vod",
            mediaKind: "video",
            aliyunVodVideoId: "00000000000000000000000000000000",
            aliyunVodRegion: "cn-shanghai",
          },
        },
      },
    });
    const annotation = await prisma.resourceEntry.create({
      data: {
        type: "annotation_file",
        name: "首次发起分析.json",
        ownerUserId: owner.id,
        annotationFile: {
          create: {
            payload: {},
            mediaResourceId: media.id,
            lastEditedBy: owner.id,
          },
        },
      },
    });
    const run = await prisma.mediaAnalysisRun.create({
      data: {
        sourceMediaResourceId: media.id,
        sourceFingerprint: "c".repeat(64),
        mediaFingerprint: "c".repeat(64),
        algorithmVersion: "analysis-v1",
        configHash: "config-v1",
        config: {},
        createdBy: owner.id,
      },
    });

    // run 只归属于媒体内容；发起它的标注文件由 ProcessingJob/审计记录，不参与 run 生命周期。
    await prisma.annotationFile.delete({ where: { resourceId: annotation.id } });
    const retained = await prisma.mediaAnalysisRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(retained.sourceMediaResourceId, media.id);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});
