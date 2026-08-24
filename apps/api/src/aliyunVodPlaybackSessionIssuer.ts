import type {
  AliyunVodPlaybackSession,
  AliyunVodWebPlayerLicense,
  MediaKind,
} from "@xiqu/shared";
import {
  AliyunVodGatewayError,
  type AliyunVodProvider,
} from "./aliyunVodGateway.js";
import {
  externalMediaUnavailable,
  externalServiceUnavailable,
} from "./errors.js";

type AliyunVodPlaybackIdentity = {
  mediaKind: MediaKind;
  videoId: string;
  region: string;
};

/**
 * 主视频与替换音轨共用这一签发边界；它只返回规范化 DTO，绝不向上抛 SDK 原始错误或 provider 响应。
 */
export async function issueAliyunVodPlaybackSession(
  provider: AliyunVodProvider | null,
  webPlayerLicense: AliyunVodWebPlayerLicense | null,
  media: AliyunVodPlaybackIdentity,
): Promise<AliyunVodPlaybackSession> {
  if (!provider) throw externalServiceUnavailable("服务器尚未启用阿里云 VOD。");
  // License 缺失时不能先请求 PlayAuth，避免产生无法消费的短期凭据和无意义供应商流量。
  if (!webPlayerLicense) {
    throw externalServiceUnavailable(
      "当前服务未配置阿里云 Web 播放器 License，请联系管理员。",
    );
  }
  if (media.region !== provider.region) {
    throw externalServiceUnavailable("当前服务未配置该 VOD 媒资所在区域。");
  }

  let credential: Awaited<ReturnType<AliyunVodProvider["gateway"]["createPlaybackCredential"]>>;
  try {
    credential = await provider.gateway.createPlaybackCredential(media.videoId);
  } catch (error) {
    if (!(error instanceof AliyunVodGatewayError)) {
      throw externalServiceUnavailable("暂时无法创建阿里云 VOD 播放会话，请稍后重试。");
    }
    const details = error.requestId ? { requestId: error.requestId } : undefined;
    if (error.category === "not_found") {
      throw externalMediaUnavailable("未找到指定的阿里云 VOD 媒资。", details);
    }
    if (error.category === "permission_denied") {
      throw externalServiceUnavailable("服务器没有访问阿里云 VOD 媒资的权限。", details);
    }
    throw externalServiceUnavailable(
      "暂时无法创建阿里云 VOD 播放会话，请稍后重试。",
      details,
    );
  }
  if (credential.status !== "Normal" || credential.videoId !== media.videoId) {
    throw externalMediaUnavailable("阿里云 VOD 媒资当前不可播放。");
  }
  return {
    sourceType: "aliyun_vod",
    mediaKind: media.mediaKind,
    videoId: credential.videoId,
    region: media.region,
    playAuth: credential.playAuth,
    expiresAt: credential.expiresAt.toISOString(),
    webPlayerLicense,
  };
}
