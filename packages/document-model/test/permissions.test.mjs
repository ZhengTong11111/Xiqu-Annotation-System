import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeProjectMutations,
  canPerformActionWithGrants,
  collectPersistedPermissionTrackIds,
  collectProjectMutations,
  resolveEffectiveDocumentPermission,
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
        { id: "right", name: "右手", parentId: null, children: [] },
      ],
    },
  }],
  activeTrackOrder: ["character-track", "hands"],
};

function grant(overrides = {}) {
  return {
    id: "grant-1",
    userId: "user-a",
    actions: ["edit"],
    scope: {
      projectId: "project-1",
      documentId: "document-1",
    },
    expiresAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function permission(grants) {
  return resolveEffectiveDocumentPermission({
    userId: "user-a",
    isOwner: false,
    isAdmin: false,
    grants,
    documentId: "document-1",
    projectId: "project-1",
  });
}

test("grant 只授权目标用户，manage 正确隐含 edit/view", () => {
  assert.equal(canPerformActionWithGrants({
    userId: "other-user",
    action: "edit",
    scope: { documentId: "document-1" },
    grants: [grant({ actions: ["manage"] })],
  }), false);
  const effective = permission([grant({ actions: ["manage"] })]);
  assert.equal(effective.canManage, true);
  assert.equal(effective.canEdit, true);
  assert.equal(effective.canView, true);
});

test("过期授权不参与有效权限", () => {
  const effective = permission([
    grant({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
  ]);
  assert.equal(effective.canView, false);
  assert.equal(effective.canEdit, false);
});

test("板眼和附属打点使用 point.time 进行范围校验", () => {
  const before = structuredClone(baseProject);
  before.banyanMarks = [{ id: "mark-1", time: 5 }];
  const after = structuredClone(before);
  after.banyanMarks[0].time = 50;
  const mutations = collectProjectMutations(before, after);
  assert.deepEqual(mutations[0].timeRange, { startTime: 5, endTime: 50 });
  const result = authorizeProjectMutations(mutations, permission([
    grant({
      scope: {
        projectId: "project-1",
        documentId: "document-1",
        timeRange: { startTime: 0, endTime: 10 },
        trackScope: { trackIds: ["banyan"] },
      },
    }),
  ]));
  assert.equal(result.allowed, false);
});

test("动作和工尺 mutation 使用真实父轨道 id", () => {
  const before = structuredClone(baseProject);
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
  const mutations = collectProjectMutations(before, after);
  assert.deepEqual(
    mutations.map((mutation) => mutation.trackIds),
    [["hands"], ["character-track"]],
  );
});

test("共有分叉块要求所有所属分叉都被授权", () => {
  const before = structuredClone(baseProject);
  const after = structuredClone(baseProject);
  after.customTracks[0].blocks.push({
    id: "block-1",
    type: "夹扇",
    startTime: 2,
    endTime: 3,
    branchScope: { mode: "lanes", laneIds: ["left", "right"] },
  });
  const mutations = collectProjectMutations(before, after);
  assert.deepEqual(mutations[0].trackIds, [
    "hands#branch:left",
    "hands#branch:right",
  ]);
  const result = authorizeProjectMutations(mutations, permission([
    grant({
      scope: {
        projectId: "project-1",
        documentId: "document-1",
        trackScope: { trackIds: ["hands#branch:left"] },
      },
    }),
  ]));
  assert.equal(result.allowed, false);
});

test("父轨授权覆盖递归子轨，但子轨授权不反向覆盖父轨", () => {
  const after = structuredClone(baseProject);
  after.customTracks[0].blocks.push({
    id: "block-1",
    type: "夹扇",
    startTime: 2,
    endTime: 3,
    branchScope: { mode: "lanes", laneIds: ["left"] },
  });
  const mutations = collectProjectMutations(baseProject, after);
  assert.equal(authorizeProjectMutations(mutations, permission([
    grant({
      scope: {
        documentId: "document-1",
        trackScope: { trackIds: ["hands"] },
      },
    }),
  ])).allowed, true);

  const rootAfter = structuredClone(baseProject);
  rootAfter.customTracks[0].blocks.push({
    id: "root-block",
    type: "共有",
    startTime: 2,
    endTime: 3,
  });
  const rootMutations = collectProjectMutations(baseProject, rootAfter);
  assert.equal(authorizeProjectMutations(rootMutations, permission([
    grant({
      scope: {
        documentId: "document-1",
        trackScope: { trackIds: ["hands#branch:left"] },
      },
    }),
  ])).allowed, false);
});

test("连续的多个时间授权可以共同覆盖一次修改", () => {
  const effective = permission([
    grant({
      id: "grant-a",
      scope: {
        documentId: "document-1",
        timeRange: { startTime: 0, endTime: 5 },
        trackScope: { trackIds: ["character-track"] },
      },
    }),
    grant({
      id: "grant-b",
      scope: {
        documentId: "document-1",
        timeRange: { startTime: 5, endTime: 10 },
        trackScope: { trackIds: ["character-track"] },
      },
    }),
  ]);
  const result = authorizeProjectMutations([{
    kind: "character.move",
    action: "move",
    trackIds: ["character-track"],
    timeRange: { startTime: 2, endTime: 8 },
    requiresManage: false,
  }], effective);
  assert.equal(result.allowed, true);
});

test("轨道目录包含分叉与附属打点的稳定 scope id", () => {
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
  assert.equal(trackIds.has("hands#point:breath"), true);
});
