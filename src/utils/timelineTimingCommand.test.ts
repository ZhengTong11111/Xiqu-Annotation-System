import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import {
  buildProjectTimelineTimingCommand,
  getGongcheTimingTargetsForParents,
  type TimelineTimingTarget,
} from "./timelineTimingCommand";

// 构造覆盖全部首批实体的项目夹具，验证 UI 外的纯提取层不会遗漏嵌套轨道时间。
function createTimingProject(): ProjectData {
  const character = mockProject.characterAnnotations[0];
  const customTrack = mockProject.customTracks[0];
  const customBlock = customTrack.blocks[0];
  if (!character || !customBlock) throw new Error("mockProject 缺少时间命令测试数据。");
  return {
    ...structuredClone(mockProject),
    actionAnnotations: [{
      id: "action-command-1",
      trackId: customTrack.id,
      label: "测试动作",
      startTime: 10,
      endTime: 11,
    }],
    banyanMarks: [{
      id: "banyan-command-1",
      sectionId: "banyan-section-1",
      sourceSymbol: "5",
      role: "ban",
      subtype: "headBan",
      segment: "main",
      attachment: "on_note",
      estimatedTime: 12,
      time: 12,
      manualOffset: 0,
      confidence: "manual",
    }],
    gongcheAnnotations: [{
      id: "gongche-command-1",
      parentTrackId: "character-track",
      parentBlockId: character.id,
      startTime: character.startTime,
      endTime: character.endTime,
      symbols: [],
    }],
    builtinTracks: mockProject.builtinTracks.map((track) => ({
      ...track,
      attachedPointTracks: [{
        id: "point-track-command-1",
        name: "测试打点",
        typeOptions: ["点"],
        points: [{ id: "point-command-1", time: 13, label: "点" }],
      }],
    })),
  };
}

// 同一命令必须从 base/next 提取 before/after，并稳定去重重复目标。
test("项目 timing helper 提取嵌套实体并稳定去重", () => {
  const baseProject = createTimingProject();
  const nextProject = structuredClone(baseProject);
  const line = nextProject.subtitleLines[0];
  const character = nextProject.characterAnnotations[0];
  const customTrack = nextProject.customTracks[0];
  const customBlock = customTrack.blocks[0];
  if (!line || !character || !customBlock) throw new Error("测试数据不完整。");
  line.startTime += 1;
  line.endTime += 1;
  character.startTime += 1;
  character.endTime += 1;
  nextProject.actionAnnotations[0] = {
    ...nextProject.actionAnnotations[0],
    startTime: 11,
    endTime: 12,
  };
  customTrack.blocks[0] = { ...customBlock, startTime: customBlock.startTime + 1, endTime: customBlock.endTime + 1 };
  const point = nextProject.builtinTracks[0]?.attachedPointTracks?.[0]?.points[0];
  if (!point) throw new Error("测试打点不存在。");
  point.time = 14;
  nextProject.gongcheAnnotations[0] = {
    ...nextProject.gongcheAnnotations[0],
    startTime: nextProject.gongcheAnnotations[0].startTime + 1,
    endTime: nextProject.gongcheAnnotations[0].endTime + 1,
  };
  nextProject.banyanMarks[0] = { ...nextProject.banyanMarks[0], time: 14 };

  const targets: TimelineTimingTarget[] = [
    { entityType: "sentence", entityId: line.id },
    { entityType: "character", entityId: character.id },
    { entityType: "action", entityId: "action-command-1", trackId: customTrack.id },
    { entityType: "custom-block", entityId: customBlock.id, trackId: customTrack.id },
    { entityType: "attached-point", entityId: "point-command-1", trackId: "point-track-command-1" },
    { entityType: "gongche-block", entityId: "gongche-command-1", trackId: "character-track" },
    { entityType: "banyan-mark", entityId: "banyan-command-1" },
    { entityType: "character", entityId: character.id },
  ];
  const envelope = buildProjectTimelineTimingCommand(baseProject, nextProject, targets);

  assert.ok(envelope);
  assert.equal(envelope.command.items.length, 7);
  const characterItem = envelope.command.items.find((item) => item.entityType === "character");
  assert.deepEqual(characterItem?.before, {
    startTime: baseProject.characterAnnotations[0].startTime,
    endTime: baseProject.characterAnnotations[0].endTime,
  });
  assert.deepEqual(characterItem?.after, {
    startTime: character.startTime,
    endTime: character.endTime,
  });
});

// 创建或删除目标不能伪装成 timing.update；调用层应回退到完整 snapshot 操作。
test("项目 timing helper 对缺失目标和无变化返回 null", () => {
  const baseProject = createTimingProject();
  assert.equal(buildProjectTimelineTimingCommand(baseProject, structuredClone(baseProject), [{
    entityType: "character",
    entityId: baseProject.characterAnnotations[0].id,
  }]), null);
  assert.equal(buildProjectTimelineTimingCommand(baseProject, structuredClone(baseProject), [{
    entityType: "character",
    entityId: "missing-character",
  }]), null);
});

// 工尺派生目标从 base/next 并集收集，保证同步前后存在的同一块只产生一个命令目标。
test("工尺父块 helper 按父轨道和父块过滤并去重", () => {
  const baseProject = createTimingProject();
  const nextProject = structuredClone(baseProject);
  const characterId = baseProject.characterAnnotations[0].id;
  nextProject.gongcheAnnotations.push({
    id: "gongche-unrelated",
    parentTrackId: "character-track",
    parentBlockId: "other-character",
    startTime: 1,
    endTime: 2,
    symbols: [],
  });
  assert.deepEqual(getGongcheTimingTargetsForParents(
    [baseProject, nextProject],
    "character-track",
    [characterId],
  ), [{
    entityType: "gongche-block",
    entityId: "gongche-command-1",
    trackId: "character-track",
  }]);
});
