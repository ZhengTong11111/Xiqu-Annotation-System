import assert from "node:assert/strict";
import test from "node:test";
import type { BuiltinTrack, CustomTrack } from "../types";
import {
  buildTrackSettingCommands,
  findTrackForCommand,
  LOCAL_STATIC_COMMAND_DEFINITIONS,
  PLATFORM_STATIC_COMMAND_DEFINITIONS,
  resolveTrackSettingCommandState,
  type TrackSettingCommandTarget,
} from "./commandCatalog";

// 内置文字轨带一条附属打点轨，用于验证父轨道与附属轨的命令都会被展开。
const builtinTrack: BuiltinTrack = {
  id: "character-track",
  name: "逐字文字轨",
  type: "character",
  attachedPointTracks: [
    {
      id: "point-1",
      name: "起手点",
      typeOptions: ["起"],
      points: [],
    },
  ],
};

const customTextTrack: CustomTrack = {
  id: "custom-text",
  name: "身段说明",
  trackType: "text",
  typeOptions: [],
  blocks: [],
  attachedPointTracks: [],
};

const customActionTrack: CustomTrack = {
  id: "custom-action",
  name: "身段轨",
  trackType: "action",
  typeOptions: [],
  blocks: [],
  attachedPointTracks: [],
};

test("静态命令 id 唯一且路径、关键词非空", () => {
  const all = [...LOCAL_STATIC_COMMAND_DEFINITIONS, ...PLATFORM_STATIC_COMMAND_DEFINITIONS];
  const ids = new Set(all.map((definition) => definition.id));
  assert.equal(ids.size, all.length);
  for (const definition of all) {
    assert.ok(definition.label.length > 0, `${definition.id} 缺少标题`);
    assert.ok(definition.path.length > 0, `${definition.id} 缺少路径`);
    assert.ok(definition.keywords.length > 0, `${definition.id} 缺少关键词`);
  }
});

test("音频设置类命令必须携带 audio-* 聚焦目标", () => {
  const all = [...LOCAL_STATIC_COMMAND_DEFINITIONS, ...PLATFORM_STATIC_COMMAND_DEFINITIONS];
  for (const definition of all) {
    if (definition.target.kind === "audio-setting") {
      assert.ok(
        definition.target.focusTarget.startsWith("audio-"),
        `${definition.id} 的聚焦目标不属于音频轨道设置面板`,
      );
    } else {
      assert.equal(definition.target.kind, "static", `${definition.id} 使用了非法的静态命令目标`);
    }
  }
});

test("自定义轨道展开颜色与递归分叉，内置轨道不展开", () => {
  const builtinCommands = buildTrackSettingCommands([builtinTrack], []);
  const customCommands = buildTrackSettingCommands([], [customActionTrack]);
  const builtinFields = builtinCommands
    .filter((definition) => definition.target.kind === "track-setting" &&
      definition.target.trackId === "character-track")
    .map((definition) => definition.id);
  assert.ok(!builtinFields.includes("track:character-track:color"));
  assert.ok(!builtinFields.includes("track:character-track:branching"));
  assert.ok(customCommands.some((definition) => definition.id === "track:custom-action:color"));
  assert.ok(customCommands.some((definition) => definition.id === "track:custom-action:branching"));
});

test("附属打点轨展开父轨道边界吸附，且不展开选中块循环范围", () => {
  const commands = buildTrackSettingCommands([builtinTrack], []);
  const pointCommand = commands.find((definition) => definition.id === "track:point-1:parent-boundary-snap");
  assert.ok(pointCommand);
  assert.deepEqual(pointCommand?.path, ["起手点", "附属打点轨设置", "吸附到父轨道标注边界"]);
  assert.equal(pointCommand?.target.kind, "track-setting");
  if (pointCommand?.target.kind === "track-setting") {
    assert.equal(pointCommand.target.parentTrackId, "character-track");
    assert.equal(pointCommand.target.trackKind, "attached-point");
  }
  assert.ok(!commands.some((definition) => definition.id === "track:point-1:auto-loop-range"));
});

