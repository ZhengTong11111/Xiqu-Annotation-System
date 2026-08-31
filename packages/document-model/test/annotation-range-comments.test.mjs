import assert from "node:assert/strict";
import test from "node:test";
import {
  canCreateAnnotationRangeComment,
  canWithdrawAnnotationRangeComment,
  getAnnotationRangeCommentFreshness,
  getAnnotationRangeCommentLifecycle,
  validateAnnotationRangeCommentDraft,
} from "../dist/index.js";

const scope = { startTime: 1, endTime: 2, targets: { mode: "all" } };

function record(overrides = {}) {
  return {
    id: "comment-1",
    annotationFileId: "file-1",
    commentedRevision: 3,
    scope,
    kind: "review_comment",
    body: "检查唱词与动作的衔接。",
    createdBy: { id: "user-1", accountName: "teacher", displayName: "教师" },
    createdAt: "2026-08-22T00:00:00.000Z",
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawReason: null,
    ...overrides,
  };
}

test("范围评论规范化正文并复用审核作用域", () => {
  const result = validateAnnotationRangeCommentDraft({
    annotationFileId: " file-1 ",
    commentedRevision: 3,
    scope,
    kind: "review_comment",
    body: "  检查唱词与动作的衔接。  ",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.annotationFileId, "file-1");
    assert.equal(result.value.body, "检查唱词与动作的衔接。");
  }
});

test("范围评论拒绝空正文、超长正文和非法 revision", () => {
  const blank = validateAnnotationRangeCommentDraft({
    annotationFileId: "file-1", commentedRevision: 0, scope, kind: "review_comment", body: "   ",
  });
  assert.equal(blank.ok, false);
  if (!blank.ok) {
    assert.deepEqual(new Set(blank.issues.map((issue) => issue.code)), new Set([
      "invalid_revision", "body_required",
    ]));
  }
  const long = validateAnnotationRangeCommentDraft({
    annotationFileId: "file-1", commentedRevision: 1, scope, kind: "review_comment", body: "字".repeat(4_001),
  });
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.issues[0].code, "body_too_long");
});

test("审核评论和编辑反馈分别要求 review 与 write", () => {
  const writeOnly = {
    actorUserId: "editor-1",
    canRead: true,
    canReview: false,
    canWrite: true,
    isAdminOrOwner: false,
  };
  assert.deepEqual(canCreateAnnotationRangeComment(writeOnly, "review_comment"), {
    allowed: false,
    reason: "review_required",
  });
  assert.deepEqual(canCreateAnnotationRangeComment(writeOnly, "editor_feedback"), {
    allowed: true,
    reason: "allowed",
  });
  assert.equal(canWithdrawAnnotationRangeComment(
    writeOnly,
    "editor_feedback",
    "other-editor",
  ).reason, "creator_or_manager_required");
  assert.equal(canWithdrawAnnotationRangeComment(
    { ...writeOnly, isAdminOrOwner: true },
    "editor_feedback",
    "other-editor",
  ).allowed, true);
});

test("范围评论撤回字段严格成组且 freshness 只跟随 revision", () => {
  assert.deepEqual(getAnnotationRangeCommentLifecycle(record()), { ok: true, value: "active" });
  assert.deepEqual(getAnnotationRangeCommentLifecycle(record({
    withdrawnAt: "2026-08-22T01:00:00.000Z",
    withdrawnBy: { id: "user-1", accountName: "teacher", displayName: "教师" },
  })), { ok: true, value: "withdrawn" });
  assert.equal(getAnnotationRangeCommentLifecycle(record({ withdrawReason: "缺少撤回主体" })).ok, false);
  assert.deepEqual(getAnnotationRangeCommentFreshness(3, 3), { ok: true, value: "current" });
  assert.deepEqual(getAnnotationRangeCommentFreshness(3, 4), { ok: true, value: "stale" });
  assert.equal(getAnnotationRangeCommentFreshness(3, 2).ok, false);
});
