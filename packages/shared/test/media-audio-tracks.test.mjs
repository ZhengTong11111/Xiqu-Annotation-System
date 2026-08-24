import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH,
  MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS,
  parseAnnotationAudioPreference,
  parseMediaAnalysisRunIdentity,
  parseMediaAudioTrackSummary,
  serializeMediaAnalysisRunIdentity,
} from "../dist/index.js";

const ORIGINAL_TRACK = {
  id: "track-original",
  primaryMediaResourceId: "media-video",
  name: "视频原声",
  kind: "original",
  source: { type: "embedded_original", sourceType: "aliyun_vod" },
  offsetSeconds: 0,
  sortOrder: 0,
  enabled: true,
  analysis: { status: "ready", runId: "run-original" },
};

test("音轨摘要严格区分视频原声与独立音频资源", () => {
  assert.deepEqual(parseMediaAudioTrackSummary(ORIGINAL_TRACK), ORIGINAL_TRACK);

  const vocal = {
    ...ORIGINAL_TRACK,
    id: "track-vocal",
    name: "人声分离",
    kind: "vocal",
    source: {
      type: "media_resource",
      mediaResourceId: "media-vocal",
      sourceType: "uploaded",
    },
    offsetSeconds: 0.25,
    sortOrder: 1,
    analysis: { status: "processing", runId: "run-vocal", progress: 0.4 },
  };
  assert.deepEqual(parseMediaAudioTrackSummary(vocal), vocal);
  assert.equal(parseMediaAudioTrackSummary({
    ...ORIGINAL_TRACK,
    source: {
      type: "media_resource",
      mediaResourceId: "media-vocal",
      sourceType: "uploaded",
    },
  }), null);
  assert.equal(parseMediaAudioTrackSummary({
    ...vocal,
    source: { type: "embedded_original", sourceType: "aliyun_vod" },
  }), null);
  assert.equal(parseMediaAudioTrackSummary({ ...ORIGINAL_TRACK, offsetSeconds: 1 }), null);
});

test("音轨摘要拒绝越界文本、时间、顺序、进度和额外字段", () => {
  assert.equal(parseMediaAudioTrackSummary({
    ...ORIGINAL_TRACK,
    name: "x".repeat(MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH + 1),
  }), null);
  assert.equal(parseMediaAudioTrackSummary({
    ...ORIGINAL_TRACK,
    offsetSeconds: MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS + 1,
  }), null);
  assert.equal(parseMediaAudioTrackSummary({ ...ORIGINAL_TRACK, sortOrder: -1 }), null);
  assert.equal(parseMediaAudioTrackSummary({
    ...ORIGINAL_TRACK,
    analysis: { status: "processing", runId: "run", progress: 1.1 },
  }), null);
  assert.equal(parseMediaAudioTrackSummary({ ...ORIGINAL_TRACK, temporaryUrl: "secret" }), null);
  assert.equal(parseMediaAudioTrackSummary({
    ...ORIGINAL_TRACK,
    source: {
      type: "embedded_original",
      sourceType: "aliyun_vod",
      mediaResourceId: "unexpected",
    },
  }), null);
  assert.equal(parseMediaAudioTrackSummary({
    ...ORIGINAL_TRACK,
    source: { type: "embedded_original", sourceType: "unknown" },
  }), null);
});

test("音轨摘要接受全部有界分析状态并拒绝不稳定错误码", () => {
  const summaries = [
    { status: "not_analyzed" },
    { status: "queued", runId: "run-queued", progress: 0 },
    { status: "processing", runId: "run-processing", progress: 0.5 },
    { status: "ready", runId: "run-ready" },
    { status: "failed", runId: "run-failed", errorCode: "source_unavailable" },
  ];
  for (const analysis of summaries) {
    assert.ok(parseMediaAudioTrackSummary({ ...ORIGINAL_TRACK, analysis }));
  }
  assert.equal(parseMediaAudioTrackSummary({
    ...ORIGINAL_TRACK,
    analysis: { status: "failed", runId: "run", errorCode: "包含空格" },
  }), null);
});

test("标注文件默认音轨偏好只接受稳定身份和有效时间", () => {
  const preference = {
    annotationFileId: "annotation-file",
    defaultAudioTrackId: "track-vocal",
    updatedByAccountId: "account-admin",
    updatedAt: "2026-08-24T12:00:00.000Z",
  };
  assert.deepEqual(parseAnnotationAudioPreference(preference), preference);
  assert.deepEqual(parseAnnotationAudioPreference({
    ...preference,
    defaultAudioTrackId: null,
  }), { ...preference, defaultAudioTrackId: null });
  assert.equal(parseAnnotationAudioPreference({ ...preference, updatedAt: "not-a-date" }), null);
  assert.equal(parseAnnotationAudioPreference({
    ...preference,
    updatedAt: "2026-08-24T12:00:00Z",
  }), null);
  assert.equal(parseAnnotationAudioPreference({
    ...preference,
    updatedAt: "9999-99-99T99:99:99.999Z",
  }), null);
  assert.equal(parseAnnotationAudioPreference({ ...preference, annotationFileId: " bad " }), null);
});

test("媒体级分析身份保留字段边界且不接受标注文件或偏移", () => {
  const first = parseMediaAnalysisRunIdentity({
    mediaResourceId: "media:a",
    sourceFingerprint: "fingerprint",
    algorithmVersion: "algorithm",
    configHash: "config",
  });
  const second = parseMediaAnalysisRunIdentity({
    mediaResourceId: "media",
    sourceFingerprint: "a:fingerprint",
    algorithmVersion: "algorithm",
    configHash: "config",
  });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(
    serializeMediaAnalysisRunIdentity(first),
    serializeMediaAnalysisRunIdentity(second),
  );

  assert.equal(parseMediaAnalysisRunIdentity({
    ...first,
    annotationFileId: "annotation-file",
  }), null);
  assert.equal(parseMediaAnalysisRunIdentity({
    ...first,
    offsetSeconds: 1.25,
  }), null);
});
