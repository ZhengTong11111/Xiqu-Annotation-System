import type { AliyunVodPlaybackSession, AnnotationMediaReference } from "@xiqu/shared";
import type { MediaPlaybackSource } from "../media/mediaPlaybackController";

type BuildPlatformMediaPlaybackSourceInput = {
  media: AnnotationMediaReference | null | undefined;
  nativeUrl: string;
  requiresManualImport: boolean;
  loadAliyunVodSession: (resourceId: string) => Promise<AliyunVodPlaybackSession>;
};

/**
 * 把持久资源引用转换成编辑器运行时播放来源。
 * uploaded 与本机 Blob URL 共用浏览器原生播放；VOD 只保留稳定 id，并延迟获取内存中的短时 playauth。
 */
export function buildPlatformMediaPlaybackSource(
  input: BuildPlatformMediaPlaybackSourceInput,
): MediaPlaybackSource {
  if (input.media?.sourceType === "aliyun_vod") {
    const resourceId = input.media.resourceId;
    return {
      type: "aliyun_vod",
      resourceId,
      expectedVideoId: input.media.videoId,
      loadSession: () => input.loadAliyunVodSession(resourceId),
    };
  }
  if (input.nativeUrl) return { type: "native", url: input.nativeUrl };
  return {
    type: "unavailable",
    message: input.requiresManualImport
      ? "当前标注文件需要重新关联本机、服务器或阿里云 VOD 媒体。"
      : "当前标注文件尚未关联可播放媒体。",
  };
}
