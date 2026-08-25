import assert from "node:assert/strict";
import test from "node:test";
import type { MediaAudioTrackPlaybackSession, MediaAudioTrackRecord } from "@xiqu/shared";
import { buildPlatformExternalAudioPlaybackSource } from "./platformMediaAudioPlaybackSource";

const TRACK: MediaAudioTrackRecord = {
  id: "track-vocal",
  primaryMediaResourceId: "media-video",
  name: "人声",
  kind: "vocal",
  source: {
    type: "media_resource",
    mediaResourceId: "media-audio",
    sourceType: "uploaded",
  },
  offsetSeconds: 0.25,
  sortOrder: 1,
  enabled: true,
};

test("上传音轨只在加载时构造带当前会话 token 的 Range URL", async () => {
  let sessionRequests = 0;
  const source = buildPlatformExternalAudioPlaybackSource({
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    track: TRACK,
    client: {
      createMediaAudioTrackPlaybackSession: async () => {
        sessionRequests += 1;
        return createUploadedSession();
      },
      getFileContentUrl: (fileId) => `/api/files/${fileId}/content?access_token=current`,
    },
  });
  assert.equal(source?.type, "uploaded_audio");
  assert.equal(sessionRequests, 0);
  if (source?.type !== "uploaded_audio") return;
  assert.deepEqual(await source.load(), {
    url: "/api/files/file-audio/content?access_token=current",
    mimeType: "audio/mpeg",
    duration: 120,
  });
  assert.equal(sessionRequests, 1);
});

test("VOD 音轨只在加载时请求短时凭据并固定为音频媒体", async () => {
  let sessionRequests = 0;
  const source = buildPlatformExternalAudioPlaybackSource({
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    track: {
      ...TRACK,
      source: {
        type: "media_resource",
        mediaResourceId: "media-audio",
        sourceType: "aliyun_vod",
      },
    },
    client: {
      createMediaAudioTrackPlaybackSession: async () => {
        sessionRequests += 1;
        return {
          version: 1,
          annotationFileId: "annotation-file",
          primaryMediaResourceId: "media-video",
          trackId: "track-vocal",
          audioMediaResourceId: "media-audio",
          sourceType: "aliyun_vod",
          videoId: "vod-audio",
          region: "cn-shanghai",
          playAuth: "temporary-auth",
          expiresAt: "2030-01-01T00:00:00.000Z",
          webPlayerLicense: { domain: "example.test", key: "public-license" },
        };
      },
      getFileContentUrl: () => "unused",
    },
  });
  assert.equal(source?.type, "aliyun_vod_audio");
  assert.equal(sessionRequests, 0);
  if (source?.type !== "aliyun_vod_audio") return;
  assert.deepEqual(await source.loadSession(), {
    sourceType: "aliyun_vod",
    mediaKind: "audio",
    videoId: "vod-audio",
    region: "cn-shanghai",
    playAuth: "temporary-auth",
    expiresAt: "2030-01-01T00:00:00.000Z",
    webPlayerLicense: { domain: "example.test", key: "public-license" },
  });
  assert.equal(sessionRequests, 1);
});

test("VOD 转码音轨保留稳定 JobId，并只在加载时取得临时直链", async () => {
  let sessionRequests = 0;
  const source = buildPlatformExternalAudioPlaybackSource({
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    track: {
      ...TRACK,
      source: {
        type: "aliyun_vod_rendition",
        mediaResourceId: "media-video",
        sourceType: "aliyun_vod",
        rendition: {
          jobId: "job-audio-mp3",
          format: "mp3",
          definition: "SQ",
          bitrate: 128.002,
          duration: 120,
        },
      },
    },
    client: {
      createMediaAudioTrackPlaybackSession: async () => {
        sessionRequests += 1;
        return createVodRenditionSession();
      },
      getFileContentUrl: () => "unused",
    },
  });
  assert.equal(source?.type, "aliyun_vod_rendition_audio");
  assert.equal(sessionRequests, 0);
  if (source?.type !== "aliyun_vod_rendition_audio") return;
  assert.equal(source.renditionJobId, "job-audio-mp3");
  assert.deepEqual(await source.loadSession(), createVodRenditionSession());
  assert.equal(sessionRequests, 1);
});

test("VOD 转码 JobId 变化时拒绝把迟到会话接到当前音轨", async () => {
  const source = buildPlatformExternalAudioPlaybackSource({
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    track: {
      ...TRACK,
      source: {
        type: "aliyun_vod_rendition",
        mediaResourceId: "media-video",
        sourceType: "aliyun_vod",
        rendition: {
          jobId: "job-audio-mp3",
          format: "mp3",
          definition: "SQ",
          bitrate: null,
          duration: null,
        },
      },
    },
    client: {
      createMediaAudioTrackPlaybackSession: async () => ({
        ...createVodRenditionSession(),
        jobId: "job-replaced",
      }),
      getFileContentUrl: () => "unused",
    },
  });
  if (source?.type !== "aliyun_vod_rendition_audio") return;
  await assert.rejects(source.loadSession(), /转码会话来源已经变化/u);
});

test("会话身份或来源变化时 fail closed", async () => {
  const source = buildPlatformExternalAudioPlaybackSource({
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    track: TRACK,
    client: {
      createMediaAudioTrackPlaybackSession: async () => ({
        ...createUploadedSession(),
        trackId: "track-other",
      }),
      getFileContentUrl: () => "unused",
    },
  });
  if (source?.type !== "uploaded_audio") return;
  await assert.rejects(source.load(), /不匹配/u);

  assert.equal(buildPlatformExternalAudioPlaybackSource({
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    track: { ...TRACK, enabled: false },
    client: {
      createMediaAudioTrackPlaybackSession: async () => createUploadedSession(),
      getFileContentUrl: () => "unused",
    },
  }), null);
});

function createUploadedSession(): MediaAudioTrackPlaybackSession {
  return {
    version: 1,
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    trackId: "track-vocal",
    audioMediaResourceId: "media-audio",
    sourceType: "uploaded",
    fileId: "file-audio",
    mimeType: "audio/mpeg",
    duration: 120,
  };
}

function createVodRenditionSession(): Extract<
  MediaAudioTrackPlaybackSession,
  { sourceType: "aliyun_vod_rendition" }
> {
  return {
    version: 1,
    annotationFileId: "annotation-file",
    primaryMediaResourceId: "media-video",
    trackId: "track-vocal",
    audioMediaResourceId: "media-video",
    sourceType: "aliyun_vod_rendition",
    videoId: "vod-video",
    region: "cn-shanghai",
    jobId: "job-audio-mp3",
    url: "https://vod.example.test/audio.mp3?temporary=1",
    mimeType: "audio/mpeg",
    duration: 120,
    expiresAt: "2030-01-01T00:00:00.000Z",
    webPlayerLicense: { domain: "example.test", key: "public-license" },
  };
}
