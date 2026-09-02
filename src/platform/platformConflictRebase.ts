import {
  getAnnotationMutationLeasePurposeForCommand,
  type AnnotationDomainCommand,
  type AnnotationMutationPurpose,
  type AtomicAnnotationCommandOperation,
} from "@xiqu/shared";
import {
  applyAnnotationCommandToProject,
  resolveConcurrentAnnotationCommandConflict,
} from "@xiqu/document-model";
import type { ProjectDocumentOperation } from "../state/projectDocumentState";
import type { ProjectData } from "../types";
import {
  auditPendingAnnotationCommandChain,
  type PendingCommandChainBarrierReason,
  type PendingCommandChainInvalidReason,
} from "./platformPendingCommandChain";

const MAX_REBASE_ISSUES = 20;

export type ConflictRebaseIssue = {
  code: string;
  targetKey?: string;
};

export type PlatformConflictRebaseResult =
  | {
      status: "rebase_ready";
      baseRevision: number;
      latestRevision: number;
      rebasedProject: ProjectData;
      operations: AtomicAnnotationCommandOperation[];
      rebasedPendingOperations: ProjectDocumentOperation[];
      requiredLeasePurpose: AnnotationMutationPurpose | null;
    }
  | {
      status: "command_conflict";
      operationId: string;
      operationIndex: number;
      commandType: AnnotationDomainCommand["type"];
      issues: ConflictRebaseIssue[];
    }
  | {
      status: "manual_review_required";
      reason: PendingCommandChainBarrierReason;
      operationId: string;
      operationIndex: number;
    }
  | {
      status: "invalid_local_chain";
      reason: PendingCommandChainInvalidReason | "no_operations";
      operationId?: string;
      operationIndex?: number;
    }
  | {
      status: "invalid_revision";
      reason: "invalid_base_revision" | "invalid_latest_revision" | "latest_revision_not_newer";
    };

type PlatformConflictRebaseInput = {
  baseRevision: number;
  latestRevision: number;
  savedProject: ProjectData;
  currentProject: ProjectData;
  latestServerProject: ProjectData;
  savedLocalRevision: number;
  pendingOperations: readonly ProjectDocumentOperation[];
  // 仅实时 409 恢复开启；浏览器旧草稿可能对应“请求成功但响应丢失”，不得再次改写后重放。
  allowConcurrentValueResolution?: boolean;
};

// 冲突重放分两步：先在原 saved baseline 上证明本地命令链没有缺口，再在最新服务器项目上试运行。
// 两次都采用同一领域 dispatcher；第二步任一失败即丢弃中间结果，绝不发布“应用了一半”的项目。
export function planPlatformConflictRebase(
  input: PlatformConflictRebaseInput,
): PlatformConflictRebaseResult {
  if (!isDatabaseInteger(input.baseRevision)) {
    return { status: "invalid_revision", reason: "invalid_base_revision" };
  }
  if (!isDatabaseInteger(input.latestRevision)) {
    return { status: "invalid_revision", reason: "invalid_latest_revision" };
  }
  if (input.latestRevision <= input.baseRevision) {
    return { status: "invalid_revision", reason: "latest_revision_not_newer" };
  }

  const audit = auditPendingAnnotationCommandChain({
    savedProject: input.savedProject,
    currentProject: input.currentProject,
    savedLocalRevision: input.savedLocalRevision,
    pendingOperations: input.pendingOperations,
  });
  if (audit.status === "no_operations") {
    return { status: "invalid_local_chain", reason: "no_operations" };
  }
  if (audit.status === "manual_review_required") return audit;
  if (audit.status === "invalid_local_chain") {
    return {
      status: audit.status,
      reason: audit.reason,
      ...(audit.operationId ? { operationId: audit.operationId } : {}),
      ...(audit.operationIndex !== undefined ? { operationIndex: audit.operationIndex } : {}),
    };
  }

  let rebasedProject = input.latestServerProject;
  const operations: AtomicAnnotationCommandOperation[] = [];
  const rebasedPendingOperations: ProjectDocumentOperation[] = [];
  let requiredLeasePurpose: AnnotationMutationPurpose | null = null;
  for (const [operationIndex, { operation, envelope }] of audit.operations.entries()) {
    const strictResult = applyAnnotationCommandToProject(rebasedProject, envelope);
    const resolved = strictResult.status === "applied"
      ? { status: "resolved" as const, project: strictResult.project, envelope: strictResult.envelope }
      : input.allowConcurrentValueResolution
        ? resolveConcurrentAnnotationCommandConflict(rebasedProject, envelope)
        : null;
    if (!resolved || resolved.status !== "resolved") {
      return {
        status: "command_conflict",
        operationId: operation.id,
        operationIndex,
        commandType: envelope.command.type,
        issues: resolved
          ? [{ code: resolved.reason }]
          : sanitizeApplyIssues(strictResult),
      };
    }
    rebasedProject = resolved.project;
    const rebasedOperation: ProjectDocumentOperation = {
      ...operation,
      type: resolved.envelope.command.type,
      commandEnvelope: resolved.envelope,
    };
    rebasedPendingOperations.push(rebasedOperation);
    operations.push({
      clientOperationId: operation.id,
      localRevision: operation.localRevision,
      ...(operation.toolAttemptId ? { toolAttemptId: operation.toolAttemptId } : {}),
      action: resolved.envelope.command.type,
      payload: resolved.envelope,
    });
    requiredLeasePurpose ??= getAnnotationMutationLeasePurposeForCommand(resolved.envelope);
  }

  return {
    status: "rebase_ready",
    baseRevision: input.baseRevision,
    latestRevision: input.latestRevision,
    rebasedProject,
    operations,
    rebasedPendingOperations,
    requiredLeasePurpose,
  };
}

// 对 UI/日志只暴露有界的机器事实，不能把 before/after 正文或完整命令带入冲突详情。
function sanitizeApplyIssues(
  result: ReturnType<typeof applyAnnotationCommandToProject>,
): ConflictRebaseIssue[] {
  if (result.status === "applied") return [{ code: "unexpected_applied_result" }];
  if (!("issues" in result) || !Array.isArray(result.issues)) {
    return [{ code: result.status }];
  }
  return result.issues.slice(0, MAX_REBASE_ISSUES).map((issue) => {
    if (!isPlainObject(issue)) return { code: "unknown_precondition_issue" };
    return {
      code: typeof issue.code === "string" ? issue.code : "unknown_precondition_issue",
      ...(typeof issue.targetKey === "string" ? { targetKey: issue.targetKey } : {}),
    };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDatabaseInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
}
