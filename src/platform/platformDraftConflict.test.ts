import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationFile, ResourceEntry } from "@xiqu/shared";
import type { ProjectData } from "../types";
import { buildAnnotationDiff } from "./annotationDiff";
import { getAnnotationMergePlanFingerprint } from "./annotationMergeConflict";
import { buildAnnotationMergePlan } from "./annotationMergePlan";
import { buildPlatformDraftRecord } from "./platformDraft";
import {
  preparePlatformDraftConflict,
  type PlatformDraftConflictPreparationRequest,
} from "./platformDraftConflict";

// stale 草稿只把明确选择的本地实体整合到最新服务器基线，并保持两侧输入不可变。
test("stale 草稿可准备为服务器目标的未保存整合草稿", () => {
  const local = projectWithLines([
    ["shared", "本地修改"],
    ["local-only", "本地独有"],
  ]);
  const server = projectWithLines([
    ["shared", "服务器修改"],
    ["server-only", "服务器独有"],
  ]);
  const localDraft = draftFor(local, 2, 900);
  const serverFile = annotationFile(3, server, ["read", "write"]);
  const request = requestFor(localDraft, serverFile, ["subtitle_lines:local-only"]);
  const before = JSON.stringify({ localDraft, serverFile, request });
  const result = preparePlatformDraftConflict({
    localDraft,
    serverFile,
    request,
    hydrateProject: structuredClone,
    createDraftId: () => "draft-conflict-1",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.draft.baseProject.subtitleLines.map(({ id }) => id), [
    "shared",
    "server-only",
  ]);
  assert.deepEqual(result.value.draft.mergedProject.subtitleLines.map(({ id }) => id), [
    "shared",
    "local-only",
    "server-only",
  ]);
  assert.equal(JSON.stringify({ localDraft, serverFile, request }), before);
});

// 草稿更新、服务器推进或写权限撤销都必须使屏幕上的旧计划失效。
test("权威草稿与服务器上下文变化会阻断准备", () => {
  const localDraft = draftFor(projectWithLines([["line-1", "本地"]]), 2, 900);
  const serverFile = annotationFile(3, emptyProject(), ["read", "write"]);
  const request = requestFor(localDraft, serverFile, ["subtitle_lines:line-1"]);

  const updatedDraft = { ...localDraft, updatedAt: 901 };
  assertFailure(updatedDraft, serverFile, request, /另一个页面/);
  assertFailure(localDraft, { ...serverFile, revision: 4 }, request, /新修订/);
  const readOnly = structuredClone(serverFile);
  readOnly.resource.permission.capabilities = ["read"];
  assertFailure(localDraft, readOnly, request, /编辑权限/);
});

// 旧选择与旧指纹不能在新 diff 中被静默修剪或继续应用。
test("失效选择和计划指纹会阻断准备", () => {
  const localDraft = draftFor(projectWithLines([["line-1", "本地"]]), 2, 900);
  const serverFile = annotationFile(3, emptyProject(), ["read", "write"]);
  const request = requestFor(localDraft, serverFile, ["subtitle_lines:line-1"]);
  assertFailure(localDraft, serverFile, {
    ...request,
    selectedEntryKeys: ["subtitle_lines:server-only"],
  }, /所选实体/);
  assertFailure(localDraft, serverFile, {
    ...request,
    planFingerprint: "outdated",
  }, /依赖或冲突状态/);
});

// 失败断言集中验证准备器不会返回任何可进入编辑器的半成品。
function assertFailure(
  localDraft: ReturnType<typeof draftFor>,
  serverFile: AnnotationFile<unknown>,
  request: PlatformDraftConflictPreparationRequest,
  pattern: RegExp,
) {
  const result = preparePlatformDraftConflict({
    localDraft,
    serverFile,
    request,
    hydrateProject: structuredClone,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, pattern);
}

// 测试请求模拟屏幕预检生成的稳定选择与计划指纹。
function requestFor(
  localDraft: ReturnType<typeof draftFor>,
  serverFile: AnnotationFile<unknown>,
  selectedEntryKeys: string[],
): PlatformDraftConflictPreparationRequest {
  const comparison = buildAnnotationDiff(localDraft.currentProject, serverFile.payload);
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
    userId: localDraft.userId,
    annotationFileId: localDraft.annotationFileId,
    draftUpdatedAt: localDraft.updatedAt,
    draftRemoteBaseRevision: localDraft.remoteBaseRevision,
    serverRevision: serverFile.revision,
    selectedEntryKeys,
    conflictResolutions: {},
    planFingerprint: getAnnotationMergePlanFingerprint(plan),
  };
}

// 草稿夹具使用正式 builder，避免测试手写一个生产环境不会生成的 envelope。
function draftFor(project: ProjectData, remoteRevision: number, now: number) {
  return buildPlatformDraftRecord({
    userId: "user-1",
    annotationFileId: "file-1",
    remoteBaseRevision: remoteRevision,
    recoveryState: {
      currentProject: project,
      savedProject: emptyProject(),
      currentTrackSnapEnabled: {},
      savedTrackSnapEnabled: {},
      pendingOperations: [],
      localRevision: 1,
      savedRevision: 0,
      lastChangedAt: now,
      lastSavedAt: null,
    },
    now,
  });
}

// 服务器文件夹具保留真实 ResourceEntry 权限形状，供准备器复核 write 能力。
function annotationFile(
  revision: number,
  payload: ProjectData,
  capabilities: ResourceEntry["permission"]["capabilities"],
): AnnotationFile<unknown> {
  const now = new Date(1_785_700_000_000).toISOString();
  const user = { id: "owner-1", accountName: "owner", displayName: "所有者" };
  return {
    resource: {
      id: "file-1",
      parentId: "project-1",
      type: "annotation_file",
      name: "测试标注.json",
      owner: user,
      breakPermissionInheritance: false,
      createdAt: now,
      updatedAt: now,
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
    revision,
    payload,
    lastEditor: user,
    lastSavedAt: now,
  };
}

// 句级夹具用稳定 id 和时间顺序构造可预测的领域差异。
function projectWithLines(entries: Array<[string, string]>): ProjectData {
  const project = emptyProject();
  project.subtitleLines = entries.map(([id, text], index) => ({
    id,
    startTime: index,
    endTime: index + 0.8,
    text,
  }));
  return project;
}

// 最小合法项目仍包含内建逐字轨，确保正式迁移入口可以识别。
function emptyProject(): ProjectData {
  return {
    video: { url: "", name: null, source: "url" },
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
