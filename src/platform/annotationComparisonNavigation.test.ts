import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationDiffEntry } from "./annotationDiff";
import { buildAnnotationComparisonFocus } from "./annotationComparisonNavigation";

// 测试夹具只保留导航所需字段，方便逐项覆盖左右范围和非法旧数据。
function createEntry(
  leftTimeRange: AnnotationDiffEntry["leftTimeRange"],
  rightTimeRange: AnnotationDiffEntry["rightTimeRange"],
): AnnotationDiffEntry {
  return {
    domain: "characters",
    changeType: "modified",
    identity: "character-1",
    label: "那",
    leftTimeRange,
    rightTimeRange,
    changedFields: ["时间"],
  };
}

// 左侧命令必须使用左侧范围的开始时间，不能借用右侧或 Canvas 坐标。
test("builds a left-side focus from the left range", () => {
  const focus = buildAnnotationComparisonFocus(
    createEntry({ start: 1.25, end: 2.5 }, { start: 8, end: 9 }),
    "left",
  );
  assert.deepEqual(focus, {
    time: 1.25,
    start: 1.25,
    end: 2.5,
    source: "annotation-comparison",
  });
});

// 右侧命令必须独立使用右侧范围。
test("builds a right-side focus from the right range", () => {
  const focus = buildAnnotationComparisonFocus(
    createEntry({ start: 1, end: 2 }, { start: 3.5, end: 4.75 }),
    "right",
  );
  assert.equal(focus?.time, 3.5);
  assert.equal(focus?.end, 4.75);
});

// 新增实体在左侧不存在，因此不能伪造左侧定位。
test("returns null when an added entry has no left range", () => {
  assert.equal(buildAnnotationComparisonFocus(
    createEntry(null, { start: 2, end: 3 }),
    "left",
  ), null);
});

// 删除实体在右侧不存在，因此不能伪造右侧定位。
test("returns null when a removed entry has no right range", () => {
  assert.equal(buildAnnotationComparisonFocus(
    createEntry({ start: 2, end: 3 }, null),
    "right",
  ), null);
});

// 点状标记允许零时长，播放头仍应落到该真实时间点。
test("preserves a zero-duration point range", () => {
  assert.deepEqual(buildAnnotationComparisonFocus(
    createEntry({ start: 6.25, end: 6.25 }, null),
    "left",
  ), {
    time: 6.25,
    start: 6.25,
    end: 6.25,
    source: "annotation-comparison",
  });
});

// 旧文件中的反向范围在导航边界统一纠正，time 始终取归一化后的开始。
test("normalizes a reversed range", () => {
  assert.deepEqual(buildAnnotationComparisonFocus(
    createEntry(null, { start: 9, end: 4 }),
    "right",
  ), {
    time: 4,
    start: 4,
    end: 9,
    source: "annotation-comparison",
  });
});

// 负数、NaN 和 Infinity 都不是可导航时间，不能默认为 0。
test("rejects negative and non-finite ranges", () => {
  for (const range of [
    { start: -1, end: 2 },
    { start: 1, end: Number.NaN },
    { start: Number.POSITIVE_INFINITY, end: 2 },
  ]) {
    assert.equal(buildAnnotationComparisonFocus(
      createEntry(range, null),
      "left",
    ), null);
  }
});

// helper 必须保持结构化差异不可变，避免选择命令污染后续筛选和 Canvas 索引。
test("does not mutate the diff entry", () => {
  const entry = createEntry({ start: 5, end: 2 }, { start: 7, end: 8 });
  const snapshot = structuredClone(entry);
  buildAnnotationComparisonFocus(entry, "left");
  assert.deepEqual(entry, snapshot);
});
