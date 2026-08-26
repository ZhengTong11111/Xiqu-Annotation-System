import assert from "node:assert/strict";
import test from "node:test";
import { AnalysisAudioSettingMigrationService } from "../src/analysisAudioSettingMigrationService.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("旧分析音频设置迁移可创建、复用、重验并对阻断计划保持原子", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  try {
    const admin = await prisma.user.create({
      data: {
        accountName: "analysis-setting-admin",
        displayName: "迁移管理员",
        passwordHash: "not-used",
        roles: { create: { role: "super_admin" } },
      },
    });
    await prisma.user.create({
      data: {
        accountName: "analysis-setting-user",
        displayName: "普通账号",
        passwordHash: "not-used",
        roles: { create: { role: "annotator" } },
      },
    });
    const primaryVideoId = await createMedia(prisma, {
      ownerId: admin.id,
      name: "主视频",
      mediaKind: "video",
      videoId: "00000000000000000000000000000000",
    });
    const vocalAudioId = await createMedia(prisma, {
      ownerId: admin.id,
      name: "分离人声.mp3",
      mediaKind: "audio",
      videoId: "11111111111111111111111111111111",
    });
    const firstAnnotationId = await createAnnotation(prisma, {
      ownerId: admin.id,
      primaryMediaId: primaryVideoId,
      name: "覆盖来源标注.json",
    });
    const autoAnnotationId = await createAnnotation(prisma, {
      ownerId: admin.id,
      primaryMediaId: primaryVideoId,
      name: "自动来源标注.json",
    });
    await prisma.annotationAnalysisAudioSetting.createMany({
      data: [
        {
          annotationFileId: firstAnnotationId,
          mode: "media_override",
          overrideMediaResourceId: vocalAudioId,
          offsetSeconds: 0.25,
          updatedBy: admin.id,
        },
        {
          annotationFileId: autoAnnotationId,
          mode: "auto",
          overrideMediaResourceId: null,
          offsetSeconds: 0,
          updatedBy: admin.id,
        },
      ],
    });

    const service = new AnalysisAudioSettingMigrationService(prisma);
    const dryRun = await service.dryRun();
    assert.equal(dryRun.plan.settingCount, 2);
    assert.equal(dryRun.plan.createTrackCount, 1);
    assert.equal(dryRun.plan.noActionCount, 1);
    assert.equal(dryRun.plan.blockedCount, 0);
    assert.doesNotMatch(JSON.stringify(dryRun), /分离人声|主视频/u);

    await assert.rejects(() => service.execute({
      operatorAccountName: "analysis-setting-user",
      expectedPlanFingerprint: dryRun.plan.fingerprint,
    }), /系统管理员/u);
    assert.equal(await prisma.mediaAudioTrack.count({
      where: { primaryMediaResourceId: primaryVideoId },
    }), 1);

    const executed = await service.execute({
      operatorAccountName: "analysis-setting-admin",
      expectedPlanFingerprint: dryRun.plan.fingerprint,
    });
    assert.equal(executed.applied, true);
    assert.equal(executed.createdTrackCount, 1);
    const migratedTrack = await prisma.mediaAudioTrack.findFirstOrThrow({
      where: {
        primaryMediaResourceId: primaryVideoId,
        audioMediaResourceId: vocalAudioId,
      },
    });
    assert.equal(migratedTrack.kind, "reference");
    assert.equal(migratedTrack.offsetSeconds, 0.25);
    assert.equal(migratedTrack.createdBy, admin.id);
    assert.match(migratedTrack.name, /（迁移）$/u);
    assert.equal(await prisma.auditLog.count({
      where: { action: "analysis_audio_setting_migration_apply" },
    }), 1);

    const repeated = await service.dryRun();
    assert.equal(repeated.plan.createTrackCount, 0);
    assert.equal(repeated.plan.reuseCount, 1);
    const repeatedExecution = await service.execute({
      operatorAccountName: "analysis-setting-admin",
      expectedPlanFingerprint: repeated.plan.fingerprint,
    });
    assert.equal(repeatedExecution.applied, false);
    assert.equal(await prisma.auditLog.count({
      where: { action: "analysis_audio_setting_migration_apply" },
    }), 1);

    // dry-run 后 setting 变化必须使旧 fingerprint 失效，且不能创建半条关系。
    const secondAudioId = await createMedia(prisma, {
      ownerId: admin.id,
      name: "伴奏.mp3",
      mediaKind: "audio",
      videoId: "22222222222222222222222222222222",
    });
    const staleAnnotationId = await createAnnotation(prisma, {
      ownerId: admin.id,
      primaryMediaId: primaryVideoId,
      name: "计划漂移标注.json",
    });
    await prisma.annotationAnalysisAudioSetting.create({
      data: {
        annotationFileId: staleAnnotationId,
        mode: "media_override",
        overrideMediaResourceId: secondAudioId,
        offsetSeconds: 0,
        updatedBy: admin.id,
      },
    });
    const stale = await service.dryRun();
    await prisma.annotationAnalysisAudioSetting.update({
      where: { annotationFileId: staleAnnotationId },
      data: { offsetSeconds: 0.5 },
    });
    await assert.rejects(() => service.execute({
      operatorAccountName: "analysis-setting-admin",
      expectedPlanFingerprint: stale.plan.fingerprint,
    }), /计划已经变化/u);
    assert.equal(await prisma.mediaAudioTrack.count({
      where: {
        primaryMediaResourceId: primaryVideoId,
        audioMediaResourceId: secondAudioId,
      },
    }), 0);

    // 另一条 VOD 视频没有稳定 rendition JobId，blocked plan 必须阻止同批合法来源被部分写入。
    const thirdAudioId = await createMedia(prisma, {
      ownerId: admin.id,
      name: "降噪音频.mp3",
      mediaKind: "audio",
      videoId: "33333333333333333333333333333333",
    });
    const otherVideoId = await createMedia(prisma, {
      ownerId: admin.id,
      name: "另一条视频",
      mediaKind: "video",
      videoId: "44444444444444444444444444444444",
    });
    const validAnnotationId = await createAnnotation(prisma, {
      ownerId: admin.id,
      primaryMediaId: primaryVideoId,
      name: "同批合法设置.json",
    });
    const blockedAnnotationId = await createAnnotation(prisma, {
      ownerId: admin.id,
      primaryMediaId: primaryVideoId,
      name: "同批阻断设置.json",
    });
    await prisma.annotationAnalysisAudioSetting.createMany({
      data: [
        {
          annotationFileId: validAnnotationId,
          mode: "media_override",
          overrideMediaResourceId: thirdAudioId,
          offsetSeconds: 0,
          updatedBy: admin.id,
        },
        {
          annotationFileId: blockedAnnotationId,
          mode: "media_override",
          overrideMediaResourceId: otherVideoId,
          offsetSeconds: 0,
          updatedBy: admin.id,
        },
      ],
    });
    const blocked = await service.dryRun();
    assert.ok(blocked.plan.items.some(({ blockCodes }) =>
      blockCodes.includes("override_source_not_audio")));
    await assert.rejects(() => service.execute({
      operatorAccountName: "analysis-setting-admin",
      expectedPlanFingerprint: blocked.plan.fingerprint,
    }), /阻断项/u);
    assert.equal(await prisma.mediaAudioTrack.count({
      where: {
        primaryMediaResourceId: primaryVideoId,
        audioMediaResourceId: thirdAudioId,
      },
    }), 0);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

