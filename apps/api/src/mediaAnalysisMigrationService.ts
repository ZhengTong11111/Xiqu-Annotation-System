import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";
import { digestReadable } from "./backup/checksum.js";
import { createMediaAnalysisSourceFingerprint } from "./mediaAnalysisSourceFingerprint.js";
import type { ObjectStorage } from "./objectStorage.js";
import {
  buildMediaAnalysisMigrationPlan,
  type MediaAnalysisMigrationPlan,
  type MediaAnalysisMigrationRunFact,
} from "./mediaAnalysisMigrationPlan.js";

const MAX_MIGRATION_RUNS = 50_000;

const migrationRunInclude = {
  assets: {
    orderBy: [
      { kind: "asc" as const },
      { preset: "asc" as const },
      { level: "asc" as const },
      { tileIndex: "asc" as const },
      { id: "asc" as const },
    ],
  },
  jobs: {
    select: { status: true },
  },
  sourceMedia: {
    select: {
      resourceId: true,
      sourceType: true,
      duration: true,
      aliyunVodVideoId: true,
      aliyunVodRegion: true,
      file: { select: { id: true, checksum: true, size: true } },
    },
  },
} satisfies Prisma.MediaAnalysisRunInclude;

type MigrationRunRow = Prisma.MediaAnalysisRunGetPayload<{
  include: typeof migrationRunInclude;
}>;

export type MediaAnalysisMigrationResult = {
  plan: MediaAnalysisMigrationPlan;
  applied: boolean;
  markedRunCount: number;
};

