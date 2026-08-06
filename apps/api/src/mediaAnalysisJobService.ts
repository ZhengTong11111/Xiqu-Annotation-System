import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AnalysisAudioMode,
  AnnotationMediaAnalysisStatus,
  AnalysisAudioSetting,
  CreateMediaAnalysisRequest,
  MediaAnalysisAssetKind,
  MediaAnalysisAssetDescriptor,
  ListMediaAnalysisAssetsOptions,
  MediaAnalysisRun as MediaAnalysisRunDto,
  ResolvedAnalysisAudioSource,
  UpdateAnalysisAudioRequest,
} from "@xiqu/shared";
import {
  MAX_MEDIA_ANALYSIS_BATCH_ASSETS,
  MAX_MEDIA_ANALYSIS_BATCH_BYTES,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import {
  analysisAudioForbidden,
  analysisSourceMissing,
  badRequest,
  notFound,
} from "./errors.js";
import { ResourceAccessService } from "./resourceAccess.js";
import {
  MEDIA_ANALYSIS_SPECTROGRAM_PRESETS,
  MEDIA_ANALYSIS_TILE_DURATION_SECONDS,
  MEDIA_ANALYSIS_WAVEFORM_LEVELS,
} from "./mediaAnalysisComputation.js";

const MAX_ANALYSIS_AUDIO_OFFSET_SECONDS = 24 * 60 * 60;
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
  mode: AnalysisAudioMode;
  offsetSeconds: number;
  media: AnalysisMediaRow;
  fingerprint: string;
};