test("只有文字类轨道生成工尺谱导入入口", () => {
  const commands = buildTrackSettingCommands([builtinTrack], [customTextTrack, customActionTrack]);
  assert.ok(commands.some((definition) => definition.id === "track:character-track:gongche-import"));
  assert.ok(commands.some((definition) => definition.id === "track:custom-text:gongche-import"));
  assert.ok(!commands.some((definition) => definition.id === "track:custom-action:gongche-import"));
});

test("选中块时更新循环范围带上轨道名作为关键词", () => {
  const commands = buildTrackSettingCommands([builtinTrack], []);
  const loopCommand = commands.find(
    (definition) => definition.id === "track:character-track:auto-loop-range",
  );
  assert.ok(loopCommand);
  assert.deepEqual(loopCommand?.path, ["逐字文字轨", "轨道设置", "选中块时更新循环范围"]);
  assert.ok(loopCommand?.keywords.includes("逐字文字轨"));
});

// 从生成的命令里取出目标，避免测试自己手写一份可能与实现漂移的 target。
function targetOf(id: string): TrackSettingCommandTarget {
  const commands = buildTrackSettingCommands([builtinTrack], [customActionTrack]);
  const definition = commands.find((item) => item.id === id);
  assert.ok(definition, `未生成命令 ${id}`);
  assert.equal(definition?.target.kind, "track-setting");
  return definition?.target as TrackSettingCommandTarget;
}

test("开关类字段标记为 toggle，输入类字段不标记", () => {
  assert.equal(targetOf("track:character-track:auto-loop-range").toggle, true);
  assert.equal(targetOf("track:character-track:track-snap").toggle, true);
  assert.equal(targetOf("track:character-track:waveform-snap").toggle, true);
  assert.equal(targetOf("track:custom-action:branching").toggle, true);
  assert.equal(targetOf("track:point-1:parent-boundary-snap").toggle, true);
  assert.equal(targetOf("track:character-track:name").toggle, false);
  assert.equal(targetOf("track:custom-action:color").toggle, false);
  assert.equal(targetOf("track:character-track:type-options").toggle, false);
});

test("轨道吸附总开关挂在轨道头面包屑下", () => {
  const commands = buildTrackSettingCommands([builtinTrack], []);
  const definition = commands.find((item) => item.id === "track:character-track:track-snap");
  assert.deepEqual(definition?.path, ["逐字文字轨", "轨道头", "吸附"]);
});

test("附属打点轨没有轨道头吸附开关", () => {
  const commands = buildTrackSettingCommands([builtinTrack], []);
  assert.ok(!commands.some((item) => item.id === "track:point-1:track-snap"));
});

test("勾选态读取轨道上的真实取值", () => {
  const track = { ...builtinTrack, autoSetLoopRangeOnSelect: true, snapToWaveformKeypoints: true };
  const state = resolveTrackSettingCommandState(
    targetOf("track:character-track:auto-loop-range"),
    [track],
    [],
    {},
  );
  assert.equal(state.checked, true);
  assert.equal(state.disabledReason, undefined);
});

test("吸附细项在轨道头总开关关闭时给出禁用原因", () => {
  const target = targetOf("track:character-track:waveform-snap");
  const off = resolveTrackSettingCommandState(target, [builtinTrack], [], {});
  assert.equal(off.disabledReason, "请先开启该轨道的吸附总开关");
  const on = resolveTrackSettingCommandState(target, [builtinTrack], [], { "character-track": true });
  assert.equal(on.disabledReason, undefined);
  assert.equal(on.checked, false);
});

test("轨道已被删除时命令给出禁用原因而不是崩溃", () => {
  const state = resolveTrackSettingCommandState(
    targetOf("track:character-track:auto-loop-range"),
    [],
    [],
    {},
  );
  assert.equal(state.disabledReason, "轨道已不存在");
});

test("findTrackForCommand 也能找到附属打点轨", () => {
  assert.equal(findTrackForCommand("point-1", [builtinTrack], [])?.name, "起手点");
  assert.equal(findTrackForCommand("missing", [builtinTrack], []), null);
});

test("动态轨道命令 id 在同一项目内唯一", () => {
  const commands = buildTrackSettingCommands([builtinTrack], [customTextTrack, customActionTrack]);
  const ids = new Set(commands.map((definition) => definition.id));
  assert.equal(ids.size, commands.length);
});
