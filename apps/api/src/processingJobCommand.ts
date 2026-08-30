import { createHash } from "node:crypto";
import type {
  ProcessingJobCommandAction,
  ProcessingJobCommandOutcome,
} from "@prisma/client";
import type { ProcessingJobCommandResult } from "@xiqu/shared";
import { badRequest, conflict } from "./errors.js";

const MAX_CANCELLATION_REASON_LENGTH = 500;

export type ProcessingJobCommandFingerprintInput = {
  action: ProcessingJobCommandAction;
  targetJobId: string | null;
  targetRequestId: string | null;
  reason: string | null;
};

/** 用户可见原因只保留有限纯文本；空白等同于未填写，避免制造无意义的幂等差异。 */
export function normalizeProcessingJobCancellationReason(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest("取消原因必须是文字。");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > MAX_CANCELLATION_REASON_LENGTH) {
    throw badRequest(`取消原因不能超过 ${MAX_CANCELLATION_REASON_LENGTH} 个字符。`);
  }
  return normalized;
}

/** 命令指纹绑定动作、目标与规范化原因，不包含任务内部执行键或媒体来源。 */
export function createProcessingJobCommandFingerprint(
  input: ProcessingJobCommandFingerprintInput,
) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...input }))
    .digest("hex");
}

export function assertProcessingJobCommandMatch(
  storedFingerprint: string,
  expectedFingerprint: string,
) {
  if (storedFingerprint !== expectedFingerprint) {
    throw conflict("后台任务命令编号已用于另一项操作。", {
      code: "idempotency_conflict",
    });
  }
}

/**
 * retry 内部分析请求使用服务端派生 UUID，与浏览器原始分析请求编号隔离。
 * UUID v8 只承担稳定幂等身份，不用于凭据、授权或不可预测令牌。
 */
export function createProcessingJobRetryClientRequestId(
  actorUserId: string,
  clientCommandId: string,
) {
  const bytes = createHash("sha256")
    .update(`xiqu:processing-job-retry:v1:${actorUserId}:${clientCommandId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function mapProcessingJobCommandResult(command: {
  id: string;
  outcome: ProcessingJobCommandOutcome;
  targetRequestId: string | null;
  targetJobId: string | null;
  resultJobId: string | null;
}): ProcessingJobCommandResult {
  if (command.outcome === "pending") {
    throw conflict("后台任务命令仍在执行，请稍后重试。", {
      code: "processing_job_command_pending",
    });
  }
  const jobId = command.targetJobId ?? command.resultJobId;
  if (!jobId) {
    throw conflict("后台任务命令缺少结果任务。", {
      code: "processing_job_command_result_missing",
    });
  }
  return {
    commandId: command.id,
    outcome: command.outcome,
    requestId: command.targetRequestId,
    jobId,
    resultJobId: command.resultJobId,
  };
}
