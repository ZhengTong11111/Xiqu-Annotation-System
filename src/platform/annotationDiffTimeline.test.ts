import assert from "node:assert/strict";
import test from "node:test";
import type {
  AnnotationDiffEntry,
  AnnotationDiffGroup,
  AnnotationDiffResult,
} from "./annotationDiff";
import {
  buildAnnotationDiffTimelineIndex,
  filterAnnotationDiffTimeline,
  hitTestAnnotationDiffTimeline,
} from "./annotationDiffTimeline";

// 修改项在左右都有范围时必须产生两个独立片段，且共享同一个实体键。
test("修改项生成左右两个时间片段", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([
    entry("characters", "char-1", "modified", [1, 2], [1.2, 2.2]),
  ]));
  assert.equal(index.segments.length, 2);
  assert.deepEqual(index.segments.map(({ side }) => side), ["left", "right"]);
  assert.equal(index.segments[0]?.entryKey, index.segments[1]?.entryKey);
  assert.equal(index.duration, 2.2);
});

// 新增和删除不假设固定方向，而是忠实使用结果中实际存在的一侧范围。
test("新增删除保留各自存在的单侧范围", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([
    entry("subtitle_lines", "removed", "removed", [3, 4], null),
    entry("subtitle_lines", "added", "added", null, [5, 6]),
  ]));
  assert.deepEqual(index.segments.map(({ side, identity }) => [side, identity]), [
    ["left", "removed"],
    ["right", "added"],
  ]);
});

// 板眼等零时长事件必须保留真实点语义，模型不得伪造一段持续时间。
test("零时长点事件保留", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([
    entry("banyan_marks", "mark", "modified", [7, 7], [7.1, 7.1]),
  ]));
  assert.deepEqual(index.segments.map(({ start, end }) => [start, end]), [
    [7, 7],
    [7.1, 7.1],
  ]);
});

// 项目字段等没有时间的数据仍纳入当前筛选统计，避免概览误导为没有差异。
test("无时间变化单独统计", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([
    entry("project", "project", "modified", null, null),
  ]));
  assert.equal(index.segments.length, 0);
  assert.equal(index.untimedEntries.length, 1);
  assert.equal(index.duration, 0);
});

// 反向范围可安全修正；负值与非有限值计为坏范围且不进入 Canvas。
test("反向范围归一化并拒绝非法范围", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([
    entry("characters", "reverse", "modified", [4, 2], null),
    entry("characters", "negative", "modified", [-1, 2], null),
    entry("characters", "infinite", "modified", [1, Infinity], null),
  ]));
  assert.deepEqual(index.segments.map(({ start, end }) => [start, end]), [[2, 4]]);
  assert.equal(index.invalidRangeCount, 2);
  assert.equal(index.normalizedRangeCount, 1);
  assert.equal(index.untimedEntries.length, 2);
});

// 领域和变化类型必须同时满足，筛选不能修改原始索引。
test("领域与变化类型组合筛选", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([
    entry("characters", "changed", "modified", [1, 2], [1, 2]),
    entry("characters", "added", "added", null, [3, 4]),
    entry("gongche", "gongche", "modified", [5, 6], [5, 6]),
  ]));
  const before = JSON.stringify(index);
  const filtered = filterAnnotationDiffTimeline(index, {
    domains: new Set(["characters"]),
    changeTypes: new Set(["added"]),
  });
  assert.deepEqual(filtered.segments.map(({ identity }) => identity), ["added"]);
  assert.equal(JSON.stringify(index), before);
});

// 时间窗口只保留相交片段，落在边界上的点也属于窗口。
test("时间窗口按闭区间保留相交片段", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([
    entry("characters", "before", "removed", [0, 1], null),
    entry("characters", "touch", "removed", [2, 2], null),
    entry("characters", "after", "removed", [3, 4], null),
  ]));
  const filtered = filterAnnotationDiffTimeline(index, {
    domains: new Set(["characters"]),
    changeTypes: new Set(["removed"]),
    timeWindow: { start: 1.5, end: 2 },
  });
  assert.deepEqual(filtered.segments.map(({ identity }) => identity), ["touch"]);
});

