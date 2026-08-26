import type { AnnotationAudioPlaybackOptions } from "@xiqu/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { findAudioTrackOption } from "./platformAudioTrackSelection";
import {
  INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION,
  resolvePlatformAnalysisTrackId,
  updatePlatformAnalysisTrackFollowMode,
  updatePlatformFixedAnalysisTrack,
  type PlatformAnalysisTrackSelectionState,
} from "./platformAnalysisTrackSelection";

type Options = {
  sessionKey: string | null;
  listeningTrackId: string | null;
  playbackOptions: AnnotationAudioPlaybackOptions | null;
};

type SessionState = {
  sessionKey: string | null;
  selection: PlatformAnalysisTrackSelectionState;
};

/**
 * 分析音轨选择只属于当前编辑器会话，不写标注文档或平台默认值。
 * state 带 sessionKey，保证文件切换后的首帧也不会使用上一文件的固定音轨。
 */
export function usePlatformAnalysisTrackSelection(options: Options) {
  const [sessionState, setSessionState] = useState<SessionState>(() => ({
    sessionKey: options.sessionKey,
    selection: INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION,
  }));
  const selection = sessionState.sessionKey === options.sessionKey
    ? sessionState.selection
    : INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION;

  useEffect(() => {
    setSessionState((current) => current.sessionKey === options.sessionKey
      ? current
      : {
          sessionKey: options.sessionKey,
          selection: INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION,
        });
  }, [options.sessionKey]);

  const analysisTrackId = resolvePlatformAnalysisTrackId(
    selection,
    options.listeningTrackId,
  );
  const analysisTrackOption = useMemo(
    () => findAudioTrackOption(options.playbackOptions, analysisTrackId),
    [analysisTrackId, options.playbackOptions],
  );

  const setFollowListening = useCallback((followListening: boolean) => {
    setSessionState((current) => {
      if (current.sessionKey !== options.sessionKey) {
        return {
          sessionKey: options.sessionKey,
          selection: updatePlatformAnalysisTrackFollowMode(
            INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION,
            followListening,
            options.listeningTrackId,
          ),
        };
      }
      return {
        ...current,
        selection: updatePlatformAnalysisTrackFollowMode(
          current.selection,
          followListening,
          options.listeningTrackId,
        ),
      };
    });
  }, [options.listeningTrackId, options.sessionKey]);

  const selectFixedTrack = useCallback((trackId: string) => {
    setSessionState((current) => {
      const currentSelection = current.sessionKey === options.sessionKey
        ? current.selection
        : INITIAL_PLATFORM_ANALYSIS_TRACK_SELECTION;
      const nextSelection = updatePlatformFixedAnalysisTrack(
        currentSelection,
        trackId,
        options.playbackOptions,
      );
      if (current.sessionKey === options.sessionKey && nextSelection === currentSelection) {
        return current;
      }
      // 选择发生时再读取最新会话状态，避免快速切换文件时由旧渲染闭包覆盖新文件的初始选择。
      return {
        sessionKey: options.sessionKey,
        selection: nextSelection,
      };
    });
  }, [options.playbackOptions, options.sessionKey]);

  return {
    followListening: selection.followListening,
    fixedTrackId: selection.fixedTrackId,
    analysisTrackId,
    analysisTrackOption,
    setFollowListening,
    selectFixedTrack,
  };
}
