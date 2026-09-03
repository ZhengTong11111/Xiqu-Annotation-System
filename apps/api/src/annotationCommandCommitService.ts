import type { Prisma, PrismaClient } from "@prisma/client";
import {
  applyAnnotationCommandToProject,
  type ProjectData,
} from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import {
  getAnnotationMutationLeasePurposeForCommand,
  type AnnotationMutationPurpose,
  type AtomicAnnotationCommandOperation,
  type CommitAnnotationCommandBatchRequest,
  type CommitAnnotationCommandBatchResponse,
} from "@xiqu/shared";
import type { AnnotationRevisionPublisher } from "./annotationCollaborationHub.js";
import { encodeAnnotationSnapshotOperationCursor } from "./annotationCommittedOperationPagination.js";
import { lockActiveAnnotationFileForWrite } from "./annotationFileWriteLock.js";
import { assertAnnotationMutationLeaseForWrite } from "./annotationMutationLeaseStore.js";
import {
  assertIdempotentOperationMatch,
  createAnnotationOperationRequestHash,
} from "./annotationOperationIdempotency.js";
import {
  mapAnnotationOperationRecord,
  type AnnotationOperationRow,
} from "./annotationOperationRecord.js";
import {
  assertReplayedAnnotationToolAttemptBindings,
  commitAnnotationToolAttemptBinding,
  prepareAnnotationToolAttemptBindings,
  validateAnnotationToolAttemptCommand,
  type PreparedAnnotationToolAttemptBinding,
} from "./annotationToolAttemptCommit.js";
import type { ApiUser } from "./domain.js";
import { conflict } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";
import {
  writeFutureAnnotationRecoverySnapshot,
} from "./annotationHistoryFutureSnapshotWriter.js";
import type { AnnotationHistoryFutureSnapshotRollout } from "./annotationHistoryFutureSnapshotPolicy.js";

const MAX_DATABASE_SEQUENCE = 2_147_483_647;
const MAX_EXPOSED_VALIDATION_ISSUES = 20;

type PreparedOperation = {
  input: AtomicAnnotationCommandOperation;
  requestHash: string;
};

type CommitTransactionResult = {
  committedRevision: number;
  operations: AnnotationOperationRow[];
  replayed: boolean;
};

/**
 * 把有序领域命令链作为一次权威数据库提交。
 *
 * 这里刻意不依赖 ResourceService：旧的 operation + PUT 保存路径仍需保留到客户端迁移完成，
 * 而新入口必须拥有清晰、可测试且不会被旧快照语义稀释的事务边界。
 */
