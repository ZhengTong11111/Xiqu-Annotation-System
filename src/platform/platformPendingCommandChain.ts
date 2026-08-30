import {
  isReplayableAnnotationCommandEnvelope,
  parseAnnotationCommandEnvelope,
  type AnnotationCommandEnvelope,
} from "@xiqu/shared";
import {
  applyAnnotationCommandToProject,
  areProjectValuesEqual,
} from "@xiqu/document-model";
import type { ProjectDocumentOperation } from "../state/projectDocumentState";
import type { ProjectData } from "../types";

export type PendingCommandChainBarrierReason =
  | "legacy_submitted_operation"
  | "legacy_operation"
  | "snapshot_boundary"
  | "track_snap_operation";

export type PendingCommandChainInvalidReason =
  | "invalid_operation"
  | "duplicate_operation_id"
  | "non_contiguous_local_revision"
  | "command_precondition_failed"
  | "local_chain_mismatch";

export type AuditedPendingCommand = {
  operation: ProjectDocumentOperation;
  envelope: AnnotationCommandEnvelope;
};

export type PendingCommandChainMismatchDetail = {
  path: string;
  savedValue: unknown;
  replayedValue: unknown;
  currentValue: unknown;
};

const MAX_MISMATCH_DETAILS = 64;
const MISSING_VALUE = "[MISSING]";

export type PendingCommandChainAuditResult =
  | { status: "ready"; operations: AuditedPendingCommand[]; capturedProject: ProjectData | null }
  | { status: "no_operations" }
  | {
      status: "manual_review_required";
      reason: PendingCommandChainBarrierReason;
      operationId: string;
      operationIndex: number;
    }
  | {
      status: "invalid_local_chain";
      reason: PendingCommandChainInvalidReason;
      operationId?: string;
      operationIndex?: number;
      issues?: unknown;
    };

type AuditInput = {
  savedProject: ProjectData;
  currentProject: ProjectData;
  savedLocalRevision: number;
  pendingOperations: readonly ProjectDocumentOperation[];
  captureAfterCount?: number;
};

// 这一层只证明 pending operations 能否从 saved baseline 完整解释当前编辑器状态。
// 正常提交与冲突重放必须共用同一审计规则，否则两条保存路径会对同一草稿得出不同结论。
export function auditPendingAnnotationCommandChain(
  input: AuditInput,
): PendingCommandChainAuditResult {
  if (input.pendingOperations.length === 0) return { status: "no_operations" };

  const operationIds = new Set<string>();
  const auditedOperations: AuditedPendingCommand[] = [];
  const captureAfterCount = normalizeCaptureCount(
    input.captureAfterCount,
    input.pendingOperations.length,
  );
  let auditProject = input.savedProject;
  let capturedProject: ProjectData | null = null;
  let previousLocalRevision = input.savedLocalRevision;

  for (const [operationIndex, operation] of input.pendingOperations.entries()) {
    const barrier = getPendingCommandBarrier(operation);
    if (barrier) {
      return {
        status: "manual_review_required",
        reason: barrier,
        operationId: operation.id,
        operationIndex,
      };
    }
    if (operation.syncState !== "pending") {
      return invalid("invalid_operation", operation, operationIndex);
    }
    if (operationIds.has(operation.id)) {
      return invalid("duplicate_operation_id", operation, operationIndex);
    }
    operationIds.add(operation.id);
    if (
      operation.baseRevision !== previousLocalRevision ||
      operation.localRevision !== previousLocalRevision + 1
    ) {
      return invalid("non_contiguous_local_revision", operation, operationIndex);
    }
    previousLocalRevision = operation.localRevision;

    const envelope = parseAnnotationCommandEnvelope(operation.commandEnvelope);
    if (
      !envelope ||
      envelope.command.type !== operation.type ||
      !operation.summary.hasProjectChange ||
      operation.summary.hasTrackSnapChange
    ) {
      return invalid("invalid_operation", operation, operationIndex);
    }

    const applied = applyAnnotationCommandToProject(auditProject, envelope);
    if (applied.status !== "applied") {
      return {
        ...invalid("command_precondition_failed", operation, operationIndex),
        // 保留失败 adapter 的结构化结果，诊断端才能区分事务 childIndex 与具体 before 不匹配。
        // 这里只包含命令执行事实，不包含完整项目；完整 envelope 已由 pending operation 单独有界记录。
        issues: sanitizeCommandApplyFailure(applied),
      };
    }
    auditProject = applied.project;
    auditedOperations.push({ operation, envelope });
    if (operationIndex + 1 === captureAfterCount) capturedProject = auditProject;
  }

  // 命令链之外的可持久项目变化无法被服务端逐条重放，必须停在人工/快照边界而不是漏存。
  if (!areProjectValuesEqual(auditProject, input.currentProject)) {
    return {
      status: "invalid_local_chain",
      reason: "local_chain_mismatch",
      issues: {
        // UI 错误提示仍只展示 reason；详细值仅进入受限调试审计，用来定位没有生成命令的编辑入口。
        mismatchedTopLevelFields: getMismatchedTopLevelFields(auditProject, input.currentProject),
        mismatchDetails: collectProjectMismatchDetails(
          input.savedProject,
          auditProject,
          input.currentProject,
        ),
      },
    };
  }

  return {
    status: "ready",
    operations: auditedOperations,
    capturedProject,
  };
}