type TestPrisma = ReturnType<typeof createTestPrisma>["prisma"];

async function createMedia(
  prisma: TestPrisma,
  input: {
    ownerId: string;
    name: string;
    mediaKind: "video" | "audio";
    videoId: string;
  },
) {
  const resource = await prisma.resourceEntry.create({
    data: {
      type: "media_file",
      name: input.name,
      ownerUserId: input.ownerId,
      mediaFile: {
        create: {
          sourceType: "aliyun_vod",
          mediaKind: input.mediaKind,
          duration: 120,
          aliyunVodVideoId: input.videoId,
          aliyunVodRegion: "cn-shanghai",
        },
      },
    },
  });
  await prisma.mediaAudioTrack.create({
    data: {
      primaryMediaResourceId: resource.id,
      name: input.mediaKind === "video" ? "视频原声" : "媒体原声",
      kind: "original",
      offsetSeconds: 0,
      sortOrder: 0,
      enabled: true,
      createdBy: input.ownerId,
    },
  });
  return resource.id;
}

async function createAnnotation(
  prisma: TestPrisma,
  input: {
    ownerId: string;
    primaryMediaId: string;
    name: string;
  },
) {
  return (await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: input.name,
      ownerUserId: input.ownerId,
      annotationFile: {
        create: {
          payload: { version: 1 },
          mediaResourceId: input.primaryMediaId,
          lastEditedBy: input.ownerId,
        },
      },
    },
  })).id;
}
