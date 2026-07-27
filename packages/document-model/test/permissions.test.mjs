import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeProjectMutations,
  collectPersistedPermissionTrackIds,
  collectProjectMutations,
  isMembershipActive,
  isProjectScopeAuthorized,
  validateProjectScope,
} from "../dist/index.js";

const baseProject = {
  video: { url: "", name: null, source: "url" },
  subtitleLines: [],
  characterAnnotations: [],
  gongcheAnnotations: [],
  banyanSections: [],
  banyanMarks: [],
  actionAnnotations: [],
  builtinTracks: [{
    id: "character-track",
    name: "逐字",
    type: "character",
    attachedPointTracks: [],
  }],
  customTracks: [{
    id: "hands",
    name: "手部",
    trackType: "action",
    typeOptions: [],
    blocks: [],
    attachedPointTracks: [],
    branching: {
      enabled: true,
      displayMode: "merged",
      lanes: [
        { id: "left", name: "左手", parentId: null, children: [] },
        {
          id: "right",
          name: "右手",
          parentId: null,
          children: [
            { id: "right-finger", name: "右手指法", parentId: "right", children: [] },
          ],
        },
      ],
    },
  }],
  activeTrackOrder: ["character-track", "hands"],
};

function permission(overrides = {}) {
  return {
    source: "membership",
    capabilities: ["view_project", "create_workspace"],
    timeRange: null,
    trackIds: [],
    expiresAt: null,
    canView: true,
    canEdit: true,
    canManage: false,
    isWorkspaceOwner: true,
    ...overrides,
  };
}

test("项目范围只接受合法的时间和轨道约束", () => {
  assert.deepEqual(validateProjectScope({
    timeRange: { startTime: 0, endTime: 10 },
    trackScope: { trackIds: ["character-track"] },
  }), { valid: true });
  assert.equal(validateProjectScope({
    timeRange: { startTime: 10, endTime: 10 },
  }).valid, false);
  assert.equal(validateProjectScope({
    trackScope: { trackIds: ["hands", "hands"] },
  }).valid, false);
  assert.equal(validateProjectScope({ legacyGrantId: "grant-1" }).valid, false);
});

