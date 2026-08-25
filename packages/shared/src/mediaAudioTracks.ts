import type { MediaSourceType } from "./platform.js";

export const MEDIA_AUDIO_TRACK_KINDS = [
  "original",
  "vocal",
  "accompaniment",
  "denoised",
  "reference",
  "custom",
] as const;

export type MediaAudioTrackKind = (typeof MEDIA_AUDIO_TRACK_KINDS)[number];

export const MEDIA_AUDIO_TRACK_ANALYSIS_STATUSES = [
  "not_analyzed",
  "queued",
  "processing",
  "ready",
  "failed",
] as const;

export type MediaAudioTrackAnalysisStatus =
  (typeof MEDIA_AUDIO_TRACK_ANALYSIS_STATUSES)[number];

export const MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH = 120;
export const MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA = 64;
export const MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS = 86_400;
export const MAX_VOD_AUDIO_RENDITION_DEFINITION_LENGTH = 32;

export type AliyunVodAudioRendition = {
  jobId: string;
  format: "mp3";
  definition: string | null;
  bitrate: number | null;
  duration: number | null;
};

export type AliyunVodAudioRenditionList = {
  mediaResourceId: string;
  renditions: AliyunVodAudioRendition[];
};

export type MediaAudioTrackSource =
  | { type: "embedded_original"; sourceType: MediaSourceType }
  | {
      type: "media_resource";
      mediaResourceId: string;
      sourceType: MediaSourceType;
    }
  | {
      type: "aliyun_vod_rendition";
      mediaResourceId: string;
      sourceType: "aliyun_vod";
      rendition: AliyunVodAudioRendition;
    };

export type MediaAudioTrackAnalysisSummary =
  | { status: "not_analyzed" }
  | { status: "queued" | "processing"; runId: string; progress: number }
  | { status: "ready"; runId: string }
  | { status: "failed"; runId: string; errorCode: string };

export type MediaAudioTrackRecord = {
  id: string;
  primaryMediaResourceId: string;
  name: string;
  kind: MediaAudioTrackKind;
  source: MediaAudioTrackSource;
  offsetSeconds: number;
  sortOrder: number;
  enabled: boolean;
};

export type AnnotationAudioPreference = {
  annotationFileId: string;
  defaultAudioTrackId: string | null;
  updatedByAccountId: string | null;
  updatedAt: string | null;
};

export const MEDIA_AUDIO_TRACK_AVAILABILITIES = [
  "available",
  "disabled",
  "permission_denied",
  "source_unavailable",
  "invalid_source",
] as const;

export type MediaAudioTrackAvailability =
  (typeof MEDIA_AUDIO_TRACK_AVAILABILITIES)[number];

export type AnnotationAudioPlaybackTrackOption = {
  track: MediaAudioTrackRecord;
  availability: MediaAudioTrackAvailability;
};

/** 标注文件上下文的一次可试听快照；它不包含播放地址或短时凭据。 */
export type AnnotationAudioPlaybackOptions = {
  annotationFileId: string;
  primaryMediaResourceId: string;
  defaultAudioTrackId: string | null;
  canManageTracks: boolean;
  tracks: AnnotationAudioPlaybackTrackOption[];
};

