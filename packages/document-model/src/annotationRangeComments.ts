import type {
  AnnotationRangeCommentDraft,
  AnnotationRangeCommentFreshness,
  AnnotationRangeCommentLifecycle,
  AnnotationRangeCommentRecord,
} from "@xiqu/shared";
import {
  normalizeAnnotationReviewScope,
  type AnnotationConfirmationIssue,
  type AnnotationConfirmationValidationResult,
} from "./annotationConfirmations.js";

export const MAX_ANNOTATION_RANGE_COMMENT_BODY_LENGTH = 4_000;

// 评论草稿只补充正文规则；范围、revision 和文件标识继续复用审核事实的统一合同。
export function validateAnnotationRangeCommentDraft(
  draft: AnnotationRangeCommentDraft,
): AnnotationConfirmationValidationResult<AnnotationRangeCommentDraft> {
  const issues: AnnotationConfirmationIssue[] = [];
  const annotationFileId = normalizeIdentifier(draft.annotationFileId);
  if (!annotationFileId) {
    issues.push({
      code: "invalid_file_id",
      field: "annotationFileId",
      message: "标注文件标识不能为空或超过允许长度。",
    });
  }
  if (!Number.isInteger(draft.commentedRevision) || draft.commentedRevision < 1) {
    issues.push({
      code: "invalid_revision",
      field: "commentedRevision",
      message: "评论绑定的修订必须是正整数。",
    });
  }
  const scope = normalizeAnnotationReviewScope(draft.scope);
  if (!scope.ok) issues.push(...scope.issues);
  const body = draft.body.trim();
  if (!body) {
    issues.push({
      code: "body_required",
      field: "body",
      message: "范围评论正文不能为空。",
    });
  } else if (body.length > MAX_ANNOTATION_RANGE_COMMENT_BODY_LENGTH) {
    issues.push({
      code: "body_too_long",
      field: "body",
      message: `范围评论不能超过 ${MAX_ANNOTATION_RANGE_COMMENT_BODY_LENGTH} 个字符。`,
    });
  }
  if (issues.length || !annotationFileId || !scope.ok || !body) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      annotationFileId,
      commentedRevision: draft.commentedRevision,
      scope: scope.value,
      body,
    },
  };
}

// 撤回主体和时间必须成组出现，避免半截历史被误认为有效评论。
export function getAnnotationRangeCommentLifecycle(
  record: AnnotationRangeCommentRecord,
): AnnotationConfirmationValidationResult<AnnotationRangeCommentLifecycle> {
  const hasWithdrawnAt = typeof record.withdrawnAt === "string" && record.withdrawnAt.length > 0;
  const validWithdrawnAt = hasWithdrawnAt && Number.isFinite(Date.parse(record.withdrawnAt!));
  const hasWithdrawnBy = Boolean(record.withdrawnBy?.id);
  const hasReason = Boolean(record.withdrawReason?.trim());
  if (
    hasWithdrawnAt !== hasWithdrawnBy ||
    (hasWithdrawnAt && !validWithdrawnAt) ||
    (!hasWithdrawnAt && hasReason)
  ) {
    return {
      ok: false,
      issues: [{
        code: "invalid_revocation",
        field: "withdrawal",
        message: "撤回时间和撤回账号必须同时存在。",
      }],
    };
  }
  return { ok: true, value: hasWithdrawnAt ? "withdrawn" : "active" };
}

// 评论保存后仍是历史意见；freshness 仅说明它基于当前还是旧修订。
export function getAnnotationRangeCommentFreshness(
  commentedRevision: number,
  currentRevision: number,
): AnnotationConfirmationValidationResult<AnnotationRangeCommentFreshness> {
  if (!Number.isInteger(commentedRevision) || commentedRevision < 1) {
    return invalidRevision("评论记录绑定的修订必须是正整数。");
  }
  if (!Number.isInteger(currentRevision) || currentRevision < commentedRevision) {
    return invalidRevision("当前修订不能早于评论记录绑定的修订。", "currentRevision");
  }
  return {
    ok: true,
    value: currentRevision === commentedRevision ? "current" : "stale",
  };
}

function normalizeIdentifier(value: string): string | null {
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

function invalidRevision(
  message: string,
  field = "commentedRevision",
): AnnotationConfirmationValidationResult<never> {
  return {
    ok: false,
    issues: [{ code: "invalid_revision", field, message }],
  };
}
