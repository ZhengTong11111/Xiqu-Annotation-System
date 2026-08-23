import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationFile, ResourceEntry } from "@xiqu/shared";
import type { ProjectData } from "../types";
import { buildAnnotationDiff } from "./annotationDiff";
import { getAnnotationMergePlanFingerprint } from "./annotationMergeConflict";
import type { AnnotationMergePreparationRequest } from "./annotationMergeDraft";
import { buildAnnotationMergePlan } from "./annotationMergePlan";
import { prepareAnnotationMergeDraft } from "./annotationMergePreparation";

// 成功准备必须返回目标基线和未保存的合并结果，且不修改两份网络响应。
test("最新文件可准备为目标编辑器草稿", () => {
  const left = annotationFile("left", 2, projectWithLine("line-1", "来源"), ["read"]);
  const right = annotationFile("right", 4, emptyProject(), ["read", "write"]);
  const request = requestFor(left, right, ["subtitle_lines:line-1"]);
  const before = JSON.stringify({ left, right });
  const result = prepareAnnotationMergeDraft({
    leftFile: left,
    rightFile: right,
    request,
    hydrateProject: structuredClone,
    createDraftId: () => "draft-1",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.targetFile.resource.id, "right");
  assert.equal(result.value.draft.baseProject.subtitleLines.length, 0);
  assert.equal(result.value.draft.mergedProject.subtitleLines[0]!.text, "来源");
  assert.equal(JSON.stringify({ left, right }), before);
});

// revision 和目标写权限都在最新响应上复核，不信任比较对话框打开时的资源快照。
test("过期版本和权限变化阻断准备", () => {
  const left = annotationFile("left", 2, projectWithLine("line-1", "来源"), ["read"]);
  const right = annotationFile("right", 4, emptyProject(), ["read", "write"]);
  const request = requestFor(left, right, ["subtitle_lines:line-1"]);
  const staleRight = structuredClone(right);
  staleRight.revision = 5;
  const stale = prepareAnnotationMergeDraft({
    leftFile: left,
    rightFile: staleRight,
    request,
    hydrateProject: structuredClone,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.message, /新修订/);

  const readonlyRight = structuredClone(right);
  readonlyRight.resource.permission.capabilities = ["read"];
  const denied = prepareAnnotationMergeDraft({
    leftFile: left,
    rightFile: readonlyRight,
    request,
    hydrateProject: structuredClone,
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.message, /编辑权限/);
});

// 指纹变化说明依赖闭包或冲突语义已改变，不能继续使用旧屏幕上的人工决定。
test("语义指纹不一致阻断准备", () => {
  const left = annotationFile("left", 1, projectWithLine("line-1", "来源"), ["read"]);
  const right = annotationFile("right", 1, emptyProject(), ["read", "write"]);
  const request = requestFor(left, right, ["subtitle_lines:line-1"]);
  request.planFingerprint = "outdated";
  const result = prepareAnnotationMergeDraft({
    leftFile: left,
    rightFile: right,
    request,
    hydrateProject: structuredClone,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /依赖或冲突状态/);
});

// 默认草稿 id 路径必须直接调用宿主 crypto，避免浏览器中出现 Illegal invocation。
test("默认草稿标识可以正常生成", () => {
  const left = annotationFile("left", 1, projectWithLine("line-1", "来源"), ["read"]);
  const right = annotationFile("right", 1, emptyProject(), ["read", "write"]);
  const result = prepareAnnotationMergeDraft({
    leftFile: left,
    rightFile: right,
    request: requestFor(left, right, ["subtitle_lines:line-1"]),
    hydrateProject: structuredClone,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.value.draft.id.length > 0);
});

function requestFor(
  left: AnnotationFile<unknown>,
  right: AnnotationFile<unknown>,
  selectedEntryKeys: string[],
): AnnotationMergePreparationRequest {
  const comparison = buildAnnotationDiff(left.payload, right.payload);
  assert.equal(comparison.ok, true);
  if (!comparison.ok) throw new Error("测试项目应能比较");
  const plan = buildAnnotationMergePlan({
    leftProject: comparison.leftProject,
    rightProject: comparison.rightProject,
    diff: comparison.diff,
    direction: "left-to-right",
    selectedEntryKeys,
  });
  return {
    leftResourceId: left.resource.id,
    rightResourceId: right.resource.id,
    leftRevision: left.revision,
    rightRevision: right.revision,
    direction: "left-to-right",
    selectedEntryKeys,
    conflictResolutions: {},
    planFingerprint: getAnnotationMergePlanFingerprint(plan),
  };
}

function annotationFile(
  id: string,
  revision: number,
  payload: ProjectData,
  capabilities: ResourceEntry["permission"]["capabilities"],
): AnnotationFile<unknown> {
  const user = { id: "user-1", accountName: "admin", displayName: "管理员" };
  return {
    resource: {
      id,
      parentId: null,
      type: "annotation_file",
      name: `${id}.json`,
      owner: user,
      breakPermissionInheritance: false,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      childCount: 0,
      revision,
      favorite: false,
      permission: {
        source: "direct",
        capabilities: [...capabilities],
        inheritedFrom: [],
        isOwner: false,
        canManagePermissions: false,
      },
    },
    payload,
    revision,
    operationCursor: `cursor-${revision}`,
    lastEditor: user,
    lastSavedAt: "2026-08-02T00:00:00.000Z",
  };
}

function projectWithLine(id: string, text: string): ProjectData {
  const project = emptyProject();
  project.subtitleLines.push({ id, text, startTime: 0, endTime: 1, deliveryMode: null, roleType: null });
  return project;
}

function emptyProject(): ProjectData {
  return {
    video: { url: "", name: null, source: "url" },
    sentenceAnnotationConfig: { roleOptions: [] },
    subtitleLines: [],
    characterAnnotations: [],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字轨",
      type: "character",
      attachedPointTracks: [],
    }],
    customTracks: [],
    activeTrackOrder: ["character-track"],
  };
}
