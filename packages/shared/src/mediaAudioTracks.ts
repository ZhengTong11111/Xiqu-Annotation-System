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

export type MediaAudioTrackSource =
  | { type: "embedded_original"; sourceType: MediaSourceType }
  | {
      type: "media_resource";
      mediaResourceId: string;
      sourceType: MediaSourceType;
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
  return null;
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
    (value.kind !== "original" && source.type !== "media_resource")
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
