import {
  MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS,
  getAnnotationMutationLeasePurposeForCommand,
  isReplayableAnnotationCommandEnvelope,
  parseAnnotationCommandEnvelope,
  type AnnotationMutationPurpose,
  type CommitAnnotationCommandBatchRequest,
} from "@xiqu/shared";
import {
  applyAnnotationCommandToProject,
  areProjectValuesEqual,
} from "@xiqu/document-model";
import type {
  ProjectDocumentOperation,
} from "../state/projectDocumentState";
import type { ProjectData } from "../types";
import { normalizeTrackSnapEnabledForProject } from "../utils/project";

export type AtomicCommandLegacyBarrierReason =
  | "legacy_submitted_operation"
  | "legacy_operation"
  | "snapshot_boundary"
  | "track_snap_operation";

export type AtomicCommandBlockedReason =
  | "invalid_server_revision"
  | "invalid_operation"
  | "duplicate_operation_id"
  | "non_contiguous_local_revision"
  | "command_precondition_failed"
  | "local_chain_mismatch";

export type AtomicCommandPlan = {
  request: CommitAnnotationCommandBatchRequest;
  operationIds: string[];
  acknowledgedProject: ProjectData;
  acknowledgedTrackSnapEnabled: Record<string, boolean>;
  remainingCount: number;
  expectedSavedLocalRevision: number;
  acknowledgedLocalRevision: number;
  requiredLeasePurpose: AnnotationMutationPurpose | null;
};

export type AtomicCommandPlanResult =
  | { status: "ready"; plan: AtomicCommandPlan }
  | { status: "no_operations" }
  | {
      status: "legacy_required";
      reason: AtomicCommandLegacyBarrierReason;
      operationId: string;
      operationIndex: number;
    }
  | {
      status: "blocked";
      reason: AtomicCommandBlockedReason;
      operationId?: string;
      operationIndex?: number;
      issues?: unknown;
    };

type PlanInput = {
  savedProject: ProjectData;
  currentProject: ProjectData;
  serverRevision: number;
  savedLocalRevision: number;
  savedTrackSnapEnabled: Record<string, boolean>;
  pendingOperations: readonly ProjectDocumentOperation[];
  mutationLeaseToken?: string;
  maxBatchSize?: number;
};

// planner 会先审计完整待提交命令链，再切首批。这样第二条命令失败时不会错误提交第一条“半事务”。
export function planAtomicAnnotationCommandBatch(input: PlanInput): AtomicCommandPlanResult {
  if (input.pendingOperations.length === 0) return { status: "no_operations" };
  if (!isDatabaseInteger(input.serverRevision) || !isDatabaseInteger(input.savedLocalRevision)) {
    return { status: "blocked", reason: "invalid_server_revision" };
  }

  const maxBatchSize = normalizeBatchSize(input.maxBatchSize);
  const operationIds = new Set<string>();
  let auditProject = input.savedProject;
  let acknowledgedProject: ProjectData | null = null;
  let previousLocalRevision = input.savedLocalRevision;

  for (const [operationIndex, operation] of input.pendingOperations.entries()) {
    const barrier = getLegacyBarrier(operation);
    if (barrier) {
      return {
        status: "legacy_required",
        reason: barrier,
        operationId: operation.id,
        operationIndex,
      };
    }
    if (operation.syncState !== "pending") {
      return blocked("invalid_operation", operation, operationIndex);
    }
    if (operationIds.has(operation.id)) {
      return blocked("duplicate_operation_id", operation, operationIndex);
    }
    operationIds.add(operation.id);
    if (
      operation.baseRevision !== previousLocalRevision ||
      operation.localRevision !== previousLocalRevision + 1
    ) {
      return blocked("non_contiguous_local_revision", operation, operationIndex);
    }
    previousLocalRevision = operation.localRevision;

    const envelope = parseAnnotationCommandEnvelope(operation.commandEnvelope);
    if (
      !envelope ||
      envelope.command.type !== operation.type ||
      !operation.summary.hasProjectChange ||
      operation.summary.hasTrackSnapChange
    ) {
      return blocked("invalid_operation", operation, operationIndex);
    }
    const applied = applyAnnotationCommandToProject(auditProject, envelope);
    if (applied.status !== "applied") {
      return {
        ...blocked("command_precondition_failed", operation, operationIndex),
        issues: "issues" in applied ? applied.issues : applied.status,
      };
    }
    auditProject = applied.project;
    if (operationIndex === Math.min(maxBatchSize, input.pendingOperations.length) - 1) {
      acknowledgedProject = auditProject;
    }
  }

  // 当前项目必须能被整条 pending command chain 完整解释；合同外变化只能回退到完整快照保存。
  if (!areProjectValuesEqual(auditProject, input.currentProject)) {
    return { status: "blocked", reason: "local_chain_mismatch" };
  }

  const batchOperations = input.pendingOperations.slice(0, maxBatchSize);
  if (!acknowledgedProject || batchOperations.length === 0) {
    return { status: "blocked", reason: "invalid_operation" };
  }
  const request: CommitAnnotationCommandBatchRequest = {
    baseRevision: input.serverRevision,
    operations: batchOperations.map((operation) => ({
      clientOperationId: operation.id,
      localRevision: operation.localRevision,
      action: operation.commandEnvelope!.command.type,
      payload: operation.commandEnvelope!,
    })),
    ...(input.mutationLeaseToken ? { mutationLeaseToken: input.mutationLeaseToken } : {}),
  };
  return {
    status: "ready",
    plan: {
      request,
      operationIds: batchOperations.map((operation) => operation.id),
      acknowledgedProject,
      // 结构命令产生的新/删轨 key 是项目变化的派生事实，必须随同一批 saved baseline 一起推进。
      acknowledgedTrackSnapEnabled: normalizeTrackSnapEnabledForProject(
        acknowledgedProject,
        input.savedTrackSnapEnabled,
      ),
      remainingCount: input.pendingOperations.length - batchOperations.length,
      expectedSavedLocalRevision: input.savedLocalRevision,
      acknowledgedLocalRevision: batchOperations[batchOperations.length - 1].localRevision,
      requiredLeasePurpose: resolveRequiredLeasePurpose(batchOperations),
    },
  };
}

function getLegacyBarrier(
  operation: ProjectDocumentOperation,
): AtomicCommandLegacyBarrierReason | null {
  if (operation.syncState === "submitted") return "legacy_submitted_operation";
  if (operation.type === "track-snap.update" || operation.action === "track-snap") {
    return "track_snap_operation";
  }
  if (!operation.commandEnvelope) return "legacy_operation";
  if (!isReplayableAnnotationCommandEnvelope(operation.commandEnvelope)) return "snapshot_boundary";
  return null;
}

function resolveRequiredLeasePurpose(
  operations: readonly ProjectDocumentOperation[],
): AnnotationMutationPurpose | null {
  for (const operation of operations) {
    const purpose = getAnnotationMutationLeasePurposeForCommand(operation.commandEnvelope);
    if (purpose) return purpose;
  }
  return null;
}

function normalizeBatchSize(value: number | undefined) {
  if (value === undefined) return MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS;
  if (!Number.isFinite(value)) return MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS;
  return Math.max(1, Math.min(
    MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS,
    Math.floor(value),
  ));
}

function blocked(
  reason: AtomicCommandBlockedReason,
  operation: ProjectDocumentOperation,
  operationIndex: number,
) {
  return {
    status: "blocked" as const,
    reason,
    operationId: operation.id,
    operationIndex,
  };
}

function isDatabaseInteger(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
}
