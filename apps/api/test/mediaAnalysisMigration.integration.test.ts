import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { MediaAnalysisMigrationService } from "../src/mediaAnalysisMigrationService.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("媒体分析归并 dry-run/execute 可重验、幂等且不删除历史事实", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "xiqu-analysis-migration-"));
  const storage = new LocalObjectStorage(storageRoot);
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  try {
    const admin = await prisma.user.create({
      data: {
        accountName: "migration-admin",
        displayName: "迁移管理员",
        passwordHash: "not-used",
        roles: { create: { role: "super_admin" } },
      },
    });
    await prisma.user.create({
      data: {
        accountName: "migration-user",
        displayName: "普通账号",
        passwordHash: "not-used",
        roles: { create: { role: "annotator" } },
      },
    });
    const mediaId = await createMigrationMedia(prisma, admin.id);

    const runOne = await createFailedRun(prisma, {
      mediaId,
      creatorId: admin.id,
    });
    const runTwo = await createFailedRun(prisma, {
      mediaId,
      creatorId: admin.id,
    });

    // 真实 manifest 保存波形桶宽，而资产 level 使用 0 开始的序号；迁移必须接受这类已完成 run。
    const validRun = await createSucceededRunWithIndexedWaveformLevels(prisma, storage, {
      mediaId,
      creatorId: admin.id,
    });
    const service = new MediaAnalysisMigrationService(prisma, storage);
    const dryRun = await service.dryRun();
    assert.equal(dryRun.plan.actionableGroupCount, 2);
    assert.equal(dryRun.plan.blockedGroupCount, 0);

    await assert.rejects(() => service.execute({
      operatorAccountName: "migration-user",
      expectedPlanFingerprint: dryRun.plan.fingerprint,
    }), /系统管理员/u);
    const executed = await service.execute({
      operatorAccountName: "migration-admin",
      expectedPlanFingerprint: dryRun.plan.fingerprint,
    });
    assert.equal(executed.markedRunCount, 1);
    const rows = await prisma.mediaAnalysisRun.findMany({
      where: { id: { in: [runOne.id, runTwo.id] } },
      orderBy: { id: "asc" },
    });
    assert.equal(rows.filter((row) => row.supersededByRunId !== null).length, 1);
    assert.equal(rows.filter((row) => row.mediaFingerprint !== null).length, 1);
    assert.equal(await prisma.mediaAnalysisAsset.count(), 3);
    assert.notEqual((await prisma.mediaAnalysisRun.findUniqueOrThrow({
      where: { id: validRun.id },
    })).mediaFingerprint, null);
    assert.equal(await prisma.auditLog.count({
      where: { action: "media_analysis_migration_apply" },
    }), 1);

    const repeated = await service.dryRun();
    assert.equal(repeated.plan.actionableGroupCount, 0);
    assert.equal(repeated.plan.blockedGroupCount, 0);

    // dry-run 后新增活跃任务会改变 fingerprint；旧计划不能越过重验，也不能留下部分 supersede 标记。
    const staleOne = await createFailedRun(prisma, {
      mediaId,
      creatorId: admin.id,
      fingerprint: "stale-source",
    });
    const staleTwo = await createFailedRun(prisma, {
      mediaId,
      creatorId: admin.id,
      fingerprint: "stale-source",
    });
    const stalePlan = await service.dryRun();
    await prisma.processingJob.create({
      data: {
        type: "media_analysis",
        status: "queued",
        createdBy: admin.id,
        analysisRunId: staleOne.id,
        deduplicationKey: `test:migration:${staleOne.id}`,
      },
    });
    await assert.rejects(() => service.execute({
      operatorAccountName: "migration-admin",
      expectedPlanFingerprint: stalePlan.plan.fingerprint,
    }), /计划已经变化/u);
    assert.equal(await prisma.mediaAnalysisRun.count({
      where: { id: { in: [staleOne.id, staleTwo.id] }, supersededByRunId: { not: null } },
    }), 0);

    // succeeded run 的数据库资产若缺少对象，dry-run 只报告稳定阻断码，不泄露 storage key。
    await prisma.processingJob.deleteMany({ where: { analysisRunId: staleOne.id } });
    const brokenRun = await prisma.mediaAnalysisRun.create({
      data: {
        sourceMediaResourceId: mediaId,
        sourceFingerprint: "broken-source",
        algorithmVersion: "analysis-v1",
        configHash: "config-v1",
        config: { sampleRate: 16000 },
        status: "succeeded",
        progress: 1,
        manifest: {
          version: 1,
          tileDurationSeconds: 10,
          tileCount: 1,
          waveformLevels: [64],
          spectrogramPresets: [],
          pitchPreset: "yin-v1",
        },
        duration: 1,
        sampleRate: 16000,
        completedAt: new Date(),
        createdBy: admin.id,
      },
    });
    await prisma.mediaAnalysisAsset.createMany({
      data: [
        {
          runId: brokenRun.id,
          kind: "waveform",
          preset: "default",
          level: 0,
          tileIndex: 0,
          startTime: 0,
          endTime: 1,
          mimeType: "application/octet-stream",
          size: 4,
          checksum: "0".repeat(64),
          storageKey: "private/missing-waveform.xqa",
        },
        {
          runId: brokenRun.id,
          kind: "pitch",
          preset: "yin-v1",
          level: 0,
          tileIndex: 0,
          startTime: 0,
          endTime: 1,
          mimeType: "application/octet-stream",
          size: 4,
          checksum: "0".repeat(64),
          storageKey: "private/missing-pitch.xqa",
        },
      ],
    });
    await createFailedRun(prisma, {
      mediaId,
      creatorId: admin.id,
      fingerprint: "broken-source",
    });
    const blocked = await service.dryRun();
    assert.ok(blocked.plan.groups.some((group) =>
      group.blockCodes.includes("asset_validation_failed")));
    assert.doesNotMatch(JSON.stringify(blocked), /missing-waveform|missing-pitch/u);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

async function createMigrationMedia(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  ownerId: string,
) {
  const media = await prisma.resourceEntry.create({
    data: {
      type: "media_file",
      name: "迁移媒体.wav",
      ownerUserId: ownerId,
      mediaFile: {
        create: {
          sourceType: "aliyun_vod",
          mediaKind: "audio",
          duration: 120,
          aliyunVodVideoId: "00000000000000000000000000000000",
          aliyunVodRegion: "cn-shanghai",
        },
      },
    },
  });
  return media.id;
}

function createFailedRun(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  input: {
    mediaId: string;
    creatorId: string;
    fingerprint?: string;
  },
) {
  return prisma.mediaAnalysisRun.create({
    data: {
      sourceMediaResourceId: input.mediaId,
      sourceFingerprint: input.fingerprint ?? "shared-source",
      algorithmVersion: "analysis-v1",
      configHash: "config-v1",
      config: { sampleRate: 16000 },
      status: "failed",
      progress: 0,
      errorCode: "historical_failure",
      createdBy: input.creatorId,
    },
  });
}

async function createSucceededRunWithIndexedWaveformLevels(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  storage: LocalObjectStorage,
  input: {
    mediaId: string;
    creatorId: string;
  },
) {
  const run = await prisma.mediaAnalysisRun.create({
    data: {
      sourceMediaResourceId: input.mediaId,
      sourceFingerprint: "valid-indexed-levels",
      algorithmVersion: "analysis-v1",
      configHash: "valid-indexed-levels-config",
      config: { sampleRate: 16000, fixture: "indexed-waveform-levels" },
      status: "succeeded",
      progress: 1,
      manifest: {
        version: 1,
        tileDurationSeconds: 10,
        tileCount: 1,
        waveformLevels: [64, 256],
        spectrogramPresets: [],
        pitchPreset: "yin-v1",
      },
      duration: 1,
      sampleRate: 16000,
      completedAt: new Date(),
      createdBy: input.creatorId,
    },
  });

  const assetSpecs = [
    { kind: "waveform", preset: "default", level: 0 },
    { kind: "waveform", preset: "default", level: 1 },
    { kind: "pitch", preset: "yin-v1", level: 0 },
  ] as const;
  for (const [index, spec] of assetSpecs.entries()) {
    const payload = Buffer.from(`migration-asset-${index}`);
    const storageKey = storage.createStorageKey("xqa");
    const staged = await storage.putStagedObject(
      storageKey,
      Readable.from([payload]),
      payload.length,
    );
    await storage.promoteStagedObject(staged);
    await prisma.mediaAnalysisAsset.create({
      data: {
        runId: run.id,
        ...spec,
        tileIndex: 0,
        startTime: 0,
        endTime: 1,
        mimeType: "application/octet-stream",
        size: staged.size,
        checksum: staged.checksum,
        storageKey: staged.finalStorageKey,
      },
    });
  }
  return run;
}
