import assert from "node:assert/strict";
import test from "node:test";
import { isMediaAudioTrackSource } from "./mediaAudioTrackSourcePolicy";

test("监听音轨来源只接受稳定的纯音频资源", () => {
  assert.equal(isMediaAudioTrackSource({ type: "media_file", mediaKind: "audio" }), true);
  assert.equal(isMediaAudioTrackSource({ type: "media_file", mediaKind: "video" }), false);
  assert.equal(isMediaAudioTrackSource({ type: "folder", mediaKind: null }), false);
});
