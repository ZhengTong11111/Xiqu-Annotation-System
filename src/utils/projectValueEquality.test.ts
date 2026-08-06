import assert from "node:assert/strict";
import test from "node:test";
import { areProjectValuesEqual } from "./projectValueEquality";

test("对象中的 undefined 与缺失键遵循 JSON 等价语义", () => {
  assert.equal(areProjectValuesEqual({ id: "item", optional: undefined }, { id: "item" }), true);
  assert.equal(areProjectValuesEqual({ id: "item", optional: null }, { id: "item" }), false);
});

test("数组位置仍保持严格比较", () => {
  assert.equal(areProjectValuesEqual(["item", undefined], ["item"]), false);
  assert.equal(areProjectValuesEqual(["item", undefined], ["item", null]), false);
});
