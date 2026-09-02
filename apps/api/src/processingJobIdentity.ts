import { createHash } from "node:crypto";
import { conflict } from "./errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type MediaAnalysisJobIdentity = {
  sourceMediaResourceId: string;
  mediaFingerprint: string;
  sourceVodRenditionJobId: string | null;
  algorithmVersion: string;
  configHash: string;
};

/** 客户端请求编号只承担幂等身份，不接受任意长字符串或含糊的自定义格式。 */
export function isValidProcessingJobClientRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * 媒体分析执行键只包含会改变持久分析结果的稳定事实。
 * 长度前缀避免字段边界碰撞，并与无 pgcrypto 依赖的 PostgreSQL 历史回填保持一致。
 */
export function createMediaAnalysisJobDeduplicationKey(identity: MediaAnalysisJobIdentity) {
  return `media-analysis:v1:${[
    identity.sourceMediaResourceId,
    identity.mediaFingerprint,
    identity.sourceVodRenditionJobId ?? "",
    identity.algorithmVersion,
    identity.configHash,
  ].map(encodeIdentitySegment).join(":")}`;
}

/**
 * request 指纹绑定用户本次操作的稳定语义；它不会进入公开 DTO，也不包含媒体 URL、凭据或完整配置。
 */
export function createMediaAnalysisRequestFingerprint(input: {
  deduplicationKey: string;
  contextResourceId: string;
  audioTrackId: string;
  force: boolean;
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      deduplicationKey: input.deduplicationKey,
      contextResourceId: input.contextResourceId,
      audioTrackId: input.audioTrackId,
      force: input.force,
    }))
    .digest("hex");
}

/** 强制对齐请求指纹只绑定已重读的执行身份和使用上下文，不复制正文、模型配置或媒体 URL。 */
export function createForceAlignmentRequestFingerprint(input: {
  deduplicationKey: string;
  contextResourceId: string;
  audioTrackId: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      type: "force_alignment",
      deduplicationKey: input.deduplicationKey,
      contextResourceId: input.contextResourceId,
      audioTrackId: input.audioTrackId,
    }))
    .digest("hex");
}

/** 同一 clientRequestId 不能被静默改绑到另一项任务或另一种 force 语义。 */
export function assertProcessingJobRequestMatch(
  storedFingerprint: string,
  expectedFingerprint: string,
) {
  if (storedFingerprint !== expectedFingerprint) {
    throw conflict("后台任务请求编号已用于另一项请求。", {
      code: "idempotency_conflict",
    });
  }
}

function encodeIdentitySegment(value: string) {
  return `${value.length}:${value}`;
}
