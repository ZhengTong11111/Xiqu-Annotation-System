import type {
  CommitAnnotationCommandBatchResponse,
} from "@xiqu/shared";
import { PlatformApiError } from "../api/platformClient";
import {
  PLATFORM_MAINTENANCE_ERROR_CODE,
  PLATFORM_MAINTENANCE_SAVE_ERROR_MESSAGE,
} from "./platformMaintenanceSaveWarning";
import type { AtomicCommandPlan } from "./platformAtomicCommandPlan";

export type AtomicSubmitErrorClassification =
  | { status: "offline"; retryable: true; code: "offline"; message: string }
  | { status: "retryable"; retryable: true; code: string | null; message: string }
  | { status: "conflict"; retryable: false; code: string | null; message: string }
  | { status: "error"; retryable: false; code: string | null; message: string };

export type AtomicSubmitResponseValidation =
  | { status: "valid"; committedRevision: number }
  | {
      status: "invalid";
      reason:
        | "invalid_revision"
        | "invalid_cursor"
        | "operation_count_mismatch"
        | "operation_identity_mismatch"
        | "operation_commit_mismatch";
      operationIndex?: number;
    };

// 成功响应也是不可信网络输入；只有 revision 与整批 operation 确认完全匹配时才能推进本地 saved baseline。
export function validateAtomicSubmitResponse(
  plan: AtomicCommandPlan,
  response: CommitAnnotationCommandBatchResponse,
): AtomicSubmitResponseValidation {
  const expectedRevision = plan.request.baseRevision + 1;
  if (response.committedRevision !== expectedRevision) {
    return { status: "invalid", reason: "invalid_revision" };
  }
  if (typeof response.operationCursor !== "string" || response.operationCursor.length === 0) {
    return { status: "invalid", reason: "invalid_cursor" };
  }
  if (response.operations.length !== plan.request.operations.length) {
    return { status: "invalid", reason: "operation_count_mismatch" };
  }
  for (const [operationIndex, expected] of plan.request.operations.entries()) {
    const actual = response.operations[operationIndex];
    if (
      actual.clientOperationId !== expected.clientOperationId ||
      actual.baseRevision !== plan.request.baseRevision ||
      actual.localRevision !== (expected.localRevision ?? null) ||
      actual.action !== expected.action
    ) {
      return { status: "invalid", reason: "operation_identity_mismatch", operationIndex };
    }
    if (
      actual.status !== "accepted" ||
      actual.commitState !== "committed" ||
      actual.committedRevision !== expectedRevision ||
      actual.committedAt === null ||
      actual.replayability !== "domain_command"
    ) {
      return { status: "invalid", reason: "operation_commit_mismatch", operationIndex };
    }
  }
  return { status: "valid", committedRevision: expectedRevision };
}

// 原子命令错误分类独立于旧完整快照保存，避免 409 租约/前置冲突被旧文案误判为可重试网络错误。
export function classifyAtomicSubmitError(
  error: unknown,
  online: boolean,
): AtomicSubmitErrorClassification {
  if (!online) {
    return { status: "offline", retryable: true, code: "offline", message: "网络离线，命令批次尚未确认。" };
  }
  if (error instanceof PlatformApiError) {
    const code = getDetailCode(error.details) ?? error.code ?? null;
    // 维护是确定性的写门禁；继续退避重发只会制造同步噪声，应保留本地命令等待恢复。
    if (code === PLATFORM_MAINTENANCE_ERROR_CODE) {
      return {
        status: "error",
        retryable: false,
        code,
        message: PLATFORM_MAINTENANCE_SAVE_ERROR_MESSAGE,
      };
    }
    if (error.status === 409) {
      if (code?.startsWith("annotation_mutation_lease_")) {
        return { status: "error", retryable: false, code, message: error.message };
      }
      if (code === "annotation_payload_invalid") {
        // 旧导入文件可能已在浏览器中迁移，但服务器仍保存旧 payload；这不是并发冲突。
        return { status: "error", retryable: false, code, message: error.message };
      }
      return { status: "conflict", retryable: false, code, message: error.message };
    }
    if (error.status === 408 || error.status === 429 || error.status >= 500) {
      return { status: "retryable", retryable: true, code, message: error.message };
    }
    return { status: "error", retryable: false, code, message: error.message };
  }
  if (error instanceof TypeError) {
    return { status: "retryable", retryable: true, code: null, message: error.message };
  }
  return {
    status: "error",
    retryable: false,
    code: null,
    message: error instanceof Error ? error.message : "原子命令提交失败。",
  };
}

// 只有服务器明确证明当前 payload 不是可重放格式时，客户端才允许退回一次完整快照迁移。
// revision、租约或命令前置条件冲突都不能借此路径覆盖远端内容。
export function requiresLegacySnapshotMigration(
  failure: AtomicSubmitErrorClassification,
) {
  return failure.code === "annotation_payload_invalid";
}

// 租约拒绝意味着客户端持有的 token 已不可继续写入；调用方应清除本地凭据后再由用户重试取得新锁。
export function isMutationLeaseSubmitFailure(
  failure: AtomicSubmitErrorClassification,
) {
  return failure.code?.startsWith("annotation_mutation_lease_") === true;
}

// 租约拒绝或终态 409 都已经结束当前结构事务；旧 token 留在客户端只会继续阻塞协作者。
export function shouldReleaseMutationLeaseAfterAtomicFailure(
  failure: AtomicSubmitErrorClassification,
) {
  return failure.status === "conflict" || isMutationLeaseSubmitFailure(failure);
}

export function getAtomicSubmitRetryDelay(attempt: number) {
  return Math.min(1_000 * (2 ** Math.max(0, Math.floor(attempt))), 30_000);
}

function getDetailCode(details: unknown) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const code = (details as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}
