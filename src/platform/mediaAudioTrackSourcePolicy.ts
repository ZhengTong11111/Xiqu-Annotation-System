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
