import type { AlignmentArtifact, Prisma, PrismaClient } from "@prisma/client";
import {
  ALIGNMENT_PREDICTION_FORMAT_VERSION,
  ALIGNMENT_PREDICTION_MIME_TYPE,
  buildAlignmentPredictionArtifact,
  buildAlignmentPredictionQualitySummary,
  buildAlignmentTextProjection,
  type AlignmentPredictionQualitySummary,
} from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { AliyunVodProvider } from "./aliyunVodGateway.js";
import {
  ForceAlignmentExecutorError,
  type ForceAlignmentExecutor,
  type ForceAlignmentAudioInput,
} from "./alignmentExecutor.js";
import { resolveAnalysisAudioContext, type ReadyAnalysisAudioSource } from "./analysisAudioSourceResolver.js";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";
import type { ApiUser } from "./domain.js";
import { createAliyunVodFfmpegInput } from "./mediaAnalysisWorkerService.js";
import {
  cleanupUncommittedStagedBinary,
  type ObjectStorage,
  type StagedBinary,
} from "./objectStorage.js";
import { PROCESSING_JOB_STALE_AFTER_MS } from "./processingJobReliability.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const MAX_PREDICTION_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_PREDICTION_COMPRESSED_BYTES = 32 * 1024 * 1024;
const CANCELLATION_POLL_INTERVAL_MS = 500;
const CLAIM_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_ACTIVE_ALIGNMENT_REQUESTS = 1_000;

type AlignmentWorkerLogger = {
  info(facts: Record<string, unknown>, message: string): void;
  warn(facts: Record<string, unknown>, message: string): void;
};

type ClaimedAlignmentJob = Awaited<ReturnType<AlignmentWorkerService["claimNext"]>>;
type ClaimedAlignmentRun = NonNullable<Exclude<ClaimedAlignmentJob, null>["alignmentRun"]>;

type AlignmentClaimFence = {
  jobId: string;
  runId: string;
  claimedBy: string;
  attemptCount: number;
};

/**
 * 强制对齐 worker 只编排权威输入、模型端口和完整预测对象；它不生成 annotation command，
 * 也不把 prediction 正文写进 PostgreSQL。
 */
