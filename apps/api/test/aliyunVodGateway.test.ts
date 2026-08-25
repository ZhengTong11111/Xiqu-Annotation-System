import assert from "node:assert/strict";
import test from "node:test";
import {
  AliyunVodGatewayError,
  AliyunVodSdkGateway,
  createAliyunVodProvider,
  parseAliyunVodAudioRenditions,
  selectAliyunVodAnalysisAudio,
} from "../src/aliyunVodGateway.js";

test("生产 VOD provider 使用官方 SDK 默认导出并能完成运行时构造", () => {
  // 模拟网关测试不会执行 SDK 构造路径；这里专门防止 CJS/ESM 默认导入层级再次写错。
  const provider = createAliyunVodProvider("cn-shanghai");
  assert.equal(provider.region, "cn-shanghai");
  assert.ok(provider.gateway instanceof AliyunVodSdkGateway);
});

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
    getPlayInfo: async () => ({
      body: {
        requestId: "request-play-info-1",
        videoBase: { videoId: "video_123456", mediaType: "Video" },
      },
    }),
  } as never);

  assert.deepEqual(await gateway.inspectVideo("video_123456"), {
    videoId: "video_123456",
    title: "寻梦",
    status: "Normal",
    mediaKind: "video",
    duration: 123.5,
  });
});

test("VOD 网关按 VideoBase 媒体类型识别纯音频资源", async () => {
  const gateway = new AliyunVodSdkGateway({
    getVideoInfo: async () => ({
      body: {
        video: {
          videoId: "audio_123456",
          title: "寻梦人声分离",
          status: "Normal",
          duration: 123.5,
        },
      },
    }),
    getVideoPlayAuth: async () => ({ body: {} }),
    getPlayInfo: async () => ({
      body: {
        videoBase: { videoId: "audio_123456", mediaType: "audio" },
      },
    }),
  } as never);

  assert.equal((await gateway.inspectVideo("audio_123456")).mediaKind, "audio");
});

test("VOD 分析音频只选择正常 HTTPS mp3 音频并按码率稳定排序", () => {
  assert.deepEqual(selectAliyunVodAnalysisAudio([
    {
      playURL: "https://vod.example.test/low.mp3",
      format: "mp3",
      streamType: "audio",
      status: "Normal",
      duration: "12.5",
      bitrate: "64",
    },
    {
      playURL: "http://vod.example.test/insecure.mp3",
      format: "mp3",
      streamType: "audio",
      status: "Normal",
      bitrate: "999",
    },
    {
      playURL: "https://vod.example.test/video.mp3",
      format: "mp3",
      streamType: "video",
      status: "Normal",
      bitrate: "256",
    },
    {
      playURL: "https://vod.example.test/high.mp3",
      format: "MP3",
      streamType: "audio",
      status: "Normal",
      duration: "12.5",
      bitrate: "128",
    },
  ]), {
    url: "https://vod.example.test/high.mp3",
    format: "mp3",
    duration: 12.5,
    bitrate: 128,
  });
  assert.equal(selectAliyunVodAnalysisAudio([]), null);
});

test("VOD 分析音频请求使用纯音频参数并拒绝错配媒资", async () => {
  let capturedRequest: Record<string, unknown> | null = null;
  const gateway = new AliyunVodSdkGateway({
    getVideoInfo: async () => ({ body: {} }),
    getVideoPlayAuth: async () => ({ body: {} }),
    getPlayInfo: async (request: Record<string, unknown>) => {
      capturedRequest = request;
      return {
        body: {
          requestId: "request-audio",
          videoBase: { videoId: "video_123456", status: "Normal" },
          playInfoList: {
            playInfo: [{
              playURL: "https://vod.example.test/audio.mp3?auth=temporary",
              format: "mp3",
              streamType: "audio",
              status: "Normal",
              bitrate: "128",
            }],
          },
        },
      };
    },
  } as never);
  const stream = await gateway.createAnalysisAudioStream("video_123456");
  // TypeScript 不会把异步测试桩内部的赋值纳入外层控制流收窄，先显式验证再读取捕获参数。
  assert.ok(capturedRequest);
  const request = capturedRequest as Record<string, unknown>;
  assert.equal(request.formats, "mp3");
  assert.equal(request.streamType, "audio");
  assert.equal(stream.url.includes("auth=temporary"), true);

  const mismatched = new AliyunVodSdkGateway({
    getVideoInfo: async () => ({ body: {} }),
    getVideoPlayAuth: async () => ({ body: {} }),
    getPlayInfo: async () => ({
      body: {
        videoBase: { videoId: "different", status: "Normal" },
        playInfoList: { playInfo: [] },
      },
    }),
  } as never);
  await assert.rejects(
    mismatched.createAnalysisAudioStream("video_123456"),
    (error: unknown) => error instanceof AliyunVodGatewayError
      && error.category === "invalid_response",
  );
});

test("VOD 音频转码以 JobId 唯一化并只签发指定流", async () => {
  const gateway = new AliyunVodSdkGateway({
    getVideoInfo: async () => ({ body: {} }),
    getVideoPlayAuth: async () => ({ body: {} }),
    getPlayInfo: async () => ({
      body: {
        requestId: "request-rendition",
        videoBase: { videoId: "video_123456", status: "Normal" },
        playInfoList: {
          playInfo: [
            {
              jobId: "job-low",
              playURL: "https://vod.example.test/low.mp3?temporary=1",
              format: "mp3",
              streamType: "audio",
              status: "Normal",
              definition: "SQ",
              bitrate: "64",
              duration: "12.5",
            },
            {
              jobId: "job-high",
              playURL: "https://vod.example.test/high.mp3?temporary=1",
              format: "mp3",
              streamType: "audio",
              status: "Normal",
              definition: "HQ",
              bitrate: "128",
              duration: "12.5",
            },
          ],
        },
      },
    }),
  } as never);

  assert.deepEqual(await gateway.listAudioRenditions("video_123456"), [
    {
      jobId: "job-high",
      format: "mp3",
      definition: "HQ",
      bitrate: 128,
      duration: 12.5,
    },
    {
      jobId: "job-low",
      format: "mp3",
      definition: "SQ",
      bitrate: 64,
      duration: 12.5,
    },
  ]);
  const stream = await gateway.createAudioRenditionStream(
    "video_123456",
    "job-low",
  );
  assert.equal(stream.jobId, "job-low");
  assert.match(stream.url, /low\.mp3/u);
  await assert.rejects(
    gateway.createAudioRenditionStream("video_123456", "missing-job"),
    (error: unknown) => error instanceof AliyunVodGatewayError &&
      error.category === "not_found",
  );
});

test("VOD 音频转码拒绝重复 JobId 和不安全候选", () => {
  assert.equal(parseAliyunVodAudioRenditions([
    {
      jobId: "same-job",
      playURL: "https://vod.example.test/a.mp3",
      format: "mp3",
      streamType: "audio",
      status: "Normal",
    },
    {
      jobId: "same-job",
      playURL: "https://vod.example.test/b.mp3",
      format: "mp3",
      streamType: "audio",
      status: "Normal",
    },
  ]), null);
  assert.deepEqual(parseAliyunVodAudioRenditions([
    {
      jobId: "http-job",
      playURL: "http://vod.example.test/audio.mp3",
      format: "mp3",
      streamType: "audio",
      status: "Normal",
    },
    {
      jobId: "video-job",
      playURL: "https://vod.example.test/video.mp3",
      format: "mp3",
      streamType: "video",
      status: "Normal",
    },
  ]), []);
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
