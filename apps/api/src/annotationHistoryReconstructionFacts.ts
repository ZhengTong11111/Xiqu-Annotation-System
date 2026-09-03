import type { Prisma } from "@prisma/client";
import { ANNOTATION_HISTORY_CANONICAL_HASH_VERSION } from "./annotationHistoryCanonicalHash.js";
import type { AnnotationHistoryOperationFact } from "./annotationHistoryCompactionTypes.js";
import type { AnnotationHistoryShadowRecipe } from "./annotationHistoryReconstruction.js";

export const MAX_ANNOTATION_HISTORY_RECONSTRUCTION_OPERATIONS = 10_000;

export type AnnotationHistoryStoredRecipeColumns = {
  payloadSha256: string | null;
  checkpointSnapshotId: string | null;
  operationRevisionStart: number | null;
  operationRevisionEnd: number | null;
  operationSequenceStart: number | null;
  operationSequenceEnd: number | null;
  operationCount: number | null;
  compactionVersion: number | null;
  recipeVerifiedAt: Date | null;
};

export type AnnotationHistoryReconstructionFactLoadCode =
  | "checkpoint_missing"
  | "recipe_incomplete"
  | "recipe_operation_limit_exceeded"
  | "snapshot_storage_mode_changed";

export type AnnotationHistoryReconstructionFactLoadResult =
  | {
      ok: true;
      checkpoint: {
        id: string;
        annotationFileId: string;
        revision: number;
        payload: unknown;
      };
      operations: AnnotationHistoryOperationFact[];
      recipe: AnnotationHistoryShadowRecipe;
    }
  | {
      ok: false;
      code: AnnotationHistoryReconstructionFactLoadCode;
      operationCount: number;
    };

/**
 * 从同一事务快照中读取重建所需的最小数据库事实。
 * 本模块只负责有界查询与 recipe 形状读取；ProjectData 解析、命令重放和 hash 证明仍由统一纯内核负责。
 */
export async function loadAnnotationHistoryReconstructionFacts(
  transaction: Prisma.TransactionClient,
  annotationFileId: string,
  target: AnnotationHistoryStoredRecipeColumns,
): Promise<AnnotationHistoryReconstructionFactLoadResult> {
  const recipe = readAnnotationHistoryStoredRecipe(target);
  if (!recipe) return blocked("recipe_incomplete");
  if (recipe.operationCount > MAX_ANNOTATION_HISTORY_RECONSTRUCTION_OPERATIONS) {
    return blocked("recipe_operation_limit_exceeded");
  }

  const checkpoint = await transaction.annotationRecoverySnapshot.findFirst({
    where: {
      id: recipe.checkpointSnapshotId,
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
        gte: recipe.operationRevisionStart,
        lte: recipe.operationRevisionEnd,
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
    return blocked("recipe_operation_limit_exceeded", operationFacts.length);
  }

  return {
    ok: true,
    checkpoint,
    operations: operationFacts,
    recipe,
  };
}

/** 数据库 recipe 字段必须整组存在；缺一项都不能推断或补默认值。 */
export function readAnnotationHistoryStoredRecipe(
  input: AnnotationHistoryStoredRecipeColumns,
): AnnotationHistoryShadowRecipe | null {
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

function blocked(
  code: AnnotationHistoryReconstructionFactLoadCode,
  operationCount = 0,
): AnnotationHistoryReconstructionFactLoadResult {
  return { ok: false, code, operationCount };
}
