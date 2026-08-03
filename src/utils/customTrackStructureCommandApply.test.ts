import assert from "node:assert/strict";
import test from "node:test";
import { invertAnnotationCommandEnvelope } from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import { buildProjectCustomTrackStructureCommand } from "./customTrackStructureCommand";
import { applyCustomTrackStructureCommandToProject } from "./customTrackStructureCommandApply";

function createProject(): ProjectData {
  const project = structuredClone(mockProject);
  const track = project.customTracks[0];
  track.branching = {
    enabled: true,
    rootLabel: "全轨",
    displayMode: "merged",
    lanes: [{
      id: "lane-left",
      name: "左手",
      parentId: null,
      color: "#8b5cf6",
      children: [],
    }],
  };
  track.blocks[0].branchScope = { mode: "lanes", laneIds: ["lane-left"] };
  return project;
}

test("轨道元数据、递归分叉和块归属可原子应用并通过 inverse 恢复", () => {
  const base = createProject();
  const next = structuredClone(base);
  const track = next.customTracks[0];
  track.name = "双手";
  track.color = "#2563eb";
  track.branching = {
    ...track.branching!,
    displayMode: "expanded",
    lanes: [{
      ...track.branching!.lanes[0],
      children: [{
        id: "lane-fan",
        name: "扇",
        parentId: "lane-left",
        children: [],
      }],
    }],
  };
  track.blocks[0].branchScope = { mode: "lanes", laneIds: ["lane-fan"] };
  const envelope = buildProjectCustomTrackStructureCommand(base, next, [track.id]);
  assert.ok(envelope);
  const applied = applyCustomTrackStructureCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.deepEqual(applied.project, next);
  const restored = applyCustomTrackStructureCommandToProject(
    applied.project,
    invertAnnotationCommandEnvelope(envelope),
  );
  assert.equal(restored.status, "applied");
  if (restored.status === "applied") assert.deepEqual(restored.project, base);
});

test("轨道结构 adapter 拒绝 before 冲突且 builder 不掩盖合同外变化", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.customTracks[0].name = "新名称";
  const envelope = buildProjectCustomTrackStructureCommand(base, next, [next.customTracks[0].id]);
  assert.ok(envelope);

  const conflicted = structuredClone(base);
  conflicted.customTracks[0].color = "#ef4444";
  assert.equal(applyCustomTrackStructureCommandToProject(conflicted, envelope).status, "blocked");

  const changedContent = structuredClone(next);
  changedContent.customTracks[0].blocks[0].type = "合同外内容变化";
  assert.equal(buildProjectCustomTrackStructureCommand(base, changedContent, [next.customTracks[0].id]), null);
});

test("删除分叉时块归属回根，不会留下已经消失的 lane 引用", () => {
  const base = createProject();
  const next = structuredClone(base);
  next.customTracks[0].branching!.lanes = [];
  next.customTracks[0].blocks[0].branchScope = { mode: "root" };
  const envelope = buildProjectCustomTrackStructureCommand(base, next, [next.customTracks[0].id]);
  assert.ok(envelope);
  const applied = applyCustomTrackStructureCommandToProject(base, envelope);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") assert.deepEqual(applied.project, next);
});
