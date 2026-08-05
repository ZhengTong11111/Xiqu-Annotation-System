import assert from "node:assert/strict";
import test from "node:test";
import { invertAnnotationCommandEnvelope } from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import {
  buildProjectAnnotationLifecycleCommand,
  type AnnotationLifecycleTarget,
} from "./annotationLifecycleCommand";
import { applyAnnotationLifecycleCommandToProject } from "./annotationLifecycleCommandApply";

// 夹具使用当前格式真实的自定义动作轨和内建文字轨附属点，不依赖已迁移的旧 actionAnnotations。
function createProject(): ProjectData {
  const project = structuredClone(mockProject);
  project.customTracks.push({
    id: "lifecycle-action-track",
    name: "生命周期动作轨",
    trackType: "action",
    typeOptions: ["动作"],
    blocks: [
      { id: "block-a", startTime: 1, endTime: 2, type: "动作" },
      { id: "block-b", startTime: 4, endTime: 5, type: "动作" },
    ],
    attachedPointTracks: [],
  });
  project.builtinTracks[0].attachedPointTracks = [{
    id: "lifecycle-point-track",
    name: "生命周期点轨",
    typeOptions: ["呼吸"],
    points: [
      { id: "point-a", time: 1, label: "呼吸" },
      { id: "point-b", time: 3, label: "呼吸" },
      { id: "point-c", time: 5, label: "呼吸" },
    ],
  }];
  return project;
}

test("自定义块创建命令可应用并通过 inverse 精确恢复集合顺序", () => {
  const base = createProject();
  const original = structuredClone(base);
  const next = structuredClone(base);
  next.customTracks[next.customTracks.length - 1]?.blocks.splice(1, 0, {
    id: "block-new",
    startTime: 2,
    endTime: 3,
    type: "动作",
  });
  const target: AnnotationLifecycleTarget = {
    entityType: "custom-block",
    entityId: "block-new",
    trackId: "lifecycle-action-track",
  };
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, [target]);
  assert.ok(envelope);
  const applied = applyAnnotationLifecycleCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyAnnotationLifecycleCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, original);
  assert.deepEqual(base, original);
});

test("文字块生命周期保留文本与递归分叉归属", () => {
  const base = createProject();
  base.customTracks.push({
    id: "lifecycle-text-track",
    name: "生命周期文字轨",
    trackType: "text",
    typeOptions: ["唱词"],
    blocks: [],
    attachedPointTracks: [],
  });
  const next = structuredClone(base);
  const textTrack = next.customTracks.find((track) => track.id === "lifecycle-text-track");
  if (!textTrack || textTrack.trackType !== "text") throw new Error("生命周期测试夹具缺少文字轨。 ");
  textTrack.blocks.push({
    id: "text-block-new",
    startTime: 7,
    endTime: 8,
    text: "新唱词",
    type: "唱词",
    branchScope: { mode: "lanes", laneIds: ["lane-left", "lane-right"] },
    branchGroupId: "branch-group-1",
  });
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, [{
    entityType: "custom-block",
    entityId: "text-block-new",
    trackId: "lifecycle-text-track",
  }]);
  assert.ok(envelope);
  const applied = applyAnnotationLifecycleCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});

test("同一附属点集合多项删除一次规划并可反向恢复原索引", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.builtinTracks[0].attachedPointTracks[0].points = [{ id: "point-b", time: 3, label: "呼吸" }];
  const targets: AnnotationLifecycleTarget[] = ["point-a", "point-c"].map((entityId) => ({
    entityType: "attached-point",
    entityId,
    trackId: "lifecycle-point-track",
  }));
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, targets);
  assert.ok(envelope);
  const applied = applyAnnotationLifecycleCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyAnnotationLifecycleCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("生命周期命令在错父、位置漂移或实体冲突时保持输入不变", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.builtinTracks[0].attachedPointTracks[0].points.splice(1, 0, {
    id: "point-new",
    time: 2,
    label: "呼吸",
  });
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, [{
    entityType: "attached-point",
    entityId: "point-new",
    trackId: "lifecycle-point-track",
  }]);
  assert.ok(envelope);

  const missingParent = structuredClone(base);
  missingParent.builtinTracks[0].attachedPointTracks = [];
  assert.equal(applyAnnotationLifecycleCommandToProject(missingParent, envelope).status, "blocked");
  const drifted = structuredClone(base);
  drifted.builtinTracks[0].attachedPointTracks[0].points.reverse();
  assert.equal(applyAnnotationLifecycleCommandToProject(drifted, envelope).status, "blocked");
  const alreadyExists = structuredClone(base);
  alreadyExists.builtinTracks[0].attachedPointTracks[0].points.push({
    id: "point-new",
    time: 9,
    label: "冲突",
  });
  assert.equal(applyAnnotationLifecycleCommandToProject(alreadyExists, envelope).status, "blocked");
  assert.deepEqual(base.builtinTracks[0].attachedPointTracks[0].points.map((point) => point.id), [
    "point-a",
    "point-b",
    "point-c",
  ]);
});

