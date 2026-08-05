import type { AnnotationFile, AnnotationMutationPurpose } from "@xiqu/shared";
import type {
  ProjectDocumentOperation,
  ProjectDocumentRecoveryState,
} from "../state/projectDocumentState";
import type { ProjectData } from "../types";
import {
  buildPlatformDraftRecord,
  type PlatformDraftRecord,
} from "./platformDraft";
import {
  planPlatformConflictRebase,
  type PlatformConflictRebaseResult,
} from "./platformConflictRebase";

export type PlatformConflictRebaseProposal = {
  userId: string;
  annotationFileId: string;
  draftUpdatedAt: number;
  draftRemoteBaseRevision: number;
  serverRevision: number;
  operationCount: number;
  requiredLeasePurpose: AnnotationMutationPurpose | null;
  planFingerprint: string;
};

export type PlatformConflictRebaseUnavailableReason =
  | "identity_mismatch"
  | "not_revision_conflict"
  | "write_permission_required"
  | "track_snap_state_changed"
  | Exclude<PlatformConflictRebaseResult["status"], "rebase_ready">;

export type BuildPlatformConflictRebaseProposalResult =
  | { status: "ready"; proposal: PlatformConflictRebaseProposal }
  | { status: "not_available"; reason: PlatformConflictRebaseUnavailableReason };

export type PreparePlatformConflictRebaseResult =
  | {
      status: "ready";
      targetFile: AnnotationFile<ProjectData>;
      recoveryState: ProjectDocumentRecoveryState;
      draftRecord: PlatformDraftRecord;
    }
  | {
      status: "rejected";
      reason:
        | "identity_changed"
        | "draft_changed"
        | "server_revision_changed"
        | "write_permission_revoked"
        | "plan_changed";
      message: string;
    };

type RebaseFacts = {
  userId: string;
  draft: PlatformDraftRecord;
  serverFile: AnnotationFile<ProjectData>;
  latestServerProject: ProjectData;
};

// 初次冲突检查只生成可展示的轻量 proposal，不把重放后的项目或命令正文放进 React 对话框状态。
export function buildPlatformConflictRebaseProposal(
  input: RebaseFacts,
): BuildPlatformConflictRebaseProposalResult {
  const evaluated = evaluateRebaseFacts(input);
  if (evaluated.status !== "ready") return evaluated;

  return {
    status: "ready",
    proposal: createProposal(input, evaluated.plan),
  };
}

// 用户确认后必须用第二次权威读取重新建立全部事实；首次屏幕上的“可重放”不能直接变成编辑器状态。
export function preparePlatformConflictRebase(input: RebaseFacts & {
  proposal: PlatformConflictRebaseProposal;
  now?: number;
}): PreparePlatformConflictRebaseResult {
  const { proposal, draft, serverFile } = input;
  if (
    proposal.userId !== input.userId ||
    proposal.annotationFileId !== draft.annotationFileId ||
    proposal.annotationFileId !== serverFile.resource.id ||
    draft.userId !== input.userId
  ) {
    return rejected("identity_changed", "账号、草稿或服务器文件身份已经变化，请重新打开冲突检查。");
  }
  if (
    draft.updatedAt !== proposal.draftUpdatedAt ||
    draft.remoteBaseRevision !== proposal.draftRemoteBaseRevision
  ) {
    return rejected("draft_changed", "浏览器草稿已被更新或替换，请重新读取冲突状态。");
  }
  if (serverFile.revision !== proposal.serverRevision) {
    return rejected("server_revision_changed", "服务器文件已产生新修订，请重新检查后再重放。");
  }
  if (!serverFile.resource.permission.capabilities.includes("write")) {
    return rejected("write_permission_revoked", "当前账号已没有服务器文件的编辑权限。");
  }

  const evaluated = evaluateRebaseFacts(input);
  if (evaluated.status !== "ready") {
    return rejected("plan_changed", "本地命令已不能完整重放到当前服务器版本，请改用人工比较。");
  }
  const latestProposal = createProposal(input, evaluated.plan);
  if (latestProposal.planFingerprint !== proposal.planFingerprint) {
    return rejected("plan_changed", "冲突重放计划已经变化，请重新检查后再确认。");
  }

  // 重基线只替换 saved/current 项目起点；原 operation 身份和本地 revision 必须原样保留给原子接口重提。
  const recoveryState: ProjectDocumentRecoveryState = {
    currentProject: evaluated.plan.rebasedProject,
    savedProject: input.latestServerProject,
    currentTrackSnapEnabled: { ...draft.currentTrackSnapEnabled },
    savedTrackSnapEnabled: { ...draft.savedTrackSnapEnabled },
    pendingOperations: draft.pendingOperations.map(cloneOperation),
    localRevision: draft.localRevision,
    savedRevision: draft.savedRevision,
    lastChangedAt: draft.lastChangedAt,
    lastSavedAt: draft.lastSavedAt,
  };
  // 先生成以最新 remote revision 为基准的 IndexedDB checkpoint；Workspace 必须写入成功后才重开编辑器。
  const draftRecord = buildPlatformDraftRecord({
    userId: input.userId,
    annotationFileId: draft.annotationFileId,
    remoteBaseRevision: serverFile.revision,
    recoveryState,
    createdAt: draft.createdAt,
    now: input.now,
  });
  return { status: "ready", targetFile: serverFile, recoveryState, draftRecord };
}

