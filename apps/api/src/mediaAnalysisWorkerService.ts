import type { MediaAnalysisAsset, Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { AliyunVodGateway, AliyunVodProvider } from "./aliyunVodGateway.js";
import { AliyunVodGatewayError } from "./aliyunVodGateway.js";
import {
  computeMediaAnalysisAssets,
  MEDIA_ANALYSIS_TILE_DURATION_SECONDS,
  MEDIA_ANALYSIS_WAVEFORM_LEVELS,
  MediaAnalysisPcmTileAccumulator,
} from "./mediaAnalysisComputation.js";
import {
  MEDIA_ANALYSIS_SAMPLE_RATE,
  MediaAnalysisFfmpegError,
  streamMediaAnalysisPcm,
} from "./mediaAnalysisFfmpeg.js";
import {
  cleanupUncommittedStagedBinary,
  type ObjectStorage,
  type StagedBinary,
} from "./objectStorage.js";
import { PROCESSING_JOB_STALE_AFTER_MS } from "./processingJobReliability.js";

const MAX_ANALYSIS_ASSET_BYTES = 32 * 1024 * 1024;
const CANCELLATION_POLL_INTERVAL_MS = 500;
const CLAIM_HEARTBEAT_INTERVAL_MS = 15_000;

type WorkerLogger = {
  info(facts: Record<string, unknown>, message: string): void;
  warn(facts: Record<string, unknown>, message: string): void;
};

type ClaimedMediaAnalysisJob = Awaited<ReturnType<MediaAnalysisWorkerService["claimNext"]>>;

/** 数据库任务、对象存储、VOD 和 FFmpeg 的编排层；API 进程不执行任何长媒体计算。 */
export class MediaAnalysisWorkerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: ObjectStorage,
    private readonly aliyunVod: AliyunVodProvider | null,
    private readonly ffmpegPath: string,
    private readonly logger: WorkerLogger,
    private readonly cancellationPollIntervalMs = CANCELLATION_POLL_INTERVAL_MS,
    private readonly claimHeartbeatIntervalMs = CLAIM_HEARTBEAT_INTERVAL_MS,
  ) {}

  async recoverStaleJobs(now = new Date()) {
    const staleBefore = new Date(now.getTime() - PROCESSING_JOB_STALE_AFTER_MS);
    const stale = await this.prisma.processingJob.findMany({
      where: {
        type: "media_analysis",
        status: { in: ["running", "cancelling"] },
        analysisRunId: { not: null },
        // 历史 superseded run 只保留迁移证据，不能被恢复逻辑重新放回在线队列。
        analysisRun: { supersededByRunId: null },
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, claimedAt: { lt: staleBefore } },
        ],
      },
      select: {
        id: true,
      },
    });
    if (stale.length === 0) return 0;
    let recoveredCount = 0;
    for (const job of stale) {
      if (await this.recoverStaleJob(job.id, staleBefore)) recoveredCount += 1;
    }
    return recoveredCount;
  }

  async claimNext(workerId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.processingJob.findFirst({
        where: {
          type: "media_analysis",
          status: "queued",
          analysisRunId: { not: null },
          analysisRun: { supersededByRunId: null },
          requests: { some: { cancelledAt: null } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (!candidate) return null;
      const now = new Date();
      const claimed = await transaction.processingJob.updateMany({
        where: { id: candidate.id, status: "queued" },
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
        include: {
          analysisRun: {
            include: {
              sourceMedia: { include: { file: true } },
            },
          },
        },
      });
      if (!job.analysisRun) return null;
      const claimedRun = await transaction.mediaAnalysisRun.updateMany({
        where: { id: job.analysisRun.id, status: "queued" },
        data: { status: "running", progress: 0, errorCode: null },
      });
      if (claimedRun.count !== 1) throw new WorkerClaimLostError();
      return job;
    });
  }

  async processNext(workerId: string, signal?: AbortSignal) {
    const job = await this.claimNext(workerId);
    if (!job) return false;
    const claimController = new AbortController();
    const monitorController = new AbortController();
    const monitor = this.monitorClaim(
      job.id,
      workerId,
      claimController,
      monitorController.signal,
    );
    const workSignal = signal
      ? AbortSignal.any([signal, claimController.signal])
      : claimController.signal;
    try {
      await this.processClaimed(job, {
        workSignal,
        shutdownSignal: signal,
        claimSignal: claimController.signal,
      });
    } finally {
      monitorController.abort();
      await monitor;
    }
    return true;
  }

  private async processClaimed(
    job: Exclude<ClaimedMediaAnalysisJob, null>,
    signals: {
      workSignal: AbortSignal;
      shutdownSignal?: AbortSignal;
      claimSignal: AbortSignal;
    },
  ) {
    if (!job.analysisRun) return;
    const run = job.analysisRun;
    try {
      await this.removeExistingAssets(run.id);
      if (signals.workSignal.aborted) throw new MediaAnalysisFfmpegError("aborted");
      const input = await this.createFfmpegInput(run);
      let assetCount = 0;
      const accumulator = new MediaAnalysisPcmTileAccumulator(
        MEDIA_ANALYSIS_SAMPLE_RATE,
        async (samples, tileIndex) => {
          signals.workSignal.throwIfAborted();
          const assets = computeMediaAnalysisAssets(
            samples,
            MEDIA_ANALYSIS_SAMPLE_RATE,
            tileIndex,
          );
          for (const asset of assets) {
            signals.workSignal.throwIfAborted();
            await this.publishAsset({
              jobId: job.id,
              runId: run.id,
              claimedBy: job.claimedBy,
            }, asset);
            assetCount += 1;
          }
          const elapsed = (tileIndex * MEDIA_ANALYSIS_TILE_DURATION_SECONDS) +
            samples.length / MEDIA_ANALYSIS_SAMPLE_RATE;
          const progress = run.sourceMedia.duration && run.sourceMedia.duration > 0
            ? Math.min(0.99, elapsed / run.sourceMedia.duration)
            : Math.min(0.99, 0.05 + tileIndex * 0.01);
          await this.heartbeat(job.id, run.id, job.claimedBy, progress);
        },
      );
      const decoded = await streamMediaAnalysisPcm(
        input,
        (samples) => accumulator.push(samples),
        { ffmpegPath: this.ffmpegPath, signal: signals.workSignal },
      );
      await accumulator.finish();
      const duration = decoded.sampleCount / MEDIA_ANALYSIS_SAMPLE_RATE;
      const completedAt = new Date();
      await this.prisma.$transaction(async (transaction) => {
        // 成功提交必须先争得仍由本 worker 持有且未取消的终态；取消先赢时整个事务回滚。
        const completedJob = await transaction.processingJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            claimedBy: job.claimedBy,
            cancelRequestedAt: null,
          },
          data: {
            status: "succeeded",
            progress: 1,
            result: {
              runId: run.id,
              assetCount,
              tileCount: accumulator.processedTileCount,
            },
            heartbeatAt: completedAt,
            finishedAt: completedAt,
          },
        });
        if (completedJob.count !== 1) throw new WorkerClaimLostError();
        const completedRun = await transaction.mediaAnalysisRun.updateMany({
          where: { id: run.id, status: "running" },
          data: {
            status: "succeeded",
            progress: 1,
            errorCode: null,
            duration,
            sampleRate: MEDIA_ANALYSIS_SAMPLE_RATE,
            manifest: {
              version: 1,
              tileDurationSeconds: MEDIA_ANALYSIS_TILE_DURATION_SECONDS,
              tileCount: accumulator.processedTileCount,
              waveformLevels: MEDIA_ANALYSIS_WAVEFORM_LEVELS,
              spectrogramPresets: ["time-detail", "frequency-detail"],
              pitchPreset: "yin-v1",
            },
            completedAt,
          },
        });
        if (completedRun.count !== 1) throw new WorkerClaimLostError();
      });
      this.logger.info(
        { jobId: job.id, runId: run.id, assetCount },
        "媒体分析任务完成",
      );
    } catch (error) {
      const current = await this.prisma.processingJob.findUnique({
        where: { id: job.id },
        select: { status: true, claimedBy: true },
      });
      // claim 已被陈旧恢复转交给新 worker 时，旧进程不得再清理新 attempt 的资产或覆盖其状态。
      if (
        !current ||
        current.claimedBy !== job.claimedBy ||
        current.status === "succeeded" ||
        current.status === "cancelled" ||
        current.status === "failed"
      ) return;
      let failure: unknown = error;
      try {
        await this.removeExistingAssets(run.id);
      } catch (cleanupError) {
        // 清理失败必须覆盖为稳定业务状态，同时保留原始错误供进程内诊断，不能静默留下半成品。
        failure = new AggregateError(
          [error, cleanupError],
          "媒体分析失败，且半成品清理失败。",
        );
      }
      const errorCode = failure instanceof WorkerAssetCommitUncertainError
        ? "analysis_asset_commit_uncertain"
        : failure instanceof AggregateError
          ? "analysis_cleanup_failed"
          : classifyWorkerError(failure);
      if (current.status === "cancelling" || signals.claimSignal.aborted) {
        if (errorCode === "analysis_cleanup_failed") {
          await this.failClaimedJob(job, run.id, errorCode);
        } else {
          await this.settleCancelledJob(job.id, run.id, job.claimedBy);
          this.logger.info(
            { jobId: job.id, runId: run.id },
            "媒体分析任务按用户请求取消",
          );
        }
        return;
      }
      if (errorCode === "analysis_cancelled" && signals.shutdownSignal?.aborted) {
        // 进程正常停机不等于业务失败：清掉本次半成品后重新排队，由下一实例从头生成完整资产。
        await this.requeueInterruptedJob(job.id, run.id, job.claimedBy);
        this.logger.info(
          { jobId: job.id, runId: run.id },
          "媒体分析任务因 worker 停机重新排队",
        );
        return;
      }
      await this.failClaimedJob(job, run.id, errorCode);
      this.logger.warn(
        { jobId: job.id, runId: run.id, errorCode },
        "媒体分析任务失败",
      );
    }
  }

  private async createFfmpegInput(run: Exclude<
    Exclude<ClaimedMediaAnalysisJob, null>["analysisRun"],
    null
  >) {
    const media = run.sourceMedia;
    if (media.sourceType === "uploaded") {
      if (!media.file) throw new WorkerStableError("analysis_source_invalid");
      return {
        kind: "uploaded" as const,
        stream: await this.storage.getObjectStream(media.file.storageKey),
      };
    }
    if (
      !this.aliyunVod ||
      !media.aliyunVodVideoId ||
      media.aliyunVodRegion !== this.aliyunVod.region
    ) {
      throw new WorkerStableError("analysis_source_invalid");
    }
    return createAliyunVodFfmpegInput(
      this.aliyunVod.gateway,
      media.aliyunVodVideoId,
      run.sourceVodRenditionJobId,
    );
  }

  private async publishAsset(
    claim: {
      jobId: string;
      runId: string;
      claimedBy: string | null;
    },
    asset: ReturnType<typeof computeMediaAnalysisAssets>[number],
  ) {
    const assetId = randomUUID();
    const finalStorageKey = this.storage.createStorageKey("xqa");
    const staged = await this.storage.putStagedObject(
      finalStorageKey,
      Readable.from([Buffer.from(asset.bytes)]),
      MAX_ANALYSIS_ASSET_BYTES,
    );
    try {
      await this.storage.promoteStagedObject(staged);
    } catch (publishError) {
      const cleanupFailures = await cleanupUncommittedStagedBinary(
        this.storage,
        staged,
      );
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [publishError, ...cleanupFailures.map(({ error }) => error)],
          "媒体分析资产发布失败，且未提交对象补偿不完整。",
        );
      }
      throw publishError;
    }
    try {
      await this.prisma.$transaction(async (transaction) => {
        // 与取消、stale recovery 共用 job 行锁；锁后已非当前 owner 时禁止旧 attempt 发布资产。
        const ownedClaim = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM processing_jobs
          WHERE id = ${claim.jobId}
            AND status = 'running'
            AND claimed_by = ${claim.claimedBy}
            AND cancel_requested_at IS NULL
          FOR UPDATE
        `;
        if (ownedClaim.length !== 1) throw new WorkerClaimLostError();
        await transaction.mediaAnalysisAsset.create({
          data: {
            id: assetId,
            runId: claim.runId,
            kind: asset.kind,
            preset: asset.preset,
            level: asset.level,
            tileIndex: asset.tileIndex,
            startTime: asset.startTime,
            endTime: asset.endTime,
            mimeType: asset.mimeType,
            size: asset.bytes.byteLength,
            checksum: staged.checksum,
            storageKey: staged.finalStorageKey,
          },
        });
      });
    } catch (databaseError) {
      let committedRow;
      try {
        committedRow = await this.prisma.mediaAnalysisAsset.findUnique({
          where: { id: assetId },
        });
      } catch (verificationError) {
        // 无法确认数据库是否已提交时宁可保留 aged orphan，也不能删除可能已被行引用的 final。
        throw new WorkerAssetCommitUncertainError(databaseError, verificationError);
      }
      if (committedRow) {
        if (matchesCommittedAsset(committedRow, claim.runId, asset, staged)) return;
        throw new WorkerAssetCommitUncertainError(
          databaseError,
          new Error("分析资产提交事实与预期不一致。"),
        );
      }
      try {
        await this.storage.deleteObject(staged.finalStorageKey);
      } catch (cleanupError) {
        throw new AggregateError(
          [databaseError, cleanupError],
          "媒体分析资产数据库写入失败，且最终对象补偿失败。",
        );
      }
      throw databaseError;
    }
  }

  private async removeExistingAssets(runId: string) {
    const assets = await this.prisma.mediaAnalysisAsset.findMany({
      where: { runId },
      select: { id: true, storageKey: true },
    });
    const deletedIds: string[] = [];
    for (const asset of assets) {
      await this.storage.deleteObject(asset.storageKey);
      deletedIds.push(asset.id);
    }
    if (deletedIds.length > 0) {
      await this.prisma.mediaAnalysisAsset.deleteMany({
        where: { id: { in: deletedIds } },
      });
    }
  }

  /**
   * 陈旧恢复与新分析需求共用 canonical 锁，并在锁内重读心跳与需求。
   * 列表查询只负责提供候选，不能直接作为状态转换依据，否则刚附加的新需求可能被旧快照取消。
   */
  private async recoverStaleJob(jobId: string, staleBefore: Date) {
    const decision = await this.prisma.$transaction(async (transaction) => {
      const initial = await transaction.processingJob.findUnique({
        where: { id: jobId },
        select: { deduplicationKey: true },
      });
      if (!initial) return null;
      await lockCanonicalProcessingJob(transaction, initial.deduplicationKey);
      await transaction.$queryRaw`
        SELECT "id" FROM "processing_jobs" WHERE "id" = ${jobId} FOR UPDATE
      `;
      const current = await transaction.processingJob.findUnique({
        where: { id: jobId },
        select: {
          status: true,
          createdBy: true,
          claimedBy: true,
          claimedAt: true,
          heartbeatAt: true,
          analysisRunId: true,
          requests: { where: { cancelledAt: null }, select: { id: true }, take: 1 },
        },
      });
      if (!current?.analysisRunId || !isStaleClaim(current, staleBefore)) return null;

      if (current.status === "running" && current.requests.length > 0) {
        const requeued = await transitionInterruptedJob(
          transaction,
          jobId,
          current.analysisRunId,
          current.claimedBy,
        );
        return requeued ? { kind: "requeued" as const } : null;
      }

      // cancelling worker 崩溃后不能重新执行；running 却已无需求也按取消收口，避免无人消费的悬空队列。
      if (current.status === "running") {
        const cancelRequestedAt = new Date();
        const cancelling = await transaction.processingJob.updateMany({
          where: { id: jobId, status: "running", claimedBy: current.claimedBy },
          data: {
            status: "cancelling",
            cancelRequestedAt,
            cancelRequestedBy: current.createdBy,
            cancellationMode: "user_request",
          },
        });
        const cancellingRun = await transaction.mediaAnalysisRun.updateMany({
          where: { id: current.analysisRunId, status: "running" },
          data: { status: "cancelling" },
        });
        if (cancelling.count !== 1 || cancellingRun.count !== 1) {
          throw new WorkerClaimLostError();
        }
      }
      return {
        kind: "cancel" as const,
        runId: current.analysisRunId,
        claimedBy: current.claimedBy,
      };
    });
    if (!decision) return false;
    if (decision.kind === "cancel") {
      await this.finishCancellation(jobId, decision.runId, decision.claimedBy);
    }
    return true;
  }

  /**
   * 每个 claim 只有一个 monitor：它既响应业务取消/claim 转移，也在无瓦片产出时续写活性心跳。
   * 数据库短故障不能永久关闭监控；下一轮仍需追赶状态，避免任务从此无法取消。
   */
  private async monitorClaim(
    jobId: string,
    workerId: string,
    claimController: AbortController,
    stopSignal: AbortSignal,
  ) {
    let nextHeartbeatAt = Date.now() + this.claimHeartbeatIntervalMs;
    while (!stopSignal.aborted && !claimController.signal.aborted) {
      try {
        const job = await this.prisma.processingJob.findUnique({
          where: { id: jobId },
          select: { status: true, claimedBy: true, cancelRequestedAt: true },
        });
        if (
          job?.claimedBy === workerId &&
          (job.status === "cancelling" || job.cancelRequestedAt !== null)
        ) {
          claimController.abort("processing_job_cancelled");
          return;
        }
        if (!job || job.status !== "running" || job.claimedBy !== workerId) {
          // stale recovery 或其他终态已经夺走 claim 时，旧 FFmpeg 必须立即停止，不能继续发布迟到资产。
          claimController.abort("processing_job_claim_lost");
          return;
        }
        if (Date.now() >= nextHeartbeatAt) {
          const refreshed = await this.prisma.processingJob.updateMany({
            where: {
              id: jobId,
              status: "running",
              claimedBy: workerId,
              cancelRequestedAt: null,
            },
            data: { heartbeatAt: new Date() },
          });
          // 状态可能在读取与更新之间改变；不猜测结果，下一轮立即按权威行重新分类。
          if (refreshed.count === 1) {
            nextHeartbeatAt = Date.now() + this.claimHeartbeatIntervalMs;
          }
        }
      } catch {
        // monitor 不打印每次连接抖动，避免故障时日志风暴；runtime/最终 heartbeat 仍负责稳定诊断。
      }
      await waitForSignal(this.cancellationPollIntervalMs, stopSignal);
    }
  }

  private async finishCancellation(
    jobId: string,
    runId: string,
    claimedBy: string | null,
  ) {
    try {
      await this.removeExistingAssets(runId);
      await this.settleCancelledJob(jobId, runId, claimedBy);
    } catch {
      await this.failJob(jobId, runId, claimedBy, "analysis_cleanup_failed");
      this.logger.warn(
        { jobId, runId, errorCode: "analysis_cleanup_failed" },
        "取消媒体分析时半成品清理失败",
      );
    }
  }

  private async settleCancelledJob(
    jobId: string,
    runId: string,
    claimedBy: string | null,
  ) {
    const finishedAt = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const cancelled = await transaction.processingJob.updateMany({
        where: { id: jobId, status: "cancelling", claimedBy },
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
      if (cancelled.count !== 1) return;
      const cancelledRun = await transaction.mediaAnalysisRun.updateMany({
        where: { id: runId, status: { in: ["running", "cancelling", "cancelled"] } },
        data: {
          status: "cancelled",
          progress: 0,
          errorCode: null,
          completedAt: finishedAt,
        },
      });
      if (cancelledRun.count !== 1) throw new WorkerClaimLostError();
    });
  }

  private async requeueInterruptedJob(
    jobId: string,
    runId: string,
    claimedBy: string | null,
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await transitionInterruptedJob(transaction, jobId, runId, claimedBy);
    });
  }

  private async failClaimedJob(
    job: Exclude<ClaimedMediaAnalysisJob, null>,
    runId: string,
    errorCode: string,
  ) {
    await this.failJob(job.id, runId, job.claimedBy, errorCode);
  }

  private async failJob(
    jobId: string,
    runId: string,
    claimedBy: string | null,
    errorCode: string,
  ) {
    const finishedAt = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const failed = await transaction.processingJob.updateMany({
        where: {
          id: jobId,
          claimedBy,
          status: { in: ["running", "cancelling"] },
        },
        data: {
          status: "failed",
          progress: 0,
          errorCode,
          errorMessage: userFacingWorkerError(errorCode),
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          finishedAt,
        },
      });
      if (failed.count !== 1) return;
      const failedRun = await transaction.mediaAnalysisRun.updateMany({
        where: { id: runId, status: { in: ["running", "cancelling", "failed"] } },
        data: {
          status: "failed",
          progress: 0,
          errorCode,
          completedAt: finishedAt,
        },
      });
      if (failedRun.count !== 1) throw new WorkerClaimLostError();
    });
  }

  private async heartbeat(
    jobId: string,
    runId: string,
    claimedBy: string | null,
    progress: number,
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const heartbeat = await transaction.processingJob.updateMany({
        where: {
          id: jobId,
          status: "running",
          claimedBy,
          cancelRequestedAt: null,
        },
        data: { heartbeatAt: now, progress },
      });
      if (heartbeat.count !== 1) throw new WorkerClaimLostError();
      const runHeartbeat = await transaction.mediaAnalysisRun.updateMany({
        where: { id: runId, status: "running" },
        data: { progress },
      });
      if (runHeartbeat.count !== 1) throw new WorkerClaimLostError();
    });
  }
}

/**
 * rendition run 必须精确使用创建时冻结的 JobId；重新选择“最佳 mp3”会让波形与用户试听内容错位。
 * 返回值只包含本次 FFmpeg 消费所需的临时 URL，调用方不得持久化或写入日志。
 */
export async function createAliyunVodFfmpegInput(
  gateway: AliyunVodGateway,
  videoId: string,
  renditionJobId: string | null,
) {
  if (!renditionJobId) {
    const audio = await gateway.createAnalysisAudioStream(videoId);
    return { kind: "vod" as const, url: audio.url };
  }
  const audio = await gateway.createAudioRenditionStream(videoId, renditionJobId);
  if (audio.jobId !== renditionJobId) {
    throw new WorkerStableError("analysis_source_invalid");
  }
  return { kind: "vod" as const, url: audio.url };
}

class WorkerStableError extends Error {
  constructor(readonly code: string) {
    super(`Media analysis worker failed: ${code}`);
  }
}

class WorkerClaimLostError extends Error {}

class WorkerAssetCommitUncertainError extends AggregateError {
  constructor(databaseError: unknown, verificationError: unknown) {
    super(
      [databaseError, verificationError],
      "媒体分析资产数据库提交结果无法确认。",
    );
  }
}

function matchesCommittedAsset(
  row: MediaAnalysisAsset,
  runId: string,
  asset: ReturnType<typeof computeMediaAnalysisAssets>[number],
  staged: StagedBinary,
) {
  return row.runId === runId &&
    row.kind === asset.kind &&
    row.preset === asset.preset &&
    row.level === asset.level &&
    row.tileIndex === asset.tileIndex &&
    row.startTime === asset.startTime &&
    row.endTime === asset.endTime &&
    row.mimeType === asset.mimeType &&
    row.size === BigInt(asset.bytes.byteLength) &&
    row.checksum === staged.checksum &&
    row.storageKey === staged.finalStorageKey;
}

function classifyWorkerError(error: unknown) {
  if (error instanceof WorkerClaimLostError) return "analysis_claim_lost";
  if (error instanceof WorkerStableError) return error.code;
  if (error instanceof MediaAnalysisFfmpegError) {
    return error.code === "tool_unavailable"
      ? "analysis_tool_unavailable"
      : error.code === "aborted"
        ? "analysis_cancelled"
        : "analysis_decode_failed";
  }
  if (error instanceof AliyunVodGatewayError) {
    return error.category === "not_found"
      ? "audio_stream_missing"
      : "analysis_external_service_unavailable";
  }
  return "analysis_failed";
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

async function lockCanonicalProcessingJob(
  transaction: Prisma.TransactionClient,
  deduplicationKey: string,
) {
  await transaction.$queryRaw`
    SELECT 1::integer AS locked
    FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-job:${deduplicationKey}`}))
  `;
}

/** job 与 analysis run 必须成对重排；任一前置状态不匹配时整笔事务回滚。 */
async function transitionInterruptedJob(
  transaction: Prisma.TransactionClient,
  jobId: string,
  runId: string,
  claimedBy: string | null,
) {
  const requeued = await transaction.processingJob.updateMany({
    where: { id: jobId, status: "running", claimedBy, cancelRequestedAt: null },
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
  if (requeued.count !== 1) return false;
  const requeuedRun = await transaction.mediaAnalysisRun.updateMany({
    where: { id: runId, status: "running" },
    data: {
      status: "queued",
      progress: 0,
      errorCode: null,
      completedAt: null,
    },
  });
  if (requeuedRun.count !== 1) throw new WorkerClaimLostError();
  return true;
}

function isStaleClaim(
  job: {
    status: string;
    heartbeatAt: Date | null;
    claimedAt: Date | null;
  },
  staleBefore: Date,
) {
  if (job.status !== "running" && job.status !== "cancelling") return false;
  const lastWorkerFact = job.heartbeatAt ?? job.claimedAt;
  return Boolean(lastWorkerFact && lastWorkerFact < staleBefore);
}

function userFacingWorkerError(code: string) {
  switch (code) {
    case "analysis_tool_unavailable":
      return "服务器未配置可用的 FFmpeg。";
    case "audio_stream_missing":
      return "阿里云媒资没有可用的纯音频转码。";
    case "analysis_source_invalid":
      return "分析音频来源已失效。";
    case "analysis_cancelled":
      return "分析任务已停止。";
    case "analysis_cleanup_failed":
      return "媒体分析失败且半成品清理未完成，请联系管理员检查对象存储。";
    case "analysis_asset_commit_uncertain":
      return "媒体分析资产提交结果无法确认，请联系管理员检查数据库与对象存储。";
    default:
      return "媒体分析失败，请稍后重试。";
  }
}