export class AnnotationCommandCommitService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly revisionPublisher: AnnotationRevisionPublisher,
    private readonly annotationHistoryFutureSnapshotRollout: AnnotationHistoryFutureSnapshotRollout = "disabled",
  ) {}

  async commitBatch(
    user: ApiUser,
    annotationFileId: string,
    request: CommitAnnotationCommandBatchRequest,
  ): Promise<CommitAnnotationCommandBatchResponse> {
    // 锁外权限预检只用于快速失败；事务内锁定资源树后仍会再次复核，不能把这里当授权事实。
    await this.access.assertCapability(user, annotationFileId, "write");
    const operations = request.operations.map((input) => ({
      input,
      requestHash: createAnnotationOperationRequestHash({
        baseRevision: request.baseRevision,
        localRevision: input.localRevision ?? null,
        ...(input.toolAttemptId ? { toolAttemptId: input.toolAttemptId } : {}),
        action: input.action,
        payload: input.payload,
      }),
    }));

    const result = await this.prisma.$transaction((transaction) =>
      this.commitTransaction(transaction, user, annotationFileId, request, operations));
    const operationCursor = encodeAnnotationSnapshotOperationCursor(
      annotationFileId,
      result.committedRevision,
    );

    // 幂等重放只返回既有确认，不能重新发布 revision 通知，否则会制造一次不存在的新提交。
    if (!result.replayed) {
      this.revisionPublisher.publishRevisionAdvanced({
        annotationFileId,
        revision: result.committedRevision,
        operationCursor,
      });
    }
    return {
      committedRevision: result.committedRevision,
      operationCursor,
      operations: result.operations.map(mapAnnotationOperationRecord),
    };
  }

  private async commitTransaction(
    transaction: Prisma.TransactionClient,
    user: ApiUser,
    annotationFileId: string,
    request: CommitAnnotationCommandBatchRequest,
    operations: PreparedOperation[],
  ): Promise<CommitTransactionResult> {
    // 固定锁序与旧保存路径一致；拿锁后再读 operation，避免并发同 key 同时穿过幂等检查。
    const current = await lockActiveAnnotationFileForWrite(
      transaction,
      this.access,
      user,
      annotationFileId,
    );
    const existing = await transaction.annotationOperation.findMany({
      where: {
        annotationFileId,
        actorUserId: user.id,
        clientOperationId: { in: operations.map(({ input }) => input.clientOperationId) },
      },
    });
    const replay = await this.resolveExactReplay(
      transaction,
      user,
      annotationFileId,
      request.baseRevision,
      operations,
      existing,
    );
    if (replay) return replay;
    if (existing.length > 0) {
      throw conflict("原子命令批次与已存在的操作记录不完整匹配。", {
        code: "annotation_command_batch_partial_replay",
      });
    }

    if (current.revision !== request.baseRevision) {
      throw conflict("标注文件已被其他人修改，请刷新后重新提交。", {
        code: "annotation_command_batch_revision_conflict",
        expectedRevision: current.revision,
        receivedRevision: request.baseRevision,
      });
    }
    if (request.baseRevision >= MAX_DATABASE_SEQUENCE) {
      throw conflict("标注文件修订号已达到数据库上限。", {
        code: "annotation_revision_exhausted",
      });
    }

    const requiredPurpose = resolveRequiredMutationPurpose(operations);
    const leaseGuard = await assertAnnotationMutationLeaseForWrite(
      transaction,
      annotationFileId,
      user.id,
      request.baseRevision,
      request.mutationLeaseToken,
      requiredPurpose,
    );
    const parsedCurrent = parseCurrentProjectData(current.payload);
    if (!parsedCurrent.success) {
      throw conflict("当前标注文档格式不完整，需先通过完整保存或迁移修复。", {
        code: "annotation_payload_invalid",
        issues: limitProjectValidationIssues(parsedCurrent.issues),
      });
    }

    const toolAttemptBindings = await prepareAnnotationToolAttemptBindings(transaction, {
      actorUserId: user.id,
      annotationFileId,
      operations: operations.map(({ input }) => input),
    });
    const nextProject = applyOrderedCommands(parsedCurrent.data, operations, toolAttemptBindings);
    // Prisma JSON 不接受 undefined；round-trip 后再过严格 schema，可同时发现 adapter 输出与持久格式漂移。
    const serializedProject = JSON.parse(JSON.stringify(nextProject)) as unknown;
    const parsedResult = parseCurrentProjectData(serializedProject);
    if (!parsedResult.success) {
      // 这是服务端 adapter/schema 的内部不一致，不能伪装成用户可解决的 409。
      throw new Error(`领域命令产生了无效 ProjectData：${JSON.stringify(
        limitProjectValidationIssues(parsedResult.issues),
      )}`);
    }

    if (current.lastOperationSequence > MAX_DATABASE_SEQUENCE - operations.length) {
      throw conflict("标注文件操作序号已达到数据库上限。", {
        code: "annotation_operation_sequence_exhausted",
      });
    }
    await writeFutureAnnotationRecoverySnapshot(transaction, {
      annotationFileId,
      current,
      createdBy: user.id,
      reason: "save",
      rollout: this.annotationHistoryFutureSnapshotRollout,
    });

    const targetRevision = request.baseRevision + 1;
    const committedAt = new Date();
    const sequenceState = await transaction.annotationFile.update({
      where: { resourceId: annotationFileId },
      data: {
        payload: parsedResult.data as Prisma.InputJsonValue,
        revision: targetRevision,
        lastEditedBy: user.id,
        lastSavedAt: committedAt,
        lastOperationSequence: { increment: operations.length },
      },
      select: { lastOperationSequence: true },
    });
    const firstSequence = sequenceState.lastOperationSequence - operations.length + 1;

    // 逐行 create 保留请求顺序和稳定 sequence；批量 API 不返回生成 id，无法构造可靠确认响应。
    const committedRows: AnnotationOperationRow[] = [];
    for (const [operationIndex, operation] of operations.entries()) {
      const committedRow = await transaction.annotationOperation.create({
        data: {
          annotationFileId,
          actorUserId: user.id,
          clientOperationId: operation.input.clientOperationId,
          requestHash: operation.requestHash,
          sequence: firstSequence + operationIndex,
          baseRevision: request.baseRevision,
          localRevision: operation.input.localRevision ?? null,
          action: operation.input.action,
          payload: operation.input.payload as Prisma.InputJsonValue,
          status: "accepted",
          committedRevision: targetRevision,
          committedAt,
        },
      });
      committedRows.push(committedRow);
      const toolAttemptBinding = toolAttemptBindings.get(operationIndex);
      if (toolAttemptBinding) {
        await commitAnnotationToolAttemptBinding(
          transaction,
          toolAttemptBinding,
          committedRow,
          committedAt,
        );
      }
    }
    await transaction.resourceEntry.update({
      where: { id: annotationFileId },
      data: { updatedAt: committedAt },
    });
    if (leaseGuard.leaseWasUsed) {
      await transaction.annotationMutationLease.delete({
        where: { annotationFileId },
      });
    }
    await transaction.auditLog.create({
      data: {
        action: "annotation_file_save",
        actorUserId: user.id,
        resourceId: annotationFileId,
        detail: {
          revision: targetRevision,
          operationCount: operations.length,
          commitMode: "domain_command_batch",
          ...(leaseGuard.leaseWasUsed ? { mutationLeaseReleased: true } : {}),
        },
      },
    });
    return {
      committedRevision: targetRevision,
      operations: committedRows,
      replayed: false,
    };
  }

  private async resolveExactReplay(
    transaction: Prisma.TransactionClient,
    user: ApiUser,
    annotationFileId: string,
    baseRevision: number,
    operations: PreparedOperation[],
    existingRows: AnnotationOperationRow[],
  ): Promise<CommitTransactionResult | null> {
    if (existingRows.length === 0) return null;
    const byClientId = new Map(existingRows.map((row) => [row.clientOperationId, row]));
    // 已存在 key 即使最终不能完整重放，也必须先核对指纹，给“同 id 不同请求”稳定的幂等冲突。
    for (const operation of operations) {
      const row = byClientId.get(operation.input.clientOperationId);
      if (row) assertIdempotentOperationMatch(row.requestHash, operation.requestHash);
    }
    if (existingRows.length !== operations.length) return null;
    const orderedRows = operations.map(({ input }) => byClientId.get(input.clientOperationId));
    if (orderedRows.some((row) => !row)) return null;
    const rows = orderedRows as AnnotationOperationRow[];
    const committedRevision = rows[0]?.committedRevision;
    if (
      committedRevision === null || committedRevision === undefined ||
      rows.some((row) =>
        row.committedRevision !== committedRevision ||
        row.status !== "accepted") ||
      rows.some((row, index) => index > 0 && row.sequence <= rows[index - 1]!.sequence)
    ) {
      throw conflict("已有操作不能作为该原子批次的完整提交确认。", {
        code: "annotation_command_batch_replay_ambiguous",
      });
    }
    // 不能只比较请求子集：原批次若有第三条 operation，重试前两条也会“全部存在”。
    // 回查同一 actor/base/committed revision 的完整序列，确保响应确实代表当初那一整批。
    const completeCommittedRows = await transaction.annotationOperation.findMany({
      where: {
        annotationFileId,
        actorUserId: user.id,
        baseRevision,
        committedRevision,
      },
      orderBy: { sequence: "asc" },
    });
    if (
      completeCommittedRows.length !== rows.length ||
      completeCommittedRows.some((row, index) =>
        row.clientOperationId !== rows[index]?.clientOperationId)
    ) {
      throw conflict("请求不是原已提交命令批次的完整序列。", {
        code: "annotation_command_batch_replay_ambiguous",
      });
    }
    await assertReplayedAnnotationToolAttemptBindings(
      transaction,
      operations.map(({ input }) => input),
      rows,
    );
    return { committedRevision, operations: rows, replayed: true };
  }
}

