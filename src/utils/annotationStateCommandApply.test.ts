import assert from "node:assert/strict";
import test from "node:test";
import { buildAnnotationStateUpdateEnvelope, invertAnnotationCommandEnvelope } from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { BanyanMark, ProjectData } from "../types";
import { createBanyanMarkSnapshot } from "./annotationCompositeSnapshots";
import { buildProjectAnnotationStateCommand } from "./annotationStateCommand";
import { applyAnnotationStateCommandToProject } from "./annotationStateCommandApply";

function createMark(overrides: Partial<BanyanMark> = {}): BanyanMark {
  return {
    id: "mark-state",
    sectionId: "section-state",
    time: 1.5,
    estimatedTime: 1.5,
    sourceSymbol: "1",
    sourceTokenIndex: 0,
    sourceKey: "symbol-state:0",
    role: "ban",
    subtype: "mainBan",
    segment: "main",
    beatIndex: 0,
    cycleIndex: 0,
    strength: "strong",
    attachment: "on_note",
    linkedGongcheAnnotationId: "gongche-state",
    linkedGongcheSymbolId: "symbol-state",
    linkedGongcheSymbolIds: ["symbol-state"],
    confidence: "auto",
    durationHint: null,
    orphaned: false,
    ...overrides,
  };
}

// 夹具显式建立板眼到工尺符号的有效强引用，便于验证完整状态命令不会制造悬空关系。
function createProject(): ProjectData {
  const project = structuredClone(mockProject);
  const character = project.characterAnnotations[0];
  if (!character) throw new Error("mockProject 缺少逐字夹具。");
  project.gongcheAnnotations = [{
    id: "gongche-state",
    parentTrackId: "character-track",
    parentBlockId: character.id,
    startTime: 1,
    endTime: 2,
    symbols: [{
      id: "symbol-state",
      label: "上",
      notation: "1/",
      rawText: "上1/",
      parenthesized: false,
      startTime: 1,
      endTime: 2,
      assetUrl: null,
    }],
  }];
  project.banyanSections = [{
    id: "section-state",
    name: "第一段",
    startTime: 1,
    endTime: 2,
    cycleType: "yi_ban_san_yan",
    freeRhythm: false,
    beatCount: 1,
    hasZengBan: false,
    source: "test",
  }];
  project.banyanMarks = [createMark()];
  return project;
}

test("工尺符号与板眼完整状态可原子应用并通过 inverse 恢复", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.gongcheAnnotations[0].symbols[0] = {
    ...next.gongcheAnnotations[0].symbols[0],
    label: "尺",
    notation: "4/",
    rawText: "尺4/",
  };
  next.banyanMarks[0] = { ...next.banyanMarks[0], confidence: "reviewed", comment: "人工复核" };
  const envelope = buildProjectAnnotationStateCommand(base, next, [
    { entityType: "gongche-symbol", entityId: "symbol-state", trackId: "gongche-state" },
    { entityType: "banyan-mark", entityId: "mark-state" },
  ]);
  assert.ok(envelope);
  const applied = applyAnnotationStateCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyAnnotationStateCommandToProject(applied.project, invertAnnotationCommandEnvelope(envelope));
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("状态适配器拒绝 before 冲突与不存在的板眼工尺引用", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.banyanMarks[0] = { ...next.banyanMarks[0], comment: "新注释" };
  const envelope = buildProjectAnnotationStateCommand(base, next, [{
    entityType: "banyan-mark",
    entityId: "mark-state",
  }]);
  assert.ok(envelope);

  const conflicted = structuredClone(base);
  conflicted.banyanMarks[0].comment = "并发修改";
  assert.equal(applyAnnotationStateCommandToProject(conflicted, envelope).status, "blocked");

  const before = createBanyanMarkSnapshot(base.banyanMarks[0]);
  const invalidEnvelope = buildAnnotationStateUpdateEnvelope([{
    entityType: "banyan-mark",
    entityId: "mark-state",
    before,
    after: { ...before, linkedGongcheSymbolId: "missing-symbol", linkedGongcheSymbolIds: ["missing-symbol"] },
  }]);
  assert.ok(invalidEnvelope);
  const invalidResult = applyAnnotationStateCommandToProject(base, invalidEnvelope);
  assert.equal(invalidResult.status, "blocked");
  if (invalidResult.status === "blocked") assert.equal(invalidResult.issues[0]?.code, "result_invalid");
});

test("含冒号的父块与符号 id 仍能分别应用到正确实体", () => {
  const base = createProject();
  base.gongcheAnnotations = [
    { ...base.gongcheAnnotations[0], id: "a:b", symbols: [{ ...base.gongcheAnnotations[0].symbols[0], id: "c" }] },
    { ...base.gongcheAnnotations[0], id: "a", symbols: [{ ...base.gongcheAnnotations[0].symbols[0], id: "b:c" }] },
  ];
  base.banyanMarks = [];
  const next = structuredClone(base);
  next.gongcheAnnotations[0].symbols[0].label = "工";
  next.gongcheAnnotations[0].symbols[0].rawText = "工";
  next.gongcheAnnotations[1].symbols[0].label = "合";
  next.gongcheAnnotations[1].symbols[0].rawText = "合";
  const envelope = buildProjectAnnotationStateCommand(base, next, [
    { entityType: "gongche-symbol", entityId: "c", trackId: "a:b" },
    { entityType: "gongche-symbol", entityId: "b:c", trackId: "a" },
  ]);
  assert.ok(envelope);
  const applied = applyAnnotationStateCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});
