import { createHash } from "node:crypto";
import type { AlignmentQualityAssessment, Prisma, PrismaClient } from "@prisma/client";
import {
  type AlignmentQualityAssessmentList,
  type AlignmentQualityAssessmentSummary,
  type AlignmentQualityIssueCode,
  type UpsertAlignmentQualityAssessmentRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { conflict, notFound } from "./errors.js";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const MAX_CURRENT_ASSESSMENTS_PER_APPLICATION = 500;

/**
 * 质量评价是独立研究事实：它只引用一次真实 application，不进入标注文档保存、revision 或 operation 事务。
 * 每次改判追加新行并替代旧行，从而同时获得单一当前值、历史可追溯和可靠的网络幂等。
 */
export class AlignmentQualityAssessmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async listCurrent(
    user: ApiUser,
    annotationFileId: string,
    applicationId: string,
  ): Promise<AlignmentQualityAssessmentList> {
    await this.access.assertCapability(user, annotationFileId, "read");
    await this.requireApplication(this.prisma, annotationFileId, applicationId);
    const rows = await this.prisma.alignmentQualityAssessment.findMany({
      where: { alignmentApplicationId: applicationId, supersededAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAX_CURRENT_ASSESSMENTS_PER_APPLICATION + 1,
    });
    return {
      items: rows.slice(0, MAX_CURRENT_ASSESSMENTS_PER_APPLICATION).map(mapAssessmentSummary),
      isPartial: rows.length > MAX_CURRENT_ASSESSMENTS_PER_APPLICATION,
    };
  }

  async upsert(
    user: ApiUser,
    annotationFileId: string,
    applicationId: string,
    input: UpsertAlignmentQualityAssessmentRequest,
  ): Promise<AlignmentQualityAssessmentSummary> {
    const requestHash = createRequestHash(annotationFileId, applicationId, input);
    return this.prisma.$transaction(async (transaction) => {
      // 先锁账号 action，再锁 application/scope 当前槽位；所有写入使用同一顺序，避免并发首次评价互相穿透。
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${`xiqu:alignment-quality-action:${user.id}:${input.clientActionId}`})
        )::text AS locked
      `;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${`xiqu:alignment-quality-current:${applicationId}:${user.id}:${input.scope}`})
        )::text AS locked
      `;

      const requiredCapability = input.scope === "reviewer" ? "review" : "write";
      await this.access.assertCapability(user, annotationFileId, requiredCapability, transaction);
      await this.requireApplication(transaction, annotationFileId, applicationId);

      const existingAction = await transaction.alignmentQualityAssessment.findUnique({
        where: {
          assessorUserId_clientActionId: {
            assessorUserId: user.id,
            clientActionId: input.clientActionId,
          },
        },
      });
      if (existingAction) {
        if (
          existingAction.alignmentApplicationId !== applicationId ||
          existingAction.scope !== input.scope ||
          existingAction.requestHash !== requestHash
        ) {
          throw conflict("clientActionId 已用于另一条强制对齐质量评价。", {
            code: "alignment_quality_action_conflict",
          });
        }
        return mapAssessmentSummary(existingAction);
      }

      const current = await transaction.alignmentQualityAssessment.findFirst({
        where: {
          alignmentApplicationId: applicationId,
          assessorUserId: user.id,
          scope: input.scope,
          supersededAt: null,
        },
      });
      if (current && sameAssessmentValue(current, input)) {
        throw conflict("当前质量评价已经是所选内容。", {
          code: "alignment_quality_no_change",
        });
      }

      const now = new Date();
      if (current) {
        const superseded = await transaction.alignmentQualityAssessment.updateMany({
          where: { id: current.id, supersededAt: null },
          data: { supersededAt: now },
        });
        if (superseded.count !== 1) {
          throw conflict("质量评价已被另一请求更新，请刷新后重试。", {
            code: "alignment_quality_concurrent_update",
          });
        }
      }

      const created = await transaction.alignmentQualityAssessment.create({
        data: {
          alignmentApplicationId: applicationId,
          assessorUserId: user.id,
          clientActionId: input.clientActionId,
          requestHash,
          scope: input.scope,
          verdict: input.verdict,
          issueCodes: input.issueCodes,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "alignment_quality_assessment_upsert",
          actorUserId: user.id,
          resourceId: annotationFileId,
          detail: {
            alignmentApplicationId: applicationId,
            scope: input.scope,
            previous: current ? summarizeAssessmentValue(current) : null,
            current: summarizeAssessmentValue(created),
          },
        },
      });
      return mapAssessmentSummary(created);
    });
  }

  /** application 与 run 的文件快照必须一致，防止未来导入/修复代码留下可跨文件评价的孤立关系。 */
  private async requireApplication(
    database: PrismaClient | Prisma.TransactionClient,
    annotationFileId: string,
    applicationId: string,
  ) {
    const application = await database.alignmentApplication.findFirst({
      where: { id: applicationId, annotationFileId },
      select: {
        id: true,
        operationCount: true,
        alignmentRunId: true,
        artifact: { select: { runId: true } },
        run: { select: { annotationFileIdSnapshot: true } },
        _count: { select: { operations: true } },
      },
    });
    if (
      !application ||
      application.run.annotationFileIdSnapshot !== annotationFileId ||
      application.artifact.runId !== application.alignmentRunId ||
      application._count.operations !== application.operationCount
    ) {
      throw notFound("强制对齐应用记录不存在。");
    }
    return application;
  }
}

function createRequestHash(
  annotationFileId: string,
  applicationId: string,
  input: UpsertAlignmentQualityAssessmentRequest,
) {
  return createHash("sha256").update(stableJsonStringify({
    version: 1,
    annotationFileId,
    applicationId,
    clientActionId: input.clientActionId,
    scope: input.scope,
    verdict: input.verdict,
    issueCodes: input.issueCodes,
  })).digest("hex");
}

function sameAssessmentValue(
  assessment: AlignmentQualityAssessment,
  input: UpsertAlignmentQualityAssessmentRequest,
) {
  return assessment.verdict === input.verdict &&
    stableJsonStringify(assessment.issueCodes) === stableJsonStringify(input.issueCodes);
}

function summarizeAssessmentValue(assessment: AlignmentQualityAssessment) {
  return {
    verdict: assessment.verdict,
    issueCodes: assessment.issueCodes,
  };
}

function mapAssessmentSummary(
  assessment: AlignmentQualityAssessment,
): AlignmentQualityAssessmentSummary {
  return {
    id: assessment.id,
    alignmentApplicationId: assessment.alignmentApplicationId,
    assessorUserId: assessment.assessorUserId,
    scope: assessment.scope,
    verdict: assessment.verdict,
    issueCodes: assessment.issueCodes as AlignmentQualityIssueCode[],
    isCurrent: assessment.supersededAt === null,
    createdAt: assessment.createdAt.toISOString(),
    supersededAt: assessment.supersededAt?.toISOString() ?? null,
  };
}
