import assert from "node:assert/strict";
import test from "node:test";
import {
  invertAnnotationCommandEnvelope,
  isAnnotationMutationLeaseRequiredCommandType,
  parseAnnotationCommandEnvelope,
  TRACK_STRUCTURE_TRANSACTION_APPLY_COMMAND,
} from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { AttachedPointTrack, CustomTrack, ProjectData } from "../types";
import { repairBanyanGongcheReferences } from "./banyanReferenceIntegrity";
import { buildProjectTrackStructureTransactionCommand } from "./trackStructureTransactionCommand";
import { applyTrackStructureTransactionCommandToProject } from "./trackStructureTransactionCommandApply";

function createProject(): ProjectData {
  return structuredClone(mockProject);
}

test("自定义轨创建可精确恢复 customTracks 与 activeTrackOrder 位置", () => {
  const base = createProject();
  const nextTrack: CustomTrack = {
    id: "custom-track-new",
    name: "新轨道",
    trackType: "text",
    color: "#2563eb",
    typeOptions: ["类型 1"],
    blocks: [],
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
  };
  const next = {
    ...base,
    customTracks: [base.customTracks[0], nextTrack, base.customTracks[1]] as CustomTrack[],
    activeTrackOrder: [base.activeTrackOrder[0], base.activeTrackOrder[1], nextTrack.id, base.activeTrackOrder[2]],
  };
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    customTrackLifecycleTargets: [{ trackId: nextTrack.id }],
  });
  assert.ok(envelope);
  assert.equal(envelope.command.type, TRACK_STRUCTURE_TRANSACTION_APPLY_COMMAND);
  assert.equal(isAnnotationMutationLeaseRequiredCommandType(envelope.command.type), true);
  const applied = applyTrackStructureTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const inverse = invertAnnotationCommandEnvelope(envelope);
  assert.ok(inverse);
  const restored = applyTrackStructureTransactionCommandToProject(applied.project, inverse);
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("内建轨附属点轨创建同时恢复父轨展开状态和点轨顺序", () => {
  const base = createProject();
  const pointTrack: AttachedPointTrack = {
    id: "point-track-new",
    name: "呼吸轨",
    typeOptions: ["呼吸"],
    points: [{ id: "point-new", time: 1.25, label: "呼吸" }],
    snapToWaveformKeypoints: false,
    snapToParentBoundaries: true,
  };
  const next = {
    ...base,
    builtinTracks: base.builtinTracks.map((track) => track.id === "character-track"
      ? { ...track, attachedPointTracksExpanded: true, attachedPointTracks: [pointTrack] }
      : track),
  };
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    attachedPointTrackLifecycleTargets: [{
      pointTrackId: pointTrack.id,
      parentTrackId: "character-track",
      parentTrackType: "builtin",
    }],
  });
  assert.ok(envelope);
  const applied = applyTrackStructureTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});

test("自定义父轨附属点轨删除可反向恢复，跨父轨重复 id 会被拒绝", () => {
  const base = createProject();
  const pointTrack: AttachedPointTrack = {
    id: "point-track-owned",
    name: "气口",
    typeOptions: ["呼吸"],
    points: [{ id: "point-owned", time: 2.5, label: "呼吸" }],
    snapToParentBoundaries: true,
  };
  base.customTracks[0].attachedPointTracks = [pointTrack];
  base.customTracks[0].attachedPointTracksExpanded = true;
  const next = structuredClone(base);
  next.customTracks[0].attachedPointTracks = [];
  next.customTracks[0].attachedPointTracksExpanded = false;
  const target = {
    pointTrackId: pointTrack.id,
    parentTrackId: base.customTracks[0].id,
    parentTrackType: "custom" as const,
  };
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    attachedPointTrackLifecycleTargets: [target],
  });
  assert.ok(envelope);
  const applied = applyTrackStructureTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyTrackStructureTransactionCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);

  const duplicated = structuredClone(base);
  duplicated.builtinTracks[0].attachedPointTracks = [structuredClone(pointTrack)];
  assert.equal(buildProjectTrackStructureTransactionCommand(duplicated, next, {
    attachedPointTrackLifecycleTargets: [target],
  }), null);
});

