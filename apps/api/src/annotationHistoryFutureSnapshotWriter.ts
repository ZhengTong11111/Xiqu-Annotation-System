import { Prisma } from "@prisma/client";
import type { AnnotationHistoryOperationFact } from "./annotationHistoryCompactionTypes.js";
import {
  buildAnnotationHistoryRecipe,
  buildAnnotationHistoryRevisionValidations,
} from "./annotationHistoryCompactionReplay.js";
import { reconstructAnnotationHistoryPayload } from "./annotationHistoryReconstruction.js";
import { createAnnotationHistoryCanonicalHash } from "./annotationHistoryCanonicalHash.js";
import {
  DEFAULT_ANNOTATION_HISTORY_COMPACTION_POLICY,
} from "./annotationHistoryCompactionPolicy.js";
import {
  decideFutureSnapshotStorage,
  MAX_ANNOTATION_HISTORY_FUTURE_REPLAY_OPERATIONS,
  type AnnotationHistoryFutureSnapshotRollout,
  type AnnotationHistoryFutureInlineReason,
  type AnnotationHistoryFutureSnapshotProof,
} from "./annotationHistoryFutureSnapshotPolicy.js";

type FutureSnapshotTransaction = Prisma.TransactionClient;

type CurrentAnnotationFile = {
  revision: number;
  payload: Prisma.JsonValue;
};

export type AnnotationHistoryFutureSnapshotWriteResult = {
  rollout: AnnotationHistoryFutureSnapshotRollout;
  result: "inline" | "reconstructible" | "existing";
  fallbackReason: AnnotationHistoryFutureInlineReason | null;
  durationMs: number;
};

/**
 * 观测属于提交后的旁路动作，不能因为指标注册/写入异常把已经成功的保存伪装成失败。
 * 业务事务本身的异常仍由调用方正常抛出，这个 helper 只隔离观测回调。
 */
export function notifyAnnotationHistoryFutureSnapshotObserver(
  observer: (result: AnnotationHistoryFutureSnapshotWriteResult) => void,
  result: AnnotationHistoryFutureSnapshotWriteResult,
) {
  try {
    observer(result);
  } catch {
    // 指标故障不应触发客户端重试，也不应改变已经提交的数据库事实。
  }
}

/**
 * 保存当前 revision 的恢复快照，并在同一事务中尝试转换为未来轻量形态。
 *
 * 先写完整 inline 再证明，是这里最重要的失败补偿边界：证明、查询或数据库约束
 * 任何一步不满足时，函数只保留 inline；只有完整 recipe 已经验证成功，才会原子
 * 地把同一行改成 reconstructible。调用方事务回滚时，两种形态都会一起回滚。
 */