export class AlignmentWorkerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
    private readonly access: ResourceAccessService,
    private readonly aliyunVod: AliyunVodProvider | null,
    private readonly executor: ForceAlignmentExecutor,
    private readonly logger: AlignmentWorkerLogger,
    private readonly cancellationPollIntervalMs = CANCELLATION_POLL_INTERVAL_MS,
    private readonly claimHeartbeatIntervalMs = CLAIM_HEARTBEAT_INTERVAL_MS,
  ) {}

  async recoverStaleJobs(now = new Date()) {
    const staleBefore = new Date(now.getTime() - PROCESSING_JOB_STALE_AFTER_MS);
    const candidates = await this.prisma.processingJob.findMany({
      where: {
        type: "force_alignment",
        status: { in: ["running", "cancelling"] },
        alignmentRunId: { not: null },
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, claimedAt: { lt: staleBefore } },
        ],
      },
      select: { id: true },
    });
    let recovered = 0;
    for (const candidate of candidates) {
      if (await this.recoverStaleJob(candidate.id, staleBefore)) recovered += 1;
    }
    return recovered;
  }

  async claimNext(workerId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.processingJob.findFirst({
        where: {
          type: "force_alignment",
          status: "queued",
          alignmentRunId: { not: null },
          requests: { some: { cancelledAt: null } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (!candidate) return null;
      const now = new Date();
      const claimed = await transaction.processingJob.updateMany({
        where: { id: candidate.id, type: "force_alignment", status: "queued" },
        data: {
          status: "running",
          claimedBy: workerId,
          claimedAt: now,
          heartbeatAt: now,
          attemptCount: { increment: 1 },
          progress: 0,
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
        },
      });
      if (claimed.count !== 1) return null;
      const job = await transaction.processingJob.findUniqueOrThrow({
        where: { id: candidate.id },
        include: { alignmentRun: true },
      });
      if (!job.alignmentRun) throw new AlignmentClaimLostError();
      const claimedRun = await transaction.alignmentRun.updateMany({
        where: { id: job.alignmentRun.id, status: "queued" },
        data: { status: "running", progress: 0, errorCode: null, completedAt: null },
      });
      if (claimedRun.count !== 1) throw new AlignmentClaimLostError();
      return job;
    });
  }

  async processNext(workerId: string, shutdownSignal?: AbortSignal) {
    const job = await this.claimNext(workerId);
    if (!job) return false;
    const claimController = new AbortController();
    const monitorController = new AbortController();
    const fence = createClaimFence(job);
    const monitor = this.monitorClaim(fence, claimController, monitorController.signal);
    const workSignal = shutdownSignal
      ? AbortSignal.any([shutdownSignal, claimController.signal])
      : claimController.signal;
    try {
      await this.processClaimed(job, fence, {
        workSignal,
        shutdownSignal,
        claimSignal: claimController.signal,
      });
    } finally {
      monitorController.abort();
      await monitor;
    }
    return true;
  }

  private async processClaimed(
    job: Exclude<ClaimedAlignmentJob, null>,
    fence: AlignmentClaimFence,
    signals: {
      workSignal: AbortSignal;
      shutdownSignal?: AbortSignal;
      claimSignal: AbortSignal;
    },
  ) {
    const run = job.alignmentRun;
    if (!run) return;
    let audioInput: ForceAlignmentAudioInput | null = null;
    try {
      const verified = await this.readVerifiedInput(run, this.prisma);
      signals.workSignal.throwIfAborted();
      audioInput = await this.createAudioInput(verified.source);
      await this.heartbeat(fence, 0.1);
      const executorOutput = await this.executor.execute({
        projection: verified.projection,
        audioOffsetMicros: Number(run.audioOffsetMicros),
        audio: audioInput,
        model: {
          name: run.modelName,
          version: run.modelVersion,
          dictionaryVersion: run.dictionaryVersion,
          codeVersion: run.codeVersion,
          config: requirePlainConfig(run.config),
        },
      }, signals.workSignal);
      signals.workSignal.throwIfAborted();
      await this.heartbeat(fence, 0.9);
      const prediction = buildAlignmentPredictionArtifact({
        runId: run.id,
        inputRevision: run.inputRevision,
        inputTextFingerprint: run.inputTextFingerprint,
        audioOffsetMicros: Number(run.audioOffsetMicros),
        projection: verified.projection,
        executorOutput,
      });
      if (!prediction.ok) throw new AlignmentStableError(prediction.code);
      const qualitySummary = buildAlignmentPredictionQualitySummary(prediction.prediction);
      const serialized = Buffer.from(stableJsonStringify(prediction.prediction), "utf8");
      if (serialized.byteLength > MAX_PREDICTION_UNCOMPRESSED_BYTES) {
        throw new AlignmentStableError("alignment_prediction_too_large");
      }
      const compressed = gzipSync(serialized, { level: 9 });
      if (compressed.byteLength > MAX_PREDICTION_COMPRESSED_BYTES) {
        throw new AlignmentStableError("alignment_prediction_too_large");
      }
      // 发布前再次重验来源与活动需求；长模型执行期间发生的撤权或音轨变化不能穿过终态提交。
      await this.readVerifiedInput(run, this.prisma);
      await this.publishPrediction(
        fence,
        run,
        compressed,
        serialized.byteLength,
        qualitySummary,
      );
      this.logger.info(
        { jobId: job.id, runId: run.id, artifactCount: 1 },
        "强制对齐任务完成",
      );
    } catch (error) {
      await this.settleFailure(job, fence, signals, error);
    } finally {
      if (audioInput?.kind === "uploaded") audioInput.stream.destroy();
    }
  }

  private async readVerifiedInput(
    run: ClaimedAlignmentRun,
    database: PrismaClient | Prisma.TransactionClient,
  ) {
    if (!run?.annotationFileId || !run.sourceMediaResourceId || !run.mediaAudioTrackId) {
      throw new AlignmentStableError("alignment_source_missing");
    }
    const resource = await database.resourceEntry.findUnique({
      where: { id: run.annotationFileId },
      select: {
        archivedAt: true,
        trashedAt: true,
        annotationFile: { select: { revision: true, payload: true } },
      },
    });
    if (!resource?.annotationFile || resource.archivedAt || resource.trashedAt) {
      throw new AlignmentStableError("alignment_input_missing");
    }
    const parsed = parseCurrentProjectData(resource.annotationFile.payload);
    if (!parsed.success) throw new AlignmentStableError("alignment_input_invalid");
    const projected = buildAlignmentTextProjection(parsed.data);
    if (!projected.ok) throw new AlignmentStableError(projected.code);
    const fingerprint = sha256(stableJsonStringify(projected.projection));
    if (
      resource.annotationFile.revision !== run.inputRevision ||
      fingerprint !== run.inputTextFingerprint ||
      projected.sentenceCount !== run.inputSentenceCount ||
      projected.characterCount !== run.inputCharacterCount
    ) throw new AlignmentStableError("alignment_input_changed");

    const requests = await database.processingJobRequest.findMany({
      where: {
        job: { alignmentRunId: run.id, status: { in: ["running", "cancelling"] } },
        cancelledAt: null,
      },
      select: {
        requester: {
          select: {
            id: true,
            accountName: true,
            displayName: true,
            isActive: true,
            roles: { select: { role: true } },
          },
        },
      },
      take: MAX_ACTIVE_ALIGNMENT_REQUESTS + 1,
    });
    if (requests.length > MAX_ACTIVE_ALIGNMENT_REQUESTS) {
      throw new AlignmentStableError("alignment_request_capacity_exceeded");
    }
    let sawReadableAnnotation = false;
    for (const request of requests) {
      if (!request.requester.isActive) continue;
      const user = toApiUser(request.requester);
      const annotationPermission = await this.access.getEffectivePermission(user, run.annotationFileId, database);
      if (!annotationPermission.capabilities.includes("read")) continue;
      sawReadableAnnotation = true;
      const context = await resolveAnalysisAudioContext(
        database,
        this.access,
        user,
        run.annotationFileId,
        run.mediaAudioTrackId,
      );
      if (context.source.status !== "ready") continue;
      const source = context.source.value;
      if (
        source.media.resourceId !== run.sourceMediaResourceId ||
        source.mediaFingerprint !== run.sourceFingerprint ||
        BigInt(Math.round(source.offsetSeconds * 1_000_000)) !== run.audioOffsetMicros
      ) throw new AlignmentStableError("alignment_source_changed");
      return { projection: projected.projection, source };
    }
    throw new AlignmentStableError(
      sawReadableAnnotation ? "alignment_source_forbidden" : "alignment_permission_revoked",
    );
  }

  private async createAudioInput(source: ReadyAnalysisAudioSource): Promise<ForceAlignmentAudioInput> {
    if (source.media.sourceType === "uploaded") {
      if (!source.media.file) throw new AlignmentStableError("alignment_source_invalid");
      return {
        kind: "uploaded",
        stream: await this.storage.getObjectStream(source.media.file.storageKey),
      };
    }
    if (!this.aliyunVod || !source.media.aliyunVodVideoId ||
        source.media.aliyunVodRegion !== this.aliyunVod.region) {
      throw new AlignmentStableError("alignment_source_invalid");
    }
    return createAliyunVodFfmpegInput(
      this.aliyunVod.gateway,
      source.media.aliyunVodVideoId,
      source.sourceVodRenditionJobId,
    );
  }

  private async publishPrediction(
    fence: AlignmentClaimFence,
    run: ClaimedAlignmentRun,
    compressed: Buffer,
    uncompressedSize: number,
    qualitySummary: AlignmentPredictionQualitySummary,
  ) {
    if (!run) throw new AlignmentClaimLostError();
    const artifactId = randomUUID();
    const finalStorageKey = this.storage.createStorageKey("xap");
    const staged = await this.storage.putStagedObject(
      finalStorageKey,
      Readable.from([compressed]),
      MAX_PREDICTION_COMPRESSED_BYTES,
    );
    try {
      await this.storage.promoteStagedObject(staged);
    } catch (publishError) {
      const cleanupFailures = await cleanupUncommittedStagedBinary(this.storage, staged);
      if (cleanupFailures.length > 0) {
        throw new AlignmentCleanupError(
          [publishError, ...cleanupFailures.map(({ error }) => error)],
        );
      }
      throw publishError;
    }

    const completedAt = new Date();
    try {
      await this.prisma.$transaction(async (transaction) => {
        const owned = await lockOwnedAlignmentClaim(transaction, fence, "running");
        if (!owned) throw new AlignmentClaimLostError();
        // 在 job 行锁内最后一次检查活动需求与来源，避免取消/撤权和成功发布交叉提交。
        await this.readVerifiedInput(run, transaction);
        await transaction.alignmentArtifact.create({
          data: {
            id: artifactId,
            runId: run.id,
            kind: "prediction",
            formatVersion: ALIGNMENT_PREDICTION_FORMAT_VERSION,
            mimeType: ALIGNMENT_PREDICTION_MIME_TYPE,
            size: staged.size,
            checksum: staged.checksum,
            storageKey: staged.finalStorageKey,
          },
        });
        const completedRun = await transaction.alignmentRun.updateMany({
          where: { id: run.id, status: "running" },
          data: {
            status: "succeeded",
            progress: 1,
            errorCode: null,
            manifest: {
              version: 1,
              formatVersion: ALIGNMENT_PREDICTION_FORMAT_VERSION,
              artifactId,
              sentenceCount: run.inputSentenceCount,
              characterCount: run.inputCharacterCount,
              compressedSize: staged.size,
              uncompressedSize,
              checksum: staged.checksum,
              // 质量摘要与 artifact 终态原子发布；候选查询无需重新下载大型 prediction 对象。
              qualitySummary,
            },
            completedAt,
          },
        });
        if (completedRun.count !== 1) throw new AlignmentClaimLostError();
        const completedJob = await transaction.processingJob.updateMany({
          where: {
            id: fence.jobId,
            alignmentRunId: fence.runId,
            status: "running",
            claimedBy: fence.claimedBy,
            attemptCount: fence.attemptCount,
            cancelRequestedAt: null,
          },
          data: {
            status: "succeeded",
            progress: 1,
            result: { runId: run.id, artifactCount: 1 },
            heartbeatAt: completedAt,
            finishedAt: completedAt,
          },
        });
        if (completedJob.count !== 1) throw new AlignmentClaimLostError();
      });
    } catch (databaseError) {
      let committed: AlignmentArtifact | null;
      let jobState: { status: string; alignmentRunId: string | null } | null;
      try {
        [committed, jobState] = await Promise.all([
          this.prisma.alignmentArtifact.findUnique({ where: { id: artifactId } }),
          this.prisma.processingJob.findUnique({
            where: { id: fence.jobId },
            select: { status: true, alignmentRunId: true },
          }),
        ]);
      } catch (verificationError) {
        throw new AlignmentArtifactCommitUncertainError(databaseError, verificationError);
      }
      if (committed && jobState?.status === "succeeded" && jobState.alignmentRunId === run.id &&
          matchesCommittedArtifact(committed, run.id, staged)) return;
      if (committed) {
        throw new AlignmentArtifactCommitUncertainError(
          databaseError,
          new Error("强制对齐 artifact 提交事实与预期不一致。"),
        );
      }
      try {
        await this.storage.deleteObject(staged.finalStorageKey);
      } catch (cleanupError) {
        throw new AlignmentCleanupError(
          [databaseError, cleanupError],
        );
      }
      throw databaseError;
    }
  }

  private async settleFailure(
    job: Exclude<ClaimedAlignmentJob, null>,
    fence: AlignmentClaimFence,
    signals: { shutdownSignal?: AbortSignal; claimSignal: AbortSignal },
    error: unknown,
  ) {
    const current = await this.prisma.processingJob.findUnique({
      where: { id: job.id },
      select: { status: true, alignmentRunId: true, claimedBy: true, attemptCount: true },
    });
    if (!current || current.alignmentRunId !== fence.runId ||
        current.claimedBy !== fence.claimedBy || current.attemptCount !== fence.attemptCount ||
        ["succeeded", "cancelled", "failed"].includes(current.status)) return;
    const errorCode = classifyAlignmentError(error, signals);
    if (current.status === "cancelling" || signals.claimSignal.aborted) {
      await this.settleCancelledJob(fence);
      this.logger.info({ jobId: job.id, runId: fence.runId }, "强制对齐任务按用户请求取消");
      return;
    }
    if (errorCode === "alignment_cancelled" && signals.shutdownSignal?.aborted) {
      await this.requeueInterruptedJob(fence);
      this.logger.info({ jobId: job.id, runId: fence.runId }, "强制对齐任务因 worker 停机重新排队");
      return;
    }
    await this.failJob(fence, errorCode);
    this.logger.warn({ jobId: job.id, runId: fence.runId, errorCode }, "强制对齐任务失败");
  }

  private async monitorClaim(
    fence: AlignmentClaimFence,
    claimController: AbortController,
    stopSignal: AbortSignal,
  ) {
    let nextHeartbeatAt = Date.now() + this.claimHeartbeatIntervalMs;
    while (!stopSignal.aborted && !claimController.signal.aborted) {
      try {
        const job = await this.prisma.processingJob.findUnique({
          where: { id: fence.jobId },
          select: {
            status: true,
            alignmentRunId: true,
            claimedBy: true,
            attemptCount: true,
            cancelRequestedAt: true,
          },
        });
        if (job?.claimedBy === fence.claimedBy && job.attemptCount === fence.attemptCount &&
            (job.status === "cancelling" || job.cancelRequestedAt !== null)) {
          claimController.abort("processing_job_cancelled");
          return;
        }
        if (!job || job.status !== "running" || job.alignmentRunId !== fence.runId ||
            job.claimedBy !== fence.claimedBy || job.attemptCount !== fence.attemptCount) {
          claimController.abort("processing_job_claim_lost");
          return;
        }
        if (Date.now() >= nextHeartbeatAt) {
          const refreshed = await this.prisma.processingJob.updateMany({
            where: {
              id: fence.jobId,
              alignmentRunId: fence.runId,
              status: "running",
              claimedBy: fence.claimedBy,
              attemptCount: fence.attemptCount,
              cancelRequestedAt: null,
            },
            data: { heartbeatAt: new Date() },
          });
          if (refreshed.count === 1) nextHeartbeatAt = Date.now() + this.claimHeartbeatIntervalMs;
        }
      } catch {
        // 短数据库抖动不关闭 monitor；runtime 和下一次循环继续提供稳定诊断与追赶。
      }
      await waitForSignal(this.cancellationPollIntervalMs, stopSignal);
    }
  }

  private async heartbeat(fence: AlignmentClaimFence, progress: number) {
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const job = await transaction.processingJob.updateMany({
        where: {
          id: fence.jobId,
          alignmentRunId: fence.runId,
          status: "running",
          claimedBy: fence.claimedBy,
          attemptCount: fence.attemptCount,
          cancelRequestedAt: null,
        },
        data: { heartbeatAt: now, progress },
      });
      const run = await transaction.alignmentRun.updateMany({
        where: { id: fence.runId, status: "running" },
        data: { progress },
      });
      if (job.count !== 1 || run.count !== 1) throw new AlignmentClaimLostError();
    });
  }

  private async recoverStaleJob(jobId: string, staleBefore: Date) {
    const decision = await this.prisma.$transaction(async (transaction) => {
      const initial = await transaction.processingJob.findUnique({
        where: { id: jobId },
        select: { deduplicationKey: true },
      });
      if (!initial) return null;
      await lockCanonicalProcessingJob(transaction, initial.deduplicationKey);
      await transaction.$queryRaw`SELECT id FROM processing_jobs WHERE id = ${jobId} FOR UPDATE`;
      const current = await transaction.processingJob.findUnique({
        where: { id: jobId },
        select: {
          status: true,
          createdBy: true,
          claimedBy: true,
          attemptCount: true,
          claimedAt: true,
          heartbeatAt: true,
          alignmentRunId: true,
          requests: { where: { cancelledAt: null }, select: { id: true }, take: 1 },
        },
      });
      if (!current?.alignmentRunId || !isStaleClaim(current, staleBefore)) return null;
      if (current.status === "running" && current.requests.length > 0) {
        const requeued = await transitionInterruptedAlignmentJob(
          transaction,
          jobId,
          current.alignmentRunId,
          current.claimedBy,
          current.attemptCount,
        );
        return requeued ? { kind: "requeued" as const } : null;
      }
      if (current.status === "running") {
        const cancelling = await transaction.processingJob.updateMany({
          where: {
            id: jobId,
            status: "running",
            claimedBy: current.claimedBy,
            attemptCount: current.attemptCount,
          },
          data: {
            status: "cancelling",
            cancelRequestedAt: new Date(),
            cancelRequestedBy: current.createdBy,
            cancellationMode: "user_request",
          },
        });
        const cancellingRun = await transaction.alignmentRun.updateMany({
          where: { id: current.alignmentRunId, status: "running" },
          data: { status: "cancelling" },
        });
        if (cancelling.count !== 1 || cancellingRun.count !== 1) throw new AlignmentClaimLostError();
      }
      return {
        kind: "cancel" as const,
        fence: {
          jobId,
          runId: current.alignmentRunId,
          claimedBy: current.claimedBy,
          attemptCount: current.attemptCount,
        },
      };
    });
    if (!decision) return false;
    if (decision.kind === "cancel") await this.settleCancelledJob(requireCompleteFence(decision.fence));
    return true;
  }

  private async settleCancelledJob(fence: AlignmentClaimFence) {
    const finishedAt = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const job = await transaction.processingJob.updateMany({
        where: {
          id: fence.jobId,
          alignmentRunId: fence.runId,
          status: "cancelling",
          claimedBy: fence.claimedBy,
          attemptCount: fence.attemptCount,
        },
        data: {
          status: "cancelled",
          progress: 0,
          errorCode: null,
          errorMessage: null,
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          finishedAt,
        },
      });
      if (job.count !== 1) return;
      const run = await transaction.alignmentRun.updateMany({
        where: { id: fence.runId, status: { in: ["running", "cancelling", "cancelled"] } },
        data: { status: "cancelled", progress: 0, errorCode: null, completedAt: finishedAt },
      });
      if (run.count !== 1) throw new AlignmentClaimLostError();
    });
  }

  private async requeueInterruptedJob(fence: AlignmentClaimFence) {
    await this.prisma.$transaction(async (transaction) => {
      await transitionInterruptedAlignmentJob(
        transaction,
        fence.jobId,
        fence.runId,
        fence.claimedBy,
        fence.attemptCount,
      );
    });
  }

  private async failJob(fence: AlignmentClaimFence, errorCode: string) {
    const finishedAt = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const job = await transaction.processingJob.updateMany({
        where: {
          id: fence.jobId,
          alignmentRunId: fence.runId,
          claimedBy: fence.claimedBy,
          attemptCount: fence.attemptCount,
          status: { in: ["running", "cancelling"] },
        },
        data: {
          status: "failed",
          progress: 0,
          errorCode,
          errorMessage: userFacingAlignmentError(errorCode),
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          finishedAt,
        },
      });
      if (job.count !== 1) return;
      const run = await transaction.alignmentRun.updateMany({
        where: { id: fence.runId, status: { in: ["running", "cancelling", "failed"] } },
        data: { status: "failed", progress: 0, errorCode, completedAt: finishedAt },
      });
      if (run.count !== 1) throw new AlignmentClaimLostError();
    });
  }
}

