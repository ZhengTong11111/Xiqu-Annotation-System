import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type ProcessingJobStatus } from "@prisma/client";
import type {
  AnnotationMediaAnalysisStatus,
  CreateMediaAnalysisRequest,
  MediaAnalysisAssetKind,
  MediaAnalysisAssetDescriptor,
  ListMediaAnalysisAssetsOptions,
  MediaAnalysisRun as MediaAnalysisRunDto,
  ResolvedAnalysisAudioSource,
} from "@xiqu/shared";
import {
  isStableMediaAudioIdentity,
  MAX_MEDIA_ANALYSIS_BATCH_ASSETS,
  MAX_MEDIA_ANALYSIS_BATCH_BYTES,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import {
  analysisAudioForbidden,
  analysisSourceMissing,
  badRequest,
  conflict,
  notFound,
} from "./errors.js";
import { ResourceAccessService } from "./resourceAccess.js";
import {
  MEDIA_ANALYSIS_SPECTROGRAM_PRESETS,
  MEDIA_ANALYSIS_TILE_DURATION_SECONDS,
  MEDIA_ANALYSIS_WAVEFORM_LEVELS,
} from "./mediaAnalysisComputation.js";
import { createMediaAnalysisSourceFingerprint } from "./mediaAnalysisSourceFingerprint.js";
import {
  assertProcessingJobRequestMatch,
  createMediaAnalysisJobDeduplicationKey,
  createMediaAnalysisRequestFingerprint,
} from "./processingJobIdentity.js";

export const MEDIA_ANALYSIS_ALGORITHM_VERSION = "xiqu-media-analysis-v1";
export const MEDIA_ANALYSIS_CONFIG = {
  sampleRate: 16_000,
  channelCount: 1,
  tileDurationSeconds: MEDIA_ANALYSIS_TILE_DURATION_SECONDS,
  waveformLevels: MEDIA_ANALYSIS_WAVEFORM_LEVELS,
  spectrogramPresets: MEDIA_ANALYSIS_SPECTROGRAM_PRESETS,
  pitchPreset: "yin-v1",
} as const;
const MEDIA_ANALYSIS_CONFIG_HASH = stableHash(MEDIA_ANALYSIS_CONFIG);

/** 旧 run 的 manifest 可能没有合法粒度，读取时回退到当前默认值。 */
function readTileDurationSeconds(manifest: unknown, config: unknown) {
  for (const candidate of [manifest, config]) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = (candidate as { tileDurationSeconds?: unknown }).tileDurationSeconds;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return MEDIA_ANALYSIS_TILE_DURATION_SECONDS;
}

type AnalysisMediaRow = {
  resourceId: string;
  sourceType: "uploaded" | "aliyun_vod";
  mediaKind: "video" | "audio";
  mimeType: string | null;
  size: bigint | null;
  duration: number | null;
  aliyunVodVideoId: string | null;
  aliyunVodRegion: string | null;
  resource: {
    name: string;
    type: "folder" | "project" | "annotation_file" | "media_file";
    archivedAt: Date | null;
    trashedAt: Date | null;
  };
  file: {
    id: string;
    storageKey: string;
    checksum: string | null;
    size: bigint;
  } | null;
};

type ResolvedAnalysisSource = {
  offsetSeconds: number;
  media: AnalysisMediaRow;
  mediaFingerprint: string;
  sourceVodRenditionJobId: string | null;
};

type AnalysisContext = {
  audioTrackId: string;
  source:
    | { status: "ready"; value: ResolvedAnalysisSource }
    | {
        status: "unavailable";
        value: Extract<ResolvedAnalysisAudioSource, { status: "unavailable" }>;
      };
};

const analysisMediaInclude = {
  resource: {
    select: {
      name: true,
      type: true,
      archivedAt: true,
      trashedAt: true,
    },
  },
  file: {
    select: {
      id: true,
      storageKey: true,
      checksum: true,
      size: true,
    },
  },
} satisfies Prisma.MediaFileInclude;

const analysisAudioTrackInclude = {
  primaryMedia: { include: analysisMediaInclude },
  audioMedia: { include: analysisMediaInclude },
  vodRenditionMedia: { include: analysisMediaInclude },
} satisfies Prisma.MediaAudioTrackInclude;

/**
 * 媒体分析业务服务是音轨来源解析、run/job 去重和公开 DTO 的唯一边界。
 * worker 只消费这里固化的媒体身份；音轨偏移在请求时投影，不能写进共享 run。
 */
export class MediaAnalysisJobService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async getStatus(
    user: ApiUser,
    annotationFileId: string,
    audioTrackId: unknown,
  ): Promise<AnnotationMediaAnalysisStatus> {
    await this.assertActiveAnnotationFile(user, annotationFileId, "read");
    const context = await this.resolveAnalysisContext(
      user,
      annotationFileId,
      normalizeAudioTrackId(audioTrackId),
    );
    const currentRun = context.source.status === "ready"
      ? await this.prisma.mediaAnalysisRun.findFirst({
          where: {
            sourceMediaResourceId: context.source.value.media.resourceId,
            mediaFingerprint: context.source.value.mediaFingerprint,
            algorithmVersion: MEDIA_ANALYSIS_ALGORITHM_VERSION,
            configHash: MEDIA_ANALYSIS_CONFIG_HASH,
            supersededByRunId: null,
          },
          // 同一来源的最新 run 作为当前展示对象；每个 run DTO 自带粒度，历史 30 秒 run 不会被误拼成 10 秒。
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : null;
    return {
      audioTrackId: context.audioTrackId,
      resolvedSource: toResolvedSourceDto(context),
      currentRun: currentRun && context.source.status === "ready"
        ? await this.mapRun(
            currentRun,
            context.source.value.offsetSeconds,
          )
        : null,
    };
  }

  async createAnalysis(
    user: ApiUser,
    annotationFileId: string,
    input: CreateMediaAnalysisRequest,
  ): Promise<MediaAnalysisRunDto> {
    await this.assertActiveAnnotationFile(user, annotationFileId, "write");
    const audioTrackId = normalizeAudioTrackId(input.audioTrackId);
    const context = await this.resolveAnalysisContext(user, annotationFileId, audioTrackId);
    const source = requireReadySource(context);
    const deduplicationKey = createMediaAnalysisJobDeduplicationKey({
      sourceMediaResourceId: source.media.resourceId,
      mediaFingerprint: source.mediaFingerprint,
      sourceVodRenditionJobId: source.sourceVodRenditionJobId,
      algorithmVersion: MEDIA_ANALYSIS_ALGORITHM_VERSION,
      configHash: MEDIA_ANALYSIS_CONFIG_HASH,
    });
    const requestFingerprint = createMediaAnalysisRequestFingerprint({
      deduplicationKey,
      contextResourceId: annotationFileId,
      audioTrackId,
      force: input.force === true,
    });

    const run = await this.prisma.$transaction(async (transaction) => {
      // 先锁账号级请求编号，再锁 canonical 执行键；固定顺序消除跨来源复用同一编号的唯一约束竞态。
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-request:${user.id}:${input.clientRequestId}`}))
      `;
      // 模糊响应重试优先返回 clientRequestId 已绑定的原执行；任务后来完成也不能改变重放结果。
      const replayedKey = await transaction.processingJobRequestKey.findUnique({
        where: {
          requesterUserId_clientRequestId: {
            requesterUserId: user.id,
            clientRequestId: input.clientRequestId,
          },
        },
        include: { request: { include: { job: { include: { analysisRun: true } } } } },
      });
      if (replayedKey) {
        assertProcessingJobRequestMatch(
          replayedKey.requestFingerprint,
          requestFingerprint,
        );
        if (!replayedKey.request.job.analysisRun) {
          throw conflict("后台任务缺少对应的媒体分析记录。", {
            code: "processing_job_run_missing",
          });
        }
        return replayedKey.request.job.analysisRun;
      }

      // 同一媒体 identity 的并发请求先串行化，再读取 partial-unique 保护的 canonical run。
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-job:${deduplicationKey}`}))
      `;
      const existing = await transaction.mediaAnalysisRun.findFirst({
        where: {
          sourceMediaResourceId: source.media.resourceId,
          mediaFingerprint: source.mediaFingerprint,
          algorithmVersion: MEDIA_ANALYSIS_ALGORITHM_VERSION,
          configHash: MEDIA_ANALYSIS_CONFIG_HASH,
          supersededByRunId: null,
        },
      });
      if (existing && !input.force && existing.status === "succeeded") {
        // succeeded run 正常必有已完成 job；为它补当前账号的 request，任务中心才能展示真实需求。
        const completedJob = await transaction.processingJob.findFirst({
          where: {
            analysisRunId: existing.id,
            deduplicationKey,
            status: "succeeded",
          },
          orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        });
        if (completedJob) {
          const requestResult = await ensureProcessingJobRequest(transaction, {
            jobId: completedJob.id,
            requesterUserId: user.id,
            contextResourceId: annotationFileId,
            mediaAudioTrackId: context.audioTrackId,
            clientRequestId: input.clientRequestId,
            requestFingerprint,
          });
          if (requestResult.created) {
            await createMediaAnalysisRequestAudit(transaction, {
              actorUserId: user.id,
              annotationFileId,
              audioTrackId: context.audioTrackId,
              runId: existing.id,
              jobId: completedJob.id,
              requestId: requestResult.request.id,
              sourceMediaResourceId: source.media.resourceId,
              sourceVodRenditionJobId: source.sourceVodRenditionJobId,
              force: false,
            });
          }
        } else {
          // run 与 job 应由 worker 在同一事务内完成；若两者终态分裂，不能伪装成一次可追踪的成功请求。
          throw conflict("媒体分析结果缺少已完成的任务记录。", {
            code: "processing_job_completion_missing",
          });
        }
        return existing;
      }

      const activeJob = await transaction.processingJob.findFirst({
        where: {
          deduplicationKey,
          status: { in: ["queued", "running", "cancelling"] },
        },
        include: { analysisRun: true },
      });
      if (activeJob) {
        if (activeJob.status === "cancelling") {
          throw conflict("媒体分析正在取消并清理，请稍后重试。", {
            code: "processing_job_cancellation_in_progress",
          });
        }
        if (!activeJob.analysisRun) {
          throw conflict("活动媒体分析任务缺少分析记录。", {
            code: "processing_job_run_missing",
          });
        }
        const requestResult = await ensureProcessingJobRequest(transaction, {
          jobId: activeJob.id,
          requesterUserId: user.id,
          contextResourceId: annotationFileId,
          mediaAudioTrackId: context.audioTrackId,
          clientRequestId: input.clientRequestId,
          requestFingerprint,
        });
        if (requestResult.created) {
          await createMediaAnalysisRequestAudit(transaction, {
            actorUserId: user.id,
            annotationFileId,
            audioTrackId: context.audioTrackId,
            runId: activeJob.analysisRun.id,
            jobId: activeJob.id,
            requestId: requestResult.request.id,
            sourceMediaResourceId: source.media.resourceId,
            sourceVodRenditionJobId: source.sourceVodRenditionJobId,
            force: input.force === true,
          });
        }
        return activeJob.analysisRun;
      }

      const queuedRun = existing
        ? await transaction.mediaAnalysisRun.update({
            where: { id: existing.id },
            data: {
              status: "queued",
              progress: 0,
              errorCode: null,
              duration: null,
              sampleRate: null,
              manifest: Prisma.JsonNull,
              completedAt: null,
            },
          })
        : await transaction.mediaAnalysisRun.create({
            data: {
              sourceMediaResourceId: source.media.resourceId,
              sourceFingerprint: source.mediaFingerprint,
              mediaFingerprint: source.mediaFingerprint,
              sourceVodRenditionJobId: source.sourceVodRenditionJobId,
              algorithmVersion: MEDIA_ANALYSIS_ALGORITHM_VERSION,
              configHash: MEDIA_ANALYSIS_CONFIG_HASH,
              config: MEDIA_ANALYSIS_CONFIG,
              createdBy: user.id,
            },
          });

      // 强制重算复用稳定 run id；旧资产必须由 worker 先删对象再删事实，API 不能制造失联对象。
      const job = await transaction.processingJob.create({
        data: {
          type: "media_analysis",
          resourceId: annotationFileId,
          inputFileIds: source.media.file ? [source.media.file.id] : [],
          createdBy: user.id,
          analysisRunId: queuedRun.id,
          deduplicationKey,
        },
      });
      const requestResult = await ensureProcessingJobRequest(transaction, {
        jobId: job.id,
        requesterUserId: user.id,
        contextResourceId: annotationFileId,
        mediaAudioTrackId: context.audioTrackId,
        clientRequestId: input.clientRequestId,
        requestFingerprint,
      });
      await createMediaAnalysisRequestAudit(transaction, {
        actorUserId: user.id,
        annotationFileId,
        audioTrackId: context.audioTrackId,
        runId: queuedRun.id,
        jobId: job.id,
        requestId: requestResult.request.id,
        sourceMediaResourceId: source.media.resourceId,
        sourceVodRenditionJobId: source.sourceVodRenditionJobId,
        force: input.force === true,
      });
      return queuedRun;
    });
    return this.mapRun(run, source.offsetSeconds);
  }

  async listAssets(
    user: ApiUser,
    annotationFileId: string,
    options: ListMediaAnalysisAssetsOptions,
  ) {
    const identity = await this.resolveReadableAnalysisIdentity(
      user,
      annotationFileId,
      options.audioTrackId,
    );
    validateAssetListOptions(options);
    const run = await this.prisma.mediaAnalysisRun.findFirst({
      where: {
        id: options.runId,
        sourceMediaResourceId: identity.mediaResourceId,
        mediaFingerprint: identity.mediaFingerprint,
        supersededByRunId: null,
        status: "succeeded",
      },
      select: { id: true },
    });
    if (!run) throw notFound("媒体分析结果不存在。");
    const rows = await this.prisma.mediaAnalysisAsset.findMany({
      where: {
        runId: run.id,
        kind: options.kind,
        preset: options.preset,
        ...(options.level === undefined ? {} : { level: options.level }),
        startTime: { lt: options.endTime },
        endTime: { gt: options.startTime },
      },
      orderBy: [{ tileIndex: "asc" }, { id: "asc" }],
      take: 200,
    });
    return { runId: run.id, assets: rows.map(mapAssetDescriptor) };
  }

  async getAssetForRead(
    user: ApiUser,
    annotationFileId: string,
    assetId: string,
    audioTrackId: unknown,
  ) {
    const identity = await this.resolveReadableAnalysisIdentity(
      user,
      annotationFileId,
      audioTrackId,
    );
    const asset = await this.prisma.mediaAnalysisAsset.findFirst({
      where: {
        id: assetId,
        run: {
          sourceMediaResourceId: identity.mediaResourceId,
          mediaFingerprint: identity.mediaFingerprint,
          supersededByRunId: null,
          status: "succeeded",
        },
      },
      select: { storageKey: true, mimeType: true, size: true, checksum: true },
    });
    if (!asset) throw notFound("媒体分析资产不存在。");
    return {
      storageKey: asset.storageKey,
      mimeType: asset.mimeType,
      size: Number(asset.size),
      checksum: asset.checksum,
    };
  }

  /**
   * 批量读取只做一次文件 ACL 校验，但每个资产仍必须属于当前文件的同一个已完成 run。
   * 缺失、跨文件和跨 run 统一返回“批次不存在”，避免借接口探测其他资源的资产 ID。
   */
  async getAssetsForBatchRead(
    user: ApiUser,
    annotationFileId: string,
    runId: string,
    assetIds: readonly string[],
    audioTrackId: unknown,
  ) {
    const identity = await this.resolveReadableAnalysisIdentity(
      user,
      annotationFileId,
      audioTrackId,
    );
    if (
      !runId.trim() ||
      assetIds.length === 0 ||
      assetIds.length > MAX_MEDIA_ANALYSIS_BATCH_ASSETS ||
      assetIds.some((id) => !id.trim() || id !== id.trim() || id.length > 128) ||
      new Set(assetIds).size !== assetIds.length
    ) {
      throw badRequest("媒体分析批量读取参数不正确。");
    }

    const rows = await this.prisma.mediaAnalysisAsset.findMany({
      where: {
        id: { in: [...assetIds] },
        runId,
        run: {
          sourceMediaResourceId: identity.mediaResourceId,
          mediaFingerprint: identity.mediaFingerprint,
          supersededByRunId: null,
          status: "succeeded",
        },
      },
      select: {
        id: true,
        storageKey: true,
        size: true,
      },
    });
    if (rows.length !== assetIds.length) {
      throw notFound("媒体分析批次不存在。");
    }

    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const ordered = assetIds.map((id) => rowsById.get(id));
    if (ordered.some((row) => !row)) {
      throw notFound("媒体分析批次不存在。");
    }
    const totalBytes = ordered.reduce((sum, row) => sum + Number(row?.size ?? 0), 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_MEDIA_ANALYSIS_BATCH_BYTES) {
      throw badRequest("媒体分析批次总大小超过上限。");
    }
    return ordered as Array<NonNullable<(typeof ordered)[number]>>;
  }

  private async resolveAnalysisContext(
    user: ApiUser,
    annotationFileId: string,
    audioTrackId: string,
  ): Promise<AnalysisContext> {
    // 客户端只提供关系 ID，真实媒体、JobId、偏移和权限全部重读数据库。
    // 这样删除、禁用或撤权后，旧 runId 和浏览器缓存都不能绕过当前资源状态。
    const annotationFile = await this.prisma.annotationFile.findUnique({
      where: { resourceId: annotationFileId },
      select: { mediaResourceId: true },
    });
    if (!annotationFile) throw notFound("标注文件不存在。");

    if (!annotationFile.mediaResourceId) {
      return unavailableTrackAnalysisContext(
        audioTrackId,
        0,
        "analysis_source_missing",
      );
    }

    const track = await this.prisma.mediaAudioTrack.findFirst({
      where: {
        id: audioTrackId,
        primaryMediaResourceId: annotationFile.mediaResourceId,
        enabled: true,
      },
      include: analysisAudioTrackInclude,
    });
    if (!track) {
      return unavailableTrackAnalysisContext(
        audioTrackId,
        0,
        "analysis_source_invalid",
      );
    }

    // 外部音轨仍依赖主视频作为项目时钟，因此主媒体和真实音频来源都必须保持可读、可下载。
    const primaryPermission = await this.access.getEffectivePermission(
      user,
      track.primaryMediaResourceId,
    );
    if (!hasAnalysisReadAccess(primaryPermission.capabilities)) {
      return unavailableTrackAnalysisContext(
        audioTrackId,
        track.offsetSeconds,
        "analysis_audio_forbidden",
      );
    }

    let media: AnalysisMediaRow | null = null;
    let sourceVodRenditionJobId: string | null = null;
    let fingerprint: string | null = null;
    if (track.kind === "original") {
      media = track.primaryMedia;
      fingerprint = createMediaFingerprint(media);
    } else if (track.audioMediaResourceId && track.audioMedia) {
      media = track.audioMedia;
      if (media.mediaKind === "audio") fingerprint = createMediaFingerprint(media);
    } else if (
      track.vodRenditionMediaResourceId &&
      track.vodRenditionMedia &&
      track.vodRenditionJobId &&
      track.vodRenditionFormat === "mp3"
    ) {
      media = track.vodRenditionMedia;
      sourceVodRenditionJobId = track.vodRenditionJobId;
      if (media.sourceType === "aliyun_vod" && media.mediaKind === "video") {
        fingerprint = createMediaAnalysisSourceFingerprint({
          sourceType: "aliyun_vod_rendition",
          mediaResourceId: media.resourceId,
          region: media.aliyunVodRegion,
          videoId: media.aliyunVodVideoId,
          jobId: sourceVodRenditionJobId,
          format: "mp3",
        });
      }
    }

    if (!media || !isUsableAnalysisMedia(media) || !fingerprint) {
      return unavailableTrackAnalysisContext(
        audioTrackId,
        track.offsetSeconds,
        "analysis_source_invalid",
      );
    }
    const sourcePermission = await this.access.getEffectivePermission(user, media.resourceId);
    if (!hasAnalysisReadAccess(sourcePermission.capabilities)) {
      return unavailableTrackAnalysisContext(
        audioTrackId,
        track.offsetSeconds,
        "analysis_audio_forbidden",
      );
    }
    return {
      audioTrackId,
      source: {
        status: "ready",
        value: {
          offsetSeconds: track.offsetSeconds,
          media,
          mediaFingerprint: fingerprint,
          sourceVodRenditionJobId,
        },
      },
    };
  }

  private async resolveReadableAnalysisIdentity(
    user: ApiUser,
    annotationFileId: string,
    audioTrackId: unknown,
  ) {
    await this.assertActiveAnnotationFile(user, annotationFileId, "read");
    const context = await this.resolveAnalysisContext(
      user,
      annotationFileId,
      normalizeAudioTrackId(audioTrackId),
    );
    if (context.source.status !== "ready") {
      throw notFound("媒体分析结果不存在。");
    }
    return {
      mediaResourceId: context.source.value.media.resourceId,
      mediaFingerprint: context.source.value.mediaFingerprint,
    };
  }

  private async assertActiveAnnotationFile(
    user: ApiUser,
    annotationFileId: string,
    capability: "read" | "write",
  ) {
    await this.access.assertCapability(user, annotationFileId, capability);
    const resource = await this.prisma.resourceEntry.findUnique({
      where: { id: annotationFileId },
      select: { type: true, trashedAt: true, archivedAt: true, annotationFile: { select: { resourceId: true } } },
    });
    if (!resource?.annotationFile || resource.type !== "annotation_file") {
      throw notFound("标注文件不存在。");
    }
    if (resource.trashedAt || resource.archivedAt) {
      throw badRequest("请先恢复或取消归档标注文件，再管理分析音频。");
    }
  }

  private async mapRun(run: {
    id: string;
    status: ProcessingJobStatus;
    progress: number;
    errorCode: string | null;
    sourceMediaResourceId: string;
    sourceVodRenditionJobId: string | null;
    algorithmVersion: string;
    manifest: unknown;
    config: unknown;
    duration: number | null;
    sampleRate: number | null;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
  }, sourceOffsetSeconds: number): Promise<MediaAnalysisRunDto> {
    const groupedAssets = await this.prisma.mediaAnalysisAsset.groupBy({
      by: ["kind"],
      where: { runId: run.id },
      _count: { _all: true },
    });
    const assetCounts: Partial<Record<MediaAnalysisAssetKind, number>> = {};
    for (const item of groupedAssets) assetCounts[item.kind] = item._count._all;
    return {
      id: run.id,
      status: run.status,
      progress: run.progress,
      errorCode: run.errorCode,
      sourceMediaResourceId: run.sourceMediaResourceId,
      sourceVodRenditionJobId: run.sourceVodRenditionJobId,
      sourceOffsetSeconds,
      algorithmVersion: run.algorithmVersion,
      tileDurationSeconds: readTileDurationSeconds(run.manifest, run.config),
      duration: run.duration,
      sampleRate: run.sampleRate,
      assetCounts,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }
}

type ProcessingJobRequestDraft = {
  jobId: string;
  requesterUserId: string;
  contextResourceId: string;
  mediaAudioTrackId: string;
  clientRequestId: string;
  requestFingerprint: string;
};

/**
 * 同一账号在同一资源复用共享执行时只保留一个需求事实。
 * 不同 clientRequestId 的快速重复点击会复用该行；同一 clientRequestId 的精确重放已在事务入口优先处理。
 */
async function ensureProcessingJobRequest(
  transaction: Prisma.TransactionClient,
  draft: ProcessingJobRequestDraft,
) {
  const existing = await transaction.processingJobRequest.findUnique({
    where: {
      jobId_requesterUserId_contextResourceId: {
        jobId: draft.jobId,
        requesterUserId: draft.requesterUserId,
        contextResourceId: draft.contextResourceId,
      },
    },
  });
  const request = existing
    ? existing.mediaAudioTrackId
      ? existing
      : await transaction.processingJobRequest.update({
          where: { id: existing.id },
          // P1 历史需求没有可证明的音轨；再次经过完整来源校验时才补稳定外键，不能从旧审计 JSON 猜测。
          data: { mediaAudioTrackId: draft.mediaAudioTrackId },
        })
    : await transaction.processingJobRequest.create({
        data: {
          jobId: draft.jobId,
          requesterUserId: draft.requesterUserId,
          contextResourceId: draft.contextResourceId,
          mediaAudioTrackId: draft.mediaAudioTrackId,
        },
      });
  // 即使业务需求已存在，也要保存当前标签页的幂等别名，保证它在任务终态变化后仍能精确重放。
  await transaction.processingJobRequestKey.create({
    data: {
      requestId: request.id,
      requesterUserId: draft.requesterUserId,
      clientRequestId: draft.clientRequestId,
      requestFingerprint: draft.requestFingerprint,
    },
  });
  return { request, created: !existing };
}

type MediaAnalysisRequestAudit = {
  actorUserId: string;
  annotationFileId: string;
  audioTrackId: string;
  runId: string;
  jobId: string;
  requestId: string;
  sourceMediaResourceId: string;
  sourceVodRenditionJobId: string | null;
  force: boolean;
};

/** 审计只保存稳定标识和有限布尔语义，不能写入分析配置、临时 URL 或供应商响应。 */
async function createMediaAnalysisRequestAudit(
  transaction: Prisma.TransactionClient,
  input: MediaAnalysisRequestAudit,
) {
  await transaction.auditLog.create({
    data: {
      action: "media_analysis_create",
      actorUserId: input.actorUserId,
      resourceId: input.annotationFileId,
      detail: {
        runId: input.runId,
        jobId: input.jobId,
        requestId: input.requestId,
        sourceMediaResourceId: input.sourceMediaResourceId,
        audioTrackId: input.audioTrackId,
        sourceVodRenditionJobId: input.sourceVodRenditionJobId,
        force: input.force,
      },
    },
  });
}

function isUsableAnalysisMedia(media: AnalysisMediaRow): boolean {
  if (
    media.resource.type !== "media_file" ||
    media.resource.trashedAt ||
    media.resource.archivedAt
  ) return false;
  if (media.sourceType === "uploaded") {
    return Boolean(media.file && media.mimeType && media.size !== null);
  }
  return Boolean(media.aliyunVodVideoId && media.aliyunVodRegion);
}

function createMediaFingerprint(media: AnalysisMediaRow) {
  return createMediaAnalysisSourceFingerprint(
    media.sourceType === "uploaded"
      ? {
          sourceType: "uploaded",
          mediaResourceId: media.resourceId,
          fileId: media.file?.id ?? null,
          checksum: media.file?.checksum ?? null,
          size: media.file?.size ?? null,
        }
      : {
          sourceType: "aliyun_vod",
          mediaResourceId: media.resourceId,
          region: media.aliyunVodRegion,
          videoId: media.aliyunVodVideoId,
          duration: media.duration,
        },
  );
}

function hasAnalysisReadAccess(capabilities: readonly string[]) {
  return capabilities.includes("read") && capabilities.includes("download");
}

function unavailableTrackAnalysisContext(
  audioTrackId: string,
  offsetSeconds: number,
  code: Extract<ResolvedAnalysisAudioSource, { status: "unavailable" }>["code"],
): AnalysisContext {
  return {
    audioTrackId,
    source: {
      status: "unavailable",
      value: unavailableSource(offsetSeconds, code),
    },
  };
}

function normalizeAudioTrackId(value: unknown): string {
  if (!isStableMediaAudioIdentity(value)) {
    throw badRequest("分析音轨 ID 不正确。");
  }
  return value;
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unavailableSource(
  offsetSeconds: number,
  code: Extract<ResolvedAnalysisAudioSource, { status: "unavailable" }>["code"],
): Extract<ResolvedAnalysisAudioSource, { status: "unavailable" }> {
  return {
    status: "unavailable",
    code,
    offsetSeconds,
  };
}

function toResolvedSourceDto(context: AnalysisContext): ResolvedAnalysisAudioSource {
  if (context.source.status === "unavailable") return context.source.value;
  const source = context.source.value;
  return {
    status: "ready",
    mediaResourceId: source.media.resourceId,
    mediaName: source.media.resource.name,
    sourceType: source.media.sourceType,
    mediaKind: source.media.mediaKind,
    duration: source.media.duration,
    offsetSeconds: source.offsetSeconds,
  };
}

function requireReadySource(context: AnalysisContext) {
  if (context.source.status === "ready") return context.source.value;
  if (context.source.value.code === "analysis_audio_forbidden") {
    throw analysisAudioForbidden("当前账号不能读取或下载分析音频。");
  }
  throw analysisSourceMissing(
    context.source.value.code === "analysis_source_invalid"
      ? "当前分析音频已失效，请重新选择来源。"
      : "当前标注文件没有可用的分析音频。",
  );
}

function validateAssetListOptions(options: ListMediaAnalysisAssetsOptions) {
  if (!options.runId.trim() || !options.preset.trim()) {
    throw badRequest("分析资产查询缺少 run 或 preset。");
  }
  if (!(["waveform", "spectrogram", "pitch"] as string[]).includes(options.kind)) {
    throw badRequest("分析资产种类不正确。");
  }
  if (
    !Number.isFinite(options.startTime) ||
    !Number.isFinite(options.endTime) ||
    options.startTime < 0 ||
    options.endTime <= options.startTime
  ) throw badRequest("分析资产时间范围不正确。");
  if (
    options.level !== undefined &&
    (!Number.isInteger(options.level) || options.level < 0 || options.level > 32)
  ) throw badRequest("分析资产层级不正确。");
}

function mapAssetDescriptor(asset: {
  id: string;
  kind: MediaAnalysisAssetKind;
  preset: string;
  level: number;
  tileIndex: number;
  startTime: number;
  endTime: number;
  mimeType: string;
  size: bigint;
}): MediaAnalysisAssetDescriptor {
  return {
    id: asset.id,
    kind: asset.kind,
    preset: asset.preset,
    level: asset.level,
    tileIndex: asset.tileIndex,
    startTime: asset.startTime,
    endTime: asset.endTime,
    mimeType: asset.mimeType,
    size: Number(asset.size),
  };
}