const MAX_STABLE_ID_LENGTH = 200;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// 媒体、音轨和账号身份会跨数据库、API 与浏览器缓存流转；控制字符或空白身份不能进入后续关联键。
export function isStableMediaAudioIdentity(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_STABLE_ID_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isMediaAudioTrackKind(value: unknown): value is MediaAudioTrackKind {
  return typeof value === "string" &&
    MEDIA_AUDIO_TRACK_KINDS.includes(value as MediaAudioTrackKind);
}

function isMediaSourceType(value: unknown): value is MediaSourceType {
  return value === "uploaded" || value === "aliyun_vod";
}

function isMediaAudioTrackAvailability(
  value: unknown,
): value is MediaAudioTrackAvailability {
  return typeof value === "string" &&
    MEDIA_AUDIO_TRACK_AVAILABILITIES.includes(value as MediaAudioTrackAvailability);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseMediaAudioTrackSource(value: unknown): MediaAudioTrackSource | null {
  if (!isRecord(value)) return null;
  if (value.type === "embedded_original" && isMediaSourceType(value.sourceType)) {
    return Object.keys(value).length === 2
      ? { type: "embedded_original", sourceType: value.sourceType }
      : null;
  }
  if (
    value.type === "media_resource" &&
    Object.keys(value).length === 3 &&
    isStableMediaAudioIdentity(value.mediaResourceId) &&
    isMediaSourceType(value.sourceType)
  ) {
    return {
      type: "media_resource",
      mediaResourceId: value.mediaResourceId,
      sourceType: value.sourceType,
    };
  }
  if (
    value.type === "aliyun_vod_rendition" &&
    Object.keys(value).length === 4 &&
    isStableMediaAudioIdentity(value.mediaResourceId) &&
    value.sourceType === "aliyun_vod"
  ) {
    const rendition = parseAliyunVodAudioRendition(value.rendition);
    return rendition
      ? {
          type: "aliyun_vod_rendition",
          mediaResourceId: value.mediaResourceId,
          sourceType: "aliyun_vod",
          rendition,
        }
      : null;
  }
  return null;
}

export function parseAliyunVodAudioRendition(
  value: unknown,
): AliyunVodAudioRendition | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    !isStableMediaAudioIdentity(value.jobId) ||
    value.format !== "mp3" ||
    (value.definition !== null &&
      (typeof value.definition !== "string" ||
        value.definition.length < 1 ||
        value.definition.length > MAX_VOD_AUDIO_RENDITION_DEFINITION_LENGTH)) ||
    !isOptionalNonNegativeFiniteNumber(value.bitrate) ||
    !isOptionalNonNegativeFiniteNumber(value.duration)
  ) {
    return null;
  }
  return {
    jobId: value.jobId,
    format: "mp3",
    definition: value.definition,
    bitrate: value.bitrate,
    duration: value.duration,
  };
}

export function parseAliyunVodAudioRenditionList(
  value: unknown,
): AliyunVodAudioRenditionList | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !isStableMediaAudioIdentity(value.mediaResourceId) ||
    !Array.isArray(value.renditions) ||
    value.renditions.length > MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA
  ) {
    return null;
  }
  const renditions: AliyunVodAudioRendition[] = [];
  const jobIds = new Set<string>();
  for (const candidate of value.renditions) {
    const rendition = parseAliyunVodAudioRendition(candidate);
    if (!rendition || jobIds.has(rendition.jobId)) return null;
    jobIds.add(rendition.jobId);
    renditions.push(rendition);
  }
  return { mediaResourceId: value.mediaResourceId, renditions };
}

