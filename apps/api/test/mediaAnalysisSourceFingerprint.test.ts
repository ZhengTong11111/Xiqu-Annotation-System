import assert from "node:assert/strict";
import test from "node:test";
import { createMediaAnalysisSourceFingerprint } from "../src/mediaAnalysisSourceFingerprint.js";

test("媒体 fingerprint 对同一上传内容稳定且没有偏移输入", () => {
  const source = {
    sourceType: "uploaded" as const,
    mediaResourceId: "media-1",
    fileId: "file-1",
    checksum: "a".repeat(64),
    size: 128n,
  };
  assert.equal(createMediaAnalysisSourceFingerprint(source), createMediaAnalysisSourceFingerprint(source));
  assert.match(createMediaAnalysisSourceFingerprint(source) ?? "", /^[a-f0-9]{64}$/u);
});

test("VOD 内容身份变化会改变 fingerprint", () => {
  const base = {
    sourceType: "aliyun_vod" as const,
    mediaResourceId: "media-1",
    region: "cn-shanghai",
    videoId: "vod-1",
    duration: 120,
  };
  assert.notEqual(
    createMediaAnalysisSourceFingerprint(base),
    createMediaAnalysisSourceFingerprint({ ...base, videoId: "vod-2" }),
  );
});

test("缺少 checksum 或 VOD 稳定身份时 fail closed", () => {
  assert.equal(createMediaAnalysisSourceFingerprint({
    sourceType: "uploaded",
    mediaResourceId: "media-1",
    fileId: "file-1",
    checksum: null,
    size: 1n,
  }), null);
  assert.equal(createMediaAnalysisSourceFingerprint({
    sourceType: "aliyun_vod",
    mediaResourceId: "media-1",
    region: null,
    videoId: "vod-1",
    duration: 1,
  }), null);
});
