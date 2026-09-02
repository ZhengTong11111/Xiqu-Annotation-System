import type {
  AlignmentQualityAssessmentScope,
  AlignmentQualityIssueCode,
  AlignmentQualityVerdict,
} from "@xiqu/shared";

export type AlignmentQualityAssessmentRetry = {
  key: string;
  actionId: string;
};

/** 表单能力与结论组合在一个纯函数中判断，UI 禁用态和提交入口不能各自形成一套规则。 */
export function canSubmitAlignmentQualityAssessment(
  scope: AlignmentQualityAssessmentScope,
  verdict: AlignmentQualityVerdict,
  issues: readonly AlignmentQualityIssueCode[],
  canWrite: boolean,
  canReview: boolean,
) {
  if (scope === "editor" ? !canWrite : !canReview) return false;
  return verdict === "correct" ? issues.length === 0 : issues.length > 0;
}

/** 只有 application、scope、结论和规范原因完全相同，模糊失败后的显式重试才能复用 action UUID。 */
export function resolveAlignmentQualityAssessmentAction(
  previous: AlignmentQualityAssessmentRetry | null,
  input: {
    applicationId: string;
    scope: AlignmentQualityAssessmentScope;
    verdict: AlignmentQualityVerdict;
    issueCodes: readonly AlignmentQualityIssueCode[];
  },
  createId: () => string,
): AlignmentQualityAssessmentRetry {
  const key = JSON.stringify([
    input.applicationId,
    input.scope,
    input.verdict,
    input.issueCodes,
  ]);
  return previous?.key === key ? previous : { key, actionId: createId() };
}
