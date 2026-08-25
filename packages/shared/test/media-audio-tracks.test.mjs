import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH,
  MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS,
  parseAnnotationAudioPreference,
  parseAnnotationAudioPlaybackOptions,
  parseAliyunVodAudioRenditionList,
  parseMediaAnalysisRunIdentity,
  parseMediaAudioTrackPlaybackSession,
  parseMediaAudioTrackRecord,
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
};

test("音轨记录严格区分视频原声与独立音频资源", () => {
  assert.deepEqual(parseMediaAudioTrackRecord(ORIGINAL_TRACK), ORIGINAL_TRACK);

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
  };
  assert.deepEqual(parseMediaAudioTrackRecord(vocal), vocal);
  const rendition = {
    ...vocal,
    id: "track-vod-rendition",
    source: {
      type: "aliyun_vod_rendition",
      mediaResourceId: "media-video",
      sourceType: "aliyun_vod",
      rendition: {
        jobId: "job-audio",
        format: "mp3",
        definition: "SQ",
        bitrate: 128,
        duration: 120.5,
      },
    },
  };
  assert.deepEqual(parseMediaAudioTrackRecord(rendition), rendition);
  assert.equal(parseMediaAudioTrackRecord({
    ...ORIGINAL_TRACK,
    source: {
      type: "media_resource",
      mediaResourceId: "media-vocal",
      sourceType: "uploaded",
    },
  }), null);
  assert.equal(parseMediaAudioTrackRecord({
    ...vocal,
    source: { type: "embedded_original", sourceType: "aliyun_vod" },
  }), null);
  assert.equal(parseMediaAudioTrackRecord({ ...ORIGINAL_TRACK, offsetSeconds: 1 }), null);
  assert.equal(parseMediaAudioTrackRecord({
    ...rendition,
    source: {
      ...rendition.source,
      rendition: { ...rendition.source.rendition, format: "m3u8" },
    },
  }), null);
});

test("VOD 音频转码列表以唯一 JobId 和有限元数据为边界", () => {
  const list = {
    mediaResourceId: "media-video",
    renditions: [{
      jobId: "job-audio",
      format: "mp3",
      definition: "SQ",
      bitrate: 128,
      duration: 120.5,
    }],
  };
  assert.deepEqual(parseAliyunVodAudioRenditionList(list), list);
  assert.equal(parseAliyunVodAudioRenditionList({
    ...list,
    renditions: [...list.renditions, ...list.renditions],
  }), null);
  assert.equal(parseAliyunVodAudioRenditionList({
    ...list,
    renditions: [{ ...list.renditions[0], temporaryUrl: "secret" }],
  }), null);
});

