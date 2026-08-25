import { isStableMediaAudioIdentity } from "./mediaAudioTracks.js";

export const MEDIA_AUDIO_PLAYBACK_SESSION_VERSION = 1 as const;

type MediaAudioPlaybackSessionBase = {
  version: typeof MEDIA_AUDIO_PLAYBACK_SESSION_VERSION;
  annotationFileId: string;
  primaryMediaResourceId: string;
  trackId: string;
  audioMediaResourceId: string;
};

export type MediaAudioTrackPlaybackSession =
  | (MediaAudioPlaybackSessionBase & {
      sourceType: "uploaded";
      fileId: string;
      mimeType: string;
      duration: number | null;
    })
  | (MediaAudioPlaybackSessionBase & {
      sourceType: "aliyun_vod";
      videoId: string;
      region: string;
      playAuth: string;
      expiresAt: string;
      webPlayerLicense: {
        domain: string;
        key: string;
      };
    })
  | (MediaAudioPlaybackSessionBase & {
      sourceType: "aliyun_vod_rendition";
      videoId: string;
      region: string;
      jobId: string;
      url: string;
      mimeType: "audio/mpeg";
      duration: number | null;
      expiresAt: string;
      webPlayerLicense: {
        domain: string;
        key: string;
      };
    });

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_SESSION_SECRET_LENGTH = 32_768;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

type ValidSessionBaseRecord = Record<string, unknown> & {
  version: typeof MEDIA_AUDIO_PLAYBACK_SESSION_VERSION;
  annotationFileId: string;
  primaryMediaResourceId: string;
  trackId: string;
  audioMediaResourceId: string;
};

function hasValidBase(value: Record<string, unknown>): value is ValidSessionBaseRecord {
  return value.version === MEDIA_AUDIO_PLAYBACK_SESSION_VERSION &&
    isStableMediaAudioIdentity(value.annotationFileId) &&
    isStableMediaAudioIdentity(value.primaryMediaResourceId) &&
    isStableMediaAudioIdentity(value.trackId) &&
    isStableMediaAudioIdentity(value.audioMediaResourceId);
}

/**
 * 播放会话是短时安全边界：严格拒绝额外字段，防止 URL、token 或供应商响应被误带入长期状态。
 */
export function parseMediaAudioTrackPlaybackSession(
  value: unknown,
): MediaAudioTrackPlaybackSession | null {
  if (!isRecord(value) || !hasValidBase(value)) return null;
  if (value.sourceType === "uploaded") {
    if (
      Object.keys(value).length !== 9 ||
      !isStableMediaAudioIdentity(value.fileId) ||
      typeof value.mimeType !== "string" ||
      !value.mimeType.startsWith("audio/") ||
      value.mimeType.length > 200 ||
      (value.duration !== null &&
        (typeof value.duration !== "number" ||
          !Number.isFinite(value.duration) ||
          value.duration < 0))
    ) {
      return null;
    }
    return {
      version: MEDIA_AUDIO_PLAYBACK_SESSION_VERSION,
      annotationFileId: value.annotationFileId,
      primaryMediaResourceId: value.primaryMediaResourceId,
      trackId: value.trackId,
      audioMediaResourceId: value.audioMediaResourceId,
      sourceType: "uploaded",
      fileId: value.fileId,
      mimeType: value.mimeType,
      duration: value.duration,
    };
  }
  if (value.sourceType === "aliyun_vod_rendition") {
    if (
      Object.keys(value).length !== 14 ||
      !isStableMediaAudioIdentity(value.videoId) ||
      !isStableMediaAudioIdentity(value.region) ||
      !isStableMediaAudioIdentity(value.jobId) ||
      typeof value.url !== "string" ||
      !isSecureHttpsUrl(value.url) ||
      value.mimeType !== "audio/mpeg" ||
      (value.duration !== null &&
        (typeof value.duration !== "number" ||
          !Number.isFinite(value.duration) ||
          value.duration < 0)) ||
      !isStrictIsoTimestamp(value.expiresAt) ||
      !isWebPlayerLicense(value.webPlayerLicense)
    ) {
      return null;
    }
    return {
      version: MEDIA_AUDIO_PLAYBACK_SESSION_VERSION,
      annotationFileId: value.annotationFileId,
      primaryMediaResourceId: value.primaryMediaResourceId,
      trackId: value.trackId,
      audioMediaResourceId: value.audioMediaResourceId,
      sourceType: "aliyun_vod_rendition",
      videoId: value.videoId,
      region: value.region,
      jobId: value.jobId,
      url: value.url,
      mimeType: "audio/mpeg",
      duration: value.duration,
      expiresAt: value.expiresAt,
      webPlayerLicense: value.webPlayerLicense,
    };
  }
  if (value.sourceType !== "aliyun_vod" || Object.keys(value).length !== 11) {
    return null;
  }
  if (
    !isStableMediaAudioIdentity(value.videoId) ||
    !isStableMediaAudioIdentity(value.region) ||
    typeof value.playAuth !== "string" ||
    value.playAuth.length < 1 ||
    value.playAuth.length > MAX_SESSION_SECRET_LENGTH ||
    !isStrictIsoTimestamp(value.expiresAt) ||
    !isWebPlayerLicense(value.webPlayerLicense)
  ) {
    return null;
  }
  return {
    version: MEDIA_AUDIO_PLAYBACK_SESSION_VERSION,
    annotationFileId: value.annotationFileId,
    primaryMediaResourceId: value.primaryMediaResourceId,
    trackId: value.trackId,
    audioMediaResourceId: value.audioMediaResourceId,
    sourceType: "aliyun_vod",
    videoId: value.videoId,
    region: value.region,
    playAuth: value.playAuth,
    expiresAt: value.expiresAt,
    webPlayerLicense: {
      domain: value.webPlayerLicense.domain,
      key: value.webPlayerLicense.key,
    },
  };
}

function isWebPlayerLicense(value: unknown): value is {
  domain: string;
  key: string;
} {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.domain === "string" &&
    value.domain.trim().length >= 1 &&
    value.domain.length <= 253 &&
    typeof value.key === "string" &&
    value.key.trim().length >= 1 &&
    value.key.length <= MAX_SESSION_SECRET_LENGTH;
}

function isSecureHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
