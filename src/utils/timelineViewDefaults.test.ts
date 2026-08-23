import assert from "node:assert/strict";
import test from "node:test";
import { defaultSpectrogramSettings } from "./spectrogram";
import { defaultTimelineLayerVisibility } from "./timelineViewDefaults";

test("高信息密度时间轴辅助层默认全部关闭", () => {
  assert.deepEqual(defaultTimelineLayerVisibility, {
    banyanTrack: false,
    banyanGrid: false,
    waveform: false,
    spectrogram: false,
  });
  assert.equal(
    defaultSpectrogramSettings.visible,
    defaultTimelineLayerVisibility.spectrogram,
  );
});