// 运维迁移服务只建立可逆 supersede 事实，不改挂资产、不删除对象，也不参与在线分析请求。
export class MediaAnalysisMigrationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: Pick<ObjectStorage, "getObjectStream">,
  ) {}

  async dryRun(): Promise<MediaAnalysisMigrationResult> {
    const { plan } = await this.buildPlan(this.prisma);
    return { plan, applied: false, markedRunCount: 0 };
  }

  async execute(input: {
    operatorAccountName: string;
    expectedPlanFingerprint: string;
  }): Promise<MediaAnalysisMigrationResult> {
    if (!/^[a-f0-9]{64}$/u.test(input.expectedPlanFingerprint)) {
      throw new Error("迁移计划 fingerprint 格式不正确。");
    }
    if (!input.operatorAccountName.trim() || input.operatorAccountName.length > 100) {
      throw new Error("迁移执行账号名称不正确。");
    }

    // 对象在事务外先完成流式校验；final storage key 是不可变对象，短事务只需防止数据库事实漂移。
    const candidate = await this.buildPlan(this.prisma);
    if (candidate.plan.fingerprint !== input.expectedPlanFingerprint) {
      throw new Error("媒体分析迁移计划已经变化，请重新执行 dry-run。");
    }
    if (candidate.plan.blockedGroupCount > 0) {
      throw new Error("媒体分析迁移计划包含阻断项，未写入任何归并标记。");
    }

    return this.prisma.$transaction(async (transaction) => {
      // 全局 advisory lock 与 run 行锁共同保证两个 CLI 不会基于不同候选同时写入 supersede 关系。
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext('xiqu:media-analysis:migration'))
      `;
      await transaction.$queryRaw`
        SELECT id FROM media_analysis_runs ORDER BY id FOR UPDATE
      `;
      await transaction.$queryRaw`
        SELECT id FROM processing_jobs
        WHERE analysis_run_id IS NOT NULL
        ORDER BY id FOR UPDATE
      `;

      const operator = await transaction.user.findUnique({
        where: { accountName: input.operatorAccountName.trim() },
        select: {
          id: true,
          isActive: true,
          roles: { select: { role: true } },
        },
      });
      if (!operator?.isActive || !operator.roles.some(({ role }) => role === "super_admin")) {
        throw new Error("只有有效的系统管理员账号可以执行媒体分析归并。");
      }

      // 锁内只重算数据库 fingerprint，避免持锁期间读取远程对象；对象生命周期不会改写有引用的 final key。
      const lockedRows = await this.loadRows(transaction);
      if (createDatabaseStateFingerprint(lockedRows) !== candidate.databaseFingerprint) {
        throw new Error("媒体分析迁移计划已经变化，请重新执行 dry-run。");
      }

      const now = new Date();
      let markedRunCount = 0;
      for (const group of candidate.plan.groups) {
        if (!group.canonicalRunId || group.duplicateRunIds.length === 0) continue;
        const updated = await transaction.mediaAnalysisRun.updateMany({
          where: {
            id: { in: group.duplicateRunIds },
            supersededByRunId: null,
          },
          data: {
            supersededByRunId: group.canonicalRunId,
            supersededAt: now,
            supersededBy: operator.id,
          },
        });
        if (updated.count !== group.duplicateRunIds.length) {
          throw new Error("媒体分析候选在事务内发生变化，归并已回滚。");
        }
        markedRunCount += updated.count;
      }
      for (const group of candidate.plan.groups) {
        for (const runId of group.backfillRunIds) {
          const mediaFingerprint = candidate.mediaFingerprintsByRunId.get(runId);
          if (!mediaFingerprint) throw new Error("媒体 fingerprint 候选缺失，归并已回滚。");
          await transaction.mediaAnalysisRun.update({
            where: { id: runId },
            data: { mediaFingerprint },
          });
        }
      }
      await transaction.auditLog.create({
        data: {
          action: "media_analysis_migration_apply",
          actorUserId: operator.id,
          detail: {
            planFingerprint: candidate.plan.fingerprint,
            actionableGroupCount: candidate.plan.actionableGroupCount,
            markedRunCount,
          },
        },
      });
      return { plan: candidate.plan, applied: true, markedRunCount };
    }, { maxWait: 30_000, timeout: 60_000 });
  }

  private async buildPlan(database: PrismaClient | Prisma.TransactionClient) {
    const rows = await this.loadRows(database);
    const facts: MediaAnalysisMigrationRunFact[] = [];
    for (const row of rows) facts.push(await this.buildRunFact(row));
    return {
      plan: buildMediaAnalysisMigrationPlan(facts),
      databaseFingerprint: createDatabaseStateFingerprint(rows),
      mediaFingerprintsByRunId: new Map(facts.map((fact) => [fact.id, fact.sourceFingerprint])),
    };
  }

  private async loadRows(database: PrismaClient | Prisma.TransactionClient) {
    const rows = await database.mediaAnalysisRun.findMany({
      include: migrationRunInclude,
      orderBy: { id: "asc" },
      take: MAX_MIGRATION_RUNS + 1,
    });
    if (rows.length > MAX_MIGRATION_RUNS) {
      throw new Error(`媒体分析 run 超过单次迁移上限 ${MAX_MIGRATION_RUNS}。`);
    }
    return rows;
  }

  private async buildRunFact(row: MigrationRunRow): Promise<MediaAnalysisMigrationRunFact> {
    const mediaFingerprint = createMediaAnalysisSourceFingerprint(
      row.sourceMedia.sourceType === "uploaded"
        ? {
            sourceType: "uploaded",
            mediaResourceId: row.sourceMedia.resourceId,
            fileId: row.sourceMedia.file?.id ?? null,
            checksum: row.sourceMedia.file?.checksum ?? null,
            size: row.sourceMedia.file?.size ?? null,
          }
        : {
            sourceType: "aliyun_vod",
            mediaResourceId: row.sourceMedia.resourceId,
            region: row.sourceMedia.aliyunVodRegion,
            videoId: row.sourceMedia.aliyunVodVideoId,
            duration: row.sourceMedia.duration,
          },
    );
    const databaseAssetFacts = row.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      preset: asset.preset,
      level: asset.level,
      tileIndex: asset.tileIndex,
      startTime: asset.startTime,
      endTime: asset.endTime,
      size: asset.size.toString(),
      checksum: asset.checksum,
    }));
    let assetValidation: "valid" | "invalid" = validateManifestAndAssetSet(
      row.status,
      row.manifest,
      databaseAssetFacts,
    ) ? "valid" : "invalid";
    const actualObjects: Array<{ id: string; size: number | null; checksum: string | null }> = [];
    for (const asset of row.assets) {
      try {
        const digest = await digestReadable(await this.storage.getObjectStream(asset.storageKey));
        actualObjects.push({ id: asset.id, size: digest.size, checksum: digest.sha256 });
        if (digest.size !== Number(asset.size) || digest.sha256 !== asset.checksum) {
          assetValidation = "invalid";
        }
      } catch {
        // 报告只保留稳定 invalid 事实；底层路径、bucket 和 SDK 错误不能进入 fingerprint 或 CLI 输出。
        actualObjects.push({ id: asset.id, size: null, checksum: null });
        assetValidation = "invalid";
      }
    }
    return {
      id: row.id,
      sourceMediaResourceId: row.sourceMediaResourceId,
      sourceFingerprint: mediaFingerprint ?? `missing:${row.id}`,
      persistedMediaFingerprint: row.mediaFingerprint,
      algorithmVersion: row.algorithmVersion,
      configHash: row.configHash,
      configFingerprint: createHash("sha256")
        .update(stableJsonStringify(row.config))
        .digest("hex"),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      supersededByRunId: row.supersededByRunId,
      activeJobCount: row.jobs.filter(({ status }) => status === "queued" || status === "running").length,
      assetCount: row.assets.length,
      assetFactsFingerprint: createHash("sha256")
        .update(stableJsonStringify({ databaseAssetFacts, actualObjects }))
        .digest("hex"),
      assetValidation,
    };
  }
}

// 数据库 fingerprint 包含所有会影响计划和对象引用的事实；storage key 只进入 hash，不会出现在报告中。
function createDatabaseStateFingerprint(rows: readonly MigrationRunRow[]) {
  const facts = rows.map((row) => ({
    id: row.id,
    sourceMediaResourceId: row.sourceMediaResourceId,
    sourceFingerprint: row.sourceFingerprint,
    mediaFingerprint: row.mediaFingerprint,
    algorithmVersion: row.algorithmVersion,
    configHash: row.configHash,
    config: row.config,
    status: row.status,
    manifest: row.manifest,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    supersededByRunId: row.supersededByRunId,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    supersededBy: row.supersededBy,
    sourceMedia: {
      resourceId: row.sourceMedia.resourceId,
      sourceType: row.sourceMedia.sourceType,
      duration: row.sourceMedia.duration,
      aliyunVodVideoId: row.sourceMedia.aliyunVodVideoId,
      aliyunVodRegion: row.sourceMedia.aliyunVodRegion,
      file: row.sourceMedia.file && {
        id: row.sourceMedia.file.id,
        checksum: row.sourceMedia.file.checksum,
        size: row.sourceMedia.file.size.toString(),
      },
    },
    jobs: row.jobs.map(({ status }) => status).sort(),
    assets: row.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      preset: asset.preset,
      level: asset.level,
      tileIndex: asset.tileIndex,
      startTime: asset.startTime,
      endTime: asset.endTime,
      size: asset.size.toString(),
      checksum: asset.checksum,
      storageKey: asset.storageKey,
    })),
  }));
  return createHash("sha256").update(stableJsonStringify(facts)).digest("hex");
}

function validateManifestAndAssetSet(
  status: MigrationRunRow["status"],
  manifest: Prisma.JsonValue | null,
  assets: Array<{
    kind: string;
    preset: string;
    level: number;
    tileIndex: number;
  }>,
) {
  if (status !== "succeeded") return assets.length === 0 && manifest === null;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const value = manifest as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.tileCount !== "number" ||
    !Number.isInteger(value.tileCount) ||
    value.tileCount < 0 ||
    !Array.isArray(value.waveformLevels) ||
    value.waveformLevels.some((level) => typeof level !== "number" || !Number.isInteger(level)) ||
    !Array.isArray(value.spectrogramPresets) ||
    value.spectrogramPresets.some((preset) => typeof preset !== "string") ||
    typeof value.pitchPreset !== "string"
  ) return false;

  // manifest 声明每个瓦片应有的序列；精确集合比较能发现数据库缺号、重复或混入未知 preset。
  const expected = new Set<string>();
  for (let tileIndex = 0; tileIndex < value.tileCount; tileIndex += 1) {
    for (const level of value.waveformLevels as number[]) {
      expected.add(`waveform:default:${level}:${tileIndex}`);
    }
    for (const preset of value.spectrogramPresets as string[]) {
      expected.add(`spectrogram:${preset}:0:${tileIndex}`);
    }
    expected.add(`pitch:${value.pitchPreset}:0:${tileIndex}`);
  }
  const actual = new Set(assets.map((asset) =>
    `${asset.kind}:${asset.preset}:${asset.level}:${asset.tileIndex}`));
  return expected.size === assets.length &&
    actual.size === assets.length &&
    [...expected].every((key) => actual.has(key));
}
