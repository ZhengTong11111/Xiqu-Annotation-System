import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ANNOTATION_HISTORY_CANONICAL_HASH_VERSION,
} from "./annotationHistoryCanonicalHash.js";
import type { AnnotationHistoryOperationFact } from "./annotationHistoryCompactionTypes.js";
import {
  reconstructAnnotationHistoryPayload,
  type AnnotationHistoryReconstructionCode,
  type AnnotationHistoryShadowRecipe,
} from "./annotationHistoryReconstruction.js";
import {
  MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES,
  MAX_ANNOTATION_HISTORY_SHADOW_OPERATIONS,
} from "./annotationHistoryShadowRecipeService.js";

export type AnnotationHistoryStoredRecipeVerificationCode =
  | AnnotationHistoryReconstructionCode
  | "checkpoint_missing"
  | "recipe_incomplete"
  | "recipe_operation_limit_exceeded"
  | "snapshot_storage_mode_changed";

export type AnnotationHistoryStoredRecipeVerificationResult = {
  snapshotId: string;
  revision: number;
  status: "verified" | "blocked";
  code: AnnotationHistoryStoredRecipeVerificationCode | null;
  operationCount: number;
};

export type AnnotationHistoryStoredRecipeVerificationReport = {
  annotationFileId: string;
  fileFound: boolean;
  selectedCandidateCount: number;
  verifiedCount: number;
  blockedCount: number;
  truncated: boolean;
  interrupted: boolean;
  stoppedEarly: boolean;
  results: AnnotationHistoryStoredRecipeVerificationResult[];
};

type StoredRecipeTarget = Awaited<ReturnType<typeof loadStoredRecipeTargets>>[number];

/**
 * 对已持久化的 inline 影子 recipe 做强一致只读复核。
 * 服务不更新时间或修复坏行；首个漂移立即停止，交由操作者决定是否重新规划。
 */
export class AnnotationHistoryStoredRecipeVerificationService {
  constructor(private readonly prisma: PrismaClient) {}

  async verifyFileRecipes(input: {
    annotationFileId: string;
    limitCandidates: number;
    signal?: AbortSignal;
  }): Promise<AnnotationHistoryStoredRecipeVerificationReport> {
    validateVerificationInput(input);
    return this.prisma.$transaction(async (transaction) => {
      const file = await transaction.annotationFile.findUnique({
        where: { resourceId: input.annotationFileId },
        select: { resourceId: true },
      });
      if (!file) return emptyReport(input.annotationFileId);

      const loadedTargets = await loadStoredRecipeTargets(
        transaction,
        input.annotationFileId,
        input.limitCandidates + 1,
      );
      const truncated = loadedTargets.length > input.limitCandidates;
      const targets = loadedTargets.slice(0, input.limitCandidates);
      const results: AnnotationHistoryStoredRecipeVerificationResult[] = [];
      let interrupted = false;
      for (const target of targets) {
        if (input.signal?.aborted) {
          interrupted = true;
          break;
        }
        const result = await verifyStoredTarget(transaction, input.annotationFileId, target);
        results.push(result);
        // 查询期间收到终止信号时也要在报告中留下事实；否则最后一个候选完成后会被误报为正常结束。
        if (input.signal?.aborted) {
          interrupted = true;
          break;
        }
        // 相邻 recipe 往往共享 checkpoint/operation；首个漂移后继续扫描只会制造重复噪音。
        if (result.status === "blocked") break;
      }
      return {
        annotationFileId: input.annotationFileId,
        fileFound: true,
        selectedCandidateCount: targets.length,
        verifiedCount: results.filter(({ status }) => status === "verified").length,
        blockedCount: results.filter(({ status }) => status === "blocked").length,
        truncated,
        interrupted,
        stoppedEarly: (interrupted || results.some(({ status }) => status === "blocked")) &&
          results.length < targets.length,
        results,
      };
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 60_000,
    });
  }
}

async function loadStoredRecipeTargets(
  transaction: Prisma.TransactionClient,
  annotationFileId: string,
  take: number,
) {
  return transaction.annotationRecoverySnapshot.findMany({
    where: {
      annotationFileId,
      recipeVerifiedAt: { not: null },
    },
    select: {
      id: true,
      annotationFileId: true,
      revision: true,
      payload: true,
      storageMode: true,
      payloadSha256: true,
      checkpointSnapshotId: true,
      operationRevisionStart: true,
      operationRevisionEnd: true,
      operationSequenceStart: true,
      operationSequenceEnd: true,
      operationCount: true,
      compactionVersion: true,
      recipeVerifiedAt: true,
      compactedAt: true,
    },
    orderBy: [{ revision: "asc" }, { id: "asc" }],
    take,
  });
}

