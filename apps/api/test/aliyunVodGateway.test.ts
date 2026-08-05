import assert from "node:assert/strict";
import test from "node:test";
import {
  AliyunVodGatewayError,
  AliyunVodSdkGateway,
} from "../src/aliyunVodGateway.js";

test("VOD 网关规范化媒资元数据且不返回供应商原始响应", async () => {
  const gateway = new AliyunVodSdkGateway({
    getVideoInfo: async () => ({
      body: {
        requestId: "request-1",
        video: {
          videoId: "video_123456",
          title: "寻梦",
          status: "Normal",
          duration: 123.5,
        },
      },
    }),
    getVideoPlayAuth: async () => ({ body: {} }),
  } as never);

  assert.deepEqual(await gateway.inspectVideo("video_123456"), {
    videoId: "video_123456",
    title: "寻梦",
    status: "Normal",
    mediaKind: "video",
    duration: 123.5,
  });
});

test("VOD 网关为短时播放凭据保留安全余量", async () => {
  const before = Date.now();
  const gateway = new AliyunVodSdkGateway({
    getVideoInfo: async () => ({ body: {} }),
    getVideoPlayAuth: async () => ({
      body: {
        requestId: "request-2",
        playAuth: "temporary-auth",
        videoMeta: { videoId: "video_123456", status: "Normal" },
      },
    }),
  } as never);

  const credential = await gateway.createPlaybackCredential("video_123456");
  assert.equal(credential.playAuth, "temporary-auth");
  assert.ok(credential.expiresAt.getTime() >= before + 894_000);
  assert.ok(credential.expiresAt.getTime() <= Date.now() + 895_000);
});

test("VOD 网关把供应商异常收敛为有限且不携带原始 cause 的类别", async () => {
  const gateway = new AliyunVodSdkGateway({
    getVideoInfo: async () => {
      throw {
        code: "InvalidVideo.NotFound",
        requestId: "request-3",
        accessKeySecret: "must-not-escape",
      };
    },
    getVideoPlayAuth: async () => ({ body: {} }),
  } as never);

  await assert.rejects(
    gateway.inspectVideo("video_123456"),
    (error: unknown) => {
      assert.ok(error instanceof AliyunVodGatewayError);
      assert.equal(error.category, "not_found");
      assert.equal(error.requestId, "request-3");
      assert.equal("cause" in error, false);
      assert.doesNotMatch(error.message, /must-not-escape/);
      return true;
    },
  );
});
