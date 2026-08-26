import { createHash } from "node:crypto";
import { isStableMediaAudioIdentity } from "@xiqu/shared";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";

export type MediaAnalysisFingerprintSource =
  | {
      sourceType: "uploaded";
      mediaResourceId: string;
      fileId: string | null;
      checksum: string | null;
      size: bigint | null;
    }
  | {
      sourceType: "aliyun_vod";
      mediaResourceId: string;
      region: string | null;
      videoId: string | null;
      duration: number | null;
    }
  | {
      sourceType: "aliyun_vod_rendition";
      mediaResourceId: string;
      region: string | null;
      videoId: string | null;
      jobId: string | null;
      format: "mp3" | null;
    };

// 媒体级 fingerprint 只描述可分析内容；标注文件、选择模式和时间偏移没有输入位置。
export function createMediaAnalysisSourceFingerprint(
  source: MediaAnalysisFingerprintSource,
): string | null {
  if (!source.mediaResourceId.trim()) return null;
  if (source.sourceType === "uploaded") {
    if (
      !source.fileId?.trim() ||
      !source.checksum ||
      !/^[a-f0-9]{64}$/u.test(source.checksum) ||
      source.size === null ||
      source.size < 0n
    ) return null;
    return hashIdentity({
      version: 1,
      sourceType: source.sourceType,
      mediaResourceId: source.mediaResourceId,
      fileId: source.fileId,
      checksum: source.checksum,
      size: source.size.toString(),
    });
  }
  if (source.sourceType === "aliyun_vod" && (
    !source.region?.trim() ||
    !source.videoId?.trim() ||
    source.duration === null ||
    !Number.isFinite(source.duration) ||
    source.duration < 0
  )) return null;
  if (source.sourceType === "aliyun_vod") {
    return hashIdentity({
      version: 1,
      sourceType: source.sourceType,
      mediaResourceId: source.mediaResourceId,
      region: source.region,
      videoId: source.videoId,
      duration: source.duration,
    });
  }
  if (
    !source.region?.trim() ||
    !source.videoId?.trim() ||
    !isStableMediaAudioIdentity(source.jobId) ||
    source.format !== "mp3"
  ) return null;
  // rendition 使用 JobId 区分同一 VOD 下的稳定音频流；显示名称、码率和临时 URL 都不改变内容身份。
  return hashIdentity({
    version: 2,
    sourceType: source.sourceType,
    mediaResourceId: source.mediaResourceId,
    region: source.region,
    videoId: source.videoId,
    jobId: source.jobId,
    format: source.format,
  });
}

function hashIdentity(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}
