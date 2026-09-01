import assert from "node:assert/strict";
import test from "node:test";
import { getTimelineFocusScrollLeft } from "./timelineFocusNavigation";

const BASE_INPUT = {
  zoom: 20,
  viewportWidth: 1000,
  timelineWidth: 5000,
  trackLabelWidth: 164,
} as const;

test("短审核范围在轨道头右侧的内容区居中", () => {
  const scrollLeft = getTimelineFocusScrollLeft({
    ...BASE_INPUT,
    startTime: 100,
    endTime: 110,
    alignment: "center-range",
  });

  const rangeCenterCanvasX = BASE_INPUT.trackLabelWidth + 105 * BASE_INPUT.zoom;
  const contentCenterViewportX = BASE_INPUT.trackLabelWidth
    + (BASE_INPUT.viewportWidth - BASE_INPUT.trackLabelWidth) / 2;
  assert.equal(rangeCenterCanvasX - scrollLeft, contentCenterViewportX);
});

test("超长审核范围从轨道头右侧留出余量开始显示", () => {
  const scrollLeft = getTimelineFocusScrollLeft({
    ...BASE_INPUT,
    startTime: 100,
    endTime: 180,
    alignment: "center-range",
    edgePadding: 24,
  });

  const startCanvasX = BASE_INPUT.trackLabelWidth + 100 * BASE_INPUT.zoom;
  assert.equal(startCanvasX - scrollLeft, BASE_INPUT.trackLabelWidth + 24);
});

test("时间轴首尾与异常范围始终限制在合法 scrollLeft", () => {
  assert.equal(getTimelineFocusScrollLeft({
    ...BASE_INPUT,
    startTime: Number.NaN,
    endTime: -10,
    alignment: "center-range",
  }), 0);

  assert.equal(getTimelineFocusScrollLeft({
    ...BASE_INPUT,
    startTime: 999,
    endTime: 1000,
    alignment: "center-range",
  }), BASE_INPUT.timelineWidth - BASE_INPUT.viewportWidth);
});

test("原有 start 定位继续保留固定起点偏移", () => {
  assert.equal(getTimelineFocusScrollLeft({
    ...BASE_INPUT,
    startTime: 50,
    endTime: 55,
    alignment: "start",
    startViewportOffset: 120,
  }), BASE_INPUT.trackLabelWidth + 50 * BASE_INPUT.zoom - 120);
});