function isOptionalNonNegativeFiniteNumber(value: unknown): value is number | null {
  return value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

// 严格解析持久音轨记录，确保“视频原声”和“独立音频资源”不会形成互相矛盾的关系。
export function parseMediaAudioTrackRecord(
  value: unknown,
): MediaAudioTrackRecord | null {
  if (!isRecord(value) || Object.keys(value).length !== 8) return null;
  const source = parseMediaAudioTrackSource(value.source);
  if (
    !isStableMediaAudioIdentity(value.id) ||
    !isStableMediaAudioIdentity(value.primaryMediaResourceId) ||
    typeof value.name !== "string" ||
    value.name !== value.name.trim() ||
    value.name.length < 1 ||
    value.name.length > MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH ||
    !isMediaAudioTrackKind(value.kind) ||
    !source ||
    typeof value.offsetSeconds !== "number" ||
    !Number.isFinite(value.offsetSeconds) ||
    Math.abs(value.offsetSeconds) > MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS ||
    typeof value.sortOrder !== "number" ||
    !Number.isInteger(value.sortOrder) ||
    value.sortOrder < 0 ||
    value.sortOrder >= MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA ||
    typeof value.enabled !== "boolean"
  ) {
    return null;
  }

  // 内嵌原声固定属于主媒体且从零点开始；其他类型必须引用一份独立媒体资源。
  if (
    (value.kind === "original" &&
      (source.type !== "embedded_original" || value.offsetSeconds !== 0)) ||
    (value.kind !== "original" && source.type === "embedded_original")
  ) {
    return null;
  }

  return {
    id: value.id,
    primaryMediaResourceId: value.primaryMediaResourceId,
    name: value.name,
    kind: value.kind,
    source,
    offsetSeconds: value.offsetSeconds,
    sortOrder: value.sortOrder,
    enabled: value.enabled,
  };
}

// 默认音轨是平台会话偏好，不属于标注 ProjectData；严格 DTO 防止服务器资源身份混入 JSON 文档。
export function parseAnnotationAudioPreference(
  value: unknown,
): AnnotationAudioPreference | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !isStableMediaAudioIdentity(value.annotationFileId) ||
    (value.defaultAudioTrackId !== null &&
      !isStableMediaAudioIdentity(value.defaultAudioTrackId)) ||
    (value.updatedByAccountId !== null &&
      !isStableMediaAudioIdentity(value.updatedByAccountId)) ||
    (value.updatedAt !== null && !isIsoTimestamp(value.updatedAt)) ||
    ((value.updatedByAccountId === null) !== (value.updatedAt === null))
  ) {
    return null;
  }
  return {
    annotationFileId: value.annotationFileId,
    defaultAudioTrackId: value.defaultAudioTrackId,
    updatedByAccountId: value.updatedByAccountId,
    updatedAt: value.updatedAt,
  };
}

// 选项快照严格绑定标注文件、主媒体和有序音轨，避免迟到响应或坏 DTO 把另一媒体的音轨接入播放器。
export function parseAnnotationAudioPlaybackOptions(
  value: unknown,
): AnnotationAudioPlaybackOptions | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    !isStableMediaAudioIdentity(value.annotationFileId) ||
    !isStableMediaAudioIdentity(value.primaryMediaResourceId) ||
    (value.defaultAudioTrackId !== null &&
      !isStableMediaAudioIdentity(value.defaultAudioTrackId)) ||
    typeof value.canManageTracks !== "boolean" ||
    !Array.isArray(value.tracks) ||
    value.tracks.length < 1 ||
    value.tracks.length > MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA
  ) {
    return null;
  }

  const tracks: AnnotationAudioPlaybackTrackOption[] = [];
  const ids = new Set<string>();
  let originalCount = 0;
  for (const [index, optionValue] of value.tracks.entries()) {
    if (
      !isRecord(optionValue) ||
      Object.keys(optionValue).length !== 2 ||
      !isMediaAudioTrackAvailability(optionValue.availability)
    ) {
      return null;
    }
    const track = parseMediaAudioTrackRecord(optionValue.track);
    if (
      !track ||
      track.primaryMediaResourceId !== value.primaryMediaResourceId ||
      track.sortOrder !== index ||
      ids.has(track.id)
    ) {
      return null;
    }
    ids.add(track.id);
    if (track.kind === "original") originalCount += 1;
    tracks.push({ track, availability: optionValue.availability });
  }
  if (
    originalCount !== 1 ||
    (value.defaultAudioTrackId !== null && !ids.has(value.defaultAudioTrackId))
  ) {
    return null;
  }
  return {
    annotationFileId: value.annotationFileId,
    primaryMediaResourceId: value.primaryMediaResourceId,
    defaultAudioTrackId: value.defaultAudioTrackId,
    canManageTracks: value.canManageTracks,
    tracks,
  };
}
