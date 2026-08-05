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
        issues: "issues" in applied ? applied.issues : applied.status,
      };
    }
    auditProject = applied.project;
    auditedOperations.push({ operation, envelope });
    if (operationIndex + 1 === captureAfterCount) capturedProject = auditProject;
  }

  // 命令链之外的可持久项目变化无法被服务端逐条重放，必须停在人工/快照边界而不是漏存。
  if (!areProjectValuesEqual(auditProject, input.currentProject)) {
    return { status: "invalid_local_chain", reason: "local_chain_mismatch" };
  }

  return {
    status: "ready",
    operations: auditedOperations,
    capturedProject,
  };
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