export async function writeFutureAnnotationRecoverySnapshot(
  transaction: FutureSnapshotTransaction,
  input: {
    annotationFileId: string;
    current: CurrentAnnotationFile;
    createdBy: string;
    reason: string;
    rollout: AnnotationHistoryFutureSnapshotRollout;
  },
): Promise<AnnotationHistoryFutureSnapshotWriteResult> {
  const startedAt = Date.now();
  const finish = (
    result: AnnotationHistoryFutureSnapshotWriteResult["result"],
    fallbackReason: AnnotationHistoryFutureInlineReason | null,
  ): AnnotationHistoryFutureSnapshotWriteResult => ({
    rollout: input.rollout,
    result,
    fallbackReason,
    durationMs: Math.max(0, Date.now() - startedAt),
  });

  // 默认线上路径保持旧的单次幂等 upsert；未来策略关闭时不额外查询 checkpoint 或 operation。
  if (input.rollout === "disabled" || input.reason !== "save") {
    await writeInlineSnapshot(transaction, input);
    return finish("inline", input.rollout === "disabled" ? "rollout_disabled" : "non_save_reason");
  }

  // rollout 配置和数据库 migration 必须同时到位。旧数据库的 payload 仍是 NOT NULL，
  // 不能让试验性容量优化反过来阻断正文保存；未完成 migration 时保留完整 inline 快照。
  if (!(await isFutureSnapshotSchemaReady(transaction))) {
    await writeInlineSnapshot(transaction, input);
    return finish("inline", "schema_not_ready");
  }

  const existing = await transaction.annotationRecoverySnapshot.findUnique({
    where: {
      annotationFileId_revision: {
        annotationFileId: input.annotationFileId,
        revision: input.current.revision,
      },
    },
    select: { id: true },
  });
  // 同一 revision 可能由重试再次抵达；已有快照是权威事实，不能重新计算或覆盖。
  if (existing) return finish("existing", null);

  const createdAt = new Date();
  const target = await transaction.annotationRecoverySnapshot.create({
    data: {
      annotationFileId: input.annotationFileId,
      revision: input.current.revision,
      payload: input.current.payload as Prisma.InputJsonValue,
      createdBy: input.createdBy,
      reason: input.reason,
      createdAt,
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
      createdAt: true,
    },
  });

  const checkpoint = await transaction.annotationRecoverySnapshot.findFirst({
    where: {
      annotationFileId: input.annotationFileId,
      revision: { lt: target.revision },
      storageMode: "inline",
      payload: { not: Prisma.DbNull },
      compactedAt: null,
    },
    orderBy: { revision: "desc" },
    select: {
      id: true,
      annotationFileId: true,
      revision: true,
      payload: true,
      createdAt: true,
    },
  });

  const operationCount = checkpoint
    ? await transaction.annotationOperation.count({
        where: {
          annotationFileId: input.annotationFileId,
          committedRevision: {
            gt: checkpoint.revision,
            lte: target.revision,
          },
        },
      })
    : 0;
  const isCheckpoint = checkpoint === null ||
    shouldCreateFutureCheckpoint({
      checkpointRevision: checkpoint.revision,
      checkpointCreatedAt: checkpoint.createdAt,
      targetRevision: target.revision,
      targetCreatedAt: target.createdAt,
      operationCount,
    });

  const proof = checkpoint && !isCheckpoint
    ? await proveTargetSnapshot(transaction, checkpoint, target)
    : null;
  const decision = decideFutureSnapshotStorage({
    rollout: input.rollout,
    reason: input.reason,
    isCheckpoint,
    targetRevision: target.revision,
    checkpointRevision: checkpoint?.revision ?? 0,
    proof,
  });
  if (decision.storageMode !== "reconstructible") {
    return finish("inline", decision.fallbackReason);
  }

  // CHECK 与 resolver 都要求整组 recipe 同时存在；正文置空和 recipe 更新在当前事务中一次完成。
  await transaction.annotationRecoverySnapshot.update({
    where: { id: target.id },
    data: {
      storageMode: "reconstructible",
      payload: Prisma.DbNull,
      payloadSha256: decision.recipe.targetPayloadHash,
      checkpointSnapshotId: decision.recipe.checkpointSnapshotId,
      operationRevisionStart: decision.recipe.operationRevisionStart,
      operationRevisionEnd: decision.recipe.operationRevisionEnd,
      operationSequenceStart: decision.recipe.operationSequenceStart,
      operationSequenceEnd: decision.recipe.operationSequenceEnd,
      operationCount: decision.recipe.operationCount,
      compactionVersion: decision.recipe.version,
      recipeVerifiedAt: createdAt,
      compactedAt: createdAt,
    },
  });
  return finish("reconstructible", null);
}

/**
 * 复用旧的完整快照写入合同，保证所有回退路径都保持幂等且不覆盖已有历史。
 * 这里不使用 delete/update，避免一次保存重试意外改写已经存在的恢复证据。
 */
async function writeInlineSnapshot(
  transaction: FutureSnapshotTransaction,
  input: {
    annotationFileId: string;
    current: CurrentAnnotationFile;
    createdBy: string;
    reason: string;
  },
) {
  await transaction.annotationRecoverySnapshot.upsert({
    where: {
      annotationFileId_revision: {
        annotationFileId: input.annotationFileId,
        revision: input.current.revision,
      },
    },
    update: {},
    create: {
      annotationFileId: input.annotationFileId,
      revision: input.current.revision,
      payload: input.current.payload as Prisma.InputJsonValue,
      createdBy: input.createdBy,
      reason: input.reason,
    },
  });
}

/**
 * 检查正式双形态合同是否已经进入当前连接所使用的 schema。
 * 仅检查列可空还不够：旧过渡 migration 也可能已经增加字段，因此必须同时确认
 * 最终 CHECK 存在。查询失败直接抛出，让数据库故障保持真实失败，不伪装成普通回退。
 */