async function verifyStoredTarget(
  transaction: Prisma.TransactionClient,
  annotationFileId: string,
  target: StoredRecipeTarget,
): Promise<AnnotationHistoryStoredRecipeVerificationResult> {
  const blocked = (
    code: AnnotationHistoryStoredRecipeVerificationCode,
    operationCount = 0,
  ): AnnotationHistoryStoredRecipeVerificationResult => ({
    snapshotId: target.id,
    revision: target.revision,
    status: "blocked",
    code,
    operationCount,
  });
  if (target.storageMode !== "inline" || target.compactedAt !== null) {
    return blocked("snapshot_storage_mode_changed");
  }
  const storedRecipe = readStoredRecipe(target);
  if (!storedRecipe) return blocked("recipe_incomplete");
  if (storedRecipe.operationCount > MAX_ANNOTATION_HISTORY_SHADOW_OPERATIONS) {
    return blocked("recipe_operation_limit_exceeded");
  }

  const checkpoint = await transaction.annotationRecoverySnapshot.findFirst({
    where: {
      id: storedRecipe.checkpointSnapshotId,
      annotationFileId,
    },
    select: {
      id: true,
      annotationFileId: true,
      revision: true,
      payload: true,
      storageMode: true,
    },
  });
  if (!checkpoint) return blocked("checkpoint_missing");
  if (checkpoint.storageMode !== "inline") return blocked("snapshot_storage_mode_changed");

  const operations = await transaction.annotationOperation.findMany({
    where: {
      annotationFileId,
      committedRevision: {
        gte: storedRecipe.operationRevisionStart,
        lte: storedRecipe.operationRevisionEnd,
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
    take: MAX_ANNOTATION_HISTORY_SHADOW_OPERATIONS + 1,
  });
  const operationFacts = operations.flatMap((operation): AnnotationHistoryOperationFact[] =>
    operation.committedRevision === null
      ? []
      : [{ ...operation, committedRevision: operation.committedRevision }]);
  if (operationFacts.length > MAX_ANNOTATION_HISTORY_SHADOW_OPERATIONS) {
    return blocked("recipe_operation_limit_exceeded", operationFacts.length);
  }

  const reconstruction = reconstructAnnotationHistoryPayload({
    annotationFileId,
    expectedTargetSnapshotId: target.id,
    checkpoint,
    target,
    inlineTargetPayload: target.payload,
    operations: operationFacts,
    expectedRecipe: storedRecipe,
  });
  if (!reconstruction.ok) return blocked(reconstruction.code, operationFacts.length);
  return {
    snapshotId: target.id,
    revision: target.revision,
    status: "verified",
    code: null,
    operationCount: operationFacts.length,
  };
}

/** 数据库字段必须整组存在；缺一项都不能猜测 recipe。 */
export function readStoredRecipe(input: {
  payloadSha256: string | null;
  checkpointSnapshotId: string | null;
  operationRevisionStart: number | null;
  operationRevisionEnd: number | null;
  operationSequenceStart: number | null;
  operationSequenceEnd: number | null;
  operationCount: number | null;
  compactionVersion: number | null;
  recipeVerifiedAt: Date | null;
}): AnnotationHistoryShadowRecipe | null {
  if (
    input.payloadSha256 === null ||
    input.checkpointSnapshotId === null ||
    input.operationRevisionStart === null ||
    input.operationRevisionEnd === null ||
    input.operationSequenceStart === null ||
    input.operationSequenceEnd === null ||
    input.operationCount === null ||
    input.compactionVersion === null ||
    input.recipeVerifiedAt === null
  ) {
    return null;
  }
  return {
    // 数据库列是普通 integer；真实合法性仍由统一重建内核按 version=1 复核。
    version: input.compactionVersion as AnnotationHistoryShadowRecipe["version"],
    hashVersion: ANNOTATION_HISTORY_CANONICAL_HASH_VERSION,
    checkpointSnapshotId: input.checkpointSnapshotId,
    checkpointRevision: input.operationRevisionStart - 1,
    operationRevisionStart: input.operationRevisionStart,
    operationRevisionEnd: input.operationRevisionEnd,
    operationSequenceStart: input.operationSequenceStart,
    operationSequenceEnd: input.operationSequenceEnd,
    operationCount: input.operationCount,
    targetPayloadHash: input.payloadSha256,
    estimatedBytes: 0,
  };
}

function validateVerificationInput(input: { annotationFileId: string; limitCandidates: number }) {
  if (!input.annotationFileId.trim() || input.annotationFileId.length > 200) {
    throw new Error("影子 recipe 只读复核文件 id 无效。");
  }
  if (
    !Number.isSafeInteger(input.limitCandidates) ||
    input.limitCandidates < 1 ||
    input.limitCandidates > MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES
  ) {
    throw new Error(`影子 recipe 只读复核候选数必须在 1 到 ${MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES} 之间。`);
  }
}

function emptyReport(annotationFileId: string): AnnotationHistoryStoredRecipeVerificationReport {
  return {
    annotationFileId,
    fileFound: false,
    selectedCandidateCount: 0,
    verifiedCount: 0,
    blockedCount: 0,
    truncated: false,
    interrupted: false,
    stoppedEarly: false,
    results: [],
  };
}
