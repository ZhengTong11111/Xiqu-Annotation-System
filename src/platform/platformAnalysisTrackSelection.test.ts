import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationAudioPlaybackOptions } from "@xiqu/shared";
import {
  INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION,
  resolvePlatformAnalysisTrackId,
  updatePlatformAnalysisTrackFollowMode,
  updatePlatformFixedAnalysisTrack,
} from "./platformAnalysisTrackSelection";

const options: AnnotationAudioPlaybackOptions = {
  annotationFileId: "annotation-1",
  primaryMediaResourceId: "media-1",
  defaultAudioTrackId: null,
  canManageTracks: false,
  tracks: [
    {
      availability: "available",
      track: {
        id: "track-original",
        primaryMediaResourceId: "media-1",
        name: "视频原声",
        kind: "original",
        source: { type: "embedded_original", sourceType: "aliyun_vod" },
        offsetSeconds: 0,
        sortOrder: 0,
        enabled: true,
      },
    },
    {
      availability: "available",
      track: {
        id: "track-vocal",
        primaryMediaResourceId: "media-1",
        name: "分离人声",
        kind: "vocal",
        source: {
          type: "media_resource",
          mediaResourceId: "audio-1",
          sourceType: "uploaded",
        },
        offsetSeconds: 0.2,
        sortOrder: 1,
        enabled: true,
      },
    },
    {
      availability: "permission_denied",
      track: {
        id: "track-private",
        primaryMediaResourceId: "media-1",
        name: "无权音轨",
        kind: "custom",
        source: {
          type: "media_resource",
          mediaResourceId: "audio-private",
          sourceType: "uploaded",
        },
        offsetSeconds: 0,
        sortOrder: 2,
        enabled: true,
      },
    },
  ],
};

test("分析显示默认跟随监听音轨", () => {
  assert.equal(
    resolvePlatformAnalysisTrackId(INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION, "track-original"),
    "track-original",
  );
  assert.equal(
    resolvePlatformAnalysisTrackId(INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION, "track-vocal"),
    "track-vocal",
  );
});

test("关闭跟随冻结当前监听轨，固定后监听变化不再改变分析轨", () => {
  const fixed = updatePlatformAnalysisTrackFollowMode(
    INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION,
    false,
    "track-vocal",
  );
  assert.deepEqual(fixed, { followListening: false, fixedTrackId: "track-vocal" });
  assert.equal(resolvePlatformAnalysisTrackId(fixed, "track-original"), "track-vocal");
  assert.equal(
    resolvePlatformAnalysisTrackId(
      updatePlatformAnalysisTrackFollowMode(fixed, true, "track-original"),
      "track-original",
    ),
    "track-original",
  );
});

test("固定选择只接受当前可用音轨", () => {
  const fixed = updatePlatformFixedAnalysisTrack(
    INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION,
    "track-vocal",
    options,
  );
  assert.deepEqual(fixed, { followListening: false, fixedTrackId: "track-vocal" });
  assert.equal(
    updatePlatformFixedAnalysisTrack(fixed, "track-private", options),
    fixed,
  );
  assert.equal(updatePlatformFixedAnalysisTrack(fixed, "track-missing", options), fixed);
});

test("固定项失效后保留身份，由上层显示不可用而不静默回退", () => {
  const fixed = { followListening: false, fixedTrackId: "track-vocal" } as const;
  const withoutVocal = { ...options, tracks: options.tracks.slice(0, 1) };
  assert.equal(resolvePlatformAnalysisTrackId(fixed, "track-original"), "track-vocal");
  assert.equal(updatePlatformFixedAnalysisTrack(fixed, "track-private", withoutVocal), fixed);
});