test("builder 对合同外变化和工尺级联删除安全回退 snapshot", () => {
  const base = createProject();
  const unrelated = structuredClone(base);
  unrelated.video.name = "合同外变化";
  const unrelatedTrack = unrelated.customTracks[unrelated.customTracks.length - 1];
  if (unrelatedTrack.trackType !== "action") throw new Error("生命周期测试夹具缺少动作轨。");
  unrelatedTrack.blocks.push({
    id: "block-extra",
    startTime: 6,
    endTime: 7,
    type: "动作",
  });
  assert.equal(buildProjectAnnotationLifecycleCommand(base, unrelated, [{
    entityType: "custom-block",
    entityId: "block-extra",
    trackId: "lifecycle-action-track",
  }]), null);

  const withGongche = structuredClone(base);
  withGongche.gongcheAnnotations.push({
    id: "gongche-dependent",
    parentTrackId: "lifecycle-action-track",
    parentBlockId: "block-a",
    startTime: 1,
    endTime: 2,
    symbols: [],
  });
  const afterCascade = structuredClone(withGongche);
  const cascadeTrack = afterCascade.customTracks[afterCascade.customTracks.length - 1];
  if (cascadeTrack.trackType !== "action") throw new Error("生命周期测试夹具缺少动作轨。");
  cascadeTrack.blocks = cascadeTrack.blocks.filter(
    (block) => block.id !== "block-a",
  );
  afterCascade.gongcheAnnotations = [];
  assert.equal(buildProjectAnnotationLifecycleCommand(withGongche, afterCascade, [{
    entityType: "custom-block",
    entityId: "block-a",
    trackId: "lifecycle-action-track",
  }]), null);
});

test("句与首字可同批创建，缺少句引用的逐字创建会被拒绝", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.subtitleLines.push({ id: "line-created", text: "新", startTime: 9, endTime: 10 });
  next.characterAnnotations.push({
    id: "char-created",
    lineId: "line-created",
    char: "新",
    startTime: 9,
    endTime: 10,
    singingStyle: "普通唱",
    tone: { toneClass: "yang_shang", yxlzShangSubtype: "yinyang_tongyong" },
  });
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, [
    { entityType: "sentence", entityId: "line-created" },
    { entityType: "character", entityId: "char-created" },
  ]);
  assert.ok(envelope);
  const applied = applyAnnotationLifecycleCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);

  const orphaned = structuredClone(base);
  orphaned.characterAnnotations.push({
    id: "char-orphaned",
    lineId: "line-missing",
    char: "孤",
    startTime: 11,
    endTime: 12,
    singingStyle: "普通唱",
    tone: null,
  });
  assert.equal(buildProjectAnnotationLifecycleCommand(base, orphaned, [{
    entityType: "character",
    entityId: "char-orphaned",
  }]), null);
});

test("工尺块生命周期保留完整符号并验证父块引用", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.gongcheAnnotations.push({
    id: "gongche-created",
    parentTrackId: "lifecycle-action-track",
    parentBlockId: "block-a",
    startTime: 1,
    endTime: 2,
    symbols: [{
      id: "symbol-created",
      label: "上",
      notation: "1/",
      rawText: "上1/",
      parenthesized: true,
      startTime: 1,
      endTime: 2,
      assetUrl: null,
    }],
  });
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, [{
    entityType: "gongche-block",
    entityId: "gongche-created",
    trackId: "lifecycle-action-track",
  }]);
  assert.ok(envelope);
  const applied = applyAnnotationLifecycleCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyAnnotationLifecycleCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("工尺符号可在既有块内独立创建删除并保持集合位置", () => {
  const base = createProject();
  base.gongcheAnnotations.push({
    id: "gongche-symbol-parent",
    parentTrackId: "lifecycle-action-track",
    parentBlockId: "block-a",
    startTime: 1,
    endTime: 2,
    symbols: [{
      id: "symbol-first",
      label: "上",
      notation: "",
      rawText: "上",
      parenthesized: false,
      startTime: 1,
      endTime: 1.5,
      assetUrl: null,
    }],
  });
  const next = structuredClone(base);
  next.gongcheAnnotations[0].symbols.push({
    id: "symbol-second",
    label: "尺",
    notation: "2/",
    rawText: "尺2/",
    parenthesized: false,
    startTime: 1.5,
    endTime: 2,
    assetUrl: null,
  });
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, [{
    entityType: "gongche-symbol",
    entityId: "symbol-second",
    trackId: "gongche-symbol-parent",
  }]);
  assert.ok(envelope);
  const applied = applyAnnotationLifecycleCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyAnnotationLifecycleCommandToProject(applied.project, invertAnnotationCommandEnvelope(envelope));
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("板眼区段与引用它的板眼可在同一生命周期批次创建", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.banyanSections.push({
    id: "section-created",
    name: "新板眼段",
    startTime: 6,
    endTime: 8,
    cycleType: "yi_ban_yi_yan",
    freeRhythm: false,
  });
  next.banyanMarks.push({
    id: "mark-created",
    sectionId: "section-created",
    time: 6,
    estimatedTime: 6,
    sourceSymbol: "",
    role: "ban",
    subtype: "mainBan",
    segment: "main",
    beatIndex: null,
    cycleIndex: null,
    attachment: "unknown",
    linkedGongcheAnnotationId: null,
    linkedGongcheSymbolId: null,
    confidence: "manual",
    durationHint: null,
    orphaned: false,
  });
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, [
    { entityType: "banyan-section", entityId: "section-created" },
    { entityType: "banyan-mark", entityId: "mark-created" },
  ]);
  assert.ok(envelope);
  const applied = applyAnnotationLifecycleCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});
