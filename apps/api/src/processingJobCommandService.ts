import type {
  Prisma,
  PrismaClient,
  ProcessingJobCommandAction,
  ProcessingJobCommandOutcome,
  ProcessingJobStatus,
} from "@prisma/client";
import type {
  CancelProcessingJobRequest,
  ProcessingJobCommandResult,
  RetryProcessingJobRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { MediaAnalysisJobService } from "./mediaAnalysisJobService.js";
import {
  assertProcessingJobCommandMatch,
  createProcessingJobCommandFingerprint,
  createProcessingJobRetryClientRequestId,
  mapProcessingJobCommandResult,
  normalizeProcessingJobCancellationReason,
} from "./processingJobCommand.js";
import { isValidProcessingJobClientRequestId } from "./processingJobIdentity.js";
import { ResourceAccessService } from "./resourceAccess.js";

const TERMINAL_JOB_STATUSES: ReadonlySet<ProcessingJobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

type RetryReservation =
  | { completed: ProcessingJobCommandResult }
  | {
      commandId: string;
      annotationFileId: string;
      audioTrackId: string;
      sourceJobId: string;
    };

type CancellationCommandDraft = {
  action: Extract<ProcessingJobCommandAction, "cancel_request" | "force_cancel">;
  actorUserId: string;
  clientCommandId: string;
  targetJobId: string;
  targetRequestId: string | null;
  requestFingerprint: string;
  outcome: Exclude<ProcessingJobCommandOutcome, "pending" | "retry_scheduled">;
};

/** 后台任务治理命令的唯一事务 owner；router 和 worker 不得复制 request/job 状态转换。 */
export class ProcessingJobCommandService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly mediaAnalysis: MediaAnalysisJobService,
  ) {}

  async cancelRequest(
    user: ApiUser,
    requestId: string,
    input: CancelProcessingJobRequest,
  ): Promise<ProcessingJobCommandResult> {
    assertClientCommandId(input.clientCommandId);
    const reason = normalizeProcessingJobCancellationReason(input.reason);
    const fingerprint = createProcessingJobCommandFingerprint({
      action: "cancel_request",
      targetJobId: null,
      targetRequestId: requestId,
      reason,
    });
    return this.prisma.$transaction(async (transaction) => {
      await lockClientCommand(transaction, user.id, input.clientCommandId);
      const replay = await findCommandReplay(
        transaction,
        user.id,
        input.clientCommandId,
        fingerprint,
      );
      if (replay) return mapProcessingJobCommandResult(replay);

      const initial = await transaction.processingJobRequest.findUnique({
        where: { id: requestId },
        select: {
          requesterUserId: true,
          jobId: true,
          job: { select: { deduplicationKey: true } },
        },
      });
      // 普通取消只认 request owner；不存在和他人 request 使用同一 404，避免枚举任务需求。
      if (!initial || initial.requesterUserId !== user.id) {
        throw notFound("后台任务请求不存在。");
      }
      // 与媒体分析创建复用同一 canonical 锁，避免“最后需求取消”和“新需求附加”各自基于旧快照提交。
      await lockCanonicalJob(transaction, initial.job.deduplicationKey);
      await lockJob(transaction, initial.jobId);
      const request = await transaction.processingJobRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { job: true },
      });
      const now = new Date();
      let outcome: CancellationCommandDraft["outcome"];
      if (TERMINAL_JOB_STATUSES.has(request.job.status)) {
        outcome = "already_terminal";
      } else if (request.cancelledAt) {
        outcome = "request_already_cancelled";
      } else {
        await transaction.processingJobRequest.update({
          where: { id: request.id },
          data: {
            cancelledAt: now,
            cancelledBy: user.id,
            cancellationReason: reason,
          },
        });
        const remaining = await transaction.processingJobRequest.count({
          where: { jobId: request.jobId, cancelledAt: null },
        });
        outcome = remaining > 0
          ? "request_cancelled_execution_continues"
          : await transitionJobForCancellation(transaction, {
              job: request.job,
              actorUserId: user.id,
              mode: "user_request",
              reason,
              now,
            });
      }
      return createCancellationCommand(transaction, {
        action: "cancel_request",
        actorUserId: user.id,
        clientCommandId: input.clientCommandId,
        targetJobId: request.jobId,
        targetRequestId: request.id,
        requestFingerprint: fingerprint,
        outcome,
      }, reason);
    });
  }

  async forceCancel(
    user: ApiUser,
    jobId: string,
    input: CancelProcessingJobRequest,
  ): Promise<ProcessingJobCommandResult> {
    if (!this.access.hasFullResourceAccess(user)) {
      throw forbidden("只有管理员可以强制取消后台任务。");
    }
    assertClientCommandId(input.clientCommandId);
    const reason = normalizeProcessingJobCancellationReason(input.reason);
    const fingerprint = createProcessingJobCommandFingerprint({
      action: "force_cancel",
      targetJobId: jobId,
      targetRequestId: null,
      reason,
    });
    return this.prisma.$transaction(async (transaction) => {
      await lockClientCommand(transaction, user.id, input.clientCommandId);
      const replay = await findCommandReplay(
        transaction,
        user.id,
        input.clientCommandId,
        fingerprint,
      );
      if (replay) return mapProcessingJobCommandResult(replay);
      const initial = await transaction.processingJob.findUnique({
        where: { id: jobId },
        select: { deduplicationKey: true },
      });
      if (!initial) throw notFound("后台任务不存在。");
      await lockCanonicalJob(transaction, initial.deduplicationKey);
      await lockJob(transaction, jobId);
      const job = await transaction.processingJob.findUniqueOrThrow({ where: { id: jobId } });
      const now = new Date();
      let outcome: CancellationCommandDraft["outcome"];
      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        outcome = "already_terminal";
      } else {
        await transaction.processingJobRequest.updateMany({
          where: { jobId, cancelledAt: null },
          data: {
            cancelledAt: now,
            cancelledBy: user.id,
            cancellationReason: reason,
          },
        });
        outcome = await transitionJobForCancellation(transaction, {
          job,
          actorUserId: user.id,
          mode: "admin_force",
          reason,
          now,
        });
      }
      return createCancellationCommand(transaction, {
        action: "force_cancel",
        actorUserId: user.id,
        clientCommandId: input.clientCommandId,
        targetJobId: job.id,
        targetRequestId: null,
        requestFingerprint: fingerprint,
        outcome,
      }, reason);
    });
  }

  async retryRequest(
    user: ApiUser,
    requestId: string,
    input: RetryProcessingJobRequest,
  ): Promise<ProcessingJobCommandResult> {
    assertClientCommandId(input.clientCommandId);
    const fingerprint = createProcessingJobCommandFingerprint({
      action: "retry",
      targetJobId: null,
      targetRequestId: requestId,
      reason: null,
    });
    const reservation: RetryReservation = await this.prisma.$transaction(async (transaction) => {
      await lockClientCommand(transaction, user.id, input.clientCommandId);
      const replay = await findCommandReplay(
        transaction,
        user.id,
        input.clientCommandId,
        fingerprint,
      );
      if (replay && replay.outcome !== "pending") {
        return { completed: mapProcessingJobCommandResult(replay) } as const;
      }
      const request = await transaction.processingJobRequest.findUnique({
        where: { id: requestId },
        include: { job: true },
      });
      if (!request) throw notFound("后台任务请求不存在。");
      const isAdministrator = this.access.hasFullResourceAccess(user);
      if (request.requesterUserId !== user.id && !isAdministrator) {
        throw notFound("后台任务请求不存在。");
      }
      if (request.job.type !== "media_analysis") {
        throw conflict("当前任务类型尚不支持重试。", {
          code: "processing_job_retry_unsupported",
        });
      }
      if (request.job.status !== "failed" && request.job.status !== "cancelled") {
        throw conflict("只有失败或已取消的任务可以重试。", {
          code: "processing_job_retry_not_allowed",
        });
      }
      if (!request.contextResourceId || !request.mediaAudioTrackId) {
        throw conflict("该历史任务缺少可重新校验的音轨上下文。", {
          code: "processing_job_retry_context_missing",
        });
      }
      const command = replay ?? await transaction.processingJobCommand.create({
        data: {
          actorUserId: user.id,
          clientCommandId: input.clientCommandId,
          action: "retry",
          requestFingerprint: fingerprint,
          targetJobId: request.jobId,
          targetRequestId: request.id,
          outcome: "pending",
        },
      });
      return {
        commandId: command.id,
        annotationFileId: request.contextResourceId,
        audioTrackId: request.mediaAudioTrackId,
        sourceJobId: request.jobId,
      } as const;
    });
    if ("completed" in reservation) return reservation.completed;

    // reservation 先落库；若进程在分析创建后崩溃，同一命令会用派生 UUID 精确找回已有 job 再完成预约。
    const retryClientRequestId = createProcessingJobRetryClientRequestId(
      user.id,
      input.clientCommandId,
    );
    await this.mediaAnalysis.createAnalysis(user, reservation.annotationFileId, {
      audioTrackId: reservation.audioTrackId,
      force: true,
      clientRequestId: retryClientRequestId,
    });
    const resultRequestKey = await this.prisma.processingJobRequestKey.findUnique({
      where: {
        requesterUserId_clientRequestId: {
          requesterUserId: user.id,
          clientRequestId: retryClientRequestId,
        },
      },
      select: { request: { select: { jobId: true } } },
    });
    if (!resultRequestKey) {
      throw conflict("重试任务缺少幂等结果映射。", {
        code: "processing_job_retry_result_missing",
      });
    }
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.processingJobCommand.updateMany({
        where: { id: reservation.commandId, outcome: "pending" },
        data: { outcome: "retry_scheduled", resultJobId: resultRequestKey.request.jobId },
      });
      if (updated.count === 1) {
        await transaction.auditLog.create({
          data: {
            action: "processing_job_retry",
            actorUserId: user.id,
            resourceId: reservation.annotationFileId,
            detail: {
              commandId: reservation.commandId,
              requestId,
              sourceJobId: reservation.sourceJobId,
              resultJobId: resultRequestKey.request.jobId,
            },
          },
        });
      }
      const command = await transaction.processingJobCommand.findUniqueOrThrow({
        where: { id: reservation.commandId },
      });
      return mapProcessingJobCommandResult(command);
    });
  }
}

