import assert from "node:assert/strict";
import test from "node:test";
import { invertAnnotationCommandEnvelope } from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import {
  buildProjectTimelineTimingCommand,
  type TimelineTimingTarget,
} from "./timelineTimingCommand";
import { applyTimelineTimingCommandToProject } from "./timelineTimingCommandApply";

// 测试项目同时包含七类 timing 目标和嵌套附属点，便于验证一次原子命令的完整应用。
function createProject(): ProjectData {
  const project = structuredClone(mockProject);
  const character = project.characterAnnotations[0];
  const customTrack = project.customTracks[0];
  if (!character || !customTrack?.blocks[0]) throw new Error("mockProject 缺少命令测试数据。");
  project.actionAnnotations = [{
    id: "action-apply-1",
    trackId: customTrack.id,
    label: "保留标签",
    startTime: 10,
    endTime: 11,
  }];
  project.builtinTracks[0].attachedPointTracks = [{
    id: "point-track-apply-1",
    name: "保留点轨名称",
    typeOptions: ["点"],
    points: [{ id: "point-apply-1", time: 12, label: "保留点标签" }],
  }];
  project.gongcheAnnotations = [{
    id: "gongche-apply-1",
    parentTrackId: "character-track",
    parentBlockId: character.id,
    startTime: character.startTime,
    endTime: character.endTime,
    symbols: [],
  }];
  project.banyanMarks = [{
    id: "banyan-apply-1",
    time: 13,
    estimatedTime: 12.5,
    sourceSymbol: "5",
    role: "ban",
    subtype: "mainBan",
    segment: "main",
    attachment: "on_note",
    confidence: "auto",
    manualOffset: 0.5,
  }];
  return project;
}

// 统一列出七类稳定目标，提取、apply 和 inverse 都使用同一身份集合。
function getTargets(project: ProjectData): TimelineTimingTarget[] {
  return [
    { entityType: "sentence", entityId: project.subtitleLines[0].id },
    { entityType: "character", entityId: project.characterAnnotations[0].id },
    {
      entityType: "action",
      entityId: project.actionAnnotations[0].id,
      trackId: project.actionAnnotations[0].trackId,
    },
    {
      entityType: "custom-block",
      entityId: project.customTracks[0].blocks[0].id,
      trackId: project.customTracks[0].id,
    },
    { entityType: "attached-point", entityId: "point-apply-1", trackId: "point-track-apply-1" },
    { entityType: "gongche-block", entityId: "gongche-apply-1", trackId: "character-track" },
    { entityType: "banyan-mark", entityId: "banyan-apply-1" },
  ];
}

// 只改目标时间生成最终项目，非时间字段用于断言 adapter 没有重建或污染其他业务语义。
function createNextProject(base: ProjectData): ProjectData {
  const next = structuredClone(base);
  next.subtitleLines[0].startTime += 1;
  next.subtitleLines[0].endTime += 1;
  next.characterAnnotations[0].startTime += 1;
  next.characterAnnotations[0].endTime += 1;
  next.actionAnnotations[0].startTime += 1;
  next.actionAnnotations[0].endTime += 1;
  next.customTracks[0].blocks[0].startTime += 1;
  next.customTracks[0].blocks[0].endTime += 1;
  next.builtinTracks[0].attachedPointTracks[0].points[0].time += 1;
  next.gongcheAnnotations[0].startTime += 1;
  next.gongcheAnnotations[0].endTime += 1;
  next.banyanMarks[0].time += 1;
  next.banyanMarks[0].manualOffset = next.banyanMarks[0].time - next.banyanMarks[0].estimatedTime;
  next.banyanMarks[0].confidence = "manual";
  return next;
}

// apply 后七类时间与 next 一致，inverse 后回到 base 时间，并保持输入与非时间字段不变。
test("ProjectData timing adapter 原子应用并可反向恢复", () => {
  const base = createProject();
  const original = structuredClone(base);
  const next = createNextProject(base);
  const envelope = buildProjectTimelineTimingCommand(base, next, getTargets(base));
  assert.ok(envelope);

  const applied = applyTimelineTimingCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(base, original);
  const rebuilt = buildProjectTimelineTimingCommand(applied.project, next, getTargets(next));
  assert.equal(rebuilt, null);
  assert.equal(applied.project.actionAnnotations[0].label, "保留标签");
  assert.equal(applied.project.builtinTracks[0].attachedPointTracks[0].points[0].label, "保留点标签");
  assert.equal(applied.project.banyanMarks[0].manualOffset, 1.5);
  assert.equal(applied.project.banyanMarks[0].confidence, "manual");

  const inverse = invertAnnotationCommandEnvelope(envelope);
  const restored = applyTimelineTimingCommandToProject(applied.project, inverse);
  assert.equal(restored.status, "applied");
  if (restored.status !== "applied") return;
  assert.equal(buildProjectTimelineTimingCommand(restored.project, base, getTargets(base)), null);
});

// 批量命令后项缺失或 before 冲突时，前项也不能写入；错误 track 同样属于目标缺失。
test("ProjectData timing adapter 对任一前置失败保持全部输入不变", () => {
  const base = createProject();
  const next = createNextProject(base);
  const envelope = buildProjectTimelineTimingCommand(base, next, getTargets(base));
  assert.ok(envelope);
  const missingTargetEnvelope = structuredClone(envelope);
  const lastItem = missingTargetEnvelope.command.items[
    missingTargetEnvelope.command.items.length - 1
  ];
  if (!lastItem) throw new Error("测试命令为空。");
  lastItem.entityId = "missing-target";
  const missing = applyTimelineTimingCommandToProject(base, missingTargetEnvelope);
  assert.equal(missing.status, "blocked");
  assert.equal(base.subtitleLines[0].startTime, mockProject.subtitleLines[0].startTime);

  const mismatchEnvelope = structuredClone(envelope);
  mismatchEnvelope.command.items[0].before.startTime += 0.01;
  const mismatch = applyTimelineTimingCommandToProject(base, mismatchEnvelope);
  assert.equal(mismatch.status, "blocked");

  const wrongTrackEnvelope = structuredClone(envelope);
  const actionItem = wrongTrackEnvelope.command.items.find((item) => item.entityType === "action");
  if (!actionItem) throw new Error("测试命令缺少动作目标。");
  actionItem.trackId = "wrong-track";
  const wrongTrack = applyTimelineTimingCommandToProject(base, wrongTrackEnvelope);
  assert.equal(wrongTrack.status, "blocked");
  assert.deepEqual(base, createProject());
});

// unknown 输入在 ProjectData 边界 fail closed，不返回伪造的项目结果。
test("ProjectData timing adapter 拒绝损坏命令", () => {
  assert.deepEqual(applyTimelineTimingCommandToProject(createProject(), {
    version: 2,
    command: {},
  }), { status: "invalid_command" });
});