function createClaimFence(job: Exclude<ClaimedAlignmentJob, null>): AlignmentClaimFence {
  if (!job.alignmentRun || !job.claimedBy || job.attemptCount < 1) throw new AlignmentClaimLostError();
  return {
    jobId: job.id,
    runId: job.alignmentRun.id,
    claimedBy: job.claimedBy,
    attemptCount: job.attemptCount,
  };
}

function requireCompleteFence(fence: {
  jobId: string;
  runId: string;
  claimedBy: string | null;
  attemptCount: number;
}): AlignmentClaimFence {
  if (!fence.claimedBy || fence.attemptCount < 1) throw new AlignmentClaimLostError();
  return { ...fence, claimedBy: fence.claimedBy };
}

async function lockOwnedAlignmentClaim(
  transaction: Prisma.TransactionClient,
  fence: AlignmentClaimFence,
  status: "running" | "cancelling",
) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM processing_jobs
    WHERE id = ${fence.jobId}
      AND type = 'force_alignment'
      AND alignment_run_id = ${fence.runId}
      AND status = ${status}::"ProcessingJobStatus"
      AND claimed_by = ${fence.claimedBy}
      AND attempt_count = ${fence.attemptCount}
      AND cancel_requested_at IS NULL
    FOR UPDATE
  `;
  return rows.length === 1;
}

async function transitionInterruptedAlignmentJob(
  transaction: Prisma.TransactionClient,
  jobId: string,
  runId: string,
  claimedBy: string | null,
  attemptCount: number,
) {
  const job = await transaction.processingJob.updateMany({
    where: {
      id: jobId,
      alignmentRunId: runId,
      status: "running",
      claimedBy,
      attemptCount,
      cancelRequestedAt: null,
    },
    data: {
      status: "queued",
      progress: 0,
      errorCode: null,
      errorMessage: null,
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      finishedAt: null,
    },
  });
  if (job.count !== 1) return false;
  const run = await transaction.alignmentRun.updateMany({
    where: { id: runId, status: "running" },
    data: { status: "queued", progress: 0, errorCode: null, completedAt: null },
  });
  if (run.count !== 1) throw new AlignmentClaimLostError();
  return true;
}

async function lockCanonicalProcessingJob(
  transaction: Prisma.TransactionClient,
  deduplicationKey: string,
) {
  await transaction.$queryRaw`
    SELECT 1::integer AS locked
    FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-job:${deduplicationKey}`}))
  `;
}

