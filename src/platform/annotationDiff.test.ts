import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectData } from "../types";
import { buildAnnotationDiff } from "./annotationDiff";

// 相同实体即使数组顺序不同也应按稳定 id 匹配，不能制造增删差异。
test("相同项目和数组换序只产生未变化项", () => {
  const left = projectFixture();
  const right = clone(left);
  right.subtitleLines.reverse();
  right.characterAnnotations.reverse();

  const result = buildAnnotationDiff(left, right);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.diff.hasDifferences, false);
  assert.equal(result.diff.counts.added, 0);
  assert.equal(result.diff.counts.removed, 0);
  assert.equal(result.diff.counts.modified, 0);
  assert.ok(result.diff.counts.unchanged > 0);
});

// 中间插字只新增该稳定 id；同 id 的文字与四声变化应定位为一条修改。
test("逐字增删改和四声变化不会污染相邻字符", () => {
  const left = projectFixture();
  const right = clone(left);
  right.characterAnnotations = [
    {
      ...right.characterAnnotations[0]!,
      char: "新",
      tone: { toneClass: "yin_qu" },
    },
    {
      id: "char-inserted",
      lineId: "line-1",
      char: "增",
      startTime: 0.5,
      endTime: 0.75,
      singingStyle: "普通唱",
      tone: null,
    },
  ];

  const result = buildAnnotationDiff(left, right);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const group = result.diff.groups.find(({ domain }) =>
    domain === "characters");
  assert.ok(group);
  assert.deepEqual(group.counts, {
    added: 1,
    removed: 1,
    modified: 1,
    unchanged: 0,
  });
  const modified = group.entries.find(({ changeType }) =>
    changeType === "modified");
  assert.deepEqual(modified?.changedFields, ["文字", "四声"]);
});

// 工尺谱空符号会由迁移层补展示符号，但随机 fallback id 不得进入语义比较。
test("空工尺谱 fallback 多次比较保持确定", () => {
  const left = projectFixture();
  left.gongcheAnnotations[0]!.symbols = [];
  const right = clone(left);

  const first = buildAnnotationDiff(left, right);
  const second = buildAnnotationDiff(left, right);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const group = first.diff.groups.find(({ domain }) => domain === "gongche");
  assert.deepEqual(group?.counts, {
    added: 0,
    removed: 0,
    modified: 0,
    unchanged: 1,
  });
});

// 递归分支定义和块的多分支归属分别比较，共享块不能按可视 lane 重复计数。
test("递归分叉与共享块归属形成独立差异", () => {
  const left = projectFixture();
  const right = clone(left);
  const track = right.customTracks[0]!;
  if (track.branching) {
    track.branching.lanes[0]!.children![0]!.name = "扇面（改）";
  }
  track.blocks[0]!.branchScope = {
    mode: "lanes",
    laneIds: ["branch-child", "branch-root"],
  };

  const result = buildAnnotationDiff(left, right);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const trackGroup = result.diff.groups.find(({ domain }) =>
    domain === "custom_tracks");
  const blockGroup = result.diff.groups.find(({ domain }) =>
    domain === "custom_blocks");
  assert.equal(trackGroup?.counts.modified, 1);
  assert.equal(blockGroup?.counts.modified, 1);
  assert.equal(blockGroup?.entries.length, 1);
  assert.deepEqual(blockGroup?.entries[0]?.changedFields, ["分叉归属"]);
});

// 板眼点的类型和时间变化应保留同一 identity，并报告可读字段名称。
test("板眼时间与类型变化可定位", () => {
  const left = projectFixture();
  const right = clone(left);
  right.banyanMarks[0]!.time = 1.25;
  right.banyanMarks[0]!.subtype = "smallEye";

  const result = buildAnnotationDiff(left, right);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const entry = result.diff.groups
    .find(({ domain }) => domain === "banyan_marks")
    ?.entries[0];
  assert.equal(entry?.changeType, "modified");
  assert.deepEqual(entry?.changedFields, ["实际时间", "类型", "人工偏移"]);
});

// 附属轨设置与点是两个身份空间，修改点不应把轨道定义也标成修改。
test("附属点变化不重复污染附属轨设置", () => {
  const left = projectFixture();
  const right = clone(left);
  right.customTracks[0]!.attachedPointTracks[0]!.points[0]!.label = "换气";

  const result = buildAnnotationDiff(left, right);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const group = result.diff.groups.find(({ domain }) =>
    domain === "attached_points");
  assert.equal(group?.counts.modified, 1);
  assert.equal(group?.counts.unchanged, 1);
});