async function transitionJobForCancellation(
  transaction: Prisma.TransactionClient,
  input: {
    job: {
      id: string;
      status: "queued" | "running" | "cancelling" | "cancelled" | "succeeded" | "failed";
      analysisRunId: string | null;
    };
    actorUserId: string;
    mode: "user_request" | "admin_force";
    reason: string | null;
    now: Date;
  },
): Promise<Extract<ProcessingJobCommandOutcome, "execution_cancelling" | "execution_cancelled">> {
  if (input.job.status === "queued") {
    await transaction.processingJob.update({
      where: { id: input.job.id },
      data: {
        status: "cancelled",
        progress: 0,
        cancelRequestedAt: input.now,
        cancelRequestedBy: input.actorUserId,
        cancellationMode: input.mode,
        cancellationReason: input.reason,
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        finishedAt: input.now,
      },
    });
    if (input.job.analysisRunId) {
      const cancelledRun = await transaction.mediaAnalysisRun.updateMany({
        where: { id: input.job.analysisRunId, status: "queued" },
        data: {
          status: "cancelled",
          progress: 0,
          errorCode: null,
          completedAt: input.now,
        },
      });
      if (cancelledRun.count !== 1) {
        throw conflict("媒体分析任务与运行状态不一致。", {
          code: "processing_job_run_state_mismatch",
        });
      }
    }
    return "execution_cancelled";
  }
  if (input.job.status === "running") {
    await transaction.processingJob.update({
      where: { id: input.job.id },
      data: {
        status: "cancelling",
        cancelRequestedAt: input.now,
        cancelRequestedBy: input.actorUserId,
        cancellationMode: input.mode,
        cancellationReason: input.reason,
      },
    });
    if (input.job.analysisRunId) {
      const cancellingRun = await transaction.mediaAnalysisRun.updateMany({
        where: { id: input.job.analysisRunId, status: "running" },
        data: { status: "cancelling" },
      });
      if (cancellingRun.count !== 1) {
        throw conflict("媒体分析任务与运行状态不一致。", {
          code: "processing_job_run_state_mismatch",
        });
      }
    }
  }
  return "execution_cancelling";
}

