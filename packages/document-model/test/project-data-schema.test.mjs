import assert from "node:assert/strict";
import test from "node:test";
import { parseCurrentProjectData } from "../dist/projectDataSchema.js";

// 该样本同时覆盖当前持久模型的全部主要领域以及两层递归分叉，不依赖 Web migration。
function createCurrentProject() {
  return {
    video: {
      url: "",
      name: "寻梦.mp4",
      source: "url",
      filePath: "platform-file:media-1",
    },
    sentenceAnnotationConfig: { roleOptions: ["闺门旦"] },
    subtitleLines: [{
      id: "line-1",
      text: "那一答",
      startTime: 1,
      endTime: 4,
      deliveryMode: "sung",
      roleType: "闺门旦",
    }],
    characterAnnotations: [{
      id: "char-1",
      lineId: "line-1",
      char: "那",
      startTime: 1,
      endTime: 2,
      tone: { toneClass: "yang_qu" },
    }],
    gongcheAnnotations: [{
      id: "gongche-1",
      parentTrackId: "character-track",
      parentBlockId: "char-1",
      startTime: 1,
      endTime: 2,
      symbols: [{
        id: "symbol-1",
        label: "六",
        notation: "4",
        parenthesized: false,
        startTime: 1,
        endTime: 2,
        assetUrl: null,
      }],
    }],
    banyanSections: [{
      id: "section-1",
      name: "忒忒令",
      startTime: 1,
      endTime: 4,
      cycleType: "yi_ban_san_yan",
      freeRhythm: false,
      beatCount: 4,
    }],
    banyanMarks: [{
      id: "mark-1",
      sectionId: "section-1",
      time: 1,
      estimatedTime: 1,
      sourceSymbol: "4",
      role: "ban",
      subtype: "mainBan",
      segment: "main",
      attachment: "on_note",
      linkedGongcheAnnotationId: "gongche-1",
      linkedGongcheSymbolId: "symbol-1",
      confidence: "reviewed",
    }],
    actionAnnotations: [{
      id: "legacy-action-1",
      trackId: "action-track",
      label: "转身",
      startTime: 2,
      endTime: 3,
    }],
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字轨",
      type: "character",
      attachedPointTracks: [{
        id: "breath-track",
        name: "呼吸轨",
        typeOptions: ["呼吸"],
        points: [{ id: "breath-1", time: 2.5, label: "呼吸" }],
        snapToParentBoundaries: true,
      }],
    }],
    customTracks: [{
      id: "hands",
      name: "双手",
      trackType: "text",
      color: "#6366f1",
      typeOptions: ["动作"],
      blocks: [{
        id: "hand-block-1",
        startTime: 1,
        endTime: 3,
        text: "夹扇",
        type: "动作",
        branchScope: { mode: "lanes", laneIds: ["left-hand", "finger"] },
      }],
      attachedPointTracks: [],
      branching: {
        enabled: true,
        displayMode: "merged",
        lanes: [{
          id: "left-hand",
          name: "左手",
          parentId: null,
          children: [{ id: "finger", name: "手指", parentId: "left-hand" }],
        }],
      },
    }, {
      id: "body",
      name: "身段",
      trackType: "action",
      typeOptions: ["转身"],
      blocks: [{ id: "body-block-1", startTime: 2, endTime: 4, type: "转身" }],
      attachedPointTracks: [],
    }],
    activeTrackOrder: ["character-track", "hands", "body"],
  };
}

test("当前 ProjectData parser 保留完整多模态文档且不修改输入", () => {
  const project = createCurrentProject();
  const before = structuredClone(project);
  const result = parseCurrentProjectData(project);
  assert.equal(result.success, true);
  assert.deepEqual(project, before);
  assert.deepEqual(result.success ? result.data : null, before);
});

test("当前 ProjectData parser 拒绝缺失字段、未知字段和非法 union", () => {
  const missing = createCurrentProject();
  delete missing.banyanMarks;
  assert.equal(parseCurrentProjectData(missing).success, false);

  const unknown = createCurrentProject();
  unknown.video.secretToken = "must-not-be-stripped";
  assert.equal(parseCurrentProjectData(unknown).success, false);

  const invalidUnion = createCurrentProject();
  invalidUnion.customTracks[1].trackType = "gesture";
  assert.equal(parseCurrentProjectData(invalidUnion).success, false);
});

test("当前 ProjectData parser 拒绝非有限时间、倒置区间和非法四声组合", () => {
  const nonFinite = createCurrentProject();
  nonFinite.subtitleLines[0].startTime = Number.NaN;
  assert.equal(parseCurrentProjectData(nonFinite).success, false);

  const reversed = createCurrentProject();
  reversed.characterAnnotations[0].endTime = 0.5;
  assert.equal(parseCurrentProjectData(reversed).success, false);

  const invalidTone = createCurrentProject();
  invalidTone.characterAnnotations[0].tone = {
    toneClass: "yin_ping",
    yxlzShangSubtype: "yang_shang",
  };
  assert.equal(parseCurrentProjectData(invalidTone).success, false);
});

test("当前 ProjectData parser 拒绝父子不一致、重复和幽灵 lane 引用", () => {
  const parentMismatch = createCurrentProject();
  parentMismatch.customTracks[0].branching.lanes[0].children[0].parentId = null;
  assert.equal(parseCurrentProjectData(parentMismatch).success, false);

  const duplicateLane = createCurrentProject();
  duplicateLane.customTracks[0].branching.lanes.push({
    id: "left-hand",
    name: "重复",
    parentId: null,
  });
  assert.equal(parseCurrentProjectData(duplicateLane).success, false);

  const missingLane = createCurrentProject();
  missingLane.customTracks[0].blocks[0].branchScope.laneIds.push("missing-lane");
  assert.equal(parseCurrentProjectData(missingLane).success, false);
});

test("当前 ProjectData parser 拒绝重复角色和句级悬空角色引用", () => {
  const duplicateRole = createCurrentProject();
  duplicateRole.sentenceAnnotationConfig.roleOptions.push("闺门旦");
  assert.equal(parseCurrentProjectData(duplicateRole).success, false);

  const danglingRole = createCurrentProject();
  danglingRole.subtitleLines[0].roleType = "未定义行当";
  assert.equal(parseCurrentProjectData(danglingRole).success, false);
});

test("当前 ProjectData parser 在递归过深或循环对象上 fail closed", () => {
  const tooDeep = createCurrentProject();
  let lane = tooDeep.customTracks[0].branching.lanes[0];
  for (let index = 0; index < 70; index += 1) {
    const child = { id: `deep-${index}`, name: "深层", parentId: lane.id, children: [] };
    lane.children = [child];
    lane = child;
  }
  const deepResult = parseCurrentProjectData(tooDeep);
  assert.equal(deepResult.success, false);
  assert.equal(deepResult.success ? null : deepResult.issues[0]?.code, "too_deep");

  const cyclic = createCurrentProject();
  cyclic.customTracks[0].branching.lanes[0].children = [
    cyclic.customTracks[0].branching.lanes[0],
  ];
  assert.equal(parseCurrentProjectData(cyclic).success, false);
});