// 输出顺序固定为左、右及时间顺序，输入 diff 不因索引构建发生变化。
test("索引稳定排序且不修改输入", () => {
  const diff = diffFixture([
    entry("characters", "late", "modified", [8, 9], [8, 9]),
    entry("characters", "early", "modified", [1, 2], [1, 2]),
  ]);
  const before = JSON.stringify(diff);
  const index = buildAnnotationDiffTimelineIndex(diff);
  assert.deepEqual(index.segments.map(({ side, identity }) => `${side}:${identity}`), [
    "left:early",
    "left:late",
    "right:early",
    "right:late",
  ]);
  assert.equal(JSON.stringify(diff), before);
});

// 重叠命中优先较短片段，确保大范围不会长期遮住精细差异。
test("重叠命中优先更短片段", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([
    entry("characters", "wide", "removed", [1, 9], null),
    entry("characters", "narrow", "removed", [4, 6], null),
  ]));
  const hit = hitTestAnnotationDiffTimeline(index.segments, {
    duration: 10,
    width: 100,
    x: 50,
    y: 15,
    railBounds: {
      left: { top: 10, bottom: 20 },
      right: { top: 30, bottom: 40 },
    },
  });
  assert.equal(hit?.identity, "narrow");
});

// 空索引和零时长坐标轴应安全返回空命中，不能出现除零或随机对象。
test("空数据和零时长不产生命中", () => {
  const index = buildAnnotationDiffTimelineIndex(diffFixture([]));
  assert.equal(index.duration, 0);
  assert.equal(hitTestAnnotationDiffTimeline([], {
    duration: 0,
    width: 100,
    x: 0,
    y: 0,
    railBounds: {
      left: { top: 0, bottom: 10 },
      right: { top: 20, bottom: 30 },
    },
  }), null);
});

// 测试 fixture 只构造时间索引需要的结构化字段，不依赖项目迁移或浏览器环境。
function entry(
  domain: AnnotationDiffEntry["domain"],
  identity: string,
  changeType: Exclude<AnnotationDiffEntry["changeType"], "unchanged">,
  left: [number, number] | null,
  right: [number, number] | null,
): AnnotationDiffEntry {
  return {
    domain,
    identity,
    changeType,
    label: identity,
    leftTimeRange: left ? { start: left[0], end: left[1] } : null,
    rightTimeRange: right ? { start: right[0], end: right[1] } : null,
    changedFields: [],
  };
}

// 结构化 diff fixture 按领域汇总计数，使索引测试仍覆盖真实的 group 遍历边界。
function diffFixture(entries: AnnotationDiffEntry[]): AnnotationDiffResult {
  const groups = new Map<AnnotationDiffEntry["domain"], AnnotationDiffGroup>();
  for (const item of entries) {
    const group = groups.get(item.domain) ?? {
      domain: item.domain,
      label: item.domain,
      counts: { added: 0, removed: 0, modified: 0, unchanged: 0 },
      entries: [],
    };
    group.entries.push(item);
    group.counts[item.changeType] += 1;
    groups.set(item.domain, group);
  }
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const group of groups.values()) {
    counts.added += group.counts.added;
    counts.removed += group.counts.removed;
    counts.modified += group.counts.modified;
  }
  return {
    counts,
    groups: [...groups.values()],
    hasDifferences: entries.length > 0,
    leftSummary: emptySummary(),
    rightSummary: emptySummary(),
    warnings: [],
    hasDuplicateIdentities: false,
  };
}

// 双侧摘要与时间索引无关，统一返回合法空值以保持 fixture 聚焦。
function emptySummary() {
  return {
    videoName: null,
    subtitleLineCount: 0,
    characterCount: 0,
    gongcheCount: 0,
    banyanMarkCount: 0,
    customTrackCount: 0,
    customBlockCount: 0,
    attachedPointCount: 0,
  };
}
