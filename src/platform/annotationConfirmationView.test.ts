import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationConfirmationRecord, AnnotationRangeCommentRecord } from "@xiqu/shared";
import { mockProject } from "../mockData";
import {
  buildAnnotationConfirmationViewRecords,
  buildAnnotationRangeCommentViewRecords,
  canShowAnnotationConfirmationRevoke,
  canShowAnnotationRangeCommentWithdraw,
  formatAnnotationConfirmationTargets,
  getAnnotationReviewCreateBlocker,
  getAnnotationConfirmationTrackOptions,
  layoutAnnotationReviewTimelineItems,
} from "./annotationConfirmationView";

// 测试数据构造器集中生成完整确认记录，单项用例只覆盖自己关心的字段。
function createRecord(
  id: string,
  startTime: number,
  endTime: number,
  overrides: Partial<AnnotationConfirmationRecord> = {},
): AnnotationConfirmationRecord {
  const base: AnnotationConfirmationRecord = {
    id,
    annotationFileId: "file-1",
    confirmedRevision: 3,
    scope: { startTime, endTime, targets: { mode: "all" } },
    note: null,
    createdBy: { id: "reviewer-1", accountName: "reviewer", displayName: "审核员" },
    createdAt: "2026-08-02T00:00:00.000Z",
  };
  // 用例可覆盖判别联合字段；最终记录仍由各测试负责保持符合目标场景。
  return { ...base, ...overrides } as AnnotationConfirmationRecord;
}

test("轨道选项只包含真实顶层持久轨道", () => {
  const project = {
    ...mockProject,
    customTracks: [{
      ...mockProject.customTracks[0],
      id: "custom-a",
      name: "动作层",
    }],
  };
  assert.deepEqual(getAnnotationConfirmationTrackOptions(project), [
    { id: "character-track", label: project.builtinTracks[0].name },
    { id: "custom-a", label: "动作层" },
  ]);
});

test("作用域摘要保留未知历史轨道并翻译领域", () => {
  const labels = new Map([["track-a", "手部动作"]]);
  assert.equal(formatAnnotationConfirmationTargets({ mode: "all" }, labels), "全部标注");
  assert.equal(
    formatAnnotationConfirmationTargets({
      mode: "domains",
      domains: ["character_annotations", "gongche_annotations"],
    }, labels),
    "逐字标注、工尺谱",
  );
  assert.equal(
    formatAnnotationConfirmationTargets({
      mode: "tracks",
      trackIds: ["track-a", "removed"],
    }, labels),
    "手部动作、已移除轨道 removed",
  );
});

test("时间轴分层允许首尾相接并稳定拆开真实重叠", () => {
  const records = buildAnnotationConfirmationViewRecords([
    createRecord("b", 1, 3),
    createRecord("a", 0, 2),
    createRecord("c", 3, 4),
  ], 3, []);
  const comments: AnnotationRangeCommentRecord[] = [{
    id: "comment-1",
    annotationFileId: "file-1",
    commentedRevision: 3,
    scope: { startTime: 2, endTime: 3.5, targets: { mode: "all" } },
    kind: "review_comment",
    body: "检查衔接",
    createdBy: { id: "reviewer-2", accountName: "teacher", displayName: "教师" },
    createdAt: "2026-08-02T01:00:00.000Z",
  }];
  const layout = layoutAnnotationReviewTimelineItems({
    confirmations: records,
    comments: buildAnnotationRangeCommentViewRecords(comments, 3, []),
  });
  assert.deepEqual(layout.map((item) => [item.id, item.kind, item.lane]), [
    ["confirmation:a", "confirmation", 0],
    ["confirmation:b", "confirmation", 1],
    ["range-record:comment-1", "comment", 0],
    ["confirmation:c", "confirmation", 1],
  ]);
});

test("确认与评论即使原始 UUID 相同也保持独立时间轴身份", () => {
  const sharedId = "same-id";
  const confirmations = buildAnnotationConfirmationViewRecords([
    createRecord(sharedId, 0, 1),
  ], 3, []);
  const comments = buildAnnotationRangeCommentViewRecords([{
    id: sharedId,
    annotationFileId: "file-1",
    commentedRevision: 3,
    scope: { startTime: 1, endTime: 2, targets: { mode: "all" } },
    kind: "review_comment",
    body: "同 UUID 的另一张事实表记录",
    createdBy: { id: "reviewer-2", accountName: "teacher", displayName: "教师" },
    createdAt: "2026-08-02T01:00:00.000Z",
  }], 3, []);

  const result = layoutAnnotationReviewTimelineItems({ confirmations, comments });
  assert.deepEqual(result.map((item) => [item.id, item.recordId, item.recordType]), [
    ["confirmation:same-id", sharedId, "confirmation"],
    ["range-record:same-id", sharedId, "range_record"],
  ]);
});

