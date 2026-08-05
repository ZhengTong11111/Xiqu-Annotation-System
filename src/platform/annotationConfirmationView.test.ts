import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationConfirmationRecord } from "@xiqu/shared";
import { mockProject } from "../mockData";
import {
  buildAnnotationConfirmationViewRecords,
  canShowAnnotationConfirmationRevoke,
  formatAnnotationConfirmationTargets,
  getAnnotationConfirmationCreateBlocker,
  getAnnotationConfirmationTrackOptions,
  layoutAnnotationConfirmationTimelineItems,
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
  const layout = layoutAnnotationConfirmationTimelineItems(records);
  assert.deepEqual(layout.map((item) => [item.record.id, item.lane]), [
    ["a", 0],
    ["b", 1],
    ["c", 0],
  ]);
});

test("创建阻断优先检查权限、加载、范围、dirty 与 revision", () => {
  const base = {
    canReview: true,
    hasRange: true,
    hasUnsavedChanges: false,
    editorRevision: 3,
    serverRevision: 3,
    loading: false,
  };
  assert.equal(getAnnotationConfirmationCreateBlocker({ ...base, canReview: false }), "review_required");
  assert.equal(getAnnotationConfirmationCreateBlocker({ ...base, loading: true }), "loading");
  assert.equal(getAnnotationConfirmationCreateBlocker({ ...base, hasRange: false }), "range_required");
  assert.equal(getAnnotationConfirmationCreateBlocker({ ...base, hasUnsavedChanges: true }), "unsaved_changes");
  assert.equal(getAnnotationConfirmationCreateBlocker({ ...base, serverRevision: 4 }), "revision_mismatch");
  assert.equal(getAnnotationConfirmationCreateBlocker(base), null);
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
