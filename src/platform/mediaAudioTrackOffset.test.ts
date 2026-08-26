import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustMediaAudioTrackOffsetDraft,
  describeMediaAudioTrackOffset,
  formatMediaAudioTrackOffsetDraft,
  parseMediaAudioTrackOffsetSeconds,
} from "./mediaAudioTrackOffset";

test("音轨偏移解析接受毫秒和正负边界，拒绝空白与非有限值", () => {
  assert.equal(parseMediaAudioTrackOffsetSeconds("0"), 0);
  assert.equal(parseMediaAudioTrackOffsetSeconds("0.001"), 0.001);
  assert.equal(parseMediaAudioTrackOffsetSeconds("-0.001"), -0.001);
  assert.equal(parseMediaAudioTrackOffsetSeconds("86400"), 86_400);
  assert.equal(parseMediaAudioTrackOffsetSeconds("-86400"), -86_400);
  for (const invalid of ["", "   ", "NaN", "Infinity", "86400.001", "-86400.001"]) {
    assert.equal(parseMediaAudioTrackOffsetSeconds(invalid), null);
  }
});

test("毫秒步进使用整数运算并在边界 fail closed", () => {
  let value = "0";
  for (let index = 0; index < 300; index += 1) {
    value = adjustMediaAudioTrackOffsetDraft(value, 1) ?? "unexpected";
  }
  assert.equal(value, "0.3");
  assert.equal(adjustMediaAudioTrackOffsetDraft(value, -301), "-0.001");
  assert.equal(adjustMediaAudioTrackOffsetDraft("86400", 1), null);
  assert.equal(adjustMediaAudioTrackOffsetDraft("-86400", -1), null);
  assert.equal(adjustMediaAudioTrackOffsetDraft("invalid", 1), null);
  assert.equal(adjustMediaAudioTrackOffsetDraft("0", 0.5), null);
});

test("服务端值格式化和摘要保留明确的提前延后语义", () => {
  assert.equal(formatMediaAudioTrackOffsetDraft(0.25), "0.25");
  assert.equal(formatMediaAudioTrackOffsetDraft(-0.001), "-0.001");
  assert.equal(formatMediaAudioTrackOffsetDraft(0.0005), "0.0005");
  assert.equal(describeMediaAudioTrackOffset("0"), "与视频对齐（0 ms）");
  assert.equal(describeMediaAudioTrackOffset("0.25"), "音频相对视频延后 250 ms");
  assert.equal(describeMediaAudioTrackOffset("-0.001"), "音频相对视频提前 1 ms");
  assert.equal(describeMediaAudioTrackOffset("0.0005"), "音频相对视频延后 0.5 ms");
  assert.equal(describeMediaAudioTrackOffset("bad"), null);
});
