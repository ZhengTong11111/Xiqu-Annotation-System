import type {
  AlignmentTrainingPackageArtifact,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  ALIGNMENT_TRAINING_PACKAGE_CONTAINER,
  ALIGNMENT_TRAINING_PACKAGE_FORMAT,
  ALIGNMENT_TRAINING_PACKAGE_VERSION,
  buildAlignmentTrainingPackagePlan,
  canonicalAlignmentTrainingJson,
  parseAlignmentTrainingSourceSnapshot,
  type AlignmentTrainingPackagePlanItem,
} from "@xiqu/document-model";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { AliyunVodProvider } from "./aliyunVodGateway.js";
import {
  AlignmentTrainingAudioFfmpegError,
  type AlignmentTrainingAudioNormalizer,
} from "./alignmentTrainingAudioFfmpeg.js";
import {
  ALIGNMENT_TRAINING_EXPORT_READY_INCLUDE,
  requireReadyAlignmentTrainingExport,
  type ReadyAlignmentTrainingExport,
} from "./alignmentTrainingExportReader.js";
import {
  AlignmentTrainingPackageWriterError,
  writeAlignmentTrainingPackageToStage,
} from "./alignmentTrainingPackageWriter.js";
import { AlignmentTrainingPackageStreamError } from "./alignmentTrainingPackageStream.js";
import type { ApiUser } from "./domain.js";
import { createAliyunVodFfmpegInput } from "./mediaAnalysisWorkerService.js";
import {
  cleanupUncommittedStagedBinary,
  StorageSizeLimitError,
  type ObjectStorage,
  type StagedBinary,
} from "./objectStorage.js";
import { PROCESSING_JOB_STALE_AFTER_MS } from "./processingJobReliability.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const CANCELLATION_POLL_INTERVAL_MS = 500;
const CLAIM_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_ACTIVE_EXPORT_REQUESTS = 1_000;
const PACKAGE_MIME_TYPE = "application/zip";

type TrainingWorkerLogger = {
  info(facts: Record<string, unknown>, message: string): void;
  warn(facts: Record<string, unknown>, message: string): void;
};

const CLAIMED_JOB_INCLUDE = {
  alignmentTrainingExport: { include: ALIGNMENT_TRAINING_EXPORT_READY_INCLUDE },
} satisfies Prisma.ProcessingJobInclude;

type ClaimedTrainingJob = Prisma.ProcessingJobGetPayload<{
  include: typeof CLAIMED_JOB_INCLUDE;
}>;

type TrainingClaimFence = {
  jobId: string;
  exportId: string;
  claimedBy: string;
  attemptCount: number;
};

/**
 * 训练导出 worker 只消费冻结输入并发布不可变 ZIP；它不读取当前标注、修改训练清单或提供下载授权。
 * 所有终态都携带 job/export/worker/attempt 围栏，防止陈旧进程发布迟到对象。
 */
export class AlignmentTrainingExportWorkerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
    private readonly access: ResourceAccessService,
    private readonly aliyunVod: AliyunVodProvider | null,
    private readonly normalizeAudio: AlignmentTrainingAudioNormalizer,
    private readonly logger: TrainingWorkerLogger,
    private readonly cancellationPollIntervalMs = CANCELLATION_POLL_INTERVAL_MS,
    private readonly claimHeartbeatIntervalMs = CLAIM_HEARTBEAT_INTERVAL_MS,
  ) {}

  async recoverStaleJobs(now = new Date()) {
    const staleBefore = new Date(now.getTime() - PROCESSING_JOB_STALE_AFTER_MS);
    const candidates = await this.prisma.processingJob.findMany({
      where: {
        type: "alignment_training_export",
        status: { in: ["running", "cancelling"] },
        alignmentTrainingExportId: { not: null },
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

  async claimNext(workerId: string): Promise<ClaimedTrainingJob | null> {
    return this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.processingJob.findFirst({
        where: {
          type: "alignment_training_export",
          status: "queued",
          alignmentTrainingExportId: { not: null },
          requests: { some: { cancelledAt: null } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (!candidate) return null;
      const now = new Date();
      const claimed = await transaction.processingJob.updateMany({
        where: {
          id: candidate.id,
          type: "alignment_training_export",
          status: "queued",
          alignmentTrainingExportId: { not: null },
        },
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
        include: CLAIMED_JOB_INCLUDE,
      });
      if (!job.alignmentTrainingExport) throw new TrainingExportClaimLostError();
      return job;
    });
  }

  async processNext(workerId: string, shutdownSignal?: AbortSignal) {
    const job = await this.claimNext(workerId);
    if (!job) return false;
    const fence = createClaimFence(job);
    const claimController = new AbortController();
    const monitorController = new AbortController();
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
    job: ClaimedTrainingJob,
    fence: TrainingClaimFence,
    signals: {
      workSignal: AbortSignal;
      shutdownSignal?: AbortSignal;
      claimSignal: AbortSignal;
    },
  ) {
    try {
      const ready = await this.readVerifiedExport(fence, this.prisma);
      signals.workSignal.throwIfAborted();
      const plan = buildPlan(ready);
      await this.heartbeat(fence, 0.1);
      await this.publishPackage(fence, ready, plan, signals.workSignal);
      this.logger.info(
        { jobId: job.id, exportId: fence.exportId, itemCount: plan.itemCount },
        "强制对齐训练包任务完成",
      );
    } catch (error) {
      await this.settleFailure(job, fence, signals, error);
    }
  }

  private async publishPackage(
    fence: TrainingClaimFence,
    ready: ReadyAlignmentTrainingExport,
    plan: ReturnType<typeof buildPlan>,
    signal: AbortSignal,
  ) {
    const rows = new Map(
      ready.row.items.map((item) => [item.alignmentApplicationId, item]),
    );
    const artifactId = randomUUID();
    const finalStorageKey = this.storage.createStorageKey("zip");
    const written = await writeAlignmentTrainingPackageToStage({
      storage: this.storage,
      finalStorageKey,
      plan,
      provenanceJson: canonicalAlignmentTrainingJson(ready.provenanceManifest),
      inputJson: canonicalAlignmentTrainingJson(ready.inputManifest),
      signal,
      openPrediction: async (item) => {
        const row = requirePlanRow(rows, item);
        return this.storage.getObjectStream(row.artifact.storageKey);
      },
      openTarget: (item) => {
        const row = requirePlanRow(rows, item);
        return Readable.from([
          Buffer.from(canonicalAlignmentTrainingJson(row.input!.targetSnapshot), "utf8"),
        ]);
      },
      openAudio: async (item, entrySignal) => {
        const row = requirePlanRow(rows, item);
        const source = parseAlignmentTrainingSourceSnapshot(row.input!.sourceSnapshot);
        if (!source.ok) throw new TrainingExportStableError("training_export_input_invalid");
        if (source.value.kind === "uploaded") {
          if (!row.input?.sourceFile) {
            throw new TrainingExportStableError("training_export_source_missing");
          }
          return this.normalizeAudio({
            kind: "uploaded",
            stream: createVerifiedUploadedSourceStream(
              await this.storage.getObjectStream(row.input.sourceFile.storageKey),
              source.value.fileChecksum,
              source.value.fileSize,
            ),
          }, entrySignal);
        }
        if (!this.aliyunVod || source.value.region !== this.aliyunVod.region) {
          throw new TrainingExportStableError("training_export_source_missing");
        }
        let vodInput: { kind: "vod"; url: string };
        try {
          vodInput = await createAliyunVodFfmpegInput(
            this.aliyunVod.gateway,
            source.value.videoId,
            source.value.renditionJobId,
          );
        } catch {
          throw new TrainingExportStableError("training_export_audio_source_failed");
        }
        return this.normalizeAudio(vodInput, entrySignal);
      },
    });

    try {
      await this.storage.promoteStagedObject(written.staged);
    } catch (publishError) {
      const cleanupFailures = await cleanupUncommittedStagedBinary(this.storage, written.staged);
      if (cleanupFailures.length > 0) {
        throw new TrainingExportCleanupError([
          publishError,
          ...cleanupFailures.map(({ error }) => error),
        ]);
      }
      throw publishError;
    }

    const completedAt = new Date();
    try {
      await this.prisma.$transaction(async (transaction) => {
        const owned = await lockOwnedTrainingClaim(transaction, fence, "running");
        if (!owned) throw new TrainingExportClaimLostError();
        const currentReady = await this.readVerifiedExport(fence, transaction);
        const currentPlan = buildPlan(currentReady);
        if (currentPlan.checksum !== plan.checksum) {
          throw new TrainingExportStableError("training_export_input_changed");
        }
        await transaction.alignmentTrainingPackageArtifact.create({
          data: {
            id: artifactId,
            exportId: fence.exportId,
            processingJobId: fence.jobId,
            format: ALIGNMENT_TRAINING_PACKAGE_FORMAT,
            version: ALIGNMENT_TRAINING_PACKAGE_VERSION,
            container: ALIGNMENT_TRAINING_PACKAGE_CONTAINER,
            mimeType: PACKAGE_MIME_TYPE,
            size: written.staged.size,
            checksum: written.staged.checksum,
            storageKey: written.staged.finalStorageKey,
            planChecksum: plan.checksum,
            manifestChecksum: written.manifest.checksum,
            itemCount: plan.itemCount,
            manifest: written.manifest as unknown as Prisma.InputJsonValue,
          },
        });
        const completed = await transaction.processingJob.updateMany({
          where: {
            id: fence.jobId,
            type: "alignment_training_export",
            alignmentTrainingExportId: fence.exportId,
            status: "running",
            claimedBy: fence.claimedBy,
            attemptCount: fence.attemptCount,
            cancelRequestedAt: null,
          },
          data: {
            status: "succeeded",
            progress: 1,
            result: {
              exportId: fence.exportId,
              artifactId,
              checksum: written.staged.checksum,
              size: written.staged.size,
              itemCount: plan.itemCount,
            },
            heartbeatAt: completedAt,
            finishedAt: completedAt,
          },
        });
        if (completed.count !== 1) throw new TrainingExportClaimLostError();
      });
    } catch (databaseError) {
      await this.compensateAmbiguousCommit(
        artifactId,
        fence,
        written.staged,
        plan.checksum,
        written.manifest.checksum,
        databaseError,
      );
    }
  }

  private async compensateAmbiguousCommit(
    artifactId: string,
    fence: TrainingClaimFence,
    staged: StagedBinary,
    planChecksum: string,
    manifestChecksum: string,
    databaseError: unknown,
  ) {
    let artifact: AlignmentTrainingPackageArtifact | null;
    let job: { status: string; alignmentTrainingExportId: string | null } | null;
    try {
      [artifact, job] = await Promise.all([
        this.prisma.alignmentTrainingPackageArtifact.findUnique({ where: { id: artifactId } }),
        this.prisma.processingJob.findUnique({
          where: { id: fence.jobId },
          select: { status: true, alignmentTrainingExportId: true },
        }),
      ]);
    } catch (verificationError) {
      throw new TrainingExportCommitUncertainError(databaseError, verificationError);
    }
    if (
      artifact &&
      job?.status === "succeeded" &&
      job.alignmentTrainingExportId === fence.exportId &&
      matchesCommittedArtifact(artifact, fence, staged, planChecksum, manifestChecksum)
    ) return;
    if (artifact) {
      throw new TrainingExportCommitUncertainError(
        databaseError,
        new Error("训练包数据库提交事实与预期不一致。"),
      );
    }
    try {
      await this.storage.deleteObject(staged.finalStorageKey);
    } catch (cleanupError) {
      throw new TrainingExportCleanupError([databaseError, cleanupError]);
    }
    throw databaseError;
  }

  /** 最终提交与初始 claim 共用这条权威读取：冻结完整性、活动需求和管理员身份缺一不可。 */
  private async readVerifiedExport(
    fence: TrainingClaimFence,
    database: PrismaClient | Prisma.TransactionClient,
  ) {
    const row = await database.alignmentTrainingExport.findUnique({
      where: { id: fence.exportId },
      include: ALIGNMENT_TRAINING_EXPORT_READY_INCLUDE,
    });
    if (!row) throw new TrainingExportStableError("training_export_input_missing");
    let ready: ReadyAlignmentTrainingExport;
    try {
      ready = requireReadyAlignmentTrainingExport(row);
    } catch {
      throw new TrainingExportStableError("training_export_input_invalid");
    }
    const requests = await database.processingJobRequest.findMany({
      where: { jobId: fence.jobId, cancelledAt: null },
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
      take: MAX_ACTIVE_EXPORT_REQUESTS + 1,
    });
    if (requests.length > MAX_ACTIVE_EXPORT_REQUESTS) {
      throw new TrainingExportStableError("training_export_request_capacity_exceeded");
    }
    const authorized = requests.some(({ requester }) =>
      requester.isActive && this.access.hasFullResourceAccess(toApiUser(requester)));
    if (!authorized) throw new TrainingExportStableError("training_export_permission_revoked");
    return ready;
  }

  private async monitorClaim(
    fence: TrainingClaimFence,
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
            alignmentTrainingExportId: true,
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
        if (!job || job.status !== "running" ||
            job.alignmentTrainingExportId !== fence.exportId ||
            job.claimedBy !== fence.claimedBy || job.attemptCount !== fence.attemptCount) {
          claimController.abort("processing_job_claim_lost");
          return;
        }
        if (Date.now() >= nextHeartbeatAt) {
          const refreshed = await this.prisma.processingJob.updateMany({
            where: {
              id: fence.jobId,
              type: "alignment_training_export",
              alignmentTrainingExportId: fence.exportId,
              status: "running",
              claimedBy: fence.claimedBy,
              attemptCount: fence.attemptCount,
              cancelRequestedAt: null,
            },
            data: { heartbeatAt: new Date() },
          });
          if (refreshed.count === 1) {
            nextHeartbeatAt = Date.now() + this.claimHeartbeatIntervalMs;
          }
        }
      } catch {
        // 短数据库抖动不夺走 claim；下一个轮询或 stale recovery 继续按权威行追赶。
      }
      await waitForSignal(this.cancellationPollIntervalMs, stopSignal);
    }
  }

  private async heartbeat(fence: TrainingClaimFence, progress: number) {
    const updated = await this.prisma.processingJob.updateMany({
      where: {
        id: fence.jobId,
        type: "alignment_training_export",
        alignmentTrainingExportId: fence.exportId,
        status: "running",
        claimedBy: fence.claimedBy,
        attemptCount: fence.attemptCount,
        cancelRequestedAt: null,
      },
      data: { heartbeatAt: new Date(), progress },
    });
    if (updated.count !== 1) throw new TrainingExportClaimLostError();
  }

  private async settleFailure(
    job: ClaimedTrainingJob,
    fence: TrainingClaimFence,
    signals: { shutdownSignal?: AbortSignal; claimSignal: AbortSignal },
    error: unknown,
  ) {
    const current = await this.prisma.processingJob.findUnique({
      where: { id: fence.jobId },
      select: {
        status: true,
        alignmentTrainingExportId: true,
        claimedBy: true,
        attemptCount: true,
      },
    });
    if (!current || current.alignmentTrainingExportId !== fence.exportId ||
        current.claimedBy !== fence.claimedBy || current.attemptCount !== fence.attemptCount ||
        ["succeeded", "cancelled", "failed"].includes(current.status)) return;
    const errorCode = classifyTrainingExportError(error, signals);
    if (current.status === "cancelling" || signals.claimSignal.aborted) {
      await this.settleCancelledJob(fence);
      this.logger.info({ jobId: job.id, exportId: fence.exportId }, "训练包任务按用户请求取消");
      return;
    }
    if (errorCode === "training_export_cancelled" && signals.shutdownSignal?.aborted) {
      await this.requeueInterruptedJob(fence);
      this.logger.info({ jobId: job.id, exportId: fence.exportId }, "训练包任务因 worker 停机重新排队");
      return;
    }
    await this.failJob(fence, errorCode);
    this.logger.warn(
      { jobId: job.id, exportId: fence.exportId, errorCode },
      "强制对齐训练包任务失败",
    );
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
          alignmentTrainingExportId: true,
          requests: { where: { cancelledAt: null }, select: { id: true }, take: 1 },
        },
      });
      if (!current?.alignmentTrainingExportId || !isStaleClaim(current, staleBefore)) return null;
      const fence = requireCompleteFence({
        jobId,
        exportId: current.alignmentTrainingExportId,
        claimedBy: current.claimedBy,
        attemptCount: current.attemptCount,
      });
      if (current.status === "running" && current.requests.length > 0) {
        return await transitionInterruptedTrainingJob(transaction, fence)
          ? { kind: "requeued" as const }
          : null;
      }
      if (current.status === "running") {
        const cancelling = await transaction.processingJob.updateMany({
          where: {
            id: jobId,
            status: "running",
            claimedBy: fence.claimedBy,
            attemptCount: fence.attemptCount,
          },
          data: {
            status: "cancelling",
            cancelRequestedAt: new Date(),
            cancelRequestedBy: current.createdBy,
            cancellationMode: "user_request",
          },
        });
        if (cancelling.count !== 1) throw new TrainingExportClaimLostError();
      }
      return { kind: "cancel" as const, fence };
    });
    if (!decision) return false;
    if (decision.kind === "cancel") await this.settleCancelledJob(decision.fence);
    return true;
  }

  private async settleCancelledJob(fence: TrainingClaimFence) {
    const finishedAt = new Date();
    await this.prisma.processingJob.updateMany({
      where: {
        id: fence.jobId,
        type: "alignment_training_export",
        alignmentTrainingExportId: fence.exportId,
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
  }

  private async requeueInterruptedJob(fence: TrainingClaimFence) {
    await this.prisma.$transaction((transaction) =>
      transitionInterruptedTrainingJob(transaction, fence));
  }

  private async failJob(fence: TrainingClaimFence, errorCode: string) {
    await this.prisma.processingJob.updateMany({
      where: {
        id: fence.jobId,
        type: "alignment_training_export",
        alignmentTrainingExportId: fence.exportId,
        status: { in: ["running", "cancelling"] },
        claimedBy: fence.claimedBy,
        attemptCount: fence.attemptCount,
      },
      data: {
        status: "failed",
        progress: 0,
        errorCode,
        errorMessage: userFacingTrainingExportError(errorCode),
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
        finishedAt: new Date(),
      },
    });
  }
}

function buildPlan(ready: ReadyAlignmentTrainingExport) {
  const built = buildAlignmentTrainingPackagePlan({
    exportId: ready.row.id,
    provenanceManifest: ready.provenanceManifest,
    inputManifest: ready.inputManifest,
    snapshots: ready.row.items.map((item) => ({
      alignmentApplicationId: item.alignmentApplicationId,
      targetSnapshot: item.input?.targetSnapshot,
      sourceSnapshot: item.input?.sourceSnapshot,
    })),
  }, sha256Hex);
  if (!built.ok) throw new TrainingExportStableError("training_export_plan_invalid");
  return built.value;
}

function requirePlanRow(
  rows: Map<string, ReadyAlignmentTrainingExport["row"]["items"][number]>,
  item: AlignmentTrainingPackagePlanItem,
) {
  const row = rows.get(item.alignmentApplicationId);
  if (!row?.input || row.alignmentArtifactId !== item.alignmentArtifactId) {
    throw new TrainingExportStableError("training_export_input_invalid");
  }
  return row;
}

function createClaimFence(job: ClaimedTrainingJob): TrainingClaimFence {
  if (!job.alignmentTrainingExportId || !job.claimedBy || job.attemptCount < 1) {
    throw new TrainingExportClaimLostError();
  }
  return {
    jobId: job.id,
    exportId: job.alignmentTrainingExportId,
    claimedBy: job.claimedBy,
    attemptCount: job.attemptCount,
  };
}

function requireCompleteFence(fence: {
  jobId: string;
  exportId: string;
  claimedBy: string | null;
  attemptCount: number;
}): TrainingClaimFence {
  if (!fence.claimedBy || fence.attemptCount < 1) throw new TrainingExportClaimLostError();
  return { ...fence, claimedBy: fence.claimedBy };
}

async function lockOwnedTrainingClaim(
  transaction: Prisma.TransactionClient,
  fence: TrainingClaimFence,
  status: "running" | "cancelling",
) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM processing_jobs
    WHERE id = ${fence.jobId}
      AND type = 'alignment_training_export'
      AND alignment_training_export_id = ${fence.exportId}
      AND status = ${status}::"ProcessingJobStatus"
      AND claimed_by = ${fence.claimedBy}
      AND attempt_count = ${fence.attemptCount}
      AND cancel_requested_at IS NULL
    FOR UPDATE
  `;
  return rows.length === 1;
}

async function transitionInterruptedTrainingJob(
  transaction: Prisma.TransactionClient,
  fence: TrainingClaimFence,
) {
  const updated = await transaction.processingJob.updateMany({
    where: {
      id: fence.jobId,
      type: "alignment_training_export",
      alignmentTrainingExportId: fence.exportId,
      status: "running",
      claimedBy: fence.claimedBy,
      attemptCount: fence.attemptCount,
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
  return updated.count === 1;
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
  artifact: AlignmentTrainingPackageArtifact,
  fence: TrainingClaimFence,
  staged: StagedBinary,
  planChecksum: string,
  manifestChecksum: string,
) {
  return artifact.exportId === fence.exportId &&
    artifact.processingJobId === fence.jobId &&
    artifact.format === ALIGNMENT_TRAINING_PACKAGE_FORMAT &&
    artifact.version === ALIGNMENT_TRAINING_PACKAGE_VERSION &&
    artifact.container === ALIGNMENT_TRAINING_PACKAGE_CONTAINER &&
    artifact.mimeType === PACKAGE_MIME_TYPE &&
    artifact.size === BigInt(staged.size) &&
    artifact.checksum === staged.checksum &&
    artifact.storageKey === staged.finalStorageKey &&
    artifact.planChecksum === planChecksum &&
    artifact.manifestChecksum === manifestChecksum;
}

function classifyTrainingExportError(
  error: unknown,
  signals: { shutdownSignal?: AbortSignal; claimSignal: AbortSignal },
) {
  if (signals.shutdownSignal?.aborted || signals.claimSignal.aborted) {
    return "training_export_cancelled";
  }
  if (error instanceof TrainingExportCommitUncertainError) {
    return "training_export_commit_uncertain";
  }
  if (error instanceof TrainingExportCleanupError) return "training_export_cleanup_failed";
  if (error instanceof TrainingExportStableError) return error.code;
  if (error instanceof TrainingExportClaimLostError) return "training_export_claim_lost";
  if (error instanceof AlignmentTrainingAudioFfmpegError) return `training_export_${error.code}`;
  if (error instanceof AlignmentTrainingPackageWriterError) return `training_export_${error.code}`;
  if (error instanceof AlignmentTrainingPackageStreamError) return `training_export_${error.code}`;
  if (error instanceof StorageSizeLimitError) return "training_export_package_too_large";
  return "training_export_execution_failed";
}

function userFacingTrainingExportError(code: string) {
  switch (code) {
    case "training_export_permission_revoked":
      return "训练导出所需的管理员权限已失效。";
    case "training_export_input_missing":
    case "training_export_input_invalid":
    case "training_export_input_changed":
    case "training_export_plan_invalid":
      return "已冻结的训练导出输入缺失或完整性校验失败。";
    case "training_export_source_missing":
    case "training_export_audio_source_failed":
    case "training_export_audio_input_failed":
    case "training_export_audio_transcode_failed":
    case "training_export_package_entry_checksum_mismatch":
    case "training_export_package_entry_size_mismatch":
      return "训练音频来源不可用或无法规范化。";
    case "training_export_package_too_large":
    case "training_export_package_entry_too_large":
    case "training_export_request_capacity_exceeded":
      return "训练导出超过服务器容量限制。";
    case "training_export_cleanup_failed":
      return "训练导出失败且对象清理未完成，请联系管理员。";
    case "training_export_commit_uncertain":
      return "训练导出结果提交状态无法确认，请联系管理员。";
    default:
      return "训练导出失败，请稍后重试。";
  }
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

function isStaleClaim(
  job: { status: string; heartbeatAt: Date | null; claimedAt: Date | null },
  staleBefore: Date,
) {
  if (job.status !== "running" && job.status !== "cancelling") return false;
  const lastFact = job.heartbeatAt ?? job.claimedAt;
  return Boolean(lastFact && lastFact < staleBefore);
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

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 上传训练源在进入 FFmpeg 前增量复核冻结摘要，避免对象损坏后仍生成看似成功的训练包。
 * 校验器只保留哈希状态和字节计数，不会把完整媒体缓存进 worker 内存。
 */
function createVerifiedUploadedSourceStream(
  source: Readable,
  expectedChecksum: string,
  expectedBytes: number,
) {
  const hash = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > expectedBytes) {
        callback(new AlignmentTrainingPackageStreamError("package_entry_size_mismatch"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== expectedBytes || hash.digest("hex") !== expectedChecksum) {
        callback(new AlignmentTrainingPackageStreamError(
          bytes !== expectedBytes
            ? "package_entry_size_mismatch"
            : "package_entry_checksum_mismatch",
        ));
        return;
      }
      callback();
    },
  });
  // 对象存储读流错误统一收敛为有限业务错误，不把路径或底层驱动信息带入任务事实。
  source.once("error", () => {
    verifier.destroy(new AlignmentTrainingPackageStreamError("package_entry_open_failed"));
  });
  verifier.once("close", () => source.destroy());
  source.pipe(verifier);
  return verifier;
}

class TrainingExportStableError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class TrainingExportClaimLostError extends Error {}

class TrainingExportCleanupError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, "训练包对象清理失败。");
  }
}

class TrainingExportCommitUncertainError extends AggregateError {
  constructor(databaseError: unknown, verificationError: unknown) {
    super([databaseError, verificationError], "训练包数据库提交结果无法确认。");
  }
}
