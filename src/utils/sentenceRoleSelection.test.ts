import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSentenceRoleTypes,
  normalizeSentenceRoleTypes,
  replaceSentenceRoleType,
  toggleSentenceRoleType,
} from "./sentenceRoleSelection";

const options = ["杜丽娘", "柳梦梅", "春香"];

test("角色集合按项目顺序归一化并过滤悬空、重复值", () => {
  assert.deepEqual(normalizeSentenceRoleTypes(options, ["春香", "杜丽娘", "春香", "不存在"]), [
    "杜丽娘",
    "春香",
  ]);
});

test("角色切换、替换和删除保留同句其他角色", () => {
  assert.deepEqual(toggleSentenceRoleType(options, ["杜丽娘"], "春香"), ["杜丽娘", "春香"]);
  assert.deepEqual(toggleSentenceRoleType(options, ["杜丽娘", "春香"], "杜丽娘"), ["春香"]);
  assert.deepEqual(replaceSentenceRoleType(options, ["杜丽娘", "春香"], "杜丽娘", "春香"), ["春香"]);
  assert.deepEqual(replaceSentenceRoleType(options, ["杜丽娘", "春香"], "杜丽娘", null), ["春香"]);
});

test("跨句合并采用合法角色并集而不是清空不同角色", () => {
  assert.deepEqual(mergeSentenceRoleTypes(options, [["春香"], ["杜丽娘"], ["不存在"]]), [
    "杜丽娘",
    "春香",
  ]);
});
