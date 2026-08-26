import type { AnnotationAudioPlaybackOptions } from "@xiqu/shared";
import { findAudioTrackOption } from "./platformAudioTrackSelection";

export type PlatformAnalysisTrackSelectionState = {
  followListening: boolean;
  fixedTrackId: string | null;
};

export const INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION: PlatformAnalysisTrackSelectionState = {
  followListening: true,
  fixedTrackId: null,
};

// 跟随模式只读取当前监听意图；固定项即使已经失效也保留身份，不能暗中回退到原声。
export function resolvePlatformAnalysisTrackId(
  state: PlatformAnalysisTrackSelectionState,
  listeningTrackId: string | null,
) {
  return state.followListening ? listeningTrackId : state.fixedTrackId;
}

export function updatePlatformAnalysisTrackFollowMode(
  state: PlatformAnalysisTrackSelectionState,
  followListening: boolean,
  listeningTrackId: string | null,
): PlatformAnalysisTrackSelectionState {
  if (followListening) return { ...state, followListening: true };
  if (!state.followListening) return state;
  // 关闭跟随时冻结这一刻的监听轨，避免跳回早先选择过的固定值。
  return {
    followListening: false,
    fixedTrackId: listeningTrackId,
  };
}

export function updatePlatformFixedAnalysisTrack(
  state: PlatformAnalysisTrackSelectionState,
  trackId: string,
  options: AnnotationAudioPlaybackOptions | null,
) {
  const option = findAudioTrackOption(options, trackId);
  if (!option || option.availability !== "available") return state;
  return {
    followListening: false,
    fixedTrackId: trackId,
  } satisfies PlatformAnalysisTrackSelectionState;
}