test("创建阻断优先检查权限、加载、范围、dirty 与 revision", () => {
  const base = {
    canCreate: true,
    hasRange: true,
    hasUnsavedChanges: false,
    editorRevision: 3,
    serverRevision: 3,
    loading: false,
  };
  assert.equal(getAnnotationReviewCreateBlocker({ ...base, canCreate: false }), "permission_required");
  assert.equal(getAnnotationReviewCreateBlocker({ ...base, loading: true }), "loading");
  assert.equal(getAnnotationReviewCreateBlocker({ ...base, hasRange: false }), "range_required");
  assert.equal(getAnnotationReviewCreateBlocker({ ...base, hasUnsavedChanges: true }), "unsaved_changes");
  assert.equal(getAnnotationReviewCreateBlocker({ ...base, serverRevision: 4 }), "revision_mismatch");
  assert.equal(getAnnotationReviewCreateBlocker(base), null);
});

test("撤销入口仅向创建者、owner 或管理员开放", () => {
  const record = buildAnnotationConfirmationViewRecords([createRecord("a", 0, 1)], 3, [])[0];
  const base = {
    record,
    canReview: true,
    currentUserId: "other",
    currentUserRoles: ["reviewer" as const],
    hasOwnerAuthority: false,
  };
  assert.equal(canShowAnnotationConfirmationRevoke(base), false);
  assert.equal(canShowAnnotationConfirmationRevoke({ ...base, currentUserId: "reviewer-1" }), true);
  assert.equal(canShowAnnotationConfirmationRevoke({ ...base, hasOwnerAuthority: true }), true);
  assert.equal(canShowAnnotationConfirmationRevoke({
    ...base,
    currentUserRoles: ["admin"],
  }), true);
});

test("评论撤回入口复用作者、owner 和管理员边界", () => {
  const record = buildAnnotationRangeCommentViewRecords([{
    id: "comment-a",
    annotationFileId: "file-1",
    commentedRevision: 3,
    scope: { startTime: 0, endTime: 1, targets: { mode: "all" } },
    kind: "review_comment",
    body: "需要复核",
    createdBy: { id: "reviewer-1", accountName: "reviewer", displayName: "审核员" },
    createdAt: "2026-08-22T00:00:00.000Z",
  }], 3, [])[0];
  const base = {
    record,
    canReview: true,
    canWrite: false,
    currentUserId: "other",
    currentUserRoles: ["reviewer" as const],
    hasOwnerAuthority: false,
  };
  assert.equal(canShowAnnotationRangeCommentWithdraw(base), false);
  assert.equal(canShowAnnotationRangeCommentWithdraw({ ...base, currentUserId: "reviewer-1" }), true);
  assert.equal(canShowAnnotationRangeCommentWithdraw({ ...base, hasOwnerAuthority: true }), true);
  assert.equal(canShowAnnotationRangeCommentWithdraw({ ...base, currentUserRoles: ["admin"] }), true);
});

test("编辑反馈使用 write 权限并进入独立黄色时间轴种类", () => {
  const record = buildAnnotationRangeCommentViewRecords([{
    id: "feedback-a",
    annotationFileId: "file-1",
    commentedRevision: 3,
    scope: { startTime: 4, endTime: 6, targets: { mode: "all" } },
    kind: "editor_feedback",
    body: "请审核者关注此处节奏。",
    createdBy: { id: "editor-1", accountName: "editor", displayName: "标注者" },
    createdAt: "2026-08-31T00:00:00.000Z",
  }], 3, [])[0];
  const timeline = layoutAnnotationReviewTimelineItems({ confirmations: [], comments: [record] });
  assert.equal(timeline[0]?.kind, "feedback");
  assert.match(timeline[0]?.label ?? "", /^反馈/);
  assert.equal(canShowAnnotationRangeCommentWithdraw({
    record,
    canReview: false,
    canWrite: true,
    currentUserId: "editor-1",
    currentUserRoles: ["annotator"],
    hasOwnerAuthority: false,
  }), true);
  assert.equal(canShowAnnotationRangeCommentWithdraw({
    record,
    canReview: true,
    canWrite: false,
    currentUserId: "editor-1",
    currentUserRoles: ["reviewer"],
    hasOwnerAuthority: false,
  }), false);
});