function sanitizeCommandApplyFailure(
  result: Exclude<ReturnType<typeof applyAnnotationCommandToProject>, { status: "applied" }>,
) {
  if (result.status === "blocked") {
    const failure: { status: "blocked"; childIndex?: number; issues?: unknown } = {
      status: result.status,
    };
    if ("childIndex" in result && typeof result.childIndex === "number") {
      failure.childIndex = result.childIndex;
    }
    if ("issues" in result) failure.issues = result.issues;
    return failure;
  }
  return { status: result.status };
}

// 从命令重放结果和真实编辑器状态中寻找最早的叶子差异，同时带上保存基线的同路径值。
// 数组长度单独记录，避免为了一个增删项把整条大型标注数组写进审计日志。
function collectProjectMismatchDetails(
  savedProject: ProjectData,
  replayedProject: ProjectData,
  currentProject: ProjectData,
): PendingCommandChainMismatchDetail[] {
  const details: PendingCommandChainMismatchDetail[] = [];
  collectValueMismatchDetails(savedProject, replayedProject, currentProject, "", details);
  return details;
}

function collectValueMismatchDetails(
  savedValue: unknown,
  replayedValue: unknown,
  currentValue: unknown,
  path: string,
  details: PendingCommandChainMismatchDetail[],
) {
  if (details.length >= MAX_MISMATCH_DETAILS || areProjectValuesEqual(replayedValue, currentValue)) return;

  if (Array.isArray(replayedValue) && Array.isArray(currentValue)) {
    if (replayedValue.length !== currentValue.length) {
      details.push({
        path: `${path}/length`,
        savedValue: Array.isArray(savedValue) ? savedValue.length : MISSING_VALUE,
        replayedValue: replayedValue.length,
        currentValue: currentValue.length,
      });
    }
    const maximumLength = Math.max(replayedValue.length, currentValue.length);
    for (let index = 0; index < maximumLength && details.length < MAX_MISMATCH_DETAILS; index += 1) {
      collectValueMismatchDetails(
        Array.isArray(savedValue) && index < savedValue.length ? savedValue[index] : MISSING_VALUE,
        index < replayedValue.length ? replayedValue[index] : MISSING_VALUE,
        index < currentValue.length ? currentValue[index] : MISSING_VALUE,
        `${path}/${index}`,
        details,
      );
    }
    return;
  }

  if (isPlainRecord(replayedValue) && isPlainRecord(currentValue)) {
    const keys = [...new Set([...Object.keys(replayedValue), ...Object.keys(currentValue)])].sort();
    const savedRecord = isPlainRecord(savedValue) ? savedValue : null;
    for (const key of keys) {
      if (details.length >= MAX_MISMATCH_DETAILS) return;
      collectValueMismatchDetails(
        savedRecord && Object.prototype.hasOwnProperty.call(savedRecord, key)
          ? savedRecord[key]
          : MISSING_VALUE,
        Object.prototype.hasOwnProperty.call(replayedValue, key) ? replayedValue[key] : MISSING_VALUE,
        Object.prototype.hasOwnProperty.call(currentValue, key) ? currentValue[key] : MISSING_VALUE,
        `${path}/${escapeJsonPointerSegment(key)}`,
        details,
      );
    }
    return;
  }

  details.push({
    path: path || "/",
    savedValue,
    replayedValue,
    currentValue,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeJsonPointerSegment(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function getMismatchedTopLevelFields(left: ProjectData, right: ProjectData): string[] {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...fields]
    .filter((field) => !areProjectValuesEqual(
      (left as unknown as Record<string, unknown>)[field],
      (right as unknown as Record<string, unknown>)[field],
    ))
    .sort()
    .slice(0, 32);
}

function getPendingCommandBarrier(
  operation: ProjectDocumentOperation,
): PendingCommandChainBarrierReason | null {
  if (operation.syncState === "submitted") return "legacy_submitted_operation";
  if (operation.type === "track-snap.update" || operation.action === "track-snap") {
    return "track_snap_operation";
  }
  if (!operation.commandEnvelope) return "legacy_operation";
  if (!isReplayableAnnotationCommandEnvelope(operation.commandEnvelope)) return "snapshot_boundary";
  return null;
}

function normalizeCaptureCount(value: number | undefined, operationCount: number): number {
  if (value === undefined) return operationCount;
  if (!Number.isFinite(value)) return operationCount;
  return Math.max(1, Math.min(operationCount, Math.floor(value)));
}

function invalid(
  reason: PendingCommandChainInvalidReason,
  operation: ProjectDocumentOperation,
  operationIndex: number,
) {
  return {
    status: "invalid_local_chain" as const,
    reason,
    operationId: operation.id,
    operationIndex,
  };
}
