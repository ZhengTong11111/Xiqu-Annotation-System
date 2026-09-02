import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AnnotationHistoryOperationFact,
  AnnotationHistorySnapshotDecision,
  AnnotationHistorySnapshotFact,
} from "./annotationHistoryCompactionTypes.js";
import {
  ANNOTATION_HISTORY_SHADOW_RECIPE_VERSION,
  verifyAnnotationHistoryShadowRecipe,
  type AnnotationHistoryShadowRecipe,
  type AnnotationHistoryShadowVerificationCode,
} from "./annotationHistoryShadowRecipe.js";
import { MAX_ANNOTATION_HISTORY_RECONSTRUCTION_OPERATIONS } from "./annotationHistoryReconstructionFacts.js";

export const MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES = 100;

export type AnnotationHistoryShadowWriteCode =
  | AnnotationHistoryShadowVerificationCode
  | "annotation_file_missing"
  | "annotation_file_revision_changed"
  | "candidate_invalid"
  | "existing_recipe_conflict"
  | "maintenance_required"
  | "recipe_operation_limit_exceeded"
  | "snapshot_missing"
  | "snapshot_storage_mode_changed";

export type AnnotationHistoryShadowWriteResult = {
  snapshotId: string;
  revision: number;
  status: "written" | "already_verified" | "blocked";
  code: AnnotationHistoryShadowWriteCode | null;
};

export type AnnotationHistoryShadowWriteReport = {
  annotationFileId: string;
  expectedAnnotationRevision: number;
  selectedCandidateCount: number;
  writtenCount: number;
  alreadyVerifiedCount: number;
  blockedCount: number;
  stoppedEarly: boolean;
  results: AnnotationHistoryShadowWriteResult[];
};

type LockedSnapshot = AnnotationHistorySnapshotFact & {
  annotationFileId: string;
  payload: unknown;
  storageMode: string;
  payloadSha256: string | null;
  checkpointSnapshotId: string | null;
  operationRevisionStart: number | null;
  operationRevisionEnd: number | null;
  operationSequenceStart: number | null;
  operationSequenceEnd: number | null;
  operationCount: number | null;
  compactionVersion: number | null;
  recipeVerifiedAt: Date | null;
  compactedAt: Date | null;
};

/**
 * HC3a 写入器一次只处理一个文件中的少量候选。任一候选复核失败便停止该文件，
 * 已有 payload、当前标注、operation 和审核事实始终保持不变。
 */
export class AnnotationHistoryShadowRecipeService {
  constructor(private readonly prisma: PrismaClient) {}

  async writeFileRecipes(input: {
    annotationFileId: string;
    expectedAnnotationRevision: number;
    decisions: readonly AnnotationHistorySnapshotDecision[];
    limitCandidates: number;
    verifiedAt?: Date;
  }): Promise<AnnotationHistoryShadowWriteReport> {
    validateWriteInput(input);
    const candidates = input.decisions
      .filter((decision): decision is AnnotationHistorySnapshotDecision & {
        recipe: AnnotationHistoryShadowRecipe;
      } => decision.decision === "reconstructible" && decision.recipe !== null)
      .sort((left, right) => left.revision - right.revision)
      .slice(0, input.limitCandidates);
    const verifiedAt = input.verifiedAt ?? new Date();
    if (!Number.isFinite(verifiedAt.getTime())) throw new Error("影子 recipe 复核时间无效。");

    const results: AnnotationHistoryShadowWriteResult[] = [];
    for (const candidate of candidates) {
      const result = await this.writeCandidate({
        annotationFileId: input.annotationFileId,
        expectedAnnotationRevision: input.expectedAnnotationRevision,
        candidate,
        verifiedAt,
      });
      results.push(result);
      // 一个候选出现漂移后，后续候选可能共享同一 checkpoint/operation 区间；必须停止而不是猜测继续。
      if (result.status === "blocked") break;
    }

    return {
      annotationFileId: input.annotationFileId,
      expectedAnnotationRevision: input.expectedAnnotationRevision,
      selectedCandidateCount: candidates.length,
      writtenCount: results.filter(({ status }) => status === "written").length,
      alreadyVerifiedCount: results.filter(({ status }) => status === "already_verified").length,
      blockedCount: results.filter(({ status }) => status === "blocked").length,
      stoppedEarly: results.some(({ status }) => status === "blocked") && results.length < candidates.length,
      results,
    };
  }

