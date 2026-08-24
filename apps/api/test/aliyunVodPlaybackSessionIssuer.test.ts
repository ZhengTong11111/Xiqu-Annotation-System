import assert from "node:assert/strict";
import test from "node:test";
import {
  AliyunVodGatewayError,
  type AliyunVodProvider,
} from "../src/aliyunVodGateway.js";
import { issueAliyunVodPlaybackSession } from "../src/aliyunVodPlaybackSessionIssuer.js";
import { HttpError } from "../src/errors.js";

const license = { domain: "example.test", key: "public-web-license" };

function createProvider(
  createPlaybackCredential: AliyunVodProvider["gateway"]["createPlaybackCredential"],
): AliyunVodProvider {
  return {
    region: "cn-shanghai",
    gateway: {
      inspectVideo: async () => { throw new Error("本测试不应检查元数据"); },
      createAnalysisAudioStream: async () => { throw new Error("本测试不应请求分析流"); },
      createPlaybackCredential,
    },
  };
}

test("共享 VOD 签发器在 License 缺失时不请求短时凭据", async () => {
  let requests = 0;
  const provider = createProvider(async () => {
    requests += 1;
    throw new Error("不应调用");
  });

  await assert.rejects(
    issueAliyunVodPlaybackSession(provider, null, {
      mediaKind: "audio",
      videoId: "audio-vod-1",
      region: "cn-shanghai",
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /Web 播放器 License/);
      return true;
    },
  );
  assert.equal(requests, 0);
});

test("共享 VOD 签发器拒绝供应商返回的错误媒资身份", async () => {
  const provider = createProvider(async () => ({
    videoId: "other-vod",
    status: "Normal",
    playAuth: "must-not-escape",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  }));

  await assert.rejects(
    issueAliyunVodPlaybackSession(provider, license, {
      mediaKind: "audio",
      videoId: "audio-vod-1",
      region: "cn-shanghai",
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, "external_media_unavailable");
      assert.doesNotMatch(error.message, /must-not-escape/);
      return true;
    },
  );
});

test("共享 VOD 签发器只暴露规范化错误与供应商 requestId", async () => {
  const provider = createProvider(async () => {
    throw new AliyunVodGatewayError(
      "permission_denied",
      "request-id-1",
    );
  });

  await assert.rejects(
    issueAliyunVodPlaybackSession(provider, license, {
      mediaKind: "video",
      videoId: "video-vod-1",
      region: "cn-shanghai",
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.code, "external_service_unavailable");
      assert.deepEqual(error.details, { requestId: "request-id-1" });
      assert.doesNotMatch(error.message, /accesskey|raw/iu);
      return true;
    },
  );
});
