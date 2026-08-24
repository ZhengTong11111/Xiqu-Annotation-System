import { isStableMediaAudioIdentity } from "./mediaAudioTracks.js";

export type MediaAnalysisRunIdentity = {
  mediaResourceId: string;
  sourceFingerprint: string;
  algorithmVersion: string;
  configHash: string;
};

const MAX_SOURCE_FINGERPRINT_LENGTH = 512;
const MAX_ALGORITHM_VERSION_LENGTH = 128;
const MAX_CONFIG_HASH_LENGTH = 256;

function isBoundedIdentityPart(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

// 分析复用身份只由媒体内容和算法配置构成；标注文件、来源模式与时间偏移没有输入位置。
export function parseMediaAnalysisRunIdentity(
  value: unknown,
): MediaAnalysisRunIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 4 ||
    !isStableMediaAudioIdentity(input.mediaResourceId) ||
    !isBoundedIdentityPart(input.sourceFingerprint, MAX_SOURCE_FINGERPRINT_LENGTH) ||
    !isBoundedIdentityPart(input.algorithmVersion, MAX_ALGORITHM_VERSION_LENGTH) ||
    !isBoundedIdentityPart(input.configHash, MAX_CONFIG_HASH_LENGTH)
  ) {
    return null;
  }
  return {
    mediaResourceId: input.mediaResourceId,
    sourceFingerprint: input.sourceFingerprint,
    algorithmVersion: input.algorithmVersion,
    configHash: input.configHash,
  };
}

// JSON 元组保留每个字段边界，避免允许冒号等字符的身份通过字符串拼接产生碰撞。
export function serializeMediaAnalysisRunIdentity(
  identity: MediaAnalysisRunIdentity,
): string {
  return JSON.stringify([
    identity.mediaResourceId,
    identity.sourceFingerprint,
    identity.algorithmVersion,
    identity.configHash,
  ]);
}
