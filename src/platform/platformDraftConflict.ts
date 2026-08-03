import type { AnnotationFile } from "@xiqu/shared";
import type { ProjectData } from "../types";
import { buildAnnotationDiff } from "./annotationDiff";
import { applyAnnotationMergePlan } from "./annotationMergeApply";
import {
  getAnnotationMergePlanFingerprint,
  getAnnotationMergePreparationState,
  normalizeMergeConflictResolutions,
  type AnnotationMergeConflictResolutions,
} from "./annotationMergeConflict";
import type { AnnotationMergeDraft } from "./annotationMergeDraft";
import { buildAnnotationMergePlan } from "./annotationMergePlan";
import { normalizeMergeSelection } from "./annotationMergeSelection";
import type { PlatformDraftRecord } from "./platformDraft";

export type PlatformDraftConflictPreparationRequest = {
  userId: string;
  annotationFileId: string;
  draftUpdatedAt: number;
  draftRemoteBaseRevision: number;
  serverRevision: number;
  selectedEntryKeys: string[];
  conflictResolutions: AnnotationMergeConflictResolutions;
  planFingerprint: string;
};

export type PreparedPlatformDraftConflict = {
  targetFile: AnnotationFile<unknown>;
  draft: AnnotationMergeDraft;
};

export type PreparePlatformDraftConflictResult =
  | { ok: true; value: PreparedPlatformDraftConflict }
  | { ok: false; message: string };

// stale 草稿准备器固定“本地草稿在左、服务器当前在右”，并以重新读取的数据重建全部语义计划。
export function preparePlatformDraftConflict(input: {
  localDraft: PlatformDraftRecord;
  serverFile: AnnotationFile<unknown>;
  request: PlatformDraftConflictPreparationRequest;
  hydrateProject: (project: ProjectData) => ProjectData;
  createDraftId?: () => string;
}): PreparePlatformDraftConflictResult {
  const { localDraft, serverFile, request } = input;
  if (
    localDraft.userId !== request.userId ||
    localDraft.annotationFileId !== request.annotationFileId ||
    serverFile.resource.id !== request.annotationFileId
  ) {
    return failure("草稿或服务器文件身份已经变化，请关闭后重新打开文件。");
  }
  if (
    localDraft.updatedAt !== request.draftUpdatedAt ||
    localDraft.remoteBaseRevision !== request.draftRemoteBaseRevision
  ) {
    return failure("本地草稿已在另一个页面中更新，请重新读取差异。");
  }
  if (serverFile.revision !== request.serverRevision) {
    return failure("服务器文件已产生新修订，请重新读取差异后再整合。");
  }
  if (!serverFile.resource.permission.capabilities.includes("write")) {
    return failure("当前账号已没有服务器文件的编辑权限。");
  }

  // 正式 diff 同时迁移两侧项目；重复标识会破坏实体唯一定位，因此不能进入选择性应用。
  const comparison = buildAnnotationDiff(localDraft.currentProject, serverFile.payload);
  if (!comparison.ok) {
    return failure(comparison.errors.map(({ side, message }) =>
      `${side === "left" ? "本地草稿" : "服务器文件"}：${message}`).join("；"));
  }
  if (comparison.diff.hasDuplicateIdentities) {
    return failure("草稿或服务器文件存在重复稳定标识，请先导出并修复数据再整合。");
  }
  const normalizedSelection = normalizeMergeSelection(
    comparison.diff,
    "left-to-right",
    request.selectedEntryKeys,
  );
  if (!sameStringSet(normalizedSelection, new Set(request.selectedEntryKeys))) {
    return failure("所选实体已不再是可从本地草稿整合的差异，请重新选择。");
  }
  const plan = buildAnnotationMergePlan({
    leftProject: comparison.leftProject,
    rightProject: comparison.rightProject,
    diff: comparison.diff,
    direction: "left-to-right",
    selectedEntryKeys: [...normalizedSelection],
  });
  if (getAnnotationMergePlanFingerprint(plan) !== request.planFingerprint) {
    return failure("实体依赖或冲突状态已经变化，请重新检查整合预检。");
  }
  const resolutions = normalizeMergeConflictResolutions(
    plan,
    request.conflictResolutions,
  );
  const preparationState = getAnnotationMergePreparationState(plan, resolutions);
  if (!preparationState.canPrepare) {
    return failure(preparationState.reasons.join("；"));
  }

  // 应用只生成编辑器运行时草稿；IndexedDB 删除与服务器保存都不属于纯准备器职责。
  const applied = applyAnnotationMergePlan({
    sourceProject: comparison.leftProject,
    targetProject: comparison.rightProject,
    plan,
    resolutions,
  });
  if (!applied.ok) {
    return failure(applied.issues.map(({ message }) => message).join("；"));
  }
  return {
    ok: true,
    value: {
      targetFile: serverFile,
      draft: {
        id: input.createDraftId ? input.createDraftId() : crypto.randomUUID(),
        sourceKind: "browser-draft",
        sourceFileName: `${serverFile.resource.name} 的本地草稿`,
        targetFileName: serverFile.resource.name,
        baseProject: input.hydrateProject(comparison.rightProject),
        mergedProject: input.hydrateProject(applied.project),
        summary: applied.summary,
      },
    },
  };
}

// 最新选择必须与屏幕预检完全同集，不能静默裁掉已经失效的用户意图。
function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

// 所有准备失败统一返回用户可见摘要，不抛出含 payload 的内部错误。
function failure(message: string): PreparePlatformDraftConflictResult {
  return { ok: false, message };
}
