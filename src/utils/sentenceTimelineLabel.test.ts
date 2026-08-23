import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateSentenceTimelineTextWidth,
  resolveSentenceTimelineLabelDetail,
} from "./sentenceTimelineLabel";

test("相同句块宽度会根据句子文字长度选择不同详情级别", () => {
  const common = {
    blockWidth: 150,
    deliveryLabel: "唱",
    roleLabel: "闺门旦",
  };
  assert.equal(resolveSentenceTimelineLabelDetail({ ...common, sentenceText: "寻梦" }), "full");
  assert.equal(resolveSentenceTimelineLabelDetail({ ...common, sentenceText: "原来姹紫嫣红开遍" }), "text");
});

test("空间不足时按发声方式、角色、句子的优先级逐级收敛", () => {
  const common = {
    sentenceText: "良辰美景",
    deliveryLabel: "念白",
    roleLabel: "巾生",
  };
  assert.equal(resolveSentenceTimelineLabelDetail({ ...common, blockWidth: 180 }), "full");
  assert.equal(resolveSentenceTimelineLabelDetail({ ...common, blockWidth: 120 }), "role");
  assert.equal(resolveSentenceTimelineLabelDetail({ ...common, blockWidth: 75 }), "text");
});

test("中文、ASCII 与标点使用不同视觉宽度且不拆坏 Unicode 字符", () => {
  assert.ok(estimateSentenceTimelineTextWidth("寻梦") > estimateSentenceTimelineTextWidth("AB"));
  assert.ok(estimateSentenceTimelineTextWidth("寻，梦") > estimateSentenceTimelineTextWidth("寻梦"));
  assert.ok(Number.isFinite(estimateSentenceTimelineTextWidth("𠮷")));
});