async function isFutureSnapshotSchemaReady(
  transaction: FutureSnapshotTransaction,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{
    payloadNullable: boolean;
    futureContractExists: boolean;
  }>>`
    SELECT
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'annotation_recovery_snapshots'
          AND column_name = 'payload'
          AND is_nullable = 'YES'
      ) AS "payloadNullable",
      EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
        JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
        WHERE schema_row.nspname = current_schema()
          AND table_row.relname = 'annotation_recovery_snapshots'
          AND constraint_row.conname = 'annotation_recovery_snapshots_future_storage_contract_check'
      ) AS "futureContractExists"
  `;
  return rows[0]?.payloadNullable === true && rows[0]?.futureContractExists === true;
}

/**
 * 检查点阈值统一复用容量治理策略，避免保存路径另写一套“多久保留正文”的规则。
 * 任一阈值达到就保留当前完整快照，后续轻量快照从它开始重放。
 */
function shouldCreateFutureCheckpoint(input: {
  checkpointRevision: number;
  checkpointCreatedAt: Date;
  targetRevision: number;
  targetCreatedAt: Date;
  operationCount: number;
}) {
  return input.targetRevision - input.checkpointRevision >=
      DEFAULT_ANNOTATION_HISTORY_COMPACTION_POLICY.checkpointRevisionInterval ||
    input.operationCount >= DEFAULT_ANNOTATION_HISTORY_COMPACTION_POLICY.checkpointOperationInterval ||
    input.targetCreatedAt.getTime() - input.checkpointCreatedAt.getTime() >=
      DEFAULT_ANNOTATION_HISTORY_COMPACTION_POLICY.checkpointTimeIntervalMs;
}

/**
 * 用现有重建内核生成未来快照证明。这里可以查询数据库，但不能复制 ProjectData
 * parser、命令 apply 或 hash；任何事实不完整都只返回失败证明，交由策略回退 inline。
 */
async function proveTargetSnapshot(
  transaction: FutureSnapshotTransaction,
  checkpoint: {
    id: string;
    annotationFileId: string;
    revision: number;
    payload: Prisma.JsonValue;
  },
  target: {
    id: string;
    annotationFileId: string;
    revision: number;
    payload: Prisma.JsonValue | null;
  },
): Promise<AnnotationHistoryFutureSnapshotProof> {
  if (target.payload === null) return { ok: false, code: "target_payload_missing" };
  const operations = await transaction.annotationOperation.findMany({
    where: {
      annotationFileId: target.annotationFileId,
      committedRevision: {
        gt: checkpoint.revision,
        lte: target.revision,
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
    take: MAX_ANNOTATION_HISTORY_FUTURE_REPLAY_OPERATIONS + 1,
  });
  if (operations.length > MAX_ANNOTATION_HISTORY_FUTURE_REPLAY_OPERATIONS) {
    return { ok: false, code: "operation_scan_truncated" };
  }
  const operationFacts = operations.flatMap((operation): AnnotationHistoryOperationFact[] =>
    operation.committedRevision === null
      ? []
      : [{ ...operation, committedRevision: operation.committedRevision }]);
  if (operationFacts.length === 0) return { ok: false, code: "operation_revision_missing" };

  const revisions = buildAnnotationHistoryRevisionValidations(
    target.annotationFileId,
    operationFacts,
    checkpoint.revision,
    target.revision,
  );
  const recipe = buildAnnotationHistoryRecipe({
    checkpoint,
    target,
    // 目标 hash 只作为重建内核的输入证明；内核随后会对重放结果重新计算并严格比较。
    targetPayloadHash: createAnnotationHistoryCanonicalHash(target.payload),
    revisions,
  });
  const reconstruction = reconstructAnnotationHistoryPayload({
    annotationFileId: target.annotationFileId,
    expectedTargetSnapshotId: target.id,
    checkpoint,
    target,
    inlineTargetPayload: target.payload,
    operations: operationFacts,
    expectedRecipe: recipe,
  });
  if (!reconstruction.ok) return { ok: false, code: reconstruction.code };
  return {
    ok: true,
    payloadHash: reconstruction.payloadHash,
    recipe: reconstruction.recipe,
  };
}
