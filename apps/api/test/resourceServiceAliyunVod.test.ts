import assert from "node:assert/strict";
import test from "node:test";
import type { AliyunVodProvider } from "../src/aliyunVodGateway.js";
import { HttpError } from "../src/errors.js";
import { ResourceService } from "../src/resourceService.js";

test("VOD 播放缺少 Web License 时在签发 PlayAuth 前失败", async () => {
  let credentialRequests = 0;
  const provider: AliyunVodProvider = {
    region: "cn-shanghai",
    gateway: {
      inspectVideo: async () => { throw new Error("不应调用"); },
      createAnalysisAudioStream: async () => { throw new Error("不应调用"); },
      listAudioRenditions: async () => { throw new Error("不应调用"); },
      createAudioRenditionStream: async () => { throw new Error("不应调用"); },
      createPlaybackCredential: async () => {
        credentialRequests += 1;
        throw new Error("不应调用");
      },
    },
  };
  // 单元测试只提供播放会话读取所需的最小仓储和 ACL 边界，避免启动完整数据库应用。
  const service = new ResourceService(
    {
      resourceEntry: {
        findUnique: async () => ({
          id: "media-vod-1",
          type: "media_file",
          trashedAt: null,
          archivedAt: null,
          mediaFile: {
            sourceType: "aliyun_vod",
            mediaKind: "video",
            aliyunVodVideoId: "vod-1",
            aliyunVodRegion: "cn-shanghai",
          },
        }),
      },
    } as never,
    {
      assertCapability: async () => undefined,
    } as never,
    { publishRevisionAdvanced: () => undefined },
    provider,
    null,
  );

  await assert.rejects(
    service.createAliyunVodPlaybackSession({} as never, "media-vod-1"),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "external_service_unavailable");
      assert.match(error.message, /Web 播放器 License/);
      return true;
    },
  );
  assert.equal(credentialRequests, 0);
});
