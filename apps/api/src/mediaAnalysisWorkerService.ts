import type { PrismaClient } from "@prisma/client";
import { Readable } from "node:stream";
import type { AliyunVodProvider } from "./aliyunVodGateway.js";
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
import type { ObjectStorage } from "./objectStorage.js";

const STALE_JOB_AFTER_MS = 2 * 60 * 1000;
const MAX_ANALYSIS_ASSET_BYTES = 32 * 1024 * 1024;

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
  ) {}

  async recoverStaleJobs(now = new Date()) {
    const staleBefore = new Date(now.getTime() - STALE_JOB_AFTER_MS);
    const stale = await this.prisma.processingJob.findMany({
      where: {
        type: "media_analysis",
        status: "running",
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, claimedAt: { lt: staleBefore } },
        ],
      },
      select: { id: true, analysisRunId: true },
    });
    if (stale.length === 0) return 0;
    const runIds = stale.flatMap(({ analysisRunId }) =>
      analysisRunId ? [analysisRunId] : []);
    await this.prisma.$transaction([
      this.prisma.processingJob.updateMany({
        where: { id: { in: stale.map(({ id }) => id) }, status: "running" },
        data: {
          status: "queued",
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          errorCode: null,
          errorMessage: null,
        },
      }),
      this.prisma.mediaAnalysisRun.updateMany({
        where: { id: { in: runIds }, status: "running" },
        data: { status: "queued", errorCode: null },
      }),
    ]);
    return stale.length;
  }

  async claimNext(workerId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.processingJob.findFirst({
        where: { type: "media_analysis", status: "queued", analysisRunId: { not: null } },
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
      await transaction.mediaAnalysisRun.update({
        where: { id: job.analysisRun.id },
        data: { status: "running", progress: 0, errorCode: null },
      });
      return job;
    });
  }

  async processNext(workerId: string, signal?: AbortSignal) {
    const job = await this.claimNext(workerId);
    if (!job) return false;
    await this.processClaimed(job, signal);
    return true;
  }

  private async processClaimed(
    job: Exclude<ClaimedMediaAnalysisJob, null>,
    signal?: AbortSignal,
  ) {
    if (!job.analysisRun) return;
    const run = job.analysisRun;
    try {
      await this.removeExistingAssets(run.id);
      if (signal?.aborted) throw new MediaAnalysisFfmpegError("aborted");
      const input = await this.createFfmpegInput(run.sourceMedia);
      let assetCount = 0;
      const accumulator = new MediaAnalysisPcmTileAccumulator(
        MEDIA_ANALYSIS_SAMPLE_RATE,
        async (samples, tileIndex) => {
          signal?.throwIfAborted();
          const assets = computeMediaAnalysisAssets(
            samples,
            MEDIA_ANALYSIS_SAMPLE_RATE,
            tileIndex,
          );
          for (const asset of assets) {
            await this.publishAsset(run.id, asset);
            assetCount += 1;
          }
          const elapsed = (tileIndex * MEDIA_ANALYSIS_TILE_DURATION_SECONDS) +
            samples.length / MEDIA_ANALYSIS_SAMPLE_RATE;
          const progress = run.sourceMedia.duration && run.sourceMedia.duration > 0
            ? Math.min(0.99, elapsed / run.sourceMedia.duration)
            : Math.min(0.99, 0.05 + tileIndex * 0.01);
          await this.heartbeat(job.id, run.id, progress);
        },
      );
      const decoded = await streamMediaAnalysisPcm(
        input,
        (samples) => accumulator.push(samples),
        { ffmpegPath: this.ffmpegPath, signal },
      );
      await accumulator.finish();
      const duration = decoded.sampleCount / MEDIA_ANALYSIS_SAMPLE_RATE;
      const completedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.mediaAnalysisRun.update({
          where: { id: run.id },
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
        }),
        this.prisma.processingJob.update({
          where: { id: job.id },
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
        }),
      ]);
      this.logger.info(
        { jobId: job.id, runId: run.id, assetCount },
        "媒体分析任务完成",
      );
    } catch (error) {
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
      const errorCode = failure instanceof AggregateError
        ? "analysis_cleanup_failed"
        : classifyWorkerError(failure);
      if (errorCode === "analysis_cancelled" && signal?.aborted) {
        // 进程正常停机不等于业务失败：清掉本次半成品后重新排队，由下一实例从头生成完整资产。
        await this.prisma.$transaction([
          this.prisma.mediaAnalysisRun.updateMany({
            where: { id: run.id, status: "running" },
            data: {
              status: "queued",
              progress: 0,
              errorCode: null,
              completedAt: null,
            },
          }),
          this.prisma.processingJob.updateMany({
            where: { id: job.id, status: "running" },
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
          }),
        ]);
        this.logger.info(
          { jobId: job.id, runId: run.id },
          "媒体分析任务因 worker 停机重新排队",
        );
        return;
      }
      await this.prisma.$transaction([
        this.prisma.mediaAnalysisRun.updateMany({
          where: { id: run.id },
          data: {
            status: "failed",
            progress: 0,
            errorCode,
            completedAt: new Date(),
          },
        }),
        this.prisma.processingJob.updateMany({
          where: { id: job.id },
          data: {
            status: "failed",
            progress: 0,
            errorCode,
            errorMessage: userFacingWorkerError(errorCode),
            finishedAt: new Date(),
          },
        }),
      ]);
      this.logger.warn(
        { jobId: job.id, runId: run.id, errorCode },
        "媒体分析任务失败",
      );
    }
  }

  private async createFfmpegInput(media: Exclude<
    Exclude<ClaimedMediaAnalysisJob, null>["analysisRun"],
    null
  >["sourceMedia"]) {
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
    const audio = await this.aliyunVod.gateway.createAnalysisAudioStream(
      media.aliyunVodVideoId,
    );
    return { kind: "vod" as const, url: audio.url };
  }

  private async publishAsset(
    runId: string,
    asset: ReturnType<typeof computeMediaAnalysisAssets>[number],
  ) {
    const finalStorageKey = this.storage.createStorageKey("xqa");
    const staged = await this.storage.putStagedObject(
      finalStorageKey,
      Readable.from([Buffer.from(asset.bytes)]),
      MAX_ANALYSIS_ASSET_BYTES,
    );
    try {
      await this.storage.promoteStagedObject(staged);
    } catch (publishError) {
      try {
        await this.storage.deleteObject(staged.stagedStorageKey);
      } catch (cleanupError) {
        throw new AggregateError(
          [publishError, cleanupError],
          "媒体分析资产发布失败，且暂存对象补偿失败。",
        );
      }
      throw publishError;
    }
    try {
      await this.prisma.mediaAnalysisAsset.create({
        data: {
          runId,
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
    } catch (error) {
      try {
        await this.storage.deleteObject(staged.finalStorageKey);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "媒体分析资产数据库写入失败，且最终对象补偿失败。",
        );
      }
      throw error;
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

  private async heartbeat(jobId: string, runId: string, progress: number) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.processingJob.update({
        where: { id: jobId },
        data: { heartbeatAt: now, progress },
      }),
      this.prisma.mediaAnalysisRun.update({
        where: { id: runId },
        data: { progress },
      }),
    ]);
  }
}

class WorkerStableError extends Error {
  constructor(readonly code: string) {
    super(`Media analysis worker failed: ${code}`);
  }
}

function classifyWorkerError(error: unknown) {
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
    default:
      return "媒体分析失败，请稍后重试。";
  }
}
