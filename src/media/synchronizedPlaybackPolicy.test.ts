import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExternalAudioDrift,
  EMPTY_DRIFT_OBSERVATION,
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

test("漂移策略忽略小抖动并要求中等同向漂移连续确认", () => {
  const within = classifyExternalAudioDrift({
    actualAudioTime: 10.039,
    expectedAudioTime: 10,
  });
  assert.equal(within.action, "within_tolerance");

  const first = classifyExternalAudioDrift({
    actualAudioTime: 10.1,
    expectedAudioTime: 10,
  });
  assert.equal(first.action, "observe");
  const second = classifyExternalAudioDrift({
    actualAudioTime: 10.1,
    expectedAudioTime: 10,
    previousObservation: first.nextObservation,
  });
  assert.equal(second.action, "hard_resync");
  if (second.action === "hard_resync") {
    assert.equal(second.reason, "confirmed_medium_drift");
    assert.ok(Math.abs(second.driftSeconds - 0.1) < 1e-9);
    assert.deepEqual(second.nextObservation, EMPTY_DRIFT_OBSERVATION);
  }

  const opposite = classifyExternalAudioDrift({
    actualAudioTime: 9.9,
    expectedAudioTime: 10,
    previousObservation: first.nextObservation,
  });
  assert.equal(opposite.action, "observe");
  assert.deepEqual(opposite.nextObservation, {
    consecutiveMediumSamples: 1,
    direction: -1,
  });
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