test("typeOptions 重命名与受影响块 type 作为一笔结构事务应用", () => {
  const base = createProject();
  const trackId = base.customTracks[0].id;
  const oldType = base.customTracks[0].typeOptions[0];
  const next = structuredClone(base);
  next.customTracks[0].typeOptions[0] = "新动作";
  next.customTracks[0].blocks = next.customTracks[0].blocks.map((block) =>
    block.type === oldType ? { ...block, type: "新动作" } : block) as CustomTrack["blocks"];
  const affectedIds = base.customTracks[0].blocks.filter((block) => block.type === oldType).map((block) => block.id);
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    customTrackStructureIds: [trackId],
    contentTargets: affectedIds.map((entityId) => ({
      entityType: "custom-block",
      entityId,
      trackId,
      field: "type",
    })),
  });
  assert.ok(envelope);
  const applied = applyTrackStructureTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});

test("轨道顺序、内建唱法和点轨标签配置可分别原子应用并反向恢复", () => {
  const base = createProject();
  base.builtinTracks[0].options = [base.characterAnnotations[0].singingStyle, "念白"];
  base.builtinTracks[0].attachedPointTracks = [{
    id: "configured-point-track",
    name: "呼吸",
    typeOptions: ["呼吸", "换气"],
    points: [{ id: "configured-point", time: 2, label: "呼吸" }],
  }];
  const next = structuredClone(base);
  next.activeTrackOrder = [...next.activeTrackOrder].reverse();
  next.builtinTracks[0].name = "逐字唱腔";
  next.builtinTracks[0].options![0] = "唱腔";
  next.characterAnnotations[0].singingStyle = "唱腔";
  next.builtinTracks[0].attachedPointTracks[0].typeOptions[0] = "气口";
  next.builtinTracks[0].attachedPointTracks[0].points[0].label = "气口";
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    includeTrackOrder: true,
    builtinTrackStructureIds: ["character-track"],
    attachedPointTrackStructureTargets: [{
      parentTrackType: "builtin",
      parentTrackId: "character-track",
      pointTrackId: "configured-point-track",
    }],
    contentTargets: [
      { entityType: "character", entityId: base.characterAnnotations[0].id, field: "singingStyle" },
      { entityType: "attached-point", entityId: "configured-point", trackId: "configured-point-track", field: "label" },
    ],
  });
  assert.ok(envelope);
  const applied = applyTrackStructureTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyTrackStructureTransactionCommandToProject(applied.project,
    invertAnnotationCommandEnvelope(envelope));
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("配置事务漏报唱法级联或遇到错父点轨时 fail closed", () => {
  const base = createProject();
  base.builtinTracks[0].options = [base.characterAnnotations[0].singingStyle];
  const next = structuredClone(base);
  next.builtinTracks[0].options![0] = "新唱法";
  next.characterAnnotations[0].singingStyle = "新唱法";
  assert.equal(buildProjectTrackStructureTransactionCommand(base, next, {
    builtinTrackStructureIds: ["character-track"],
  }), null);

  base.builtinTracks[0].attachedPointTracks = [{
    id: "wrong-parent-point-track",
    name: "点轨",
    typeOptions: ["点"],
    points: [],
  }];
  const renamed = structuredClone(base);
  renamed.builtinTracks[0].attachedPointTracks[0].name = "新点轨";
  assert.equal(buildProjectTrackStructureTransactionCommand(base, renamed, {
    attachedPointTrackStructureTargets: [{
      parentTrackType: "custom",
      parentTrackId: base.customTracks[0].id,
      pointTrackId: "wrong-parent-point-track",
    }],
  }), null);
});

test("自定义父轨上的既有点轨配置只更新声明父集合", () => {
  const base = createProject();
  base.customTracks[0].attachedPointTracks = [{
    id: "custom-parent-point-track",
    name: "原点轨",
    typeOptions: ["点"],
    points: [{ id: "custom-parent-point", time: 1, label: "点" }],
  }];
  const next = structuredClone(base);
  next.customTracks[0].attachedPointTracks[0].name = "新点轨";
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    attachedPointTrackStructureTargets: [{
      parentTrackType: "custom",
      parentTrackId: base.customTracks[0].id,
      pointTrackId: "custom-parent-point-track",
    }],
  });
  assert.ok(envelope);
  const applied = applyTrackStructureTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});

