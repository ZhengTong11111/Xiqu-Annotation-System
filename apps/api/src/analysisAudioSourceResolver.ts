import { Prisma, type PrismaClient } from "@prisma/client";
import type { ResolvedAnalysisAudioSource } from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { createMediaAnalysisSourceFingerprint } from "./mediaAnalysisSourceFingerprint.js";
import type { ResourceAccessService } from "./resourceAccess.js";

export type AnalysisMediaRow = {
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
  file: { id: string; storageKey: string; checksum: string | null; size: bigint } | null;
};

export type ReadyAnalysisAudioSource = {
  offsetSeconds: number;
  media: AnalysisMediaRow;
  mediaFingerprint: string;
  sourceVodRenditionJobId: string | null;
};

export type AnalysisAudioContext = {
  audioTrackId: string;
  source:
    | { status: "ready"; value: ReadyAnalysisAudioSource }
    | { status: "unavailable"; value: Extract<ResolvedAnalysisAudioSource, { status: "unavailable" }> };
};

const analysisMediaInclude = {
  resource: { select: { name: true, type: true, archivedAt: true, trashedAt: true } },
  file: { select: { id: true, storageKey: true, checksum: true, size: true } },
} satisfies Prisma.MediaFileInclude;

const analysisAudioTrackInclude = {
  primaryMedia: { include: analysisMediaInclude },
  audioMedia: { include: analysisMediaInclude },
  vodRenditionMedia: { include: analysisMediaInclude },
} satisfies Prisma.MediaAudioTrackInclude;

/**
 * 从当前数据库事实解析一条可分析音轨。调用方只提供关系 ID；媒体、VOD rendition、偏移与 ACL 都在这里重读。
 * database 可传事务客户端，使强制对齐能把文件 revision、正文投影和音频身份锁在同一个创建事务内。
 */
export async function resolveAnalysisAudioContext(
  database: PrismaClient | Prisma.TransactionClient,
  access: ResourceAccessService,
  user: ApiUser,
  annotationFileId: string,
  audioTrackId: string,
): Promise<AnalysisAudioContext> {
  const annotationFile = await database.annotationFile.findUnique({
    where: { resourceId: annotationFileId },
    select: { mediaResourceId: true },
  });
  if (!annotationFile) return unavailableContext(audioTrackId, 0, "analysis_source_missing");
  if (!annotationFile.mediaResourceId) {
    return unavailableContext(audioTrackId, 0, "analysis_source_missing");
  }

  const track = await database.mediaAudioTrack.findFirst({
    where: {
      id: audioTrackId,
      primaryMediaResourceId: annotationFile.mediaResourceId,
      enabled: true,
    },
    include: analysisAudioTrackInclude,
  });
  if (!track) return unavailableContext(audioTrackId, 0, "analysis_source_invalid");

  // 外部音轨仍以主视频为项目时钟，所以主媒体与真实音频来源都必须同时可读、可下载。
  const primaryPermission = await access.getEffectivePermission(
    user,
    track.primaryMediaResourceId,
    database,
  );
  if (!hasAnalysisReadAccess(primaryPermission.capabilities)) {
    return unavailableContext(audioTrackId, track.offsetSeconds, "analysis_audio_forbidden");
  }

  let media: AnalysisMediaRow | null = null;
  let sourceVodRenditionJobId: string | null = null;
  let mediaFingerprint: string | null = null;
  if (track.kind === "original") {
    media = track.primaryMedia;
    mediaFingerprint = createMediaFingerprint(media);
  } else if (track.audioMediaResourceId && track.audioMedia?.mediaKind === "audio") {
    media = track.audioMedia;
    mediaFingerprint = createMediaFingerprint(media);
  } else if (
    track.vodRenditionMediaResourceId &&
    track.vodRenditionMedia &&
    track.vodRenditionJobId &&
    track.vodRenditionFormat === "mp3"
  ) {
    media = track.vodRenditionMedia;
    sourceVodRenditionJobId = track.vodRenditionJobId;
    if (media.sourceType === "aliyun_vod" && media.mediaKind === "video") {
      mediaFingerprint = createMediaAnalysisSourceFingerprint({
        sourceType: "aliyun_vod_rendition",
        mediaResourceId: media.resourceId,
        region: media.aliyunVodRegion,
        videoId: media.aliyunVodVideoId,
        jobId: sourceVodRenditionJobId,
        format: "mp3",
      });
    }
  }
  if (!media || !isUsableAnalysisMedia(media) || !mediaFingerprint) {
    return unavailableContext(audioTrackId, track.offsetSeconds, "analysis_source_invalid");
  }

  const sourcePermission = await access.getEffectivePermission(user, media.resourceId, database);
  if (!hasAnalysisReadAccess(sourcePermission.capabilities)) {
    return unavailableContext(audioTrackId, track.offsetSeconds, "analysis_audio_forbidden");
  }
  return {
    audioTrackId,
    source: {
      status: "ready",
      value: { offsetSeconds: track.offsetSeconds, media, mediaFingerprint, sourceVodRenditionJobId },
    },
  };
}

function isUsableAnalysisMedia(media: AnalysisMediaRow) {
  if (media.resource.type !== "media_file" || media.resource.trashedAt || media.resource.archivedAt) return false;
  if (media.sourceType === "uploaded") return Boolean(media.file && media.mimeType && media.size !== null);
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

function unavailableContext(
  audioTrackId: string,
  offsetSeconds: number,
  code: Extract<ResolvedAnalysisAudioSource, { status: "unavailable" }>["code"],
): AnalysisAudioContext {
  return { audioTrackId, source: { status: "unavailable", value: { status: "unavailable", code, offsetSeconds } } };
}
