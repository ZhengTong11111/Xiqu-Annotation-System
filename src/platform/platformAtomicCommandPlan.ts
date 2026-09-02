import {
  MAX_ATOMIC_ANNOTATION_COMMAND_OPERATIONS,
  getAnnotationMutationLeasePurposeForCommand,
  type AnnotationMutationPurpose,
  type CommitAnnotationCommandBatchRequest,
} from "@xiqu/shared";
import type {
  ProjectDocumentOperation,
} from "../state/projectDocumentState";
import type { ProjectData } from "../types";
import { normalizeTrackSnapEnabledForProject } from "../utils/project";
import {
  auditPendingAnnotationCommandChain,
  type PendingCommandChainBarrierReason,
  type PendingCommandChainInvalidReason,
} from "./platformPendingCommandChain";

export type AtomicCommandLegacyBarrierReason = PendingCommandChainBarrierReason;

export type AtomicCommandBlockedReason =
  | "invalid_server_revision"
  | PendingCommandChainInvalidReason;

export type AtomicCommandPlan = {
  request: CommitAnnotationCommandBatchRequest;
  operationIds: string[];
  // 仅保存在当前浏览器内存中，用于成功响应后的基线一致性证明；不会进入 API 请求或持久化草稿。
  serverBaseProject: ProjectData;
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

/**
 * 遥测旁路不可用时只移除对应 operation 的 attempt 绑定，命令、operation id 与确认基线保持原样。
 * 返回新 DTO 而不修改 frozen plan，保证 atomic submit 的 ambiguous retry 始终复用同一请求。
 */
export function omitUnavailableToolAttemptBindings(
  plan: AtomicCommandPlan,
  unavailableAttemptIds: ReadonlySet<string>,
): AtomicCommandPlan {
  if (unavailableAttemptIds.size === 0) return plan;
  let changed = false;
  const operations = plan.request.operations.map((operation) => {
    if (!operation.toolAttemptId || !unavailableAttemptIds.has(operation.toolAttemptId)) {
      return operation;
    }
    changed = true;
    const { toolAttemptId: _toolAttemptId, ...ordinaryOperation } = operation;
    return ordinaryOperation;
  });
  return changed
    ? { ...plan, request: { ...plan.request, operations } }
    : plan;
}

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
  const audit = auditPendingAnnotationCommandChain({
    savedProject: input.savedProject,
    currentProject: input.currentProject,
    savedLocalRevision: input.savedLocalRevision,
    pendingOperations: input.pendingOperations,
    captureAfterCount: maxBatchSize,
  });
  if (audit.status === "manual_review_required") {
    return { ...audit, status: "legacy_required" };
  }
  if (audit.status === "invalid_local_chain") {
    return { ...audit, status: "blocked" };
  }
  if (audit.status !== "ready") {
    return { status: "blocked", reason: "invalid_operation" };
  }

  const batchOperations = input.pendingOperations.slice(0, maxBatchSize);
  const acknowledgedProject = audit.capturedProject;
  if (!acknowledgedProject || batchOperations.length === 0) {
    return { status: "blocked", reason: "invalid_operation" };
  }
  const request: CommitAnnotationCommandBatchRequest = {
    baseRevision: input.serverRevision,
    operations: batchOperations.map((operation) => ({
      clientOperationId: operation.id,
      localRevision: operation.localRevision,
      ...(operation.toolAttemptId ? { toolAttemptId: operation.toolAttemptId } : {}),
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
      serverBaseProject: input.savedProject,
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

function isDatabaseInteger(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
}
