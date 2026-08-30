import assert from "node:assert/strict";
import test from "node:test";
import {
  isTimelineDragActivated,
  TIMELINE_DRAG_ACTIVATION_PX,
} from "./timelineDragCompletion";

test("时间轴拖动达到激活阈值时允许提交", () => {
  assert.equal(isTimelineDragActivated(100, 100 + TIMELINE_DRAG_ACTIVATION_PX), true);
  assert.equal(isTimelineDragActivated(100, 100 - TIMELINE_DRAG_ACTIVATION_PX), true);
});

test("指针移出后回到激活阈值内时取消手势", () => {
  // 中间 pointermove 是否越过阈值不影响最终决定；松手位置回到起点附近必须回滚预览。
  assert.equal(isTimelineDragActivated(100, 103.99), false);
  assert.equal(isTimelineDragActivated(100, 96.01), false);
});