test("音轨记录拒绝越界文本、时间、顺序和额外字段", () => {
  assert.equal(parseMediaAudioTrackRecord({
    ...ORIGINAL_TRACK,
    name: "x".repeat(MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH + 1),
  }), null);
  assert.equal(parseMediaAudioTrackRecord({
    ...ORIGINAL_TRACK,
    offsetSeconds: MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS + 1,
  }), null);
  assert.equal(parseMediaAudioTrackRecord({ ...ORIGINAL_TRACK, sortOrder: -1 }), null);
  assert.equal(parseMediaAudioTrackRecord({ ...ORIGINAL_TRACK, temporaryUrl: "secret" }), null);
  assert.equal(parseMediaAudioTrackRecord({
    ...ORIGINAL_TRACK,
    source: {
      type: "embedded_original",
      sourceType: "aliyun_vod",
      mediaResourceId: "unexpected",
    },
  }), null);
  assert.equal(parseMediaAudioTrackRecord({
    ...ORIGINAL_TRACK,
    source: { type: "embedded_original", sourceType: "unknown" },
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
  assert.deepEqual(parseAnnotationAudioPreference({
    annotationFileId: "annotation-file",
    defaultAudioTrackId: null,
    updatedByAccountId: null,
    updatedAt: null,
  }), {
    annotationFileId: "annotation-file",
    defaultAudioTrackId: null,
    updatedByAccountId: null,
    updatedAt: null,
  });
  assert.equal(parseAnnotationAudioPreference({
    ...preference,
    updatedByAccountId: null,
  }), null);
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

test("可试听选项严格绑定标注文件、主媒体、有序音轨与默认值", () => {
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
    sortOrder: 1,
  };
  const options = {
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    defaultAudioTrackId: vocal.id,
    canManageTracks: true,
    tracks: [
      { track: ORIGINAL_TRACK, availability: "available" },
      { track: vocal, availability: "permission_denied" },
    ],
  };
  assert.deepEqual(parseAnnotationAudioPlaybackOptions(options), options);
  assert.equal(parseAnnotationAudioPlaybackOptions({
    ...options,
    defaultAudioTrackId: "missing-track",
  }), null);
  assert.equal(parseAnnotationAudioPlaybackOptions({
    ...options,
    tracks: [...options.tracks].reverse(),
  }), null);
  assert.equal(parseAnnotationAudioPlaybackOptions({
    ...options,
    tracks: [options.tracks[1]],
  }), null);
  assert.equal(parseAnnotationAudioPlaybackOptions({
    ...options,
    tracks: [
      options.tracks[0],
      { ...options.tracks[1], availability: "provider_error" },
    ],
  }), null);
  assert.equal(parseAnnotationAudioPlaybackOptions({
    ...options,
    tracks: [options.tracks[0], options.tracks[0]],
  }), null);
  assert.equal(parseAnnotationAudioPlaybackOptions({
    ...options,
    temporaryUrl: "secret",
  }), null);
  assert.equal(parseAnnotationAudioPlaybackOptions({
    ...options,
    canManageTracks: "yes",
  }), null);
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

test("音轨播放会话严格区分上传音频与短时 VOD 凭据", () => {
  const base = {
    version: 1,
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    trackId: "track-vocal",
    audioMediaResourceId: "media-vocal",
  };
  const uploaded = {
    ...base,
    sourceType: "uploaded",
    fileId: "file-vocal",
    mimeType: "audio/mpeg",
    duration: 120.5,
  };
  const vod = {
    ...base,
    sourceType: "aliyun_vod",
    videoId: "vod-audio",
    region: "cn-shanghai",
    playAuth: "temporary-play-auth",
    expiresAt: "2026-08-24T12:00:00.000Z",
    webPlayerLicense: { domain: "localhost", key: "public-license-key" },
  };
  const rendition = {
    ...base,
    sourceType: "aliyun_vod_rendition",
    videoId: "vod-video",
    region: "cn-shanghai",
    jobId: "job-audio",
    url: "https://vod.example.test/audio.mp3?temporary=1",
    mimeType: "audio/mpeg",
    duration: 120.5,
    expiresAt: "2026-08-24T12:00:00.000Z",
    webPlayerLicense: { domain: "localhost", key: "public-license-key" },
  };
  assert.deepEqual(parseMediaAudioTrackPlaybackSession(uploaded), uploaded);
  assert.deepEqual(parseMediaAudioTrackPlaybackSession(vod), vod);
  assert.deepEqual(parseMediaAudioTrackPlaybackSession(rendition), rendition);
  assert.equal(parseMediaAudioTrackPlaybackSession({ ...uploaded, url: "secret" }), null);
  assert.equal(parseMediaAudioTrackPlaybackSession({ ...uploaded, mimeType: "video/mp4" }), null);
  assert.equal(parseMediaAudioTrackPlaybackSession({ ...vod, expiresAt: "not-a-date" }), null);
  assert.equal(parseMediaAudioTrackPlaybackSession({ ...vod, playAuth: "" }), null);
  assert.equal(parseMediaAudioTrackPlaybackSession({ ...vod, annotationFileId: " bad " }), null);
  assert.equal(parseMediaAudioTrackPlaybackSession({ ...rendition, url: "http://insecure.test/audio.mp3" }), null);
  assert.equal(parseMediaAudioTrackPlaybackSession({ ...rendition, jobId: "" }), null);
});
