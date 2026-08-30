import {
  parseAnnotationCommandEnvelope,
  type AnnotationClientSyncFailureCategory,
  type AnnotationClientSyncFailureMismatch,
  type AnnotationClientSyncFailureOperation,
  type AnnotationClientSyncFailurePlannerFailure,
  type AnnotationClientSyncFailureReport,
} from "@xiqu/shared";
import type {
  ProjectDocumentOperation,
  ProjectSyncState,
} from "../state/projectDocumentState";

const MAX_REPORTED_OPERATIONS = 20;
const MAX_TARGETS_PER_OPERATION = 32;
const MAX_DEBUG_DEPTH = 12;
const MAX_DEBUG_ARRAY_ITEMS = 200;
const MAX_DEBUG_OBJECT_KEYS = 200;
const MAX_DEBUG_STRING_LENGTH = 4_000;

type BuildSyncFailureReportInput = {
  clientRuntimeId: string;
  errorMessage: string | null;
  syncState: ProjectSyncState;
  appRemoteRevision: number;
  observedRemoteRevision: number;
  hasUnsavedChanges: boolean;
  saveInFlight: boolean;
  online: boolean;
  pendingOperations: readonly ProjectDocumentOperation[];
  mismatchFields?: readonly string[];
  mismatchDetails?: readonly AnnotationClientSyncFailureMismatch[];
  plannerFailure?: AnnotationClientSyncFailurePlannerFailure | null;
};

// 诊断报告保留命令身份、目标和调试 payload，同时对任何鉴权字段、URL 与长凭据形字符串做双保险脱敏。
export function buildAnnotationClientSyncFailureReport(
  input: BuildSyncFailureReportInput,
): AnnotationClientSyncFailureReport {
  const reportedOperations = input.pendingOperations.slice(0, MAX_REPORTED_OPERATIONS);
  return {
    schemaVersion: 1,
    clientRuntimeId: input.clientRuntimeId,
    clientOccurredAt: new Date().toISOString(),
    category: classifySyncFailure(input.errorMessage),
    reason: normalizeSyncFailureReason(input.errorMessage),
    errorMessage: sanitizeDiagnosticString(input.errorMessage ?? "未提供同步失败消息。"),
    localRevision: input.syncState.localRevision,
    savedLocalRevision: input.syncState.savedRevision,
    documentRemoteRevision: input.syncState.remoteRevision,
    appRemoteRevision: input.appRemoteRevision,
    observedRemoteRevision: input.observedRemoteRevision,
    pendingOperationCount: input.pendingOperations.length,
    hasUnsavedChanges: input.hasUnsavedChanges,
    saveInFlight: input.saveInFlight,
    online: input.online,
    mismatchFields: [...new Set(input.mismatchFields ?? [])].slice(0, 32),
    mismatchDetails: (input.mismatchDetails ?? []).slice(0, 64).map((detail) => ({
      path: sanitizeDiagnosticString(detail.path),
      savedValue: sanitizeDiagnosticValue(detail.savedValue),
      replayedValue: sanitizeDiagnosticValue(detail.replayedValue),
      currentValue: sanitizeDiagnosticValue(detail.currentValue),
    })),
    ...(input.plannerFailure
      ? {
          plannerFailure: {
            operationId: input.plannerFailure.operationId
              ? sanitizeDiagnosticString(input.plannerFailure.operationId)
              : null,
            operationIndex: input.plannerFailure.operationIndex,
            issues: sanitizeDiagnosticValue(input.plannerFailure.issues),
          },
        }
      : {}),
    pendingOperations: reportedOperations.map(summarizePendingOperation),
    pendingOperationsTruncated: input.pendingOperations.length > reportedOperations.length,
  };
}

export function getSyncFailurePlannerFailure(input: {
  operationId?: string;
  operationIndex?: number;
  issues?: unknown;
}): AnnotationClientSyncFailurePlannerFailure {
  return {
    operationId: input.operationId ?? null,
    operationIndex: input.operationIndex ?? null,
    issues: input.issues ?? null,
  };
}

