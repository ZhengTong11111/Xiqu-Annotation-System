import assert from "node:assert/strict";
import test from "node:test";
import { invertAnnotationCommandEnvelope } from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import { applyAnnotationTransactionCommandToProject } from "./annotationTransactionCommandApply";
import { buildProjectAnnotationTransactionCommand } from "./annotationTransactionCommand";
import { getGongcheTransactionTargetsForParents } from "./timelineTimingCommand";

function createProject(): ProjectData {
  const project = structuredClone(mockProject);
  project.subtitleLines = [{
    id: "line-a",
    text: "甲",
    startTime: 1,
    endTime: 2,
    deliveryMode: null,
    roleType: null,
  }];
  project.characterAnnotations = [{
    id: "char-a",
    lineId: "line-a",
    char: "甲",
    startTime: 1,
    endTime: 2,
    tone: null,
  }];
  project.gongcheAnnotations = [{
    id: "gongche-a",
    parentTrackId: "character-track",
    parentBlockId: "char-a",
    startTime: 1,
    endTime: 2,
    symbols: [{
      id: "symbol-a",
      label: "合",
      notation: "",
      rawText: "合",
      parenthesized: false,
      startTime: 1,
      endTime: 2,
      assetUrl: null,
    }],
  }];
  return project;
}

test("已有句新增逐字可原子同步句内容和边界并完整反向", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.characterAnnotations.push({
    id: "char-b",
    lineId: "line-a",
    char: "乙",
    startTime: 2,
    endTime: 3,
    tone: null,
  });
  next.subtitleLines[0] = { ...next.subtitleLines[0], text: "甲乙", endTime: 3 };
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    contentTargets: [{ entityType: "sentence", entityId: "line-a", field: "text" }],
    timingTargets: [{ entityType: "sentence", entityId: "line-a" }],
    lifecycleTargets: [{ entityType: "character", entityId: "char-b" }],
  });
  assert.ok(envelope);
  const applied = applyAnnotationTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyAnnotationTransactionCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("父文字块缩放时工尺块与全部符号可原子重放并反向恢复", () => {
  const base = createProject();
  base.subtitleLines[0].endTime = 3;
  base.characterAnnotations[0].endTime = 3;
  base.gongcheAnnotations[0] = {
    ...base.gongcheAnnotations[0],
    endTime: 3,
    symbols: [
      { ...base.gongcheAnnotations[0].symbols[0], endTime: 2 },
      {
        ...base.gongcheAnnotations[0].symbols[0],
        id: "symbol-b",
        label: "尺",
        rawText: "尺",
        startTime: 2,
        endTime: 3,
      },
    ],
  };
  const next = structuredClone(base);
  next.subtitleLines[0].endTime = 2.5;
  next.characterAnnotations[0].endTime = 2.5;
  next.gongcheAnnotations[0].endTime = 2.5;
  next.gongcheAnnotations[0].symbols[0].endTime = 1.75;
  next.gongcheAnnotations[0].symbols[1].startTime = 1.75;
  next.gongcheAnnotations[0].symbols[1].endTime = 2.5;

  const gongcheTargets = getGongcheTransactionTargetsForParents(
    base,
    next,
    "character-track",
    ["char-a"],
  );
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    timingTargets: [
      { entityType: "sentence", entityId: "line-a" },
      { entityType: "character", entityId: "char-a" },
      ...gongcheTargets.timingTargets,
    ],
    stateTargets: gongcheTargets.stateTargets,
  });
  assert.ok(envelope);
  assert.deepEqual(envelope.command.commands.map((command) => command.type), [
    "timeline.items.timing.update",
    "annotation.items.state.update",
  ]);

  const applied = applyAnnotationTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyAnnotationTransactionCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("新句与首个逐字可在同一生命周期批次创建和删除", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.subtitleLines.push({
    id: "line-b", text: "新", startTime: 4, endTime: 5, deliveryMode: null, roleType: null,
  });
  next.characterAnnotations.push({
    id: "char-new",
    lineId: "line-b",
    char: "新",
    startTime: 4,
    endTime: 5,
    tone: { toneClass: "yin_ping" },
  });
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    lifecycleTargets: [
      { entityType: "sentence", entityId: "line-b" },
      { entityType: "character", entityId: "char-new" },
    ],
  });
  assert.ok(envelope);
  const applied = applyAnnotationTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});

test("删除逐字和关联工尺时句同步属于同一原子事务", () => {
  const base = createProject();
  base.subtitleLines[0] = {
    id: "line-a", text: "甲乙", startTime: 1, endTime: 3, deliveryMode: null, roleType: null,
  };
  base.characterAnnotations.push({
    id: "char-b",
    lineId: "line-a",
    char: "乙",
    startTime: 2,
    endTime: 3,
    tone: null,
  });
  const next = structuredClone(base);
  next.characterAnnotations = next.characterAnnotations.filter((item) => item.id !== "char-a");
  next.gongcheAnnotations = [];
  next.subtitleLines[0] = {
    id: "line-a", text: "乙", startTime: 2, endTime: 3, deliveryMode: null, roleType: null,
  };
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    contentTargets: [{ entityType: "sentence", entityId: "line-a", field: "text" }],
    timingTargets: [{ entityType: "sentence", entityId: "line-a" }],
    lifecycleTargets: [
      { entityType: "character", entityId: "char-a" },
      { entityType: "gongche-block", entityId: "gongche-a", trackId: "character-track" },
    ],
  });
  assert.ok(envelope);
  const applied = applyAnnotationTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});