// 两侧格式错误必须分别标明方向，不能把坏文件伪装成空项目参与比较。
test("坏 payload 返回带方向的迁移错误", () => {
  const bothInvalid = buildAnnotationDiff({}, "broken");
  assert.equal(bothInvalid.ok, false);
  if (bothInvalid.ok) return;
  assert.deepEqual(bothInvalid.errors.map(({ side }) => side), [
    "left",
    "right",
  ]);

  const leftInvalid = buildAnnotationDiff(null, projectFixture());
  assert.equal(leftInvalid.ok, false);
  if (!leftInvalid.ok) {
    assert.deepEqual(leftInvalid.errors.map(({ side }) => side), ["left"]);
  }
});

// 旧顶层 videoUrl 文件仍通过正式迁移入口，不另造比较专用兼容路径。
test("可识别旧项目格式参与比较", () => {
  const legacy = {
    videoUrl: "legacy.mp4",
    videoName: "旧视频.mp4",
    subtitleLines: [],
    characterAnnotations: [],
    builtinTracks: [],
    customTracks: [],
  };
  const result = buildAnnotationDiff(legacy, clone(legacy));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.diff.leftSummary.videoName, "旧视频.mp4");
    assert.equal(result.diff.hasDifferences, false);
  }
});

// 比较是纯读取过程，输入 payload 在 normalization 和递归遍历后必须保持原样。
test("比较不会修改输入对象", () => {
  const left = projectFixture();
  const right = clone(left);
  const leftBefore = JSON.stringify(left);
  const rightBefore = JSON.stringify(right);

  buildAnnotationDiff(left, right);

  assert.equal(JSON.stringify(left), leftBefore);
  assert.equal(JSON.stringify(right), rightBefore);
});

// 重复稳定 id 不能被 Map 静默吞掉，结果必须向用户暴露数据质量风险。
test("重复实体标识产生明确警告", () => {
  const left = projectFixture();
  left.characterAnnotations.push({
    ...left.characterAnnotations[0]!,
    char: "重",
  });
  const result = buildAnnotationDiff(left, projectFixture());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.diff.warnings.some((warning) =>
    warning.includes("左侧逐字标注存在 1 个重复标识")));
});

// 最小 fixture 覆盖逐字、工尺谱、板眼、递归分叉、自定义块和附属点，不依赖浏览器环境。
function projectFixture(): ProjectData {
  return {
    video: {
      url: "https://example.test/video.mp4",
      name: "寻梦.mp4",
      source: "url",
    },
    subtitleLines: [
      { id: "line-1", text: "那一答", startTime: 0, endTime: 2 },
      { id: "line-2", text: "可是", startTime: 2, endTime: 3 },
    ],
    characterAnnotations: [
      {
        id: "char-1",
        lineId: "line-1",
        char: "那",
        startTime: 0,
        endTime: 0.5,
        singingStyle: "唱",
        tone: { toneClass: "yin_ping" },
      },
      {
        id: "char-2",
        lineId: "line-1",
        char: "一",
        startTime: 0.5,
        endTime: 1,
        singingStyle: "唱",
        tone: null,
      },
    ],
    gongcheAnnotations: [{
      id: "gongche-1",
      parentTrackId: "character-track",
      parentBlockId: "char-1",
      startTime: 0,
      endTime: 0.5,
      symbols: [{
        id: "symbol-1",
        label: "六",
        notation: "4",
        rawText: "六4",
        startTime: 0,
        endTime: 0.5,
      }],
    }],
    banyanSections: [{
      id: "section-1",
      name: "忒忒令",
      startTime: 0,
      endTime: 3,
      cycleType: "yi_ban_san_yan",
      freeRhythm: false,
    }],
    banyanMarks: [{
      id: "mark-1",
      sectionId: "section-1",
      time: 1,
      estimatedTime: 1,
      sourceSymbol: "4",
      role: "yan",
      subtype: "middleEye",
      segment: "main",
      attachment: "on_note",
      confidence: "manual",
    }],
    actionAnnotations: [],
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字轨",
      type: "character",
      attachedPointTracks: [],
    }],
    customTracks: [{
      id: "track-hands",
      name: "双手",
      trackType: "action",
      color: "#6366f1",
      typeOptions: ["画圆"],
      blocks: [{
        id: "block-1",
        startTime: 0,
        endTime: 1,
        type: "画圆",
        branchScope: { mode: "lanes", laneIds: ["branch-root"] },
      }],
      attachedPointTracks: [{
        id: "point-track-1",
        name: "呼吸轨",
        typeOptions: ["呼吸"],
        points: [{ id: "point-1", time: 0.75, label: "呼吸" }],
      }],
      branching: {
        enabled: true,
        rootLabel: "双手",
        displayMode: "merged",
        lanes: [{
          id: "branch-root",
          name: "持扇手",
          parentId: null,
          children: [{
            id: "branch-child",
            name: "扇面",
            parentId: "branch-root",
          }],
        }],
      },
    }],
    activeTrackOrder: ["character-track", "track-hands"],
  };
}

// 测试克隆保持 JSON 文件语义，避免 structuredClone 的运行时版本差异影响 Node 测试。
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
