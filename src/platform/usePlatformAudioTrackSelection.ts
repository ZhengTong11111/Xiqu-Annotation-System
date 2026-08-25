import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AnnotationAudioPlaybackOptions } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import {
  ORIGINAL_AUDIO_SELECTION,
  type SynchronizedAudioSelection,
} from "../media/synchronizedMediaPlaybackRuntime";
import {
  INITIAL_SYNCHRONIZED_PLAYBACK_STATE,
  type SynchronizedPlaybackState,
} from "../media/synchronizedPlaybackState";
import { buildPlatformExternalAudioPlaybackSource } from "./platformMediaAudioPlaybackSource";
import {
  findAudioTrackOption,
  findOriginalAudioTrack,
  resolveInitialAudioTrackId,
  resolveRefreshedAudioTrackId,
} from "./platformAudioTrackSelection";

type UsePlatformAudioTrackSelectionOptions = {
  client: PlatformClient | null;
  annotationFileId: string | null;
  primaryMediaResourceId: string | null;
  canWrite: boolean;
  enabled: boolean;
};

type LoadMode = "initial" | "refresh";

/**
 * 文件会话级试听选择与共享默认在此分离：选择只活在 React 内存，只有显式设默认才写平台 API。
 */
export function usePlatformAudioTrackSelection(
  input: UsePlatformAudioTrackSelectionOptions,
) {
  const sessionKey = input.enabled && input.client && input.annotationFileId &&
    input.primaryMediaResourceId
    ? `${input.annotationFileId}:${input.primaryMediaResourceId}`
    : null;
  const [options, setOptions] = useState<AnnotationAudioPlaybackOptions | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [defaultUpdatingTrackId, setDefaultUpdatingTrackId] = useState<string | null>(null);
  const [defaultUpdateError, setDefaultUpdateError] = useState<string | null>(null);
  const [runtimeState, setRuntimeState] = useState<SynchronizedPlaybackState>({
    ...INITIAL_SYNCHRONIZED_PLAYBACK_STATE,
  });
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const selectedTrackIdRef = useRef(selectedTrackId);
  const optionsRef = useRef(options);
  const sessionKeyRef = useRef(sessionKey);
  const sourceCacheRef = useRef<{
    key: string;
    selection: SynchronizedAudioSelection;
  } | null>(null);

  selectedTrackIdRef.current = selectedTrackId;
  optionsRef.current = options;
  sessionKeyRef.current = sessionKey;

  const loadOptions = useCallback(async (mode: LoadMode) => {
    if (
      !sessionKey ||
      !input.client ||
      !input.annotationFileId ||
      !input.primaryMediaResourceId
    ) return;
    const requestGeneration = ++requestGenerationRef.current;
    requestAbortRef.current?.abort();
    const abortController = new AbortController();
    requestAbortRef.current = abortController;
    if (mode === "initial") {
      setLoading(true);
      setOptions(null);
      setSelectedTrackId(null);
      sourceCacheRef.current = null;
    } else {
      setRefreshing(true);
    }
    setLoadError(null);
    try {
      const nextOptions = await input.client.getAnnotationAudioPlaybackOptions(
        input.annotationFileId,
        abortController.signal,
      );
      if (
        abortController.signal.aborted ||
        requestGeneration !== requestGenerationRef.current ||
        sessionKeyRef.current !== sessionKey
      ) return;
      if (
        nextOptions.annotationFileId !== input.annotationFileId ||
        nextOptions.primaryMediaResourceId !== input.primaryMediaResourceId
      ) {
        throw new Error("服务器音轨选项与当前文件不匹配。");
      }
      const previousSelection = mode === "refresh" ? selectedTrackIdRef.current : null;
      setOptions(nextOptions);
      setSelectedTrackId(mode === "refresh"
        ? resolveRefreshedAudioTrackId(nextOptions, previousSelection)
        : resolveInitialAudioTrackId(nextOptions));
    } catch (error) {
      if (abortController.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : "读取监听音轨失败。");
    } finally {
      if (requestGeneration === requestGenerationRef.current) {
        setLoading(false);
        setRefreshing(false);
        if (requestAbortRef.current === abortController) requestAbortRef.current = null;
      }
    }
  }, [
    input.annotationFileId,
    input.client,
    input.primaryMediaResourceId,
    sessionKey,
  ]);

  useEffect(() => {
    setRuntimeState({ ...INITIAL_SYNCHRONIZED_PLAYBACK_STATE });
    setRuntimeError(null);
    setDefaultUpdatingTrackId(null);
    setDefaultUpdateError(null);
    if (!sessionKey) {
      setOptions(null);
      setSelectedTrackId(null);
      setLoading(false);
      setRefreshing(false);
      sourceCacheRef.current = null;
      return;
    }
    void loadOptions("initial");
    return () => {
      requestGenerationRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, [loadOptions, sessionKey]);

  const selectedOption = findAudioTrackOption(options, selectedTrackId);
  const originalOption = options ? findOriginalAudioTrack(options) : null;

  const audioSelection = useMemo<SynchronizedAudioSelection>(() => {
    if (!sessionKey) return ORIGINAL_AUDIO_SELECTION;
    if (!options) {
      return { type: "blocked", errorCode: loadError ? "options_failed" : "options_loading" };
    }
    if (!selectedTrackId || !selectedOption) {
      return selectedTrackId
        ? { type: "unavailable", trackId: selectedTrackId, errorCode: "selected_track_missing" }
        : { type: "blocked", errorCode: "selection_missing" };
    }
    if (selectedOption.availability !== "available") {
      return {
        type: "unavailable",
        trackId: selectedTrackId,
        errorCode: selectedOption.availability,
      };
    }
    if (selectedOption.track.kind === "original") return ORIGINAL_AUDIO_SELECTION;
    if (!input.client || !input.annotationFileId || !input.primaryMediaResourceId) {
      return { type: "blocked", errorCode: "session_missing" };
    }
    const sourceKey = [
      sessionKey,
      selectedOption.track.id,
      selectedOption.track.source.type === "embedded_original"
        ? "embedded"
        : selectedOption.track.source.mediaResourceId,
      selectedOption.track.source.sourceType,
      selectedOption.track.source.type === "aliyun_vod_rendition"
        ? selectedOption.track.source.rendition.jobId
        : "",
      selectedOption.track.offsetSeconds,
      retryGeneration,
    ].join(":");
    if (sourceCacheRef.current?.key === sourceKey) {
      return sourceCacheRef.current.selection;
    }
    const source = buildPlatformExternalAudioPlaybackSource({
      annotationFileId: input.annotationFileId,
      primaryMediaResourceId: input.primaryMediaResourceId,
      track: selectedOption.track,
      client: input.client,
    });
    const selection: SynchronizedAudioSelection = source
      ? { type: "external", source }
      : {
          type: "unavailable",
          trackId: selectedTrackId,
          errorCode: "invalid_source",
        };
    sourceCacheRef.current = { key: sourceKey, selection };
    return selection;
  }, [
    input.annotationFileId,
    input.client,
    input.primaryMediaResourceId,
    loadError,
    options,
    retryGeneration,
    selectedOption,
    selectedTrackId,
    sessionKey,
  ]);

  const selectTrack = useCallback((trackId: string) => {
    const option = findAudioTrackOption(optionsRef.current, trackId);
    if (!option || option.availability !== "available") return false;
    selectedTrackIdRef.current = trackId;
    setSelectedTrackId(trackId);
    setRuntimeError(null);
    setRetryGeneration((value) => value + 1);
    return true;
  }, []);

  const retry = useCallback(() => {
    const option = findAudioTrackOption(optionsRef.current, selectedTrackIdRef.current);
    if (!option || option.availability !== "available") {
      void loadOptions("refresh");
      return;
    }
    setRuntimeError(null);
    setRetryGeneration((value) => value + 1);
  }, [loadOptions]);

  const setAsDefault = useCallback(async (trackId: string) => {
    if (
      !input.canWrite ||
      !input.client ||
      !input.annotationFileId ||
      !sessionKey
    ) return false;
    const option = findAudioTrackOption(optionsRef.current, trackId);
    if (!option) return false;
    const requestSessionKey = sessionKey;
    setDefaultUpdatingTrackId(trackId);
    setDefaultUpdateError(null);
    try {
      const preference = await input.client.updateAnnotationAudioPreference(
        input.annotationFileId,
        {
          defaultAudioTrackId: option.track.kind === "original" ? null : trackId,
        },
      );
      if (sessionKeyRef.current !== requestSessionKey) return false;
      setOptions((current) => current
        ? { ...current, defaultAudioTrackId: preference.defaultAudioTrackId }
        : current);
      return true;
    } catch (error) {
      if (sessionKeyRef.current === requestSessionKey) {
        setDefaultUpdateError(
          error instanceof Error ? error.message : "设置共享默认音轨失败。",
        );
      }
      return false;
    } finally {
      if (sessionKeyRef.current === requestSessionKey) setDefaultUpdatingTrackId(null);
    }
  }, [input.annotationFileId, input.canWrite, input.client, sessionKey]);

  return {
    active: Boolean(sessionKey),
    options,
    selectedTrackId,
    selectedOption,
    originalTrackId: originalOption?.track.id ?? null,
    audioSelection,
    loading,
    refreshing,
    loadError,
    defaultUpdatingTrackId,
    defaultUpdateError,
    runtimeState,
    runtimeError,
    canSetDefault: input.canWrite,
    canManageTracks: options?.canManageTracks ?? false,
    selectTrack,
    retry,
    refresh: () => loadOptions("refresh"),
    setAsDefault,
    onRuntimeStateChange: setRuntimeState,
    onRuntimeError: setRuntimeError,
  };
}