function matchesCommittedArtifact(
  artifact: AlignmentArtifact,
  runId: string,
  staged: StagedBinary,
) {
  return artifact.runId === runId &&
    artifact.kind === "prediction" &&
    artifact.formatVersion === ALIGNMENT_PREDICTION_FORMAT_VERSION &&
    artifact.mimeType === ALIGNMENT_PREDICTION_MIME_TYPE &&
    artifact.size === BigInt(staged.size) &&
    artifact.checksum === staged.checksum &&
    artifact.storageKey === staged.finalStorageKey;
}

function toApiUser(user: {
  id: string;
  accountName: string;
  displayName: string;
  roles: Array<{ role: string }>;
}): ApiUser {
  return {
    id: user.id,
    accountName: user.accountName,
    displayName: user.displayName,
    roles: user.roles.map(({ role }) => role) as ApiUser["roles"],
  };
}

function requirePlainConfig(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AlignmentStableError("alignment_config_invalid");
  }
  return value as Record<string, unknown>;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function classifyAlignmentError(
  error: unknown,
  signals: { shutdownSignal?: AbortSignal; claimSignal: AbortSignal },
) {
  if (signals.shutdownSignal?.aborted || signals.claimSignal.aborted) return "alignment_cancelled";
  if (error instanceof AlignmentArtifactCommitUncertainError) return "alignment_artifact_commit_uncertain";
  if (error instanceof AlignmentCleanupError) return "alignment_cleanup_failed";
  if (error instanceof ForceAlignmentExecutorError) return error.code;
  if (error instanceof AlignmentStableError) return error.code;
  if (error instanceof AlignmentClaimLostError) return "alignment_claim_lost";
  return "alignment_execution_failed";
}

