import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_SYNCHRONIZED_PLAYBACK_STATE,
  reduceSynchronizedPlaybackState,
  type SynchronizedPlaybackEvent,
  type SynchronizedPlaybackState,
} from "./synchronizedPlaybackState";

function apply(
  state: SynchronizedPlaybackState,
  event: SynchronizedPlaybackEvent,
): SynchronizedPlaybackState {
  const transition = reduceSynchronizedPlaybackState(state, event);
  assert.equal(transition.status, "applied");
  return transition.state;
}

test("A/B/C 快速切换只允许最后音轨的 ready 事件生效", () => {
  let state = apply(INITIAL_SYNCHRONIZED_PLAYBACK_STATE, {
    type: "select_external",
    trackId: "track-a",
    desiredPlayback: "playing",
  });
  const generationA = state.sourceGeneration;
  state = apply(state, {
    type: "select_external",
    trackId: "track-b",
    desiredPlayback: "playing",
  });
  state = apply(state, {
    type: "select_external",
    trackId: "track-c",
    desiredPlayback: "playing",
  });
  const generationC = state.sourceGeneration;

  const stale = reduceSynchronizedPlaybackState(state, {
    type: "external_ready",
    generation: generationA,
  });
  assert.equal(stale.status, "stale_event");
  assert.equal(stale.state.selectedTrackId, "track-c");

  state = apply(state, { type: "external_ready", generation: generationC });
  assert.equal(state.phase, "starting");
  state = apply(state, { type: "external_started", generation: generationC });
  assert.equal(state.phase, "playing_synced");
});

test("切回原声使旧音轨错误失效且保留当前播放意图", () => {
  let state = apply(INITIAL_SYNCHRONIZED_PLAYBACK_STATE, {
    type: "select_external",
    trackId: "track-vocal",
    desiredPlayback: "playing",
  });
  const oldGeneration = state.sourceGeneration;
  state = apply(state, { type: "select_original", desiredPlayback: "playing" });
  assert.equal(state.phase, "original");
  assert.equal(state.selectedTrackId, null);
  assert.equal(state.desiredPlayback, "playing");

  const stale = reduceSynchronizedPlaybackState(state, {
    type: "external_failed",
    generation: oldGeneration,
    errorCode: "old_source_failed",
  });
  assert.equal(stale.status, "stale_event");
  assert.equal(stale.state.phase, "original");
});

test("缓冲恢复必须经过重同步再恢复播放", () => {
  let state = apply(INITIAL_SYNCHRONIZED_PLAYBACK_STATE, {
    type: "select_external",
    trackId: "track-vocal",
    desiredPlayback: "playing",
  });
  const generation = state.sourceGeneration;
  state = apply(state, { type: "external_ready", generation });
  state = apply(state, { type: "external_started", generation });
  state = apply(state, { type: "external_buffering", generation });
  assert.equal(state.phase, "buffering_external");
  state = apply(state, { type: "external_recovered", generation });
  assert.equal(state.phase, "resyncing");
  state = apply(state, { type: "resync_completed", generation });
  assert.equal(state.phase, "starting");
});

test("当前来源非法转换可诊断，销毁后任何迟到事件都不能复活", () => {
  let state = apply(INITIAL_SYNCHRONIZED_PLAYBACK_STATE, {
    type: "select_external",
    trackId: "track-vocal",
    desiredPlayback: "paused",
  });
  const generation = state.sourceGeneration;
  const invalid = reduceSynchronizedPlaybackState(state, {
    type: "external_started",
    generation,
  });
  assert.equal(invalid.status, "invalid_transition");

  state = apply(state, { type: "dispose" });
  assert.equal(state.phase, "disposed");
  const late = reduceSynchronizedPlaybackState(state, {
    type: "external_ready",
    generation,
  });
  assert.equal(late.status, "invalid_transition");
  assert.equal(late.state.phase, "disposed");
});

test("同一来源的浏览器重复事件幂等，非法身份和错误码仍被拒绝", () => {
  const invalidSelection = reduceSynchronizedPlaybackState(
    INITIAL_SYNCHRONIZED_PLAYBACK_STATE,
    { type: "select_external", trackId: " bad ", desiredPlayback: "paused" },
  );
  assert.equal(invalidSelection.status, "invalid_transition");

  let state = apply(INITIAL_SYNCHRONIZED_PLAYBACK_STATE, {
    type: "select_external",
    trackId: "track-vocal",
    desiredPlayback: "playing",
  });
  const generation = state.sourceGeneration;
  state = apply(state, { type: "external_ready", generation });
  state = apply(state, { type: "external_ready", generation });
  state = apply(state, { type: "external_started", generation });
  state = apply(state, { type: "external_started", generation });
  assert.equal(state.phase, "playing_synced");

  const invalidError = reduceSynchronizedPlaybackState(state, {
    type: "external_failed",
    generation,
    errorCode: "错误 文本",
  });
  assert.equal(invalidError.status, "invalid_transition");
});
