import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectData } from "../types";
import { buildAnnotationDiff } from "./annotationDiff";
import { applyAnnotationMergePlan } from "./annotationMergeApply";
import { buildAnnotationMergePlan } from "./annotationMergePlan";

// 新增轨道只带入计划中的块和点，不把来源整轨未选择内容偷偷复制到目标。
test("轨道定义与内容按独立实体局部应用", () => {
  const source = projectWithTrack("来源块", "来源点");
  source.customTracks[0]!.blocks.push({
    id: "unselected-block",
    startTime: 3,
    endTime: 4,
    text: "不应复制",
    type: "唱词",
  });
  const target = emptyProject();
  const result = buildAndApply(source, target, [
    "custom_blocks:text-track:block-1",
    "attached_points:point:text-track:point-track:point-1",
  ], {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const track = result.project.customTracks[0]!;
  assert.equal(track.trackType, "text");
  if (track.trackType !== "text") return;
  assert.deepEqual(track.blocks.map(({ id }) => id), ["block-1"]);
  assert.deepEqual(track.attachedPointTracks[0]!.points.map(({ id }) => id), ["point-1"]);
  assert.equal(result.project.activeTrackOrder.includes("text-track"), true);
});

// 替换定义时保留目标块和点；明确选择的冲突实体才采用来源值。
test("替换轨道定义保留目标集合并按决策替换块", () => {
  const source = projectWithTrack("来源块", "来源点");
  source.customTracks[0]!.name = "来源轨道名";
  const target = projectWithTrack("目标块", "目标点");
  target.customTracks[0]!.name = "目标轨道名";
  target.customTracks[0]!.blocks.push({
    id: "target-only",
    startTime: 2,
    endTime: 3,
    text: "目标独有",
    type: "唱词",
  });
  const result = buildAndApply(source, target, [
    "custom_tracks:text-track",
    "custom_blocks:text-track:block-1",
  ], {
    "custom_tracks:text-track": "take-source",
    "custom_blocks:text-track:block-1": "take-source",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const track = result.project.customTracks[0]!;
  assert.equal(track.trackType, "text");
  if (track.trackType !== "text") return;
  assert.equal(track.name, "来源轨道名");
  assert.deepEqual(track.blocks.map(({ id, text }) => [id, text]), [
    ["block-1", "来源块"],
    ["target-only", "目标独有"],
  ]);
  assert.equal(track.attachedPointTracks[0]!.points[0]!.label, "目标点");
});

// 保留目标冲突不产生写入；输入项目必须保持完全不变。
test("保留目标与输入不可变", () => {
  const source = projectWithTrack("来源块", "来源点");
  const target = projectWithTrack("目标块", "目标点");
  const before = JSON.stringify({ source, target });
  const result = buildAndApply(source, target, [
    "custom_blocks:text-track:block-1",
  ], { "custom_blocks:text-track:block-1": "keep-target" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const track = result.project.customTracks[0]!;
  assert.equal(track.trackType, "text");
  if (track.trackType !== "text") return;
  assert.equal(track.blocks[0]!.text, "目标块");
  assert.equal(JSON.stringify({ source, target }), before);
});

// 未决冲突和应用后坏引用都必须整体失败，不能返回可打开的半成品项目。
test("未决冲突与坏引用阻断应用", () => {
  const source = projectWithTrack("来源块", "来源点");
  const target = projectWithTrack("目标块", "目标点");
  const unresolved = buildAndApply(source, target, [
    "custom_blocks:text-track:block-1",
  ], {});
  assert.equal(unresolved.ok, false);

  source.customTracks[0]!.blocks[0]!.branchParentBlockId = "missing";
  const invalid = buildAndApply(source, emptyProject(), [
    "custom_blocks:text-track:block-1",
  ], {});
  assert.equal(invalid.ok, false);
});

test("局部整合句级字幕会补齐其角色定义", () => {
  const source = emptyProject();
  source.sentenceAnnotationConfig.roleOptions = ["闺门旦"];
  source.subtitleLines.push({
    id: "line-role",
    text: "寻梦",
    startTime: 0,
    endTime: 2,
    deliveryMode: "sung",
    roleType: "闺门旦",
  });
  const result = buildAndApply(source, emptyProject(), ["subtitle_lines:line-role"], {});

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.sentenceAnnotationConfig.roleOptions, ["闺门旦"]);
  assert.equal(result.project.subtitleLines[0]?.roleType, "闺门旦");
});

function buildAndApply(
  source: ProjectData,
  target: ProjectData,
  selectedEntryKeys: string[],
  resolutions: Record<string, "take-source" | "keep-target">,
) {
  const diffResult = buildAnnotationDiff(source, target);
  assert.equal(diffResult.ok, true);
  if (!diffResult.ok) throw new Error("测试项目应能比较");
  const plan = buildAnnotationMergePlan({
    leftProject: diffResult.leftProject,
    rightProject: diffResult.rightProject,
    diff: diffResult.diff,
    direction: "left-to-right",
    selectedEntryKeys,
  });
  return applyAnnotationMergePlan({
    sourceProject: diffResult.leftProject,
    targetProject: diffResult.rightProject,
    plan,
    resolutions,
  });
}

function projectWithTrack(blockText: string, pointLabel: string): ProjectData {
  const project = emptyProject();
  project.customTracks.push({
    id: "text-track",
    name: "文字轨",
    trackType: "text",
    typeOptions: ["唱词"],
    blocks: [{
      id: "block-1",
      startTime: 0,
      endTime: 1,
      text: blockText,
      type: "唱词",
    }],
    attachedPointTracks: [{
      id: "point-track",
      name: "呼吸",
      typeOptions: ["呼吸"],
      points: [{ id: "point-1", time: 0.5, label: pointLabel }],
    }],
  });
  project.activeTrackOrder.push("text-track");
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
