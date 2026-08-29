import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExternalAudioDrift,
  mapMasterTimeToAudioTime,
} from "./synchronizedPlaybackPolicy";

test("主时钟按正负偏移映射音轨开始、可播和结束范围", () => {
  assert.deepEqual(mapMasterTimeToAudioTime({
    masterTime: 1,
    offsetSeconds: 1.5,
    audioDuration: 10,
  }), { status: "before_start", audioTime: 0 });
  assert.deepEqual(mapMasterTimeToAudioTime({
    masterTime: 4,
    offsetSeconds: 1.5,
    audioDuration: 10,
  }), { status: "playable", audioTime: 2.5 });
  assert.deepEqual(mapMasterTimeToAudioTime({
    masterTime: 4,
    offsetSeconds: -1,
    audioDuration: 10,
  }), { status: "playable", audioTime: 5 });
  assert.deepEqual(mapMasterTimeToAudioTime({
    masterTime: 11.5,
    offsetSeconds: 1.5,
    audioDuration: 10,
  }), { status: "after_end", audioTime: 10 });
});

test("时间映射拒绝非有限值和非法时长", () => {
  assert.deepEqual(mapMasterTimeToAudioTime({
    masterTime: Number.NaN,
    offsetSeconds: 0,
    audioDuration: null,
  }), { status: "invalid_time" });
  assert.deepEqual(mapMasterTimeToAudioTime({
    masterTime: 1,
    offsetSeconds: Number.POSITIVE_INFINITY,
    audioDuration: null,
  }), { status: "invalid_time" });
  assert.deepEqual(mapMasterTimeToAudioTime({
    masterTime: 1,
    offsetSeconds: 0,
    audioDuration: -1,
  }), { status: "invalid_time" });
});

test("漂移策略忽略小抖动并用有界倍率平滑修正中等漂移", () => {
  const within = classifyExternalAudioDrift({
    actualAudioTime: 10.009,
    expectedAudioTime: 10,
  });
  assert.equal(within.action, "within_tolerance");

  const outside = classifyExternalAudioDrift({
    actualAudioTime: 10.011,
    expectedAudioTime: 10,
  });
  assert.equal(outside.action, "adjust_rate");
  if (outside.action === "adjust_rate") {
    assert.ok(outside.playbackRateMultiplier < 1);
    assert.ok(outside.playbackRateMultiplier >= 0.96);
  }

  const lagging = classifyExternalAudioDrift({
    actualAudioTime: 9.95,
    expectedAudioTime: 10,
  });
  assert.equal(lagging.action, "adjust_rate");
  if (lagging.action === "adjust_rate") {
    assert.equal(lagging.playbackRateMultiplier, 1.04);
  }
});

test("大漂移与显式恢复场景立即要求硬同步", () => {
  const large = classifyExternalAudioDrift({
    actualAudioTime: 10.2,
    expectedAudioTime: 10,
  });
  assert.equal(large.action, "hard_resync");
  if (large.action === "hard_resync") assert.equal(large.reason, "large_drift");

  const forced = classifyExternalAudioDrift({
    actualAudioTime: 10,
    expectedAudioTime: 10,
    forceHardResync: true,
  });
  assert.equal(forced.action, "hard_resync");
  if (forced.action === "hard_resync") assert.equal(forced.reason, "forced");
});

test("原生转码起播稳定窗口只放宽硬同步门槛，不改变 10ms 与倍率上限", () => {
  const startupLag = classifyExternalAudioDrift({
    actualAudioTime: 9.8,
    expectedAudioTime: 10,
    hardResyncSeconds: 0.5,
  });
  assert.equal(startupLag.action, "adjust_rate");
  if (startupLag.action === "adjust_rate") {
    assert.equal(startupLag.playbackRateMultiplier, 1.04);
  }

  const stillTooLarge = classifyExternalAudioDrift({
    actualAudioTime: 9.4,
    expectedAudioTime: 10,
    hardResyncSeconds: 0.5,
  });
  assert.equal(stillTooLarge.action, "hard_resync");
});
