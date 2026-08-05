import type { AnnotationMergePlan } from "./annotationMergePlan";

// 冲突选择只允许保留目标或采用来源；不提供隐式默认值，用户必须逐项确认。
export type AnnotationMergeConflictResolution =
  | "take-source"
  | "keep-target";

export type AnnotationMergeConflictResolutions = Readonly<
  Record<string, AnnotationMergeConflictResolution>
>;

export type AnnotationMergePreparationState = {
  canPrepare: boolean;
  unresolvedEntryKeys: string[];
  reasons: string[];
};

// 计划变化时剔除已经不是冲突的旧选择，防止交换方向或重选实体后沿用错误决定。
export function normalizeMergeConflictResolutions(
  plan: AnnotationMergePlan,
  current: AnnotationMergeConflictResolutions,
): AnnotationMergeConflictResolutions {
  const conflictKeys = new Set(plan.items
    .filter(({ action }) => action === "replace-conflict")
    .map(({ entryKey }) => entryKey));
  return Object.fromEntries(Object.entries(current).filter(([entryKey]) =>
    conflictKeys.has(entryKey))) as AnnotationMergeConflictResolutions;
}

// 单项更新返回新对象，便于 React 状态和准备请求保留不可变语义。
export function setMergeConflictResolution(
  current: AnnotationMergeConflictResolutions,
  entryKey: string,
  resolution: AnnotationMergeConflictResolution,
): AnnotationMergeConflictResolutions {
  return { ...current, [entryKey]: resolution };
}

// 未决冲突按照计划顺序返回，界面提示与应用器遍历保持一致。
export function getUnresolvedMergeConflictKeys(
  plan: AnnotationMergePlan,
  resolutions: AnnotationMergeConflictResolutions,
): string[] {
  return plan.items
    .filter(({ action, entryKey }) =>
      action === "replace-conflict" && !resolutions[entryKey])
    .map(({ entryKey }) => entryKey);
}

// 准备状态集中组合结构问题和人工决策，按钮禁用与后端前复核使用同一规则。
export function getAnnotationMergePreparationState(
  plan: AnnotationMergePlan,
  resolutions: AnnotationMergeConflictResolutions,
): AnnotationMergePreparationState {
  const unresolvedEntryKeys = getUnresolvedMergeConflictKeys(plan, resolutions);
  const reasons = [
    ...plan.issues.map(({ message }) => message),
    ...(unresolvedEntryKeys.length > 0
      ? [`仍有 ${unresolvedEntryKeys.length} 项冲突尚未决定。`]
      : []),
  ];
  return {
    canPrepare: plan.canApply && unresolvedEntryKeys.length === 0,
    unresolvedEntryKeys,
    reasons,
  };
}

// 指纹只包含决定合并语义的稳定字段，用于最新文件复核时识别比较结果是否已经过期。
export function getAnnotationMergePlanFingerprint(
  plan: AnnotationMergePlan,
): string {
  return JSON.stringify({
    direction: plan.direction,
    sourceSide: plan.sourceSide,
    targetSide: plan.targetSide,
    items: plan.items.map((item) => ({
      entryKey: item.entryKey,
      role: item.role,
      action: item.action,
      requiredBy: item.requiredBy,
    })),
    issues: plan.issues.map((issue) => ({
      code: issue.code,
      entryKey: issue.entryKey,
    })),
  });
}