test("删除最后一个逐字时句与工尺一同删除且 inverse 恢复完整符号", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.subtitleLines = [];
  next.characterAnnotations = [];
  next.gongcheAnnotations = [];
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    lifecycleTargets: [
      { entityType: "sentence", entityId: "line-a" },
      { entityType: "character", entityId: "char-a" },
      { entityType: "gongche-block", entityId: "gongche-a", trackId: "character-track" },
    ],
  });
  assert.ok(envelope);
  const applied = applyAnnotationTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  const restored = applyAnnotationTransactionCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("自定义父块与关联工尺可同批删除且不留下孤儿引用", () => {
  const base = createProject();
  base.customTracks.push({
    id: "transaction-track",
    name: "事务轨",
    trackType: "action",
    typeOptions: ["动作"],
    blocks: [{ id: "transaction-block", startTime: 4, endTime: 5, type: "动作" }],
    attachedPointTracks: [],
  });
  base.gongcheAnnotations.push({
    id: "transaction-gongche",
    parentTrackId: "transaction-track",
    parentBlockId: "transaction-block",
    startTime: 4,
    endTime: 5,
    symbols: [{
      id: "transaction-symbol",
      label: "尺",
      notation: "",
      rawText: "尺",
      parenthesized: false,
      startTime: 4,
      endTime: 5,
      assetUrl: null,
    }],
  });
  const next = structuredClone(base);
  next.customTracks[next.customTracks.length - 1].blocks = [];
  next.gongcheAnnotations = next.gongcheAnnotations.filter((block) => block.id !== "transaction-gongche");
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    lifecycleTargets: [
      { entityType: "custom-block", entityId: "transaction-block", trackId: "transaction-track" },
      { entityType: "gongche-block", entityId: "transaction-gongche", trackId: "transaction-track" },
    ],
  });
  assert.ok(envelope);
  const applied = applyAnnotationTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});

test("事务任一子命令前置条件失败时不泄漏前面步骤", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.characterAnnotations.push({
    id: "char-b",
    lineId: "line-a",
    char: "乙",
    startTime: 2,
    endTime: 3,
    tone: null,
  });
  next.subtitleLines[0] = { ...next.subtitleLines[0], text: "甲乙", endTime: 3 };
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    contentTargets: [{ entityType: "sentence", entityId: "line-a", field: "text" }],
    timingTargets: [{ entityType: "sentence", entityId: "line-a" }],
    lifecycleTargets: [{ entityType: "character", entityId: "char-b" }],
  });
  assert.ok(envelope);
  const conflicted = structuredClone(base);
  conflicted.subtitleLines[0].endTime = 2.5;
  const snapshot = structuredClone(conflicted);
  const result = applyAnnotationTransactionCommandToProject(conflicted, envelope);
  assert.equal(result.status, "blocked");
  assert.deepEqual(conflicted, snapshot);
});

test("删除被板眼引用的工尺符号时先原子断链再执行生命周期删除", () => {
  const base = createProject();
  base.banyanMarks = [{
    id: "transaction-mark",
    sectionId: null,
    time: 1,
    estimatedTime: 1,
    sourceSymbol: "1",
    role: "ban",
    subtype: "mainBan",
    segment: "main",
    beatIndex: null,
    cycleIndex: null,
    attachment: "on_note",
    linkedGongcheAnnotationId: "gongche-a",
    linkedGongcheSymbolId: "symbol-a",
    linkedGongcheSymbolIds: ["symbol-a"],
    confidence: "auto",
    durationHint: null,
    orphaned: false,
  }];
  const next = structuredClone(base);
  next.gongcheAnnotations[0].symbols = [];
  next.banyanMarks[0] = {
    ...next.banyanMarks[0],
    linkedGongcheSymbolId: null,
    linkedGongcheSymbolIds: [],
    orphaned: true,
  };
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    stateTargets: [{ entityType: "banyan-mark", entityId: "transaction-mark" }],
    lifecycleTargets: [{ entityType: "gongche-symbol", entityId: "symbol-a", trackId: "gongche-a" }],
  });
  assert.ok(envelope);
  assert.deepEqual(envelope.command.commands.map((command) => command.type), [
    "annotation.items.state.update",
    "annotation.items.lifecycle.update",
  ]);
  const applied = applyAnnotationTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyAnnotationTransactionCommandToProject(applied.project, invertAnnotationCommandEnvelope(envelope));
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});
