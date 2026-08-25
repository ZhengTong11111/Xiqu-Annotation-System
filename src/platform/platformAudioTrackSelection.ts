import type {
  AnnotationAudioPlaybackOptions,
  AnnotationAudioPlaybackTrackOption,
  MediaAudioTrackAvailability,
  MediaAudioTrackKind,
} from "@xiqu/shared";

export function findOriginalAudioTrack(
  options: AnnotationAudioPlaybackOptions,
) {
  return options.tracks.find(({ track }) => track.kind === "original") ?? null;
}

// 首次打开遵循共享默认；null 默认明确映射为该主媒体唯一原声，而不是数组第一项。
export function resolveInitialAudioTrackId(
  options: AnnotationAudioPlaybackOptions,
) {
  return options.defaultAudioTrackId ?? findOriginalAudioTrack(options)?.track.id ?? null;
}

// 刷新权限或列表时保留用户当前意图；即使音轨刚被删除，也交给 unavailable 状态明确阻断而不暗中回原声。
export function resolveRefreshedAudioTrackId(
  options: AnnotationAudioPlaybackOptions,
  currentTrackId: string | null,
) {
  return currentTrackId ?? resolveInitialAudioTrackId(options);
}

export function findAudioTrackOption(
  options: AnnotationAudioPlaybackOptions | null,
  trackId: string | null,
) {
  if (!options || !trackId) return null;
  return options.tracks.find(({ track }) => track.id === trackId) ?? null;
}

export function getAudioTrackKindLabel(kind: MediaAudioTrackKind) {
  if (kind === "original") return "视频原声";
  if (kind === "vocal") return "人声";
  if (kind === "accompaniment") return "伴奏";
  if (kind === "denoised") return "降噪";
  if (kind === "reference") return "参考";
  return "自定义";
}

export function getAudioTrackSourceLabel(option: AnnotationAudioPlaybackTrackOption) {
  if (option.track.source.type === "embedded_original") return "主媒体内嵌";
  return option.track.source.sourceType === "uploaded" ? "平台音频" : "阿里云 VOD";
}

export function getAudioTrackAvailabilityLabel(
  availability: MediaAudioTrackAvailability,
) {
  if (availability === "available") return "可试听";
  if (availability === "disabled") return "音轨已停用";
  if (availability === "permission_denied") return "缺少读取或下载权限";
  if (availability === "source_unavailable") return "音频资源当前不可用";
  return "音频来源配置异常";
}
