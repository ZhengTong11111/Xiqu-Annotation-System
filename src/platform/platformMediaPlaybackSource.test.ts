import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationMediaReference } from "@xiqu/shared";
import { buildPlatformMediaPlaybackSource } from "./platformMediaPlaybackSource";

const vodMedia: AnnotationMediaReference = {
  resourceId: "media-vod",
  name: "寻梦",
  mediaKind: "video",
  duration: 120,
  sourceType: "aliyun_vod",
  videoId: "vod-1",
  region: "cn-shanghai",
};

test("本机或 uploaded 运行时 URL 使用原生播放器", () => {
  const source = buildPlatformMediaPlaybackSource({
    media: null,
    nativeUrl: "blob:local-video",
    requiresManualImport: false,
    loadAliyunVodSession: async () => { throw new Error("不应调用"); },
  });
  assert.deepEqual(source, { type: "native", url: "blob:local-video" });
});

test("VOD 来源只保存稳定引用并延迟请求短时会话", async () => {
  const requested: string[] = [];
  let requestedSignal: AbortSignal | undefined;
  const source = buildPlatformMediaPlaybackSource({
    media: vodMedia,
    nativeUrl: "",
    requiresManualImport: false,
    loadAliyunVodSession: async (resourceId, signal) => {
      requested.push(resourceId);
      requestedSignal = signal;
      return {
        sourceType: "aliyun_vod",
        mediaKind: "video",
        videoId: "vod-1",
        region: "cn-shanghai",
        playAuth: "temporary-secret",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        webPlayerLicense: {
          domain: "example.test",
          key: "test-web-license-key",
        },
      };
    },
  });
  assert.equal(source.type, "aliyun_vod");
  assert.deepEqual(requested, []);
  const controller = new AbortController();
  if (source.type === "aliyun_vod") await source.loadSession(controller.signal);
  assert.deepEqual(requested, ["media-vod"]);
  assert.equal(requestedSignal, controller.signal);
});

test("缺少媒体时返回可解释的不可用来源", () => {
  const source = buildPlatformMediaPlaybackSource({
    media: null,
    nativeUrl: "",
    requiresManualImport: true,
    loadAliyunVodSession: async () => { throw new Error("不应调用"); },
  });
  assert.equal(source.type, "unavailable");
  if (source.type === "unavailable") assert.match(source.message, /重新关联/);
});
