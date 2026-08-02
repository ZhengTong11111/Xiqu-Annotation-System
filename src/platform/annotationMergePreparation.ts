import type { AnnotationFile } from "@xiqu/shared";
import type { ProjectData } from "../types";
import { buildAnnotationDiff } from "./annotationDiff";
import { applyAnnotationMergePlan } from "./annotationMergeApply";
import {
  getAnnotationMergePlanFingerprint,
  getAnnotationMergePreparationState,
  normalizeMergeConflictResolutions,
} from "./annotationMergeConflict";
import type {
  AnnotationMergeDraft,
  AnnotationMergePreparationRequest,
} from "./annotationMergeDraft";
import { buildAnnotationMergePlan } from "./annotationMergePlan";
import { normalizeMergeSelection } from "./annotationMergeSelection";

export type PreparedAnnotationMerge = {
  targetFile: AnnotationFile<unknown>;
  draft: AnnotationMergeDraft;
};

export type PrepareAnnotationMergeResult =
  | { ok: true; value: PreparedAnnotationMerge }
  | { ok: false; message: string };

// 纯准备器以最新网络响应重建整套计划；React 不参与任何实体匹配、冲突或应用判断。
export function prepareAnnotationMergeDraft(input: {
  leftFile: AnnotationFile<unknown>;
  rightFile: AnnotationFile<unknown>;
  request: AnnotationMergePreparationRequest;
  hydrateProject: (project: ProjectData) => ProjectData;
  createDraftId?: () => string;
}): PrepareAnnotationMergeResult {
  const { leftFile, rightFile, request } = input;
  if (
    leftFile.resource.id !== request.leftResourceId ||
    rightFile.resource.id !== request.rightResourceId
  ) {
    return failure("比较文件身份已经变化，请关闭后重新选择文件。");
  }
  if (
    leftFile.revision !== request.leftRevision ||
    rightFile.revision !== request.rightRevision
  ) {
    return failure("比较期间文件已产生新修订，请重新读取差异后再准备整合。");
  }
  const sourceFile = request.direction === "left-to-right" ? leftFile : rightFile;
  const targetFile = request.direction === "left-to-right" ? rightFile : leftFile;
  if (!sourceFile.resource.permission.capabilities.includes("read")) {
    return failure("当前账号已失去来源文件的查看权限。");
  }
  if (!targetFile.resource.permission.capabilities.includes("write")) {
    return failure("当前账号没有目标文件的编辑权限。");
  }

  // 正式 diff 同时完成旧文件迁移；重复稳定标识会破坏一对一实体定位，因此强制阻断。
  const comparison = buildAnnotationDiff(leftFile.payload, rightFile.payload);
  if (!comparison.ok) {
    return failure(comparison.errors.map(({ message }) => message).join("；"));
  }
  if (comparison.diff.hasDuplicateIdentities) {
    return failure("文件存在重复稳定标识，请先修复数据再进行选择性整合。");
  }
  const normalizedSelection = normalizeMergeSelection(
    comparison.diff,
    request.direction,
    request.selectedEntryKeys,
  );
  if (!sameStringSet(normalizedSelection, new Set(request.selectedEntryKeys))) {
    return failure("所选实体已不再适用于当前整合方向，请重新选择。");
  }
  const plan = buildAnnotationMergePlan({
    leftProject: comparison.leftProject,
    rightProject: comparison.rightProject,
    diff: comparison.diff,
    direction: request.direction,
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

  // 应用在服务端保存形态上完成，成功后才分别水合目标基线和合并结果。
  const sourceProject = plan.sourceSide === "left"
    ? comparison.leftProject
    : comparison.rightProject;
  const targetProject = plan.targetSide === "left"
    ? comparison.leftProject
    : comparison.rightProject;
  const applied = applyAnnotationMergePlan({
    sourceProject,
    targetProject,
    plan,
    resolutions,
  });
  if (!applied.ok) {
    return failure(applied.issues.map(({ message }) => message).join("；"));
  }
  return {
    ok: true,
    value: {
      targetFile,
      draft: {
        // 浏览器原生方法必须通过宿主对象调用，不能把 randomUUID 脱离 crypto 后直接执行。
        id: input.createDraftId ? input.createDraftId() : crypto.randomUUID(),
        sourceFileName: sourceFile.resource.name,
        targetFileName: targetFile.resource.name,
        baseProject: input.hydrateProject(targetProject),
        mergedProject: input.hydrateProject(applied.project),
        summary: applied.summary,
      },
    },
  };
}

// 集合比较确认最新 diff 没有裁掉或替换客户端所选实体。
function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function failure(message: string): PrepareAnnotationMergeResult {
  return { ok: false, message };
}
