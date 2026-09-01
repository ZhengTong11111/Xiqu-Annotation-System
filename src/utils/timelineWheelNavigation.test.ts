import assert from "node:assert/strict";
import test from "node:test";
import { getTimelineHorizontalWheelDelta } from "./timelineWheelNavigation";

const base = {
  shiftKey: true,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  deltaX: 0,
  deltaY: 12,
  deltaMode: 0,
};

test("Shift 滚轮使用主导轴横移并兼容浏览器预转换", () => {
  assert.equal(getTimelineHorizontalWheelDelta(base, 1000), 12);
  assert.equal(getTimelineHorizontalWheelDelta({ ...base, deltaX: -30, deltaY: 2 }, 1000), -30);
});

test("横移按 deltaMode 换算且不抢占缩放修饰键", () => {
  assert.equal(getTimelineHorizontalWheelDelta({ ...base, deltaMode: 1, deltaY: 2 }, 1000), 80);
  assert.equal(getTimelineHorizontalWheelDelta({ ...base, deltaMode: 2, deltaY: 1 }, 1000), 900);
  assert.equal(getTimelineHorizontalWheelDelta({ ...base, altKey: true }, 1000), null);
  assert.equal(getTimelineHorizontalWheelDelta({ ...base, ctrlKey: true }, 1000), null);
  assert.equal(getTimelineHorizontalWheelDelta({ ...base, shiftKey: false }, 1000), null);
});
