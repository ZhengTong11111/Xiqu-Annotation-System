import type { ResourceEntry } from "@xiqu/shared";

/**
 * 可持久监听音轨必须引用真正的纯音频资源。视频临时产生的分析 mp3 没有稳定资源身份，
 * 因此不能因为来源同为 VOD 就越过这里的媒体类型门禁。
 */
export function isMediaAudioTrackSource(
  resource: Pick<ResourceEntry, "type" | "mediaKind">,
) {
  return resource.type === "media_file" && resource.mediaKind === "audio";
}

/**
 * 阿里云会把部分上传的 MP3 媒资标记为 video，但其 MP3 rendition 仍可作为监听音轨。
 * 这里仅选择稳定 VOD 媒资容器，真实转码与 JobId 仍由后续服务端查询确认。
 */
export function isAliyunVodAudioRenditionSource(
  resource: Pick<
    ResourceEntry,
    "type" | "mediaKind" | "mediaSourceType"
  >,
) {
  return resource.type === "media_file" &&
    resource.mediaKind === "video" &&
    resource.mediaSourceType === "aliyun_vod";
}

/**
 * 监听音轨资源选择器统一展示纯音频文件与可继续选择 MP3 rendition 的 VOD 视频。
 * 这里只决定目录可见性；确认后仍必须按具体来源进入各自严格的服务端校验流程。
 */
export function isSelectableMediaAudioTrackSource(
  resource: Pick<
    ResourceEntry,
    "type" | "mediaKind" | "mediaSourceType"
  >,
) {
  return isMediaAudioTrackSource(resource) ||
    isAliyunVodAudioRenditionSource(resource);
}
