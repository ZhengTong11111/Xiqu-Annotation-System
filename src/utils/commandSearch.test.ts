import assert from "node:assert/strict";
import test from "node:test";
import type { CommandDefinition } from "./commandCatalog";
import { normalizeCommandQuery, searchCommands } from "./commandSearch";

// 测试用最小目录：覆盖标题精确、标题子串、关键词、路径四类命中来源。
const definitions: CommandDefinition[] = [
  {
    id: "playback.toggle-loop",
    label: "循环播放选区",
    path: ["播放", "循环播放选区"],
    keywords: ["loop", "重复"],
    featured: true,
    target: { kind: "static" },
  },
  {
    id: "playback.clear-loop-range",
    label: "清除循环选区",
    path: ["播放", "清除循环选区"],
    keywords: ["loop", "clear"],
    target: { kind: "static" },
  },
  {
    id: "track:t1:auto-loop-range",
    label: "选中块时更新循环范围",
    path: ["逐字文字轨", "轨道设置", "选中块时更新循环范围"],
    keywords: ["loop", "范围", "逐字文字轨"],
    target: {
      kind: "track-setting",
      trackId: "t1",
      trackKind: "builtin",
      field: "auto-loop-range",
      focusTarget: "track-auto-loop-range",
      toggle: true,
    },
  },
  {
    id: "view.waveform",
    label: "音频波形",
    path: ["视图", "音频波形"],
    keywords: ["waveform", "audio"],
    featured: true,
    target: { kind: "static" },
  },
];

test("中文子串搜索同时命中菜单项与轨道设置字段", () => {
  const ids = searchCommands(definitions, "循环").map((match) => match.item.id);
  assert.deepEqual(ids, [
    "playback.toggle-loop",
    "playback.clear-loop-range",
    "track:t1:auto-loop-range",
  ]);
});

test("标题精确匹配排在标题子串匹配之前", () => {
  const matches = searchCommands(definitions, "音频波形");
  assert.equal(matches[0]?.item.id, "view.waveform");
  assert.equal(matches[0]?.score, 100);
  assert.equal(matches[0]?.matchedField, "label");
});

test("英文关键词可以命中纯中文标题的条目", () => {
  const matches = searchCommands(definitions, "loop");
  assert.equal(matches.length, 3);
  assert.ok(matches.every((match) => match.matchedField === "keyword"));
});

test("搜索菜单名可以列出该路径下的条目", () => {
  const matches = searchCommands(definitions, "视图");
  assert.deepEqual(
    matches.map((match) => match.item.id),
    ["view.waveform"],
  );
  assert.equal(matches[0]?.matchedField, "path");
});

test("空查询返回 featured 条目而不是全部命令", () => {
  const ids = searchCommands(definitions, "   ").map((match) => match.item.id);
  assert.deepEqual(ids, ["playback.toggle-loop", "view.waveform"]);
});

test("limit 生效且排序稳定", () => {
  const first = searchCommands(definitions, "循环", 2).map((match) => match.item.id);
  const second = searchCommands(definitions, "循环", 2).map((match) => match.item.id);
  assert.equal(first.length, 2);
  assert.deepEqual(first, second);
});

test("查询归一化处理全角字符与大小写", () => {
  assert.equal(normalizeCommandQuery("　ＬＯＯＰ　"), "loop");
  const matches = searchCommands(definitions, "ＬＯＯＰ");
  assert.equal(matches.length, 3);
});

test("无命中时返回空数组", () => {
  assert.deepEqual(searchCommands(definitions, "不存在的功能"), []);
});

test("全拼可以命中纯中文标题", () => {
  const matches = searchCommands(definitions, "xunhuan");
  // 三条都是同分的全拼子串命中，彼此顺序由 id 兜底，这里只断言命中集合与来源。
  assert.deepEqual(matches.map((match) => match.item.id).sort(), [
    "playback.clear-loop-range",
    "playback.toggle-loop",
    "track:t1:auto-loop-range",
  ]);
  assert.ok(matches.every((match) => match.matchedField === "pinyin"));
});

test("首字母可以命中纯中文标题", () => {
  const matches = searchCommands(definitions, "ypbx");
  assert.equal(matches[0]?.item.id, "view.waveform");
  assert.equal(matches[0]?.matchedField, "pinyin");
});

test("显式关键词优先于拼音命中", () => {
  const matches = searchCommands(definitions, "loop");
  assert.ok(matches.every((match) => match.matchedField === "keyword"));
});

test("拼音命中排在路径命中之前", () => {
  const pinyinMatch = searchCommands(definitions, "bofang")[0];
  assert.equal(pinyinMatch?.matchedField, "pinyin");
  assert.ok((pinyinMatch?.score ?? 0) > 25);
});

test("中文查询不会因为拼音分支改变原有结果", () => {
  const ids = searchCommands(definitions, "循环").map((match) => match.item.id);
  assert.deepEqual(ids, [
    "playback.toggle-loop",
    "playback.clear-loop-range",
    "track:t1:auto-loop-range",
  ]);
});
