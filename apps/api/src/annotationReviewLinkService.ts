import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AnnotationReviewLinkDryRun,
  AnnotationReviewLinkRecord,
  AnnotationReviewPackageV1,
} from "@xiqu/shared";
import {
  buildAnnotationReviewPackageFingerprintInput,
  extractPersistedAnnotationReviewTrackIds,
  parseAnnotationReviewPackage,
} from "@xiqu/document-model";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import type { AnnotationReviewPublisher } from "./annotationCollaborationHub.js";
import { ResourceAccessService } from "./resourceAccess.js";
import { toPublicUser } from "./repositoryMappers.js";
import {
  annotationConfirmationInclude,
  annotationRangeCommentInclude,
  mapAnnotationConfirmation,
  mapAnnotationRangeComment,
} from "./annotationReviewRecordMapper.js";

const MAX_REVIEW_LINKS_PER_TARGET = 20;
const MAX_REVOKE_REASON_LENGTH = 2_000;

const reviewLinkInclude = {
  creator: { include: { roles: true } },
  revoker: { include: { roles: true } },
} satisfies Prisma.AnnotationReviewLinkInclude;

type ReviewLinkRow = Prisma.AnnotationReviewLinkGetPayload<{
  include: typeof reviewLinkInclude;
}>;

type PreparedReviewLink = {
  reviewPackage: AnnotationReviewPackageV1;
  fingerprint: string;
  result: AnnotationReviewLinkDryRun;
};

