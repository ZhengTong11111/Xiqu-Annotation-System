import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import { getAutoLoopPlaybackRangeForSelection } from "./autoLoopPlaybackRange";

test("当前选中块的边界变化会得到最新循环范围", () => {
  const project = structuredClone(mockProject);
  project.customTracks[0].autoSetLoopRangeOnSelect = true;
  project.customTracks[0].blocks[0].startTime = 4;
  project.customTracks[0].blocks[0].endTime = 8;

  assert.deepEqual(
    getAutoLoopPlaybackRangeForSelection(project, {
      type: "custom-block",
      trackId: project.customTracks[0].id,
      id: project.customTracks[0].blocks[0].id,
    }),
    { start: 4, end: 8 },
  );
});

test("未选中的块变化不会影响当前选中块的计算结果", () => {
  const project = structuredClone(mockProject);
  project.customTracks[0].autoSetLoopRangeOnSelect = true;
  const selectedBlock = project.customTracks[0].blocks[0];
  selectedBlock.startTime = 2;
  selectedBlock.endTime = 5;
  const otherBlock = project.customTracks[0].blocks[1];
  otherBlock.startTime = 20;
  otherBlock.endTime = 30;

  assert.deepEqual(
    getAutoLoopPlaybackRangeForSelection(project, {
      type: "custom-block",
      trackId: project.customTracks[0].id,
      id: selectedBlock.id,
    }),
    { start: 2, end: 5 },
  );
});

test("关闭轨道设置后不产生自动循环范围", () => {
  const project = structuredClone(mockProject);
  project.customTracks[0].autoSetLoopRangeOnSelect = false;

  assert.equal(
    getAutoLoopPlaybackRangeForSelection(project, {
      type: "custom-block",
      trackId: project.customTracks[0].id,
      id: project.customTracks[0].blocks[0].id,
    }),
    null,
  );
});