function isStaleClaim(
  job: { status: string; heartbeatAt: Date | null; claimedAt: Date | null },
  staleBefore: Date,
) {
  if (job.status !== "running" && job.status !== "cancelling") return false;
  const lastFact = job.heartbeatAt ?? job.claimedAt;
  return Boolean(lastFact && lastFact < staleBefore);
}

function userFacingAlignmentError(code: string) {
  switch (code) {
    case "alignment_input_changed":
      return "标注正文已变化，请基于最新版本重新创建强制对齐任务。";
    case "alignment_permission_revoked":
    case "alignment_source_forbidden":
      return "任务所需的标注或音频权限已失效。";
    case "alignment_source_changed":
    case "alignment_source_invalid":
    case "alignment_source_missing":
      return "强制对齐音频来源已变化或失效。";
    case "alignment_prediction_invalid":
    case "alignment_prediction_identity_mismatch":
    case "alignment_prediction_timing_invalid":
      return "强制对齐模型返回了无效预测。";
    case "alignment_prediction_too_large":
      return "强制对齐预测超过服务器容量限制。";
    case "alignment_request_capacity_exceeded":
      return "同一强制对齐任务的活动需求超过服务器容量限制。";
    case "alignment_cleanup_failed":
      return "强制对齐失败且对象清理未完成，请联系管理员。";
    case "alignment_temporary_cleanup_failed":
      return "强制对齐临时文件清理失败，请联系管理员检查 worker 主机。";
    case "alignment_artifact_commit_uncertain":
      return "强制对齐结果提交状态无法确认，请联系管理员。";
    default:
      return "强制对齐失败，请稍后重试。";
  }
}

function waitForSignal(delayMs: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

class AlignmentStableError extends Error {
  constructor(readonly code: string) {
    super(`Force alignment worker failed: ${code}`);
  }
}

class AlignmentClaimLostError extends Error {}

class AlignmentArtifactCommitUncertainError extends AggregateError {
  constructor(databaseError: unknown, verificationError: unknown) {
    super([databaseError, verificationError], "强制对齐 artifact 数据库提交结果无法确认。");
  }
}

class AlignmentCleanupError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, "强制对齐对象补偿未能完整完成。");
  }
}