type AnalysisContext = {
  setting: AnalysisAudioSetting;
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

/**
 * 媒体分析业务服务是设置、来源解析、run/job 去重和公开 DTO 的唯一边界。
 * worker 后续只消费这里固化的 run 身份，不能自行重新解释用户设置。
 */
export class MediaAnalysisJobService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async getStatus(
    user: ApiUser,
    annotationFileId: string,
  ): Promise<AnnotationMediaAnalysisStatus> {
    await this.assertActiveAnnotationFile(user, annotationFileId, "read");
    const context = await this.resolveAnalysisContext(user, annotationFileId);
    const currentRun = context.source.status === "ready"
      ? await this.prisma.mediaAnalysisRun.findUnique({
          where: {
            annotationFileId_sourceFingerprint_algorithmVersion_configHash: {
              annotationFileId,
              sourceFingerprint: context.source.value.fingerprint,
              algorithmVersion: MEDIA_ANALYSIS_ALGORITHM_VERSION,
              configHash: MEDIA_ANALYSIS_CONFIG_HASH,
            },
          },
        })
      : null;
    return {
      setting: context.setting,
      resolvedSource: toResolvedSourceDto(context),
      currentRun: currentRun ? await this.mapRun(currentRun) : null,
    };
  }

  async updateAnalysisAudio(
    user: ApiUser,
    annotationFileId: string,
    input: UpdateAnalysisAudioRequest,
  ): Promise<AnnotationMediaAnalysisStatus> {
    const normalized = normalizeAnalysisAudioInput(input);
    await this.assertActiveAnnotationFile(user, annotationFileId, "write");

    // 设置保存前必须重新验证覆盖媒资和当前账号权限，选择器中的旧结果不能充当授权事实。
    if (
      normalized.mode === "media_override" &&
      normalized.overrideMediaResourceId !== null
    ) {
      await this.assertValidOverrideMedia(
        user,
        normalized.overrideMediaResourceId,
      );
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.annotationAnalysisAudioSetting.upsert({
        where: { annotationFileId },
        update: {
          mode: normalized.mode,
          overrideMediaResourceId: normalized.overrideMediaResourceId,
          offsetSeconds: normalized.offsetSeconds,
          updatedBy: user.id,
          validatedAt: new Date(),
        },
        create: {
          annotationFileId,
          mode: normalized.mode,
          overrideMediaResourceId: normalized.overrideMediaResourceId,
          offsetSeconds: normalized.offsetSeconds,
          updatedBy: user.id,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_analysis_audio_update",
          actorUserId: user.id,
          resourceId: annotationFileId,
          detail: {
            mode: normalized.mode,
            overrideMediaResourceId: normalized.overrideMediaResourceId,
            offsetSeconds: normalized.offsetSeconds,
          },
        },
      });
    });
    return this.getStatus(user, annotationFileId);
  }

  async createAnalysis(
    user: ApiUser,
    annotationFileId: string,
    input: CreateMediaAnalysisRequest,
  ): Promise<MediaAnalysisRunDto> {
    await this.assertActiveAnnotationFile(user, annotationFileId, "write");
    const context = await this.resolveAnalysisContext(user, annotationFileId);
    const source = requireReadySource(context);

    const run = await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.mediaAnalysisRun.findUnique({
        where: {
          annotationFileId_sourceFingerprint_algorithmVersion_configHash: {
            annotationFileId,
            sourceFingerprint: source.fingerprint,
            algorithmVersion: MEDIA_ANALYSIS_ALGORITHM_VERSION,
            configHash: MEDIA_ANALYSIS_CONFIG_HASH,
          },
        },
      });
      if (existing && !input.force && existing.status === "succeeded") {
        return existing;
      }

      const activeJob = existing
        ? await transaction.processingJob.findFirst({
            where: {
              analysisRunId: existing.id,
              status: { in: ["queued", "running"] },
            },
          })
        : null;
      if (existing && activeJob) return existing;

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
              annotationFileId,
              sourceMediaResourceId: source.media.resourceId,
              sourceMode: source.mode,
              sourceFingerprint: source.fingerprint,
              sourceOffsetSeconds: source.offsetSeconds,
              algorithmVersion: MEDIA_ANALYSIS_ALGORITHM_VERSION,
              configHash: MEDIA_ANALYSIS_CONFIG_HASH,
              config: MEDIA_ANALYSIS_CONFIG,
              createdBy: user.id,
            },
          });

      // 强制重算复用稳定 run id；旧资产必须由 worker 先删对象再删事实，API 不能制造失联对象。
      await transaction.processingJob.create({
        data: {
          type: "media_analysis",
          resourceId: annotationFileId,
          inputFileIds: source.media.file ? [source.media.file.id] : [],
          createdBy: user.id,
          analysisRunId: queuedRun.id,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "media_analysis_create",
          actorUserId: user.id,
          resourceId: annotationFileId,
          detail: {
            runId: queuedRun.id,
            sourceMode: source.mode,
            sourceMediaResourceId: source.media.resourceId,
            force: input.force === true,
          },
        },
      });
      return queuedRun;
    });
    return this.mapRun(run);
  }

  async listAssets(
    user: ApiUser,
    annotationFileId: string,
    options: ListMediaAnalysisAssetsOptions,
  ) {
    await this.assertActiveAnnotationFile(user, annotationFileId, "read");
    validateAssetListOptions(options);
    const run = await this.prisma.mediaAnalysisRun.findFirst({
      where: { id: options.runId, annotationFileId, status: "succeeded" },
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
  ) {
    await this.assertActiveAnnotationFile(user, annotationFileId, "read");
    const asset = await this.prisma.mediaAnalysisAsset.findFirst({
      where: {
        id: assetId,
        run: { annotationFileId, status: "succeeded" },
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
  ) {
    await this.assertActiveAnnotationFile(user, annotationFileId, "read");
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
        run: { annotationFileId, status: "succeeded" },
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
  ): Promise<AnalysisContext> {
    const annotationFile = await this.prisma.annotationFile.findUnique({
      where: { resourceId: annotationFileId },
      include: {
        mediaResource: { include: analysisMediaInclude },
        analysisAudioSetting: {
          include: { overrideMedia: { include: analysisMediaInclude } },
        },
      },
    });
    if (!annotationFile) throw notFound("标注文件不存在。");

    const setting: AnalysisAudioSetting = annotationFile.analysisAudioSetting
      ? {
          mode: annotationFile.analysisAudioSetting.mode,
          overrideMediaResourceId:
            annotationFile.analysisAudioSetting.overrideMediaResourceId,
          offsetSeconds: annotationFile.analysisAudioSetting.offsetSeconds,
          updatedAt: annotationFile.analysisAudioSetting.updatedAt.toISOString(),
        }
      : {
          mode: "auto",
          overrideMediaResourceId: null,
          offsetSeconds: 0,
          updatedAt: null,
        };
    const media = setting.mode === "media_override"
      ? annotationFile.analysisAudioSetting?.overrideMedia ?? null
      : annotationFile.mediaResource;
    if (!media) {
      return {
        setting,
        source: {
          status: "unavailable",
          value: unavailableSource(setting, "analysis_source_missing"),
        },
      };
    }

    const permission = await this.access.getEffectivePermission(user, media.resourceId);
    if (
      !permission.capabilities.includes("read") ||
      !permission.capabilities.includes("download")
    ) {
      return {
        setting,
        source: {
          status: "unavailable",
          value: unavailableSource(setting, "analysis_audio_forbidden"),
        },
      };
    }
    if (!isUsableAnalysisMedia(media, setting.mode)) {
      return {
        setting,
        source: {
          status: "unavailable",
          value: unavailableSource(setting, "analysis_source_invalid"),
        },
      };
    }
    return {
      setting,
      source: {
        status: "ready",
        value: {
          mode: setting.mode,
          offsetSeconds: setting.offsetSeconds,
          media,
          fingerprint: createSourceFingerprint(media, setting.offsetSeconds),
        },
      },
    };
  }

  private async assertValidOverrideMedia(user: ApiUser, mediaResourceId: string) {
    const permission = await this.access.getEffectivePermission(user, mediaResourceId);
    if (
      !permission.capabilities.includes("read") ||
      !permission.capabilities.includes("download")
    ) {
      throw analysisAudioForbidden("当前账号不能读取或下载所选分析音频。");
    }
    const media = await this.prisma.mediaFile.findUnique({
      where: { resourceId: mediaResourceId },
      include: analysisMediaInclude,
    });
    if (!media || !isUsableAnalysisMedia(media, "media_override")) {
      throw badRequest("所选资源不能作为分析音频。上传覆盖必须是音频，VOD 覆盖必须是有效媒资。");
    }
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
    status: "queued" | "running" | "succeeded" | "failed";
    progress: number;
    errorCode: string | null;
    sourceMediaResourceId: string;
    sourceMode: AnalysisAudioMode;
    sourceOffsetSeconds: number;
    algorithmVersion: string;
    duration: number | null;
    sampleRate: number | null;
    createdAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
  }): Promise<MediaAnalysisRunDto> {
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
      sourceMode: run.sourceMode,
      sourceOffsetSeconds: run.sourceOffsetSeconds,
      algorithmVersion: run.algorithmVersion,
      duration: run.duration,
      sampleRate: run.sampleRate,
      assetCounts,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }
}

function normalizeAnalysisAudioInput(input: UpdateAnalysisAudioRequest): {
  mode: AnalysisAudioMode;
  overrideMediaResourceId: string | null;
  offsetSeconds: number;
} {
  if (input.mode !== "auto" && input.mode !== "media_override") {
    throw badRequest("分析音频模式不正确。");
  }
  const offsetSeconds = input.offsetSeconds ?? 0;
  if (
    !Number.isFinite(offsetSeconds) ||
    Math.abs(offsetSeconds) > MAX_ANALYSIS_AUDIO_OFFSET_SECONDS
  ) {
    throw badRequest("分析音频偏移必须是正负 24 小时以内的有限秒数。");
  }
  const overrideMediaResourceId = typeof input.overrideMediaResourceId === "string"
    && input.overrideMediaResourceId.trim()
    ? input.overrideMediaResourceId.trim()
    : null;
  if (input.mode === "auto" && overrideMediaResourceId !== null) {
    throw badRequest("自动分析音频不能同时指定覆盖媒体。");
  }
  if (input.mode === "media_override" && overrideMediaResourceId === null) {
    throw badRequest("强制分析音频需要选择一个媒体资源。");
  }
  return { mode: input.mode, overrideMediaResourceId, offsetSeconds };
}

function isUsableAnalysisMedia(
  media: AnalysisMediaRow,
  mode: AnalysisAudioMode,
): boolean {
  if (
    media.resource.type !== "media_file" ||
    media.resource.trashedAt ||
    media.resource.archivedAt
  ) return false;
  // 用户强制选择本平台上传对象时只接受纯音频；这样可明确绕过 VOD 视频链路。
  if (mode === "media_override" && media.sourceType === "uploaded" && media.mediaKind !== "audio") {
    return false;
  }
  if (media.sourceType === "uploaded") {
    return Boolean(media.file && media.mimeType && media.size !== null);
  }
  return Boolean(media.aliyunVodVideoId && media.aliyunVodRegion);
}

function createSourceFingerprint(media: AnalysisMediaRow, offsetSeconds: number) {
  const stableIdentity = media.sourceType === "uploaded"
    ? {
        sourceType: media.sourceType,
        mediaResourceId: media.resourceId,
        fileId: media.file?.id,
        checksum: media.file?.checksum,
        size: media.file?.size.toString(),
      }
    : {
        sourceType: media.sourceType,
        mediaResourceId: media.resourceId,
        region: media.aliyunVodRegion,
        videoId: media.aliyunVodVideoId,
        duration: media.duration,
      };
  return stableHash({ stableIdentity, offsetSeconds });
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unavailableSource(
  setting: AnalysisAudioSetting,
  code: Extract<ResolvedAnalysisAudioSource, { status: "unavailable" }>["code"],
): Extract<ResolvedAnalysisAudioSource, { status: "unavailable" }> {
  return {
    status: "unavailable",
    mode: setting.mode,
    code,
    offsetSeconds: setting.offsetSeconds,
  };
}

function toResolvedSourceDto(context: AnalysisContext): ResolvedAnalysisAudioSource {
  if (context.source.status === "unavailable") return context.source.value;
  const source = context.source.value;
  return {
    status: "ready",
    mode: source.mode,
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