  private async writeCandidate(input: {
    annotationFileId: string;
    expectedAnnotationRevision: number;
    candidate: AnnotationHistorySnapshotDecision & { recipe: AnnotationHistoryShadowRecipe };
    verifiedAt: Date;
  }): Promise<AnnotationHistoryShadowWriteResult> {
    const blocked = (code: AnnotationHistoryShadowWriteCode): AnnotationHistoryShadowWriteResult => ({
      snapshotId: input.candidate.snapshotId,
      revision: input.candidate.revision,
      status: "blocked",
      code,
    });
    if (!isValidCandidate(input.candidate)) {
      return blocked(
        input.candidate.recipe.operationCount > MAX_ANNOTATION_HISTORY_RECONSTRUCTION_OPERATIONS
          ? "recipe_operation_limit_exceeded"
          : "candidate_invalid",
      );
    }

    return this.prisma.$transaction(async (transaction) => {
      // 影子写入只允许在平台维护窗口内执行，并锁住状态行直到当前候选提交。
      // 这样管理员即使在批次执行期间关闭维护，也只能在当前短事务结束后生效；下一候选会重新检查并停止。
      const maintenanceRows = await transaction.$queryRaw<Array<{ maintenanceMode: boolean }>>`
        SELECT maintenance_mode AS "maintenanceMode"
        FROM platform_runtime_state
        WHERE id = 'platform'
        FOR SHARE
      `;
      if (maintenanceRows[0]?.maintenanceMode !== true) {
        return blocked("maintenance_required");
      }

      // 文件级事务锁只串行同一文件的影子写入；annotation_files 行锁同时与普通保存建立真实互斥。
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(
          hashtext(${`xiqu:annotation-history-shadow:${input.annotationFileId}`})
        )
      `;
      const files = await transaction.$queryRaw<Array<{ revision: number }>>`
        SELECT revision
        FROM annotation_files
        WHERE resource_id = ${input.annotationFileId}
        FOR SHARE
      `;
      if (files.length !== 1) return blocked("annotation_file_missing");
      if (files[0]!.revision !== input.expectedAnnotationRevision) {
        return blocked("annotation_file_revision_changed");
      }

      const snapshotIds = [
        input.candidate.recipe.checkpointSnapshotId,
        input.candidate.snapshotId,
      ].sort();
      const lockedRows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM annotation_recovery_snapshots
        WHERE annotation_file_id = ${input.annotationFileId}
          AND id IN (${Prisma.join(snapshotIds)})
        ORDER BY id
        FOR UPDATE
      `);
      if (lockedRows.length !== 2) return blocked("snapshot_missing");
      const snapshots = await transaction.annotationRecoverySnapshot.findMany({
        where: {
          annotationFileId: input.annotationFileId,
          id: { in: snapshotIds },
        },
      });
      const checkpoint = snapshots.find(({ id }) =>
        id === input.candidate.recipe.checkpointSnapshotId) as LockedSnapshot | undefined;
      const target = snapshots.find(({ id }) =>
        id === input.candidate.snapshotId) as LockedSnapshot | undefined;
      if (!checkpoint || !target) return blocked("snapshot_missing");
      if (checkpoint.storageMode !== "inline" || target.storageMode !== "inline" || target.compactedAt) {
        return blocked("snapshot_storage_mode_changed");
      }

      const operations = await transaction.annotationOperation.findMany({
        where: {
          annotationFileId: input.annotationFileId,
          committedRevision: {
            gte: input.candidate.recipe.operationRevisionStart,
            lte: input.candidate.recipe.operationRevisionEnd,
          },
        },
        select: {
          id: true,
          annotationFileId: true,
          sequence: true,
          baseRevision: true,
          action: true,
          payload: true,
          status: true,
          committedRevision: true,
          committedAt: true,
        },
        orderBy: { sequence: "asc" },
        take: MAX_ANNOTATION_HISTORY_RECONSTRUCTION_OPERATIONS + 1,
      });
      const operationFacts = operations.flatMap((operation): AnnotationHistoryOperationFact[] =>
        operation.committedRevision === null
          ? []
          : [{ ...operation, committedRevision: operation.committedRevision }]);
      if (operationFacts.length > MAX_ANNOTATION_HISTORY_RECONSTRUCTION_OPERATIONS) {
        return blocked("recipe_operation_limit_exceeded");
      }
      const verification = verifyAnnotationHistoryShadowRecipe({
        annotationFileId: input.annotationFileId,
        expectedTargetSnapshotId: input.candidate.snapshotId,
        checkpoint,
        target,
        operations: operationFacts,
        expectedRecipe: input.candidate.recipe,
      });
      if (!verification.ok) return blocked(verification.code);

      const hasStoredRecipe = target.checkpointSnapshotId !== null ||
        target.operationRevisionStart !== null ||
        target.operationRevisionEnd !== null ||
        target.operationSequenceStart !== null ||
        target.operationSequenceEnd !== null ||
        target.operationCount !== null ||
        target.compactionVersion !== null ||
        target.recipeVerifiedAt !== null;
      if (hasStoredRecipe) {
        if (!isStoredRecipeEqual(target, verification.recipe, verification.payloadHash)) {
          return blocked("existing_recipe_conflict");
        }
        return {
          snapshotId: target.id,
          revision: target.revision,
          status: "already_verified",
          code: null,
        };
      }
      if (target.payloadSha256 !== null && target.payloadSha256 !== verification.payloadHash) {
        return blocked("existing_recipe_conflict");
      }

      // 只更新轻量证明字段；payload、storageMode 和 compactedAt 故意不出现在 data 中。
      await transaction.annotationRecoverySnapshot.update({
        where: { id: target.id },
        data: {
          payloadSha256: verification.payloadHash,
          checkpointSnapshotId: verification.recipe.checkpointSnapshotId,
          operationRevisionStart: verification.recipe.operationRevisionStart,
          operationRevisionEnd: verification.recipe.operationRevisionEnd,
          operationSequenceStart: verification.recipe.operationSequenceStart,
          operationSequenceEnd: verification.recipe.operationSequenceEnd,
          operationCount: verification.recipe.operationCount,
          compactionVersion: verification.recipe.version,
          recipeVerifiedAt: input.verifiedAt,
        },
      });
      return {
        snapshotId: target.id,
        revision: target.revision,
        status: "written",
        code: null,
      };
    }, {
      // 每个候选使用短事务；超时只回滚当前轻量元数据，不会留下部分 recipe。
      maxWait: 5_000,
      timeout: 60_000,
    });
  }
}