function summarizePendingOperation(
  operation: ProjectDocumentOperation,
): AnnotationClientSyncFailureOperation {
  const envelope = parseAnnotationCommandEnvelope(operation.commandEnvelope);
  return {
    operationId: operation.id,
    action: sanitizeDiagnosticString(operation.action),
    commandType: envelope?.command.type ?? operation.type,
    baseRevision: operation.baseRevision,
    localRevision: operation.localRevision,
    createdAt: new Date(operation.createdAt).toISOString(),
    targets: envelope ? collectCommandTargets(envelope.command) : [],
    ...(envelope ? { commandPayload: sanitizeDiagnosticValue(envelope) } : {}),
  };
}

export function getSyncFailureMismatchFields(issues: unknown): string[] {
  if (!issues || typeof issues !== "object" || Array.isArray(issues)) return [];
  const fields = (issues as Record<string, unknown>).mismatchedTopLevelFields;
  if (!Array.isArray(fields)) return [];
  return fields.filter((field): field is string => typeof field === "string").slice(0, 32);
}

export function getSyncFailureMismatchDetails(
  issues: unknown,
): AnnotationClientSyncFailureMismatch[] {
  if (!issues || typeof issues !== "object" || Array.isArray(issues)) return [];
  const details = (issues as Record<string, unknown>).mismatchDetails;
  if (!Array.isArray(details)) return [];
  return details.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const detail = value as Record<string, unknown>;
    if (typeof detail.path !== "string") return [];
    return [{
      path: detail.path,
      savedValue: detail.savedValue,
      replayedValue: detail.replayedValue,
      currentValue: detail.currentValue,
    }];
  }).slice(0, 64);
}

// 目标摘要只读取命令寻址字段；before/after 留在有界 debug payload 中，不重复扩大审计行。
function collectCommandTargets(command: unknown): string[] {
  const targets = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    const identity = [
      typeof record.entityType === "string" ? record.entityType : null,
      typeof record.trackId === "string" ? `track:${record.trackId}` : null,
      typeof record.entityId === "string" ? `entity:${record.entityId}` : null,
      typeof record.field === "string" ? `field:${record.field}` : null,
    ].filter((part): part is string => Boolean(part));
    if (identity.length > 0) targets.add(identity.join("/"));
    for (const key of ["items", "commands", "command"]) visit(record[key]);
  };
  visit(command);
  return [...targets].slice(0, MAX_TARGETS_PER_OPERATION);
}

function classifySyncFailure(message: string | null): AnnotationClientSyncFailureCategory {
  if (message?.includes("本地命令链无法安全提交")) return "atomic_plan";
  if (message?.includes("服务器原子确认合同异常")) return "atomic_protocol";
  if (message?.includes("本地恢复草稿写入失败")) return "draft_persistence";
  if (message?.includes("结构编辑锁失效") || message?.includes("annotation_mutation_lease_")) {
    return "mutation_lease";
  }
  if (message?.includes("自动保存异常")) return "auto_save_runtime";
  if (message) return "server_save";
  return "unknown";
}

function normalizeSyncFailureReason(message: string | null): string {
  if (!message) return "unknown";
  const parenthesized = message.match(/[（(]([a-z0-9_.:-]{1,120})[）)]/i)?.[1];
  if (parenthesized) return parenthesized;
  const protocolReason = message.match(/合同异常：([a-z0-9_.:-]{1,120})/i)?.[1];
  return protocolReason ?? classifySyncFailure(message);
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEBUG_DEPTH) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return sanitizeDiagnosticString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DEBUG_ARRAY_ITEMS).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return String(value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_DEBUG_OBJECT_KEYS)) {
    result[key] = isSensitiveDiagnosticKey(key)
      ? "[REDACTED]"
      : sanitizeDiagnosticValue(item, depth + 1);
  }
  return result;
}

function isSensitiveDiagnosticKey(key: string) {
  return /(token|secret|password|authorization|playauth|access.?key|credential|url)/i.test(key);
}

function sanitizeDiagnosticString(value: string) {
  return value
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\bbearer\s+[^\s,;]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\bLTAI[A-Za-z0-9]{12,}\b/g, "[REDACTED_ACCESS_KEY_ID]")
    .replace(/\b(?:access.?key.?secret|playauth|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, MAX_DEBUG_STRING_LENGTH);
}
