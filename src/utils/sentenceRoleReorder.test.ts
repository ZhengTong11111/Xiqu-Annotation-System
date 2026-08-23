import assert from "node:assert/strict";
import test from "node:test";
import { reorderSentenceRoleOptions } from "./sentenceRoleReorder";

const roles = ["闺门旦", "巾生", "老旦", "净"];

test("角色拖拽可按目标上下边缘完成首尾与跨项重排", () => {
  assert.deepEqual(
    reorderSentenceRoleOptions(roles, "净", "闺门旦", "before"),
    ["净", "闺门旦", "巾生", "老旦"],
  );
  assert.deepEqual(
    reorderSentenceRoleOptions(roles, "闺门旦", "净", "after"),
    ["巾生", "老旦", "净", "闺门旦"],
  );
  assert.deepEqual(
    reorderSentenceRoleOptions(roles, "老旦", "闺门旦", "after"),
    ["闺门旦", "老旦", "巾生", "净"],
  );
});

test("相邻原位、同一目标和失效名称不会制造空结构命令", () => {
  assert.equal(reorderSentenceRoleOptions(roles, "巾生", "闺门旦", "after"), null);
  assert.equal(reorderSentenceRoleOptions(roles, "巾生", "老旦", "before"), null);
  assert.equal(reorderSentenceRoleOptions(roles, "巾生", "巾生", "before"), null);
  assert.equal(reorderSentenceRoleOptions(roles, "已删除角色", "巾生", "before"), null);
  assert.equal(reorderSentenceRoleOptions(roles, "巾生", "已删除角色", "before"), null);
});

test("排序返回新数组且不修改输入角色列表", () => {
  const input = [...roles];
  const result = reorderSentenceRoleOptions(input, "巾生", "净", "after");

  assert.deepEqual(input, roles);
  assert.deepEqual(result, ["闺门旦", "老旦", "净", "巾生"]);
  assert.notStrictEqual(result, input);
});
