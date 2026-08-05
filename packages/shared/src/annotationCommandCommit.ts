import {
  isReplayableAnnotationCommandEnvelope,
  parseAnnotationCommandEnvelope,
  type AnnotationCommandEnvelope,
  type AnnotationDomainCommand,
} from "./annotationCommands.js";
import type { AnnotationOperationRecord } from "./platform.js";

export const MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS = 100;
const CLIENT_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DATABASE_INTEGER = 2_147_483_647;

export type AtomicAnnotationCommandOperation = {
  clientOperationId: string;
  localRevision?: number | null;
  action: AnnotationDomainCommand["type"];
  payload: AnnotationCommandEnvelope;
};

export type CommitAnnotationCommandBatchRequest = {
  baseRevision: number;
  operations: AtomicAnnotationCommandOperation[];
  mutationLeaseToken?: string;
};

export type CommitAnnotationCommandBatchResponse = {
  committedRevision: number;
  operationCursor: string;
  operations: AnnotationOperationRecord[];
};

export type AnnotationCommandBatchValidationIssue = {
  code:
    | "invalid_request"
    | "invalid_base_revision"
    | "invalid_operation_count"
    | "invalid_operation"
    | "duplicate_client_operation_id"
    | "invalid_mutation_lease_token";
  operationIndex?: number;
};

export type AnnotationCommandBatchValidationResult =
  | { success: true; data: CommitAnnotationCommandBatchRequest }
  | { success: false; issues: AnnotationCommandBatchValidationIssue[] };

// client id 是跨网络重试的幂等身份；共享 validator 让旧 operation 与新原子批次保持完全相同的字符集。
export function isValidAnnotationClientOperationId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_OPERATION_ID_PATTERN.test(value);
}

// 原子批次 parser 保留 operation 数组顺序，因为后一条命令的 before 可以依赖前一条命令的 after。
export function parseAnnotationCommandBatchRequest(
  value: unknown,
): AnnotationCommandBatchValidationResult {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["baseRevision", "operations", "mutationLeaseToken"])) {
    return { success: false, issues: [{ code: "invalid_request" }] };
  }
  const issues: AnnotationCommandBatchValidationIssue[] = [];
  if (!isNonNegativeSafeInteger(value.baseRevision)) {
    issues.push({ code: "invalid_base_revision" });
  }
  if (
    !Array.isArray(value.operations) ||
    value.operations.length < 1 ||
    value.operations.length > MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS
  ) {
    issues.push({ code: "invalid_operation_count" });
  }
  if (
    value.mutationLeaseToken !== undefined &&
    (typeof value.mutationLeaseToken !== "string" ||
      value.mutationLeaseToken.length < 1 ||
      value.mutationLeaseToken.length > 256)
  ) {
    issues.push({ code: "invalid_mutation_lease_token" });
  }
  if (!Array.isArray(value.operations)) return { success: false, issues };

  const operationIds = new Set<string>();
  const operations: AtomicAnnotationCommandOperation[] = [];
  for (const [operationIndex, rawOperation] of value.operations.entries()) {
    const operation = parseAtomicOperation(rawOperation);
    if (!operation) {
      issues.push({ code: "invalid_operation", operationIndex });
      continue;
    }
    if (operationIds.has(operation.clientOperationId)) {
      issues.push({ code: "duplicate_client_operation_id", operationIndex });
      continue;
    }
    operationIds.add(operation.clientOperationId);
    operations.push(operation);
  }
  if (issues.length > 0) return { success: false, issues };
  return {
    success: true,
    data: {
      baseRevision: value.baseRevision as number,
      operations,
      ...(typeof value.mutationLeaseToken === "string"
        ? { mutationLeaseToken: value.mutationLeaseToken }
        : {}),
    },
  };
}

// 批次只接受可重放领域 envelope；legacy 摘要和 snapshot boundary 必须继续走完整 payload 保存。
function parseAtomicOperation(value: unknown): AtomicAnnotationCommandOperation | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, [
    "clientOperationId",
    "localRevision",
    "action",
    "payload",
  ])) return null;
  if (!isValidAnnotationClientOperationId(value.clientOperationId)) return null;
  if (
    value.localRevision !== undefined &&
    value.localRevision !== null &&
    !isNonNegativeSafeInteger(value.localRevision)
  ) return null;
  if (typeof value.action !== "string") return null;
  const envelope = parseAnnotationCommandEnvelope(value.payload);
  if (!envelope || envelope.command.type !== value.action || !isReplayableAnnotationCommandEnvelope(envelope)) {
    return null;
  }
  return {
    clientOperationId: value.clientOperationId,
    localRevision: value.localRevision === null || value.localRevision === undefined
      ? null
      : value.localRevision as number,
    action: envelope.command.type,
    payload: envelope,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  // revision、localRevision 和 sequence 最终落入 PostgreSQL Int，合同在路由前即拒绝越界值。
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= MAX_DATABASE_INTEGER;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}
