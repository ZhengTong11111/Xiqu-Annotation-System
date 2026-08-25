import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationAudioPlaybackOptions } from "@xiqu/shared";
import {
  findAudioTrackOption,
  findOriginalAudioTrack,
  getAudioTrackAvailabilityLabel,
  resolveInitialAudioTrackId,
  resolveRefreshedAudioTrackId,
} from "./platformAudioTrackSelection";

const options: AnnotationAudioPlaybackOptions = {
  annotationFileId: "annotation-file",
  primaryMediaResourceId: "media-video",
  defaultAudioTrackId: "track-vocal",
  tracks: [
    {
      availability: "available",
      track: {
        id: "track-original",
        primaryMediaResourceId: "media-video",
        name: "视频原声",
        kind: "original",
        source: { type: "embedded_original", sourceType: "aliyun_vod" },
        offsetSeconds: 0,
        sortOrder: 0,
        enabled: true,
      },
    },
    {
      availability: "permission_denied",
      track: {
        id: "track-vocal",
        primaryMediaResourceId: "media-video",
        name: "人声分离",
        kind: "vocal",
        source: {
          type: "media_resource",
          mediaResourceId: "media-vocal",
          sourceType: "uploaded",
        },
        offsetSeconds: 0.25,
        sortOrder: 1,
        enabled: true,
      },
    },
  ],
};

test("首次选择遵循共享默认，即使该默认当前不可用", () => {
  assert.equal(resolveInitialAudioTrackId(options), "track-vocal");
  assert.equal(findAudioTrackOption(options, "track-vocal")?.availability, "permission_denied");
});

test("空默认按 kind 查找原声而不是依赖列表位置", () => {
  const reordered = {
    ...options,
    defaultAudioTrackId: null,
    tracks: [...options.tracks].reverse(),
  };
  assert.equal(findOriginalAudioTrack(reordered)?.track.id, "track-original");
  assert.equal(resolveInitialAudioTrackId(reordered), "track-original");
});

test("刷新保留当前试听意图，音轨已删除时也不静默回退默认", () => {
  assert.equal(resolveRefreshedAudioTrackId(options, "track-session-choice"), "track-session-choice");
  assert.equal(resolveRefreshedAudioTrackId(options, null), "track-vocal");
});

test("可用性文案只由有限状态码生成", () => {
  assert.equal(getAudioTrackAvailabilityLabel("available"), "可试听");
  assert.equal(getAudioTrackAvailabilityLabel("permission_denied"), "缺少读取或下载权限");
  assert.equal(getAudioTrackAvailabilityLabel("source_unavailable"), "音频资源当前不可用");
});
