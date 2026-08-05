import CredentialPackage from "@alicloud/credentials";
import OpenApi from "@alicloud/openapi-client";
import VodPackage, {
  GetVideoInfoRequest,
  GetVideoPlayAuthRequest,
} from "@alicloud/vod20170321";
import type { MediaKind } from "@xiqu/shared";

const PLAY_AUTH_TIMEOUT_SECONDS = 900;
const PLAY_AUTH_CLOCK_SAFETY_SECONDS = 5;
const Credential = CredentialPackage.default;
const VodClient = VodPackage.default;
type VodSdkClient = InstanceType<typeof VodClient>;

export type AliyunVodMediaMetadata = {
  videoId: string;
  title: string;
  status: string;
  mediaKind: MediaKind;
  duration: number | null;
};

export type AliyunVodPlaybackCredential = {
  videoId: string;
  status: string;
  playAuth: string;
  expiresAt: Date;
};

export interface AliyunVodGateway {
  inspectVideo(videoId: string): Promise<AliyunVodMediaMetadata>;
  createPlaybackCredential(videoId: string): Promise<AliyunVodPlaybackCredential>;
}

export type AliyunVodProvider = {
  region: string;
  gateway: AliyunVodGateway;
};

export type AliyunVodGatewayErrorCategory =
  | "not_found"
  | "permission_denied"
  | "temporarily_unavailable"
  | "invalid_response";

/**
 * 供应商异常在适配器边界收敛为有限类别。
 *
 * 不保留 SDK Error/cause，避免上层日志无意输出请求签名、endpoint 参数或供应商原始响应。
 */
export class AliyunVodGatewayError extends Error {
  constructor(
    readonly category: AliyunVodGatewayErrorCategory,
    readonly requestId: string | null = null,
  ) {
    super(`Aliyun VOD gateway failed: ${category}`);
  }
}

/**
 * 创建生产 VOD 网关。凭据由阿里云默认凭据链延迟解析，仓库不读取或保存 AccessKey/Secret。
 */
export function createAliyunVodProvider(region: string): AliyunVodProvider {
  const credential = new Credential();
  const config = new OpenApi.Config({ credential, regionId: region });
  return {
    region,
    gateway: new AliyunVodSdkGateway(new VodClient(config)),
  };
}

export class AliyunVodSdkGateway implements AliyunVodGateway {
  constructor(private readonly client: Pick<VodSdkClient, "getVideoInfo" | "getVideoPlayAuth">) {}

  async inspectVideo(videoId: string): Promise<AliyunVodMediaMetadata> {
    try {
      const response = await this.client.getVideoInfo(
        new GetVideoInfoRequest({ videoId }),
      );
      const video = response.body?.video;
      const normalizedVideoId = requiredString(video?.videoId);
      const title = requiredString(video?.title);
      const status = requiredString(video?.status);
      if (!normalizedVideoId || !title || !status || normalizedVideoId !== videoId) {
        throw new AliyunVodGatewayError(
          "invalid_response",
          optionalString(response.body?.requestId),
        );
      }
      return {
        videoId: normalizedVideoId,
        title,
        status,
        // R3h2 接入的是 VOD 视频身份；同 vid 的纯音频转码由 R3h4 作为分析来源解析。
        mediaKind: "video",
        duration: optionalNonNegativeNumber(video?.duration),
      };
    } catch (error) {
      throw normalizeAliyunVodError(error);
    }
  }

  async createPlaybackCredential(videoId: string): Promise<AliyunVodPlaybackCredential> {
    const requestedAt = Date.now();
    try {
      const response = await this.client.getVideoPlayAuth(
        new GetVideoPlayAuthRequest({
          videoId,
          authInfoTimeout: PLAY_AUTH_TIMEOUT_SECONDS,
        }),
      );
      const returnedVideoId = requiredString(response.body?.videoMeta?.videoId);
      const status = requiredString(response.body?.videoMeta?.status);
      const playAuth = requiredString(response.body?.playAuth);
      if (!returnedVideoId || returnedVideoId !== videoId || !status || !playAuth) {
        throw new AliyunVodGatewayError(
          "invalid_response",
          optionalString(response.body?.requestId),
        );
      }
      return {
        videoId: returnedVideoId,
        status,
        playAuth,
        // 使用请求开始时间并减去安全余量，绝不向客户端夸大凭据有效期。
        expiresAt: new Date(
          requestedAt +
          (PLAY_AUTH_TIMEOUT_SECONDS - PLAY_AUTH_CLOCK_SAFETY_SECONDS) * 1_000,
        ),
      };
    } catch (error) {
      throw normalizeAliyunVodError(error);
    }
  }
}

// SDK 可选字段统一在边界收窄，业务层不再处理空白字符串或 undefined。
function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown) {
  return requiredString(value);
}

// 非法时长按未知处理；创建资源仍可继续，但不会伪造零秒。
function optionalNonNegativeNumber(value: unknown) {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

// 供应商错误只按稳定 code 分类，原始对象和潜在敏感字段不作为 cause 保留。
function normalizeAliyunVodError(error: unknown): AliyunVodGatewayError {
  if (error instanceof AliyunVodGatewayError) return error;
  const record = isRecord(error) ? error : null;
  const code = typeof record?.code === "string" ? record.code : "";
  const requestId = typeof record?.requestId === "string"
    ? record.requestId
    : null;
  if (/NotFound|NoSuch|InvalidVideo/i.test(code)) {
    return new AliyunVodGatewayError("not_found", requestId);
  }
  if (/Forbidden|Unauthorized|Permission|AccessDenied/i.test(code)) {
    return new AliyunVodGatewayError("permission_denied", requestId);
  }
  return new AliyunVodGatewayError("temporarily_unavailable", requestId);
}

// 错误归一化只读取普通对象的有限字段，不假设 SDK 一定抛 Error 实例。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