async function createCancellationCommand(
  transaction: Prisma.TransactionClient,
  draft: CancellationCommandDraft,
  reason: string | null,
) {
  const command = await transaction.processingJobCommand.create({ data: draft });
  await transaction.auditLog.create({
    data: {
      action: draft.action === "force_cancel"
        ? "processing_job_force_cancel"
        : "processing_job_request_cancel",
      actorUserId: draft.actorUserId,
      detail: {
        commandId: command.id,
        jobId: draft.targetJobId,
        requestId: draft.targetRequestId,
        outcome: draft.outcome,
        reason,
      },
    },
  });
  return mapProcessingJobCommandResult(command);
}

async function findCommandReplay(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  clientCommandId: string,
  requestFingerprint: string,
) {
  const command = await transaction.processingJobCommand.findUnique({
    where: { actorUserId_clientCommandId: { actorUserId, clientCommandId } },
  });
  if (command) {
    assertProcessingJobCommandMatch(command.requestFingerprint, requestFingerprint);
  }
  return command;
}

async function lockClientCommand(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  clientCommandId: string,
) {
  await transaction.$queryRaw`
    SELECT 1::integer AS locked
    FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-command:${actorUserId}:${clientCommandId}`}))
  `;
}

async function lockJob(transaction: Prisma.TransactionClient, jobId: string) {
  await transaction.$queryRaw`
    SELECT "id" FROM "processing_jobs" WHERE "id" = ${jobId} FOR UPDATE
  `;
}

async function lockCanonicalJob(
  transaction: Prisma.TransactionClient,
  deduplicationKey: string,
) {
  await transaction.$queryRaw`
    SELECT 1::integer AS locked
    FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-job:${deduplicationKey}`}))
  `;
}

function assertClientCommandId(value: unknown) {
  if (!isValidProcessingJobClientRequestId(value)) {
    throw badRequest("clientCommandId 必须是有效的 UUID。");
  }
}
