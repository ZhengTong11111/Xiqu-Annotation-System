import { Prisma, type PrismaClient } from "@prisma/client";
import { MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH } from "@xiqu/shared";
import {
  buildAnalysisAudioSettingMigrationPlan,
  type AnalysisAudioSettingMigrationFact,
  type AnalysisAudioSettingMigrationPlan,
} from "./analysisAudioSettingMigrationPlan.js";

const MAX_MIGRATION_SETTINGS = 5_000;
const RESOURCE_READ_BATCH_SIZE = 5_000;
const MIGRATION_LOCK_KEY = "xiqu:analysis-audio-setting-migration:v1";

const migrationResourceSelect = {
  id: true,
  parentId: true,
  type: true,
  name: true,
  trashedAt: true,
  archivedAt: true,
  annotationFile: { select: { mediaResourceId: true } },
  mediaFile: { select: { mediaKind: true } },
} satisfies Prisma.ResourceEntrySelect;

type DatabaseClient = PrismaClient | Prisma.TransactionClient;
type MigrationResourceRow = Prisma.ResourceEntryGetPayload<{
  select: typeof migrationResourceSelect;
}>;

export type AnalysisAudioSettingMigrationResult = {
  plan: AnalysisAudioSettingMigrationPlan;
  applied: boolean;
  createdTrackCount: number;
};

/**
 * 旧分析来源迁移是离线治理工具，不复用在线 CRUD 的请求权限上下文。
 * 它只允许有效 super_admin 执行，并在事务内重验完整计划后原子创建缺失音轨。
 */
export class AnalysisAudioSettingMigrationService {
  constructor(private readonly prisma: PrismaClient) {}

  async dryRun(): Promise<AnalysisAudioSettingMigrationResult> {
    const candidate = await this.buildCandidate(this.prisma);
    return { plan: candidate.plan, applied: false, createdTrackCount: 0 };
  }

