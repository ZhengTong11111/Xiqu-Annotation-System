/**
 * 时间轴的高信息密度辅助层默认保持关闭，由用户按当前工作需要主动开启。
 * 这些值只属于编辑器会话视图，不进入项目 JSON、撤销历史或服务器同步状态。
 */
export type TimelineLayerVisibility = {
  banyanTrack: boolean;
  banyanGrid: boolean;
  waveform: boolean;
  spectrogram: boolean;
};

export const defaultTimelineLayerVisibility: Readonly<TimelineLayerVisibility> = Object.freeze({
  banyanTrack: false,
  banyanGrid: false,
  waveform: false,
  spectrogram: false,
});