// proposal 只绑定稳定身份与命令元数据；正文留在 IndexedDB 草稿内，不进入 UI、日志或错误消息。
function createProposal(
  input: RebaseFacts,
  plan: Extract<PlatformConflictRebaseResult, { status: "rebase_ready" }>,
): PlatformConflictRebaseProposal {
  const operationFacts = plan.operations.map((operation) => ({
    clientOperationId: operation.clientOperationId,
    localRevision: operation.localRevision,
    action: operation.action,
    envelopeVersion: operation.payload.version,
  }));
  const proposalFacts = {
    version: 1,
    userId: input.userId,
    annotationFileId: input.draft.annotationFileId,
    draftUpdatedAt: input.draft.updatedAt,
    draftRemoteBaseRevision: input.draft.remoteBaseRevision,
    serverRevision: input.serverFile.revision,
    requiredLeasePurpose: plan.requiredLeasePurpose,
    operations: operationFacts,
  };
  return {
    userId: input.userId,
    annotationFileId: input.draft.annotationFileId,
    draftUpdatedAt: input.draft.updatedAt,
    draftRemoteBaseRevision: input.draft.remoteBaseRevision,
    serverRevision: input.serverFile.revision,
    operationCount: operationFacts.length,
    requiredLeasePurpose: plan.requiredLeasePurpose,
    planFingerprint: JSON.stringify(proposalFacts),
  };
}

// 初次与二次判定共用同一入口，防止两次对权限、track-snap 或 planner 状态采用不同规则。
function evaluateRebaseFacts(input: RebaseFacts):
  | { status: "ready"; plan: Extract<PlatformConflictRebaseResult, { status: "rebase_ready" }> }
  | { status: "not_available"; reason: PlatformConflictRebaseUnavailableReason } {
  if (
    input.draft.userId !== input.userId ||
    input.draft.annotationFileId !== input.serverFile.resource.id
  ) {
    return { status: "not_available", reason: "identity_mismatch" };
  }
  if (!input.serverFile.resource.permission.capabilities.includes("write")) {
    return { status: "not_available", reason: "write_permission_required" };
  }
  if (input.draft.remoteBaseRevision >= input.serverFile.revision) {
    return { status: "not_available", reason: "not_revision_conflict" };
  }
  if (!sameTrackSnapState(
    input.draft.currentTrackSnapEnabled,
    input.draft.savedTrackSnapEnabled,
  )) {
    return { status: "not_available", reason: "track_snap_state_changed" };
  }

  const plan = planPlatformConflictRebase({
    baseRevision: input.draft.remoteBaseRevision,
    latestRevision: input.serverFile.revision,
    savedProject: input.draft.savedProject,
    currentProject: input.draft.currentProject,
    latestServerProject: input.latestServerProject,
    savedLocalRevision: input.draft.savedRevision,
    pendingOperations: input.draft.pendingOperations,
  });
  return plan.status === "rebase_ready"
    ? { status: "ready", plan }
    : { status: "not_available", reason: plan.status };
}

// track-snap 不属于当前领域命令合同；任何未表示变化都必须回到人工流程，不能在重基线时悄悄丢失。
function sameTrackSnapState(
  left: Record<string, boolean>,
  right: Record<string, boolean>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

// operation 中的 envelope 属于持久 JSON；逐层克隆避免新编辑器误改仍被 proposal 引用的旧草稿对象。
function cloneOperation(operation: ProjectDocumentOperation): ProjectDocumentOperation {
  return {
    ...operation,
    ...(operation.commandEnvelope
      ? { commandEnvelope: structuredClone(operation.commandEnvelope) }
      : {}),
    summary: {
      ...operation.summary,
      ...(operation.summary.changedTrackIds
        ? { changedTrackIds: [...operation.summary.changedTrackIds] }
        : {}),
    },
  };
}

function rejected(
  reason: Extract<PreparePlatformConflictRebaseResult, { status: "rejected" }>["reason"],
  message: string,
): PreparePlatformConflictRebaseResult {
  return { status: "rejected", reason, message };
}