test("整轨删除按板眼断链、工尺删除、父轨删除顺序原子执行", () => {
  const base = createProject();
  const track = base.customTracks[0];
  const block = track.blocks[0];
  base.gongcheAnnotations = [{
    id: "gongche-block-1",
    parentTrackId: track.id,
    parentBlockId: block.id,
    startTime: block.startTime,
    endTime: block.endTime,
    symbols: [{
      id: "gongche-symbol-1",
      label: "上",
      notation: "",
      rawText: "上",
      parenthesized: false,
      startTime: block.startTime,
      endTime: block.endTime,
      assetUrl: null,
    }],
  }];
  base.banyanMarks = [{
    id: "banyan-mark-1",
    sectionId: null,
    time: block.startTime,
    estimatedTime: block.startTime,
    sourceSymbol: "1",
    role: "ban",
    subtype: "mainBan",
    segment: "main",
    beatIndex: null,
    cycleIndex: null,
    strength: "unknown",
    attachment: "on_note",
    linkedGongcheAnnotationId: "gongche-block-1",
    linkedGongcheSymbolId: "gongche-symbol-1",
    linkedGongcheSymbolIds: ["gongche-symbol-1"],
    confidence: "manual",
    manualOffset: 0,
    durationHint: null,
    orphaned: false,
  }];
  const removed = {
    ...base,
    customTracks: base.customTracks.filter((item) => item.id !== track.id) as CustomTrack[],
    activeTrackOrder: base.activeTrackOrder.filter((id) => id !== track.id),
    gongcheAnnotations: [],
  };
  const next = repairBanyanGongcheReferences(removed).project;
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    customTrackLifecycleTargets: [{ trackId: track.id }],
    lifecycleTargets: [{ entityType: "gongche-block", entityId: "gongche-block-1", trackId: track.id }],
    stateTargets: [{ entityType: "banyan-mark", entityId: "banyan-mark-1" }],
  });
  assert.ok(envelope);
  const applied = applyTrackStructureTransactionCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyTrackStructureTransactionCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("结构事务拒绝无结构子命令、坏 precondition 和未知额外字段", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.customTracks[0].name = "新名称";
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    customTrackStructureIds: [next.customTracks[0].id],
  });
  assert.ok(envelope);
  const conflicted = structuredClone(base);
  conflicted.customTracks[0].color = "#ef4444";
  assert.equal(applyTrackStructureTransactionCommandToProject(conflicted, envelope).status, "blocked");
  assert.equal(parseAnnotationCommandEnvelope({
    ...envelope,
    unexpected: true,
  }), null);
  assert.equal(parseAnnotationCommandEnvelope({
    version: 1,
    command: {
      type: TRACK_STRUCTURE_TRANSACTION_APPLY_COMMAND,
      commands: [{
        type: "annotation.items.content.update",
        items: [{
          entityType: "custom-block",
          entityId: base.customTracks[0].blocks[0].id,
          trackId: base.customTracks[0].id,
          field: "type",
          before: base.customTracks[0].blocks[0].type,
          after: "另一类型",
        }],
      }],
    },
  }), null);
});

test("结构生命周期拒绝排序失配和重复块 id，避免把畸形容器编码为创建或删除", () => {
  const base = createProject();
  const missingOrder = structuredClone(base);
  missingOrder.activeTrackOrder = missingOrder.activeTrackOrder
    .filter((trackId) => trackId !== missingOrder.customTracks[0].id);
  const deleted = {
    ...missingOrder,
    customTracks: missingOrder.customTracks.slice(1) as CustomTrack[],
  };
  assert.equal(buildProjectTrackStructureTransactionCommand(missingOrder, deleted, {
    customTrackLifecycleTargets: [{ trackId: missingOrder.customTracks[0].id }],
  }), null);

  const duplicateBlock = structuredClone(base);
  duplicateBlock.customTracks[0].blocks.push(structuredClone(duplicateBlock.customTracks[0].blocks[0]) as never);
  const renamed = structuredClone(duplicateBlock);
  renamed.customTracks[0].name = "重复块项目";
  assert.equal(buildProjectTrackStructureTransactionCommand(duplicateBlock, renamed, {
    customTrackStructureIds: [duplicateBlock.customTracks[0].id],
  }), null);
});