  async execute(input: {
    operatorAccountName: string;
    expectedPlanFingerprint: string;
  }): Promise<AnalysisAudioSettingMigrationResult> {
    const expectedPlanFingerprint = normalizePlanFingerprint(input.expectedPlanFingerprint);
    const initial = await this.buildCandidate(this.prisma);
    if (initial.plan.fingerprint !== expectedPlanFingerprint) {
      throw new Error("旧分析音频设置迁移计划已经变化，请重新执行 dry-run。");
    }
    if (initial.plan.blockedCount > 0) {
      throw new Error("旧分析音频设置仍有阻断项，不能执行迁移。");
    }
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_KEY}))
      `;
      // 与音轨 CRUD 共用资源树共享门禁，避免活动性重验后主媒体或来源被移动/回收。
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock_shared(hashtext('xiqu:resource-tree:mutation'))
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
        throw new Error("只有有效的系统管理员账号可以迁移旧分析音频设置。");
      }

      // 在线 legacy route 仍可能 upsert 设置；表锁保证事务内重验后不会插入一条未纳入计划的新设置。
      await transaction.$executeRaw(
        Prisma.sql`LOCK TABLE "annotation_analysis_audio_settings" IN SHARE ROW EXCLUSIVE MODE`,
      );
      await lockPrimaryMediaRows(transaction, initial.facts);
      const locked = await this.buildCandidate(transaction);
      if (locked.plan.fingerprint !== expectedPlanFingerprint) {
        throw new Error("旧分析音频设置迁移计划已经变化，请重新执行 dry-run。");
      }
      if (locked.plan.blockedCount > 0) {
        throw new Error("旧分析音频设置仍有阻断项，迁移已回滚。");
      }
      // 没有待创建关系时仍完成 operator 和锁内计划验证，但不制造重复迁移审计。
      if (locked.plan.createTrackCount === 0) {
        return { plan: locked.plan, applied: false, createdTrackCount: 0 };
      }

      const factByAnnotation = new Map(
        locked.facts.map((fact) => [fact.annotationFileId, fact]),
      );
      const createGroups = new Map<string, AnalysisAudioSettingMigrationFact>();
      for (const item of locked.plan.items) {
        if (
          item.action !== "create_track" ||
          !item.primaryMediaResourceId ||
          !item.overrideMediaResourceId
        ) continue;
        const key = createSourceGroupKey(
          item.primaryMediaResourceId,
          item.overrideMediaResourceId,
        );
        const fact = factByAnnotation.get(item.annotationFileId);
        if (!fact) throw new Error("迁移计划缺少对应设置事实，迁移已回滚。");
        if (!createGroups.has(key)) createGroups.set(key, fact);
      }

      let createdTrackCount = 0;
      const nextSortOrderByPrimary = new Map<string, number>();
      for (const [, fact] of [...createGroups.entries()].sort(([left], [right]) =>
        left.localeCompare(right))) {
        const primaryMediaResourceId = fact.primaryMediaResourceId!;
        const sourceMediaResourceId = fact.overrideMediaResourceId!;
        const existing = await transaction.mediaAudioTrack.findFirst({
          where: {
            primaryMediaResourceId,
            audioMediaResourceId: sourceMediaResourceId,
          },
        });
        if (existing) {
          throw new Error("媒体音轨结构在迁移期间发生变化，迁移已回滚。");
        }
        const nextSortOrder = nextSortOrderByPrimary.get(primaryMediaResourceId) ??
          fact.existingTracks.length;
        const created = await transaction.mediaAudioTrack.create({
          data: {
            primaryMediaResourceId,
            audioMediaResourceId: sourceMediaResourceId,
            name: buildMigratedTrackName(fact.overrideMediaName),
            kind: "reference",
            offsetSeconds: fact.offsetSeconds,
            sortOrder: nextSortOrder,
            enabled: true,
            createdBy: operator.id,
          },
        });
        nextSortOrderByPrimary.set(primaryMediaResourceId, nextSortOrder + 1);
        createdTrackCount += 1;
        await transaction.auditLog.create({
          data: {
            action: "media_audio_track_create",
            actorUserId: operator.id,
            resourceId: primaryMediaResourceId,
            detail: {
              trackId: created.id,
              sourceType: "media_resource",
              sourceMediaResourceId,
              kind: "reference",
              offsetSeconds: fact.offsetSeconds,
              migratedFromAnalysisAudioSetting: true,
            },
          },
        });
      }
      if (createdTrackCount !== locked.plan.createTrackCount) {
        throw new Error("旧分析音频设置迁移创建数量不一致，迁移已回滚。");
      }
      await transaction.auditLog.create({
        data: {
          action: "analysis_audio_setting_migration_apply",
          actorUserId: operator.id,
          detail: {
            planFingerprint: locked.plan.fingerprint,
            settingCount: locked.plan.settingCount,
            createdTrackCount,
            reuseCount: locked.plan.reuseCount,
            noActionCount: locked.plan.noActionCount,
          },
        },
      });
      return {
        plan: locked.plan,
        applied: true,
        createdTrackCount,
      };
    }, { maxWait: 30_000, timeout: 60_000 });
  }

  private async buildCandidate(database: DatabaseClient) {
    const settings = await database.annotationAnalysisAudioSetting.findMany({
      select: {
        annotationFileId: true,
        mode: true,
        overrideMediaResourceId: true,
        offsetSeconds: true,
        updatedBy: true,
        updatedAt: true,
      },
      orderBy: { annotationFileId: "asc" },
      take: MAX_MIGRATION_SETTINGS + 1,
    });
    if (settings.length > MAX_MIGRATION_SETTINGS) {
      throw new Error("旧分析音频设置超过单次迁移上限 " + MAX_MIGRATION_SETTINGS + "。");
    }
    const initialResourceIds = new Set<string>();
    for (const setting of settings) {
      initialResourceIds.add(setting.annotationFileId);
      if (setting.overrideMediaResourceId) {
        initialResourceIds.add(setting.overrideMediaResourceId);
      }
    }
    const resources = await loadMigrationResourceClosure(database, initialResourceIds);
    const primaryMediaIds = new Set<string>();
    for (const setting of settings) {
      const mediaResourceId = resources.get(setting.annotationFileId)
        ?.annotationFile?.mediaResourceId;
      if (mediaResourceId) primaryMediaIds.add(mediaResourceId);
    }
    const completeResources = await loadMigrationResourceClosure(
      database,
      new Set([...resources.keys(), ...primaryMediaIds]),
    );
    const tracks = primaryMediaIds.size === 0
      ? []
      : await database.mediaAudioTrack.findMany({
          where: { primaryMediaResourceId: { in: [...primaryMediaIds] } },
          select: {
            id: true,
            primaryMediaResourceId: true,
            kind: true,
            audioMediaResourceId: true,
            offsetSeconds: true,
            sortOrder: true,
            enabled: true,
          },
          orderBy: [
            { primaryMediaResourceId: "asc" },
            { sortOrder: "asc" },
            { id: "asc" },
          ],
        });
    const tracksByPrimary = new Map<string, typeof tracks>();
    for (const track of tracks) {
      const group = tracksByPrimary.get(track.primaryMediaResourceId) ?? [];
      group.push(track);
      tracksByPrimary.set(track.primaryMediaResourceId, group);
    }
    const facts: AnalysisAudioSettingMigrationFact[] = settings.map((setting) => {
      const annotationResource = completeResources.get(setting.annotationFileId);
      const primaryMediaResourceId =
        annotationResource?.annotationFile?.mediaResourceId ?? null;
      const overrideResource = setting.overrideMediaResourceId
        ? completeResources.get(setting.overrideMediaResourceId)
        : null;
      return {
        annotationFileId: setting.annotationFileId,
        mode: setting.mode,
        overrideMediaResourceId: setting.overrideMediaResourceId,
        offsetSeconds: setting.offsetSeconds,
        updatedBy: setting.updatedBy,
        updatedAt: setting.updatedAt.toISOString(),
        annotationActive: isActiveResource(
          completeResources,
          setting.annotationFileId,
          "annotation_file",
        ),
        primaryMediaResourceId,
        primaryMediaActive: primaryMediaResourceId
          ? isActiveResource(completeResources, primaryMediaResourceId, "media_file")
          : false,
        overrideMediaActive: setting.overrideMediaResourceId
          ? isActiveResource(
              completeResources,
              setting.overrideMediaResourceId,
              "media_file",
            )
          : false,
        overrideMediaKind: overrideResource?.mediaFile?.mediaKind ?? null,
        overrideMediaName: overrideResource?.name ?? null,
        existingTracks: (primaryMediaResourceId
          ? tracksByPrimary.get(primaryMediaResourceId) ?? []
          : []).map((track) => ({
            id: track.id,
            kind: track.kind,
            audioMediaResourceId: track.audioMediaResourceId,
            offsetSeconds: track.offsetSeconds,
            sortOrder: track.sortOrder,
            enabled: track.enabled,
          })),
      };
    });
    return {
      facts,
      plan: buildAnalysisAudioSettingMigrationPlan(facts),
    };
  }
}

async function loadMigrationResourceClosure(
  database: DatabaseClient,
  initialIds: ReadonlySet<string>,
) {
  const resources = new Map<string, MigrationResourceRow>();
  const requested = new Set(initialIds);
  let pending = [...requested].sort();
  while (pending.length > 0) {
    const batch = pending.slice(0, RESOURCE_READ_BATCH_SIZE);
    pending = pending.slice(RESOURCE_READ_BATCH_SIZE);
    const rows = await database.resourceEntry.findMany({
      where: { id: { in: batch } },
      select: migrationResourceSelect,
    });
    for (const row of rows) {
      resources.set(row.id, row);
      const linkedIds = [row.parentId, row.annotationFile?.mediaResourceId]
        .filter((id): id is string => Boolean(id));
      for (const linkedId of linkedIds) {
        if (requested.has(linkedId)) continue;
        requested.add(linkedId);
        pending.push(linkedId);
      }
    }
    pending.sort();
  }
  return resources;
}

function isActiveResource(
  resources: ReadonlyMap<string, MigrationResourceRow>,
  resourceId: string,
  expectedType: "annotation_file" | "media_file",
) {
  const resource = resources.get(resourceId);
  if (
    !resource ||
    resource.type !== expectedType ||
    resource.trashedAt ||
    resource.archivedAt ||
    (expectedType === "annotation_file" && !resource.annotationFile) ||
    (expectedType === "media_file" && !resource.mediaFile)
  ) return false;
  const visited = new Set([resourceId]);
  let parentId = resource.parentId;
  while (parentId) {
    if (visited.has(parentId)) return false;
    visited.add(parentId);
    const parent = resources.get(parentId);
    if (!parent || parent.trashedAt || parent.archivedAt) return false;
    parentId = parent.parentId;
  }
  return true;
}

async function lockPrimaryMediaRows(
  transaction: Prisma.TransactionClient,
  facts: readonly AnalysisAudioSettingMigrationFact[],
) {
  const primaryIds = [...new Set(
    facts
      .map(({ primaryMediaResourceId }) => primaryMediaResourceId)
      .filter((id): id is string => Boolean(id)),
  )].sort();
  if (primaryIds.length === 0) return;
  const rows = await transaction.$queryRaw<Array<{ resourceId: string }>>(
    Prisma.sql`
      SELECT "resource_id" AS "resourceId"
      FROM "media_files"
      WHERE "resource_id" IN (${Prisma.join(primaryIds)})
      ORDER BY "resource_id"
      FOR UPDATE
    `,
  );
  if (rows.length !== primaryIds.length) {
    throw new Error("迁移候选主媒体发生变化，请重新执行 dry-run。");
  }
}

function buildMigratedTrackName(sourceName: string | null) {
  const normalized = (sourceName ?? "")
    .replace(/[\x00-\x1f\x7f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const base = normalized || "迁移音轨";
  const suffix = "（迁移）";
  const truncated = base.slice(
    0,
    Math.max(1, MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH - suffix.length),
  );
  // JS slice 以 UTF-16 code unit 截断；尾部若恰好是高代理项，必须去掉，避免生成破损名称。
  return truncated.replace(/[\ud800-\udbff]$/u, "") + suffix;
}

function createSourceGroupKey(primaryMediaResourceId: string, sourceMediaResourceId: string) {
  return JSON.stringify([primaryMediaResourceId, sourceMediaResourceId]);
}

function normalizePlanFingerprint(value: string) {
  const normalized = value.trim();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("迁移必须使用 dry-run 返回的完整计划 fingerprint。");
  }
  return normalized;
}
