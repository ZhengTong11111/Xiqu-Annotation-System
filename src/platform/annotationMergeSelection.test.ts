import assert from "node:assert/strict";
import test from "node:test";
import type {
  AnnotationDiffChangeType,
  AnnotationDiffDomain,
  AnnotationDiffEntry,
  AnnotationDiffGroup,
  AnnotationDiffResult,
} from "./annotationDiff";
import {
  getMergeGroupSelectionState,
  isMergeEntrySelectable,
  normalizeMergeSelection,
  setMergeEntrySelection,
  setMergeGroupSelection,
} from "./annotationMergeSelection";

// 来源侧判断必须随方向反转，project 和 unchanged 永远不进入显式多选。
test("方向决定单侧差异是否可选", () => {
  assert.equal(isMergeEntrySelectable(entry("project", "modified"), "left-to-right"), false);
  assert.equal(isMergeEntrySelectable(entry("characters", "unchanged"), "left-to-right"), false);
  assert.equal(isMergeEntrySelectable(entry("characters", "removed"), "left-to-right"), true);
  assert.equal(isMergeEntrySelectable(entry("characters", "added"), "left-to-right"), false);
  assert.equal(isMergeEntrySelectable(entry("characters", "added"), "right-to-left"), true);
  assert.equal(isMergeEntrySelectable(entry("characters", "removed"), "right-to-left"), false);
  assert.equal(isMergeEntrySelectable(entry("characters", "modified"), "left-to-right"), true);
  assert.equal(isMergeEntrySelectable(entry("characters", "modified"), "right-to-left"), true);
});

// 切换方向保留双侧修改，清除新来源缺失项、未知 key 和重复项。
test("规范化选择裁剪幽灵与错误方向并保持稳定", () => {
  const diff = diffFixture();
  const input = [
    "characters:modified",
    "characters:left-only",
    "characters:right-only",
    "characters:modified",
    "characters:missing",
  ];
  assert.deepEqual([...normalizeMergeSelection(diff, "left-to-right", input)], [
    "characters:left-only",
    "characters:modified",
  ]);
  assert.deepEqual([...normalizeMergeSelection(diff, "right-to-left", input)], [
    "characters:modified",
    "characters:right-only",
  ]);
});

// 单项 helper 返回新 Set，调用方持有的旧状态不能被 checkbox 事件污染。
test("单项选择保持输入不可变", () => {
  const current = new Set(["characters:modified"]);
  const added = setMergeEntrySelection(current, "gongche:gongche-1", true);
  const removed = setMergeEntrySelection(added, "characters:modified", false);
  assert.deepEqual([...current], ["characters:modified"]);
  assert.deepEqual([...added].sort(), ["characters:modified", "gongche:gongche-1"]);
  assert.deepEqual([...removed], ["gongche:gongche-1"]);
});

// 分组批选排除当前方向不可用项，再次取消只移除该组，不能误删其他领域选择。
test("分组批选与取消仅作用于本组可选项", () => {
  const group = diffFixture().groups.find(({ domain }) => domain === "characters")!;
  const current = new Set(["gongche:gongche-1"]);
  const selected = setMergeGroupSelection(current, group, "left-to-right", true);
  assert.deepEqual([...selected].sort(), [
    "characters:left-only",
    "characters:modified",
    "gongche:gongche-1",
  ]);
  const cleared = setMergeGroupSelection(selected, group, "left-to-right", false);
  assert.deepEqual([...cleared], ["gongche:gongche-1"]);
  assert.deepEqual([...current], ["gongche:gongche-1"]);
});

// 分组 checkbox 必须准确表达空、部分和全部三态。
test("分组选择状态支持 checked 和 indeterminate", () => {
  const group = diffFixture().groups.find(({ domain }) => domain === "characters")!;
  assert.deepEqual(getMergeGroupSelectionState(new Set(), group, "left-to-right"), {
    selectableCount: 2,
    selectedCount: 0,
    checked: false,
    indeterminate: false,
  });
  assert.equal(getMergeGroupSelectionState(
    new Set(["characters:modified"]),
    group,
    "left-to-right",
  ).indeterminate, true);
  assert.equal(getMergeGroupSelectionState(
    new Set(["characters:modified", "characters:left-only"]),
    group,
    "left-to-right",
  ).checked, true);
});

// 测试 fixture 同时包含项目、双侧修改、左右单侧和未变化项，覆盖完整选择边界。
function diffFixture(): AnnotationDiffResult {
  const groups = [
    group("project", [entry("project", "modified", "project")]),
    group("characters", [
      entry("characters", "modified", "modified"),
      entry("characters", "removed", "left-only"),
      entry("characters", "added", "right-only"),
      entry("characters", "unchanged", "same"),
    ]),
    group("gongche", [entry("gongche", "modified", "gongche-1")]),
  ];
  return {
    counts: { added: 1, removed: 1, modified: 3, unchanged: 1 },
    groups,
    hasDifferences: true,
    leftSummary: summary(),
    rightSummary: summary(),
    warnings: [],
    hasDuplicateIdentities: false,
  };
}

function group(
  domain: AnnotationDiffDomain,
  entries: AnnotationDiffEntry[],
): AnnotationDiffGroup {
  return {
    domain,
    label: domain,
    counts: {
      added: entries.filter(({ changeType }) => changeType === "added").length,
      removed: entries.filter(({ changeType }) => changeType === "removed").length,
      modified: entries.filter(({ changeType }) => changeType === "modified").length,
      unchanged: entries.filter(({ changeType }) => changeType === "unchanged").length,
    },
    entries,
  };
}

function entry(
  domain: AnnotationDiffDomain,
  changeType: AnnotationDiffChangeType,
  identity: string = changeType,
): AnnotationDiffEntry {
  return {
    domain,
    changeType,
    identity,
    label: identity,
    leftTimeRange: changeType === "added" ? null : { start: 0, end: 1 },
    rightTimeRange: changeType === "removed" ? null : { start: 0, end: 1 },
    changedFields: changeType === "modified" ? ["测试字段"] : [],
  };
}

function summary() {
  return {
    videoName: "测试.mp4",
    subtitleLineCount: 0,
    characterCount: 0,
    gongcheCount: 0,
    banyanMarkCount: 0,
    customTrackCount: 0,
    customBlockCount: 0,
    attachedPointCount: 0,
  };
}
