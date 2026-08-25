import CredentialPackage from "@alicloud/credentials";
import OpenApi from "@alicloud/openapi-client";
import VodPackage, {
  GetPlayInfoRequest,
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

// 纯音频播放地址只允许在 analysis worker 内存中短暂存在，不能映射到公开 DTO 或数据库。
export type AliyunVodAnalysisAudioStream = {
  url: string;
  expiresAt: Date;
  format: "mp3";
  duration: number | null;
  bitrate: number | null;
};

export interface AliyunVodGateway {
  inspectVideo(videoId: string): Promise<AliyunVodMediaMetadata>;
  createPlaybackCredential(videoId: string): Promise<AliyunVodPlaybackCredential>;
  createAnalysisAudioStream(videoId: string): Promise<AliyunVodAnalysisAudioStream>;
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
  constructor(private readonly client: Pick<
    VodSdkClient,
    "getVideoInfo" | "getVideoPlayAuth" | "getPlayInfo"
  >) {}

  async inspectVideo(videoId: string): Promise<AliyunVodMediaMetadata> {
    try {
      // GetVideoInfo 提供标题与时长，GetPlayInfo.VideoBase 才提供 audio/video 媒体类别。
      // 两个响应只在适配器内短暂存在，可能携带的播放 URL 不会进入 DTO、数据库或日志。
      // 先验证基础媒资，再读取媒体类型；顺序调用能保留 NotFound 等准确错误，
      // 也避免首个请求失败后留下一个无人接收的并行 SDK rejection。
      const infoResponse = await this.client.getVideoInfo(
        new GetVideoInfoRequest({ videoId }),
      );
      const playInfoResponse = await this.client.getPlayInfo(new GetPlayInfoRequest({
        videoId,
        resultType: "Multiple",
        outputType: "cdn",
      }));
      const video = infoResponse.body?.video;
      const normalizedVideoId = requiredString(video?.videoId);
      const title = requiredString(video?.title);
      const status = requiredString(video?.status);
      const playInfoVideoId = requiredString(playInfoResponse.body?.videoBase?.videoId);
      const mediaKind = parseAliyunVodMediaKind(
        playInfoResponse.body?.videoBase?.mediaType,
      );
      if (
        !normalizedVideoId ||
        !title ||
        !status ||
        normalizedVideoId !== videoId ||
        playInfoVideoId !== videoId ||
        !mediaKind
      ) {
        throw new AliyunVodGatewayError(
          "invalid_response",
          optionalString(infoResponse.body?.requestId) ??
            optionalString(playInfoResponse.body?.requestId),
        );
      }
      return {
        videoId: normalizedVideoId,
        title,
        status,
        mediaKind,
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

  async createAnalysisAudioStream(videoId: string): Promise<AliyunVodAnalysisAudioStream> {
    const requestedAt = Date.now();
    try {
      const response = await this.client.getPlayInfo(new GetPlayInfoRequest({
        videoId,
        formats: "mp3",
        streamType: "audio",
        outputType: "cdn",
        authTimeout: PLAY_AUTH_TIMEOUT_SECONDS,
        resultType: "Multiple",
      }));
      const videoBase = response.body?.videoBase;
      const returnedVideoId = requiredString(videoBase?.videoId);
      const status = requiredString(videoBase?.status);
      if (returnedVideoId !== videoId || status !== "Normal") {
        throw new AliyunVodGatewayError(
          "invalid_response",
          optionalString(response.body?.requestId),
        );
      }
      const selected = selectAliyunVodAnalysisAudio(
        response.body?.playInfoList?.playInfo ?? [],
      );
      if (!selected) {
        throw new AliyunVodGatewayError(
          "not_found",
          optionalString(response.body?.requestId),
        );
      }
      return {
        ...selected,
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

type AliyunVodPlayInfoCandidate = {
  playURL?: unknown;
  format?: unknown;
  streamType?: unknown;
  status?: unknown;
  duration?: unknown;
  bitrate?: unknown;
};

/**
 * 只接受正常的 HTTPS mp3 纯音频流；排序规则固定为较高码率优先，再按 URL 稳定排序。
 * 供应商返回的视频流、明文 HTTP、畸形数值和未知状态都不能进入 FFmpeg argv。
 */
export function selectAliyunVodAnalysisAudio(
  candidates: AliyunVodPlayInfoCandidate[],
): Omit<AliyunVodAnalysisAudioStream, "expiresAt"> | null {
  const normalized = candidates.flatMap((candidate) => {
    const url = requiredString(candidate.playURL);
    const format = requiredString(candidate.format)?.toLowerCase();
    const streamType = requiredString(candidate.streamType)?.toLowerCase();
    const status = requiredString(candidate.status);
    if (
      !url ||
      !isSecureHttpUrl(url) ||
      format !== "mp3" ||
      streamType !== "audio" ||
      status !== "Normal"
    ) return [];
    return [{
      url,
      format: "mp3" as const,
      duration: optionalNumericString(candidate.duration),
      bitrate: optionalNumericString(candidate.bitrate),
    }];
  });
  normalized.sort((left, right) =>
    (right.bitrate ?? -1) - (left.bitrate ?? -1) ||
    left.url.localeCompare(right.url));
  return normalized[0] ?? null;
}

// SDK 可选字段统一在边界收窄，业务层不再处理空白字符串或 undefined。
function requiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown) {
  return requiredString(value);
}

// 阿里云字段大小写不作为业务差异，但未知类型必须拒绝，不能把纯音频误建成视频资源。
function parseAliyunVodMediaKind(value: unknown): MediaKind | null {
  const normalized = requiredString(value)?.toLowerCase();
  return normalized === "video" || normalized === "audio" ? normalized : null;
}

// 非法时长按未知处理；创建资源仍可继续，但不会伪造零秒。
function optionalNonNegativeNumber(value: unknown) {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function optionalNumericString(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isSecureHttpUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
