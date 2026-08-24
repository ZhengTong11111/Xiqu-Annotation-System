import { createHash } from "node:crypto";
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
  if (
    !source.region?.trim() ||
    !source.videoId?.trim() ||
    source.duration === null ||
    !Number.isFinite(source.duration) ||
    source.duration < 0
  ) return null;
  return hashIdentity({
    version: 1,
    sourceType: source.sourceType,
    mediaResourceId: source.mediaResourceId,
    region: source.region,
    videoId: source.videoId,
    duration: source.duration,
  });
}

function hashIdentity(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}
