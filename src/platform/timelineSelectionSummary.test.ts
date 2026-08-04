import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectData, TimelineSelectionItem } from "../types";
import { buildTimelineSelectionSummary } from "./timelineSelectionSummary";

const project = {
  video: { name: "test", url: "", source: "url" },
  subtitleLines: [],
  characterAnnotations: [{
    id: "char-1", lineId: "line-1", char: "字", startTime: 1, endTime: 2, singingStyle: "",
  }],
  gongcheAnnotations: [],
  banyanSections: [],
  banyanMarks: [{
    id: "ban-1", time: 5, estimatedTime: 5, sourceSymbol: "1", role: "ban", subtype: "mainBan",
    segment: "main", attachment: "on_note", confidence: "manual",
  }],
  actionAnnotations: [{ id: "action-1", trackId: "action-track", label: "动作", startTime: 3, endTime: 4 }],
  builtinTracks: [{
    id: "character-track", name: "逐字", type: "character", attachedPointTracks: [{
      id: "point-track", name: "呼吸", typeOptions: [], points: [{ id: "point-1", time: 6, label: "呼吸" }],
    }],
  }],
  customTracks: [{
    id: "custom-1", name: "手部", trackType: "action", typeOptions: [], attachedPointTracks: [],
    blocks: [{ id: "block-1", startTime: 7, endTime: 9, type: "动作" }],
  }],
  activeTrackOrder: [],
} satisfies ProjectData;

test("选区摘要只输出时间、数量、轨道数和稳定种类", () => {
  const items: TimelineSelectionItem[] = [
    { type: "character", id: "char-1" },
    { type: "action", id: "action-1" },
    { type: "banyan-mark", id: "ban-1" },
    { type: "attached-point", id: "point-1", trackId: "point-track", parentTrackId: "character-track" },
    { type: "custom-block", id: "block-1", trackId: "custom-1", branchLaneId: "left" },
  ];
  assert.deepEqual(buildTimelineSelectionSummary(project, items), {
    start: 1,
    end: 9,
    itemCount: 5,
    laneCount: 5,
    kinds: ["character", "action", "custom_block", "attached_point", "banyan_mark"],
  });
});

test("选区摘要忽略已经删除的 stale item，并在无有效项时返回 null", () => {
  assert.deepEqual(buildTimelineSelectionSummary(project, [
    { type: "character", id: "missing" },
    { type: "character", id: "char-1" },
  ]), {
    start: 1,
    end: 2,
    itemCount: 1,
    laneCount: 1,
    kinds: ["character"],
  });
  assert.equal(buildTimelineSelectionSummary(project, [{ type: "action", id: "missing" }]), null);
});
