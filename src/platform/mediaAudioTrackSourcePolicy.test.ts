import assert from "node:assert/strict";
import test from "node:test";
import {
  isAliyunVodAudioRenditionSource,
  isMediaAudioTrackSource,
  isSelectableMediaAudioTrackSource,
} from "./mediaAudioTrackSourcePolicy";

test("监听音轨来源只接受稳定的纯音频资源", () => {
  assert.equal(isMediaAudioTrackSource({ type: "media_file", mediaKind: "audio" }), true);
  assert.equal(isMediaAudioTrackSource({ type: "media_file", mediaKind: "video" }), false);
  assert.equal(isMediaAudioTrackSource({ type: "folder", mediaKind: null }), false);
});

test("VOD 音频转码来源只接受阿里云视频媒资容器", () => {
  assert.equal(isAliyunVodAudioRenditionSource({
    type: "media_file",
    mediaKind: "video",
    mediaSourceType: "aliyun_vod",
  }), true);
  assert.equal(isAliyunVodAudioRenditionSource({
    type: "media_file",
    mediaKind: "audio",
    mediaSourceType: "aliyun_vod",
  }), false);
  assert.equal(isAliyunVodAudioRenditionSource({
    type: "media_file",
    mediaKind: "video",
    mediaSourceType: "uploaded",
  }), false);
});

test("统一监听音轨选择器同时展示纯音频与可选转码的 VOD", () => {
  assert.equal(isSelectableMediaAudioTrackSource({
    type: "media_file",
    mediaKind: "audio",
    mediaSourceType: "uploaded",
  }), true);
  assert.equal(isSelectableMediaAudioTrackSource({
    type: "media_file",
    mediaKind: "video",
    mediaSourceType: "aliyun_vod",
  }), true);
  assert.equal(isSelectableMediaAudioTrackSource({
    type: "media_file",
    mediaKind: "video",
    mediaSourceType: "uploaded",
  }), false);
});
