import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import { areEditorProjectsEqual } from "./editorProjectEquality";

test("相等项目复用领域引用且运行时比较不改变输入", () => {
  const left = structuredClone(mockProject);
  const right = structuredClone(mockProject);
  assert.equal(areEditorProjectsEqual(left, right), true);
  assert.equal(areEditorProjectsEqual(left, right), true);
});

test("项目对象在首次比较后被规范化修改仍能检测差异", () => {
  const left = structuredClone(mockProject);
  const right = structuredClone(mockProject);
  assert.equal(areEditorProjectsEqual(left, right), true);
  right.subtitleLines[0].text = "比较后修改";
  assert.equal(areEditorProjectsEqual(left, right), false);
});