// 一批结构命令只能共用一种租约用途；当前可重放合同只会产生 track_structure 或 null。
function resolveRequiredMutationPurpose(
  operations: PreparedOperation[],
): AnnotationMutationPurpose | null {
  const purposes = new Set(
    operations
      .map(({ input }) => getAnnotationMutationLeasePurposeForCommand(input.payload))
      .filter((purpose): purpose is AnnotationMutationPurpose => purpose !== null),
  );
  if (purposes.size > 1) {
    throw conflict("同一原子批次不能混用不同的结构变更租约用途。", {
      code: "annotation_command_batch_mixed_lease_purpose",
    });
  }
  return purposes.values().next().value ?? null;
}

// 每条命令都在上一条产生的临时 ProjectData 上检查 before；任一失败时整个数据库事务尚未写入。
function applyOrderedCommands(
  project: ProjectData,
  operations: PreparedOperation[],
  toolAttemptBindings: ReadonlyMap<number, PreparedAnnotationToolAttemptBinding>,
) {
  let nextProject = project;
  for (const [operationIndex, operation] of operations.entries()) {
    const beforeProject = nextProject;
    const result = applyAnnotationCommandToProject(nextProject, operation.input.payload);
    if (result.status === "applied") {
      const binding = toolAttemptBindings.get(operationIndex);
      if (binding) {
        validateAnnotationToolAttemptCommand(
          binding,
          operation.input,
          beforeProject,
          result.project,
        );
      }
      nextProject = result.project;
      continue;
    }
    if (result.status === "blocked") {
      throw conflict("领域命令前置条件与当前文档不一致。", {
        code: "annotation_command_precondition_failed",
        operationIndex,
        issues: normalizeApplyIssues(result),
      });
    }
    // shared 批次 parser 已排除 invalid/snapshot；到达这里代表服务端合同或 dispatcher 漂移。
    throw new Error(`原子批次包含不可执行命令：${result.status}`);
  }
  return nextProject;
}

function normalizeApplyIssues(result: { issues?: unknown; childIndex?: number }) {
  if (Array.isArray(result.issues)) {
    return result.issues.slice(0, MAX_EXPOSED_VALIDATION_ISSUES).map((issue) => {
      if (!issue || typeof issue !== "object") return { code: "precondition_failed" };
      const value = issue as Record<string, unknown>;
      return {
        code: typeof value.code === "string" ? value.code : "precondition_failed",
        ...(typeof value.targetKey === "string" ? { targetKey: value.targetKey } : {}),
      };
    });
  }
  return typeof result.childIndex === "number"
    ? [{ code: "child_precondition_failed", childIndex: result.childIndex }]
    : [{ code: "precondition_failed" }];
}

function limitProjectValidationIssues(
  issues: Array<{ path: Array<string | number>; code: string }>,
) {
  return issues.slice(0, MAX_EXPOSED_VALIDATION_ISSUES).map((issue) => ({
    path: issue.path,
    code: issue.code,
  }));
}