// 审核包重链接拥有独立业务边界，确保来源核验与目标事务不会继续膨胀资源 CRUD 服务。
export class AnnotationReviewLinkService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly reviewPublisher: AnnotationReviewPublisher = {
      publishReviewChanged: () => undefined,
    },
  ) {}

  async dryRun(
    user: ApiUser,
    targetAnnotationFileId: string,
    targetRevision: number,
    value: unknown,
  ): Promise<AnnotationReviewLinkDryRun> {
    return (await this.prepareLink(
      this.prisma,
      user,
      targetAnnotationFileId,
      targetRevision,
      value,
    )).result;
  }

  async list(
    user: ApiUser,
    targetAnnotationFileId: string,
  ): Promise<AnnotationReviewLinkRecord[]> {
    await this.access.assertCapability(user, targetAnnotationFileId, "read");
    await this.assertActiveAnnotationFile(this.prisma, targetAnnotationFileId);
    const rows = await this.prisma.annotationReviewLink.findMany({
      where: { targetAnnotationFileId },
      include: reviewLinkInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_REVIEW_LINKS_PER_TARGET + 1,
    });
    if (rows.length > MAX_REVIEW_LINKS_PER_TARGET) {
      throw conflict("当前文件的审核包关联数量超过可安全读取上限，请先治理旧关联。");
    }
    return rows.map(mapReviewLink);
  }

  async create(
    user: ApiUser,
    targetAnnotationFileId: string,
    targetRevision: number,
    value: unknown,
  ): Promise<AnnotationReviewLinkRecord> {
    const created = await this.prisma.$transaction(async (transaction) => {
      const parsed = parseAnnotationReviewPackage(value);
      if (!parsed.ok) throw badRequest("审核包格式不正确。", { issues: parsed.issues });

      // 来源和目标按稳定 id 顺序一起加锁，避免两个互相重链接请求形成反向锁顺序。
      const lockIds = [...new Set([
        targetAnnotationFileId,
        parsed.value.source.annotationFileId,
      ])].sort();
      await transaction.$queryRaw(Prisma.sql`
        SELECT "resource_id"
        FROM "annotation_files"
        WHERE "resource_id" IN (${Prisma.join(lockIds)})
        ORDER BY "resource_id"
        FOR UPDATE
      `);

      const prepared = await this.prepareLink(
        transaction,
        user,
        targetAnnotationFileId,
        targetRevision,
        parsed.value,
      );
      if (prepared.result.status === "duplicate") {
        throw conflict("相同审核包已经关联到当前文件，不能重复导入。", {
          linkId: prepared.result.duplicateLinkId,
          lifecycle: prepared.result.duplicateLifecycle,
        });
      }
      const count = await transaction.annotationReviewLink.count({
        where: { targetAnnotationFileId },
      });
      if (count >= MAX_REVIEW_LINKS_PER_TARGET) {
        throw conflict(`每个标注文件最多保留 ${MAX_REVIEW_LINKS_PER_TARGET} 个审核包关联。`);
      }

      const row = await transaction.annotationReviewLink.create({
        data: {
          targetAnnotationFileId,
          sourceAnnotationFileId: prepared.reviewPackage.source.annotationFileId,
          sourceResourceIdSnapshot: prepared.reviewPackage.source.annotationFileId,
          sourceFileNameSnapshot: prepared.reviewPackage.source.annotationFileName,
          sourceRevision: prepared.reviewPackage.source.revision,
          packageFingerprint: prepared.fingerprint,
          packagePayload: toJsonValue(prepared.reviewPackage),
          confirmationCount: prepared.reviewPackage.counts.confirmations,
          rangeRecordCount: prepared.reviewPackage.counts.rangeRecords,
          createdBy: user.id,
        },
        include: reviewLinkInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_review_link_create",
          actorUserId: user.id,
          resourceId: targetAnnotationFileId,
          detail: {
            reviewLinkId: row.id,
            sourceAnnotationFileId: prepared.reviewPackage.source.annotationFileId,
            packageFingerprintPrefix: prepared.fingerprint.slice(0, 12),
            confirmationCount: prepared.reviewPackage.counts.confirmations,
            rangeRecordCount: prepared.reviewPackage.counts.rangeRecords,
          },
        },
      });
      return mapReviewLink(row);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.publishReviewChanged(targetAnnotationFileId);
    return created;
  }

  async revoke(
    user: ApiUser,
    targetAnnotationFileId: string,
    linkId: string,
    reason?: string | null,
  ): Promise<AnnotationReviewLinkRecord> {
    const normalizedReason = reason?.trim() || null;
    if (normalizedReason && normalizedReason.length > MAX_REVOKE_REASON_LENGTH) {
      throw badRequest(`撤销关联原因不能超过 ${MAX_REVOKE_REASON_LENGTH} 个字符。`);
    }
    const result = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "resource_id" FROM "annotation_files"
        WHERE "resource_id" = ${targetAnnotationFileId}
        FOR UPDATE
      `);
      const permission = await this.access.assertCapability(
        user,
        targetAnnotationFileId,
        "review",
        transaction,
      );
      if (!permission.capabilities.includes("read")) {
        throw forbidden("当前账号缺少目标文件的读取权限。");
      }
      await this.assertActiveAnnotationFile(transaction, targetAnnotationFileId);
      const existing = await transaction.annotationReviewLink.findFirst({
        where: { id: linkId, targetAnnotationFileId },
        include: reviewLinkInclude,
      });
      if (!existing) throw notFound("审核包关联不存在。");
      const canGovernAny = permission.source === "admin" || permission.isOwner ||
        await this.access.hasOwnerAuthority(user, targetAnnotationFileId, transaction);
      if (!canGovernAny && existing.createdBy !== user.id) {
        throw forbidden("只能撤销自己建立的审核包关联。");
      }
      if (existing.revokedAt) return { record: mapReviewLink(existing), changed: false };

      const updated = await transaction.annotationReviewLink.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), revokedBy: user.id, revokeReason: normalizedReason },
        include: reviewLinkInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_review_link_revoke",
          actorUserId: user.id,
          resourceId: targetAnnotationFileId,
          detail: {
            reviewLinkId: updated.id,
            sourceAnnotationFileId: updated.sourceResourceIdSnapshot,
            packageFingerprintPrefix: updated.packageFingerprint.slice(0, 12),
          },
        },
      });
      return { record: mapReviewLink(updated), changed: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (result.changed) this.publishReviewChanged(targetAnnotationFileId);
    return result.record;
  }

  private async prepareLink(
    database: PrismaClient | Prisma.TransactionClient,
    user: ApiUser,
    targetAnnotationFileId: string,
    targetRevision: number,
    value: unknown,
  ): Promise<PreparedReviewLink> {
    if (!Number.isInteger(targetRevision) || targetRevision < 1) {
      throw badRequest("targetRevision 必须是正整数。");
    }
    const parsed = parseAnnotationReviewPackage(value);
    if (!parsed.ok) throw badRequest("审核包格式不正确。", { issues: parsed.issues });
    const reviewPackage = parsed.value;
    if (reviewPackage.source.annotationFileId === targetAnnotationFileId) {
      throw badRequest("来源文件与目标文件相同，不需要重新链接。");
    }

    // dry-run 与 create 共用完整权限和事实核验；create 只是在锁内再次执行同一合同。
    const targetPermission = await this.access.assertCapability(
      user,
      targetAnnotationFileId,
      "review",
      database,
    );
    if (!targetPermission.capabilities.includes("read")) {
      throw forbidden("当前账号缺少目标文件的读取权限。");
    }
    await this.access.assertCapability(
      user,
      reviewPackage.source.annotationFileId,
      "read",
      database,
    );

    const [target, source, confirmations, rangeRecords] = await Promise.all([
      database.annotationFile.findUnique({
        where: { resourceId: targetAnnotationFileId },
        select: {
          revision: true,
          payload: true,
          resource: { select: { name: true, archivedAt: true, trashedAt: true } },
          mediaResource: { select: { duration: true } },
        },
      }),
      database.annotationFile.findUnique({
        where: { resourceId: reviewPackage.source.annotationFileId },
        select: {
          revision: true,
          resource: { select: { name: true, archivedAt: true, trashedAt: true } },
        },
      }),
      database.annotationConfirmation.findMany({
        where: { annotationFileId: reviewPackage.source.annotationFileId },
        include: annotationConfirmationInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: reviewPackage.counts.confirmations + 1,
      }),
      database.annotationRangeComment.findMany({
        where: { annotationFileId: reviewPackage.source.annotationFileId },
        include: annotationRangeCommentInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: reviewPackage.counts.rangeRecords + 1,
      }),
    ]);
    if (!target || target.resource.archivedAt || target.resource.trashedAt) {
      throw notFound("目标标注文件不存在或当前不可用。");
    }
    if (!source || source.resource.archivedAt || source.resource.trashedAt) {
      throw notFound("来源标注文件不存在或当前不可用。");
    }
    if (target.revision !== targetRevision) {
      throw conflict("目标文件已产生新修订，请刷新后重新预检。", {
        expectedRevision: target.revision,
        receivedRevision: targetRevision,
      });
    }
    if (
      source.revision !== reviewPackage.source.revision ||
      source.resource.name !== reviewPackage.source.annotationFileName
    ) {
      throw conflict("审核包来源文件的名称或修订已经变化，请重新导出审核包。");
    }
    const duration = target.mediaResource?.duration;
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      throw badRequest("目标文件没有可验证的媒体时长，暂不能关联审核包。");
    }

    const persistedTrackIds = extractPersistedAnnotationReviewTrackIds(target.payload);
    if (!persistedTrackIds.ok) {
      throw badRequest("目标标注内容无法验证轨道作用域。", { issues: persistedTrackIds.issues });
    }
    const availableTracks = new Set(persistedTrackIds.value);
    const usedTrackIds = collectUsedTrackIds(reviewPackage);
    const missingTrackIds = usedTrackIds.filter((trackId) => !availableTracks.has(trackId));
    if (missingTrackIds.length) {
      throw badRequest("目标文件缺少审核包引用的持久轨道，不能按名称猜测映射。", {
        missingTrackIds,
      });
    }
    const outOfRange = collectScopes(reviewPackage).find((scope) => scope.endTime > duration);
    if (outOfRange) {
      throw badRequest("审核包包含超过目标媒体时长的范围。", {
        endTime: outOfRange.endTime,
        duration,
      });
    }

    const sourceCurrentPackage: AnnotationReviewPackageV1 = {
      ...reviewPackage,
      source: {
        annotationFileId: reviewPackage.source.annotationFileId,
        annotationFileName: source.resource.name,
        revision: source.revision,
      },
      counts: {
        confirmations: confirmations.length,
        rangeRecords: rangeRecords.length,
      },
      records: {
        confirmations: confirmations.map(mapAnnotationConfirmation),
        rangeRecords: rangeRecords.map(mapAnnotationRangeComment),
      },
    };
    const normalizedCurrentPackage = parseAnnotationReviewPackage(sourceCurrentPackage);
    if (!normalizedCurrentPackage.ok) {
      throw conflict("来源文件的审核事实无法形成有效审核包，请先治理异常记录。", {
        issues: normalizedCurrentPackage.issues,
      });
    }
    const fingerprint = createPackageFingerprint(reviewPackage);
    if (
      confirmations.length !== reviewPackage.counts.confirmations ||
      rangeRecords.length !== reviewPackage.counts.rangeRecords ||
      createPackageFingerprint(normalizedCurrentPackage.value) !== fingerprint
    ) {
      throw conflict("审核包与来源文件的当前审核事实不一致，请重新导出后再关联。");
    }

    const duplicate = await database.annotationReviewLink.findUnique({
      where: {
        targetAnnotationFileId_packageFingerprint: {
          targetAnnotationFileId,
          packageFingerprint: fingerprint,
        },
      },
      select: { id: true, revokedAt: true },
    });
    return {
      reviewPackage,
      fingerprint,
      result: {
        status: duplicate ? "duplicate" : "ready",
        target: {
          annotationFileId: targetAnnotationFileId,
          annotationFileName: target.resource.name,
          revision: target.revision,
          duration,
        },
        source: reviewPackage.source,
        packageFingerprint: fingerprint,
        counts: reviewPackage.counts,
        matchedTrackIds: usedTrackIds,
        duplicateLinkId: duplicate?.id ?? null,
        duplicateLifecycle: duplicate ? (duplicate.revokedAt ? "revoked" : "active") : null,
      },
    };
  }

  private async assertActiveAnnotationFile(
    database: PrismaClient | Prisma.TransactionClient,
    annotationFileId: string,
  ) {
    const file = await database.annotationFile.findUnique({
      where: { resourceId: annotationFileId },
      select: { resource: { select: { archivedAt: true, trashedAt: true } } },
    });
    if (!file || file.resource.archivedAt || file.resource.trashedAt) {
      throw notFound("标注文件不存在或当前不可用。");
    }
  }

  private publishReviewChanged(annotationFileId: string) {
    this.reviewPublisher.publishReviewChanged({
      annotationFileId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });
  }
}

function createPackageFingerprint(reviewPackage: AnnotationReviewPackageV1): string {
  return createHash("sha256")
    .update(buildAnnotationReviewPackageFingerprintInput(reviewPackage))
    .digest("hex");
}

function collectUsedTrackIds(reviewPackage: AnnotationReviewPackageV1): string[] {
  const ids = new Set<string>();
  for (const scope of collectScopes(reviewPackage)) {
    if (scope.targets.mode === "tracks") {
      for (const trackId of scope.targets.trackIds) ids.add(trackId);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function collectScopes(reviewPackage: AnnotationReviewPackageV1) {
  return [
    ...reviewPackage.records.confirmations.map((record) => record.scope),
    ...reviewPackage.records.rangeRecords.map((record) => record.scope),
  ];
}

function toJsonValue(value: AnnotationReviewPackageV1): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function mapReviewLink(row: ReviewLinkRow): AnnotationReviewLinkRecord {
  const parsed = parseAnnotationReviewPackage(row.packagePayload);
  if (!parsed.ok) throw new Error(`审核包关联 ${row.id} 的持久化快照无效。`);
  const base = {
    id: row.id,
    targetAnnotationFileId: row.targetAnnotationFileId,
    source: {
      annotationFileId: row.sourceResourceIdSnapshot,
      annotationFileName: row.sourceFileNameSnapshot,
      revision: row.sourceRevision,
    },
    packageFingerprint: row.packageFingerprint,
    counts: {
      confirmations: row.confirmationCount,
      rangeRecords: row.rangeRecordCount,
    },
    reviewPackage: parsed.value,
    createdBy: toPublicUser(row.creator),
    createdAt: row.createdAt.toISOString(),
  };
  if (row.revokedAt && row.revoker) {
    return {
      ...base,
      revokedAt: row.revokedAt.toISOString(),
      revokedBy: toPublicUser(row.revoker),
      revokeReason: row.revokeReason,
    };
  }
  return { ...base, revokedAt: null, revokedBy: null, revokeReason: null };
}