test("过期成员不再拥有有效项目权限", () => {
  assert.equal(isMembershipActive({ expiresAt: null }), true);
  assert.equal(isMembershipActive({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), true);
  assert.equal(isMembershipActive({
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  }), false);
  assert.equal(isMembershipActive({ expiresAt: "invalid" }), false);
});

test("时间与轨道范围必须完整覆盖一次修改", () => {
  assert.equal(isProjectScopeAuthorized(
    ["character-track"],
    { startTime: 0, endTime: 10 },
    ["character-track"],
    { startTime: 2, endTime: 8 },
  ), true);
  assert.equal(isProjectScopeAuthorized(
    ["character-track"],
    { startTime: 0, endTime: 10 },
    ["character-track"],
    { startTime: 9, endTime: 11 },
  ), false);
  assert.equal(isProjectScopeAuthorized(
    ["character-track"],
    { startTime: 0, endTime: 10 },
    [],
    undefined,
  ), false);
});

test("板眼与附属打点使用点时间进行范围校验", () => {
  const before = structuredClone(baseProject);
  before.banyanMarks = [{ id: "mark-1", time: 5 }];
  const after = structuredClone(before);
  after.banyanMarks[0].time = 50;
  const mutations = collectProjectMutations(before, after);
  assert.deepEqual(mutations[0].timeRange, { startTime: 5, endTime: 50 });
  const result = authorizeProjectMutations(
    mutations,
    permission({
      timeRange: { startTime: 0, endTime: 10 },
      trackIds: ["banyan"],
    }),
  );
  assert.equal(result.allowed, false);
});

test("动作与工尺修改使用真实父轨道 id", () => {
  const after = structuredClone(baseProject);
  after.actionAnnotations.push({
    id: "action-1",
    trackId: "hands",
    label: "抬手",
    startTime: 1,
    endTime: 2,
  });
  after.gongcheAnnotations.push({
    id: "gongche-1",
    parentTrackId: "character-track",
    parentBlockId: "character-1",
    startTime: 1,
    endTime: 2,
    symbols: [],
  });
  const mutations = collectProjectMutations(baseProject, after);
  assert.deepEqual(
    mutations.map((mutation) => mutation.trackIds),
    [["hands"], ["character-track"]],
  );
});

test("共有分叉块要求所有所属分叉均在成员轨道范围内", () => {
  const after = structuredClone(baseProject);
  after.customTracks[0].blocks.push({
    id: "block-1",
    type: "夹扇",
    startTime: 2,
    endTime: 3,
    branchScope: { mode: "lanes", laneIds: ["left", "right"] },
  });
  const mutations = collectProjectMutations(baseProject, after);
  assert.deepEqual(mutations[0].trackIds, [
    "hands#branch:left",
    "hands#branch:right",
  ]);
  assert.equal(authorizeProjectMutations(
    mutations,
    permission({ trackIds: ["hands#branch:left"] }),
  ).allowed, false);
  assert.equal(authorizeProjectMutations(
    mutations,
    permission({ trackIds: ["hands"] }),
  ).allowed, true);
});

test("父轨授权覆盖递归子轨，子轨授权不会反向覆盖父轨或同级轨", () => {
  assert.equal(isProjectScopeAuthorized(
    ["hands"],
    null,
    ["hands#branch:right-finger"],
    { startTime: 1, endTime: 2 },
  ), true);
  assert.equal(isProjectScopeAuthorized(
    ["hands#branch:right"],
    null,
    ["hands"],
    { startTime: 1, endTime: 2 },
  ), false);
  assert.equal(isProjectScopeAuthorized(
    ["hands#branch:left"],
    null,
    ["hands#branch:right"],
    { startTime: 1, endTime: 2 },
  ), false);
});

test("结构修改必须由工作区管理权限执行", () => {
  const after = structuredClone(baseProject);
  after.activeTrackOrder = ["hands", "character-track"];
  const mutations = collectProjectMutations(baseProject, after);
  assert.equal(mutations[0].requiresManage, true);
  assert.equal(authorizeProjectMutations(
    mutations,
    permission({ canManage: false }),
  ).allowed, false);
  assert.equal(authorizeProjectMutations(
    mutations,
    permission({ canManage: true }),
  ).allowed, true);
});

test("轨道目录包含递归分叉与附属打点的稳定 scope id", () => {
  const project = structuredClone(baseProject);
  project.customTracks[0].attachedPointTracks.push({
    id: "breath",
    name: "呼吸",
    typeOptions: [],
    points: [],
  });
  const trackIds = collectPersistedPermissionTrackIds(project);
  assert.equal(trackIds.has("hands"), true);
  assert.equal(trackIds.has("hands#branch:left"), true);
  assert.equal(trackIds.has("hands#branch:right-finger"), true);
  assert.equal(trackIds.has("hands#point:breath"), true);
});

test("畸形集合与不存在的分叉归属不会被静默忽略", () => {
  const malformedArray = structuredClone(baseProject);
  malformedArray.characterAnnotations.push("not-an-annotation");
  const arrayMutations = collectProjectMutations(baseProject, malformedArray);
  assert.equal(arrayMutations.some((mutation) =>
    mutation.kind === "character.malformed" && mutation.requiresManage
  ), true);

  const malformedBranch = structuredClone(baseProject);
  malformedBranch.customTracks[0].blocks.push({
    id: "bad-branch",
    type: "错误归属",
    startTime: 1,
    endTime: 2,
    branchScope: { mode: "lanes", laneIds: ["missing-lane"] },
  });
  const branchMutations = collectProjectMutations(baseProject, malformedBranch);
  assert.equal(branchMutations.some((mutation) =>
    mutation.kind === "custom-block.create" && mutation.requiresManage
  ), true);
});