function validateWriteInput(input: {
  annotationFileId: string;
  expectedAnnotationRevision: number;
  limitCandidates: number;
}) {
  if (!input.annotationFileId.trim()) throw new Error("影子 recipe 文件 id 不能为空。");
  if (!Number.isInteger(input.expectedAnnotationRevision) || input.expectedAnnotationRevision < 1) {
    throw new Error("影子 recipe 预期文件 revision 无效。");
  }
  if (
    !Number.isInteger(input.limitCandidates) ||
    input.limitCandidates < 1 ||
    input.limitCandidates > MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES
  ) {
    throw new Error(`影子 recipe 候选数必须在 1 到 ${MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES} 之间。`);
  }
}

function isStoredRecipeEqual(
  target: LockedSnapshot,
  recipe: AnnotationHistoryShadowRecipe,
  payloadHash: string,
) {
  return target.payloadSha256 === payloadHash &&
    target.checkpointSnapshotId === recipe.checkpointSnapshotId &&
    target.operationRevisionStart === recipe.operationRevisionStart &&
    target.operationRevisionEnd === recipe.operationRevisionEnd &&
    target.operationSequenceStart === recipe.operationSequenceStart &&
    target.operationSequenceEnd === recipe.operationSequenceEnd &&
    target.operationCount === recipe.operationCount &&
    target.compactionVersion === recipe.version &&
    target.recipeVerifiedAt !== null &&
    target.compactedAt === null;
}

// 写服务不能假设调用者一定来自当前 planner；先挡住非法范围，避免把坏值带进 SQL 条件。
function isValidCandidate(
  candidate: AnnotationHistorySnapshotDecision & { recipe: AnnotationHistoryShadowRecipe },
) {
  const recipe = candidate.recipe;
  const integers = [
    candidate.revision,
    recipe.version,
    recipe.checkpointRevision,
    recipe.operationRevisionStart,
    recipe.operationRevisionEnd,
    recipe.operationSequenceStart,
    recipe.operationSequenceEnd,
    recipe.operationCount,
  ];
  return candidate.snapshotId.trim().length > 0 && candidate.snapshotId.length <= 200 &&
    recipe.checkpointSnapshotId.trim().length > 0 && recipe.checkpointSnapshotId.length <= 200 &&
    recipe.version === ANNOTATION_HISTORY_SHADOW_RECIPE_VERSION &&
    integers.every((value) => Number.isSafeInteger(value) && value > 0) &&
    recipe.checkpointSnapshotId !== candidate.snapshotId &&
    recipe.checkpointRevision < recipe.operationRevisionStart &&
    recipe.operationRevisionStart <= recipe.operationRevisionEnd &&
    recipe.operationRevisionEnd === candidate.revision &&
    recipe.operationSequenceStart <= recipe.operationSequenceEnd &&
    recipe.operationCount <= recipe.operationSequenceEnd - recipe.operationSequenceStart + 1 &&
    recipe.operationCount <= MAX_ANNOTATION_HISTORY_RECONSTRUCTION_OPERATIONS &&
    /^[0-9a-f]{64}$/u.test(recipe.targetPayloadHash);
}
