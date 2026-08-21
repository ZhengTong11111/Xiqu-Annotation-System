import assert from "node:assert/strict";
import test from "node:test";
import { buildPinyinIndex } from "./pinyin";

test("中文标题折出全拼与首字母两条串", () => {
  const index = buildPinyinIndex("选中块时更新循环范围");
  assert.equal(index?.full, "xuanzhongkuaishigengxinxunhuanfanwei");
  assert.equal(index?.initials, "xzksgxxhfw");
});

test("混排的数字与英文原样保留在两条串里", () => {
  const index = buildPinyinIndex("播放速度 0.5x");
  assert.equal(index?.full, "bofangsudu05x");
  assert.equal(index?.initials, "bfsd05x");
});

test("纯英文数字不建索引，交给原有关键词匹配", () => {
  assert.equal(buildPinyinIndex("F0 / Pitch contour"), null);
  assert.equal(buildPinyinIndex("1.25x"), null);
});

test("同一字符串重复调用返回等价结果（走缓存）", () => {
  const first = buildPinyinIndex("音频波形");
  const second = buildPinyinIndex("音频波形");
  assert.deepEqual(first, second);
  assert.equal(first?.initials, "ypbx");
});
