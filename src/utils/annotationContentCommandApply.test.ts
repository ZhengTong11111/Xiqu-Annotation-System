import assert from "node:assert/strict";
import test from "node:test";
import { invertAnnotationCommandEnvelope } from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import {
  buildProjectAnnotationContentCommand,
  type AnnotationContentTarget,
} from "./annotationContentCommand";
import { applyAnnotationContentCommandToProject } from "./annotationContentCommandApply";

// 夹具加入动作和附属点，使一次命令覆盖五类首批稳定内容实体。
function createProject(): ProjectData {
  const project = structuredClone(mockProject);
  project.customTracks.push({
    id: "content-text-track",
    name: "内容文字轨",
    trackType: "text",
    typeOptions: ["原类型"],
    blocks: [{
      id: "content-text-block",
      startTime: 4,
      endTime: 5,
      text: "原文字",
      type: "原类型",
    }],
    attachedPointTracks: [],
  });
  project.actionAnnotations = [{
    id: "content-action-1",
    trackId: project.customTracks[0].id,
    label: "原动作",
    startTime: 1,
    endTime: 2,
  }];
  project.builtinTracks[0].attachedPointTracks = [{
    id: "content-point-track",
    name: "内容点轨",
    typeOptions: ["原点"],
    points: [{ id: "content-point-1", time: 3, label: "原点" }],
  }];
  return project;
}

// 目标表显式绑定字段与 track scope，防止测试通过 UI 位置偶然寻址。
function getTargets(project: ProjectData): AnnotationContentTarget[] {
  return [
    { entityType: "sentence", entityId: project.subtitleLines[0].id, field: "text" },
    { entityType: "character", entityId: project.characterAnnotations[0].id, field: "char" },
    {
      entityType: "action",
      entityId: "content-action-1",
      trackId: project.customTracks[0].id,
      field: "label",
    },
    {
      entityType: "custom-block",
      entityId: "content-text-block",
      trackId: "content-text-track",
      field: "type",
    },
    {
      entityType: "custom-block",
      entityId: "content-text-block",
      trackId: "content-text-track",
      field: "text",
    },
    {
      entityType: "attached-point",
      entityId: "content-point-1",
      trackId: "content-point-track",
      field: "label",
    },
  ];
}

test("内容命令原子应用五类实体并可反向恢复", () => {
  const base = createProject();
  const original = structuredClone(base);
  const next = structuredClone(base);
  next.subtitleLines[0].text = "新句";
  next.characterAnnotations[0].char = "新";
  next.actionAnnotations[0].label = "新动作";
  const customTrack = next.customTracks.find((track) => track.id === "content-text-track");
  const customBlock = customTrack?.blocks.find((block) => block.id === "content-text-block");
  if (!customBlock) throw new Error("内容命令测试夹具缺少自定义文字块。 ");
  customBlock.type = "新类型";
  if (!("text" in customBlock)) throw new Error("内容命令测试夹具不是文字块。 ");
  customBlock.text = "新文字";
  next.builtinTracks[0].attachedPointTracks[0].points[0].label = "新点";
  const envelope = buildProjectAnnotationContentCommand(base, next, getTargets(base));
  assert.ok(envelope);
  const applied = applyAnnotationContentCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  assert.deepEqual(base, original);
  assert.equal(
    buildProjectAnnotationContentCommand(applied.project, next, getTargets(next)),
    null,
  );
  const inverse = invertAnnotationCommandEnvelope(envelope);
  const restored = applyAnnotationContentCommandToProject(applied.project, inverse);
  assert.equal(restored.status, "applied");
  if (restored.status !== "applied") return;
  assert.equal(restored.project.characterAnnotations[0].char, base.characterAnnotations[0].char);
});

test("内容命令任一错轨或 before 冲突时保持输入不变", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.actionAnnotations[0].label = "新动作";
  const envelope = buildProjectAnnotationContentCommand(base, next, [getTargets(base)[2]]);
  assert.ok(envelope);
  const wrongTrack = structuredClone(envelope);
  wrongTrack.command.items[0].trackId = "wrong-track";
  assert.equal(applyAnnotationContentCommandToProject(base, wrongTrack).status, "blocked");
  const mismatch = structuredClone(envelope);
  mismatch.command.items[0].before = "错误旧值";
  assert.equal(applyAnnotationContentCommandToProject(base, mismatch).status, "blocked");
  assert.equal(base.actionAnnotations[0].label, "原动作");
});

test("内容 builder 对缺失目标和合同外变化返回 null", () => {
  const base = createProject();
  assert.equal(buildProjectAnnotationContentCommand(base, base, [{
    entityType: "character",
    entityId: "missing-character",
    field: "char",
  }]), null);

  const next = structuredClone(base);
  next.characterAnnotations[0].char = "新";
  next.characterAnnotations[0].startTime += 1;
  assert.equal(buildProjectAnnotationContentCommand(base, next, [{
    entityType: "character",
    entityId: base.characterAnnotations[0].id,
    field: "char",
  }]), null);
});
