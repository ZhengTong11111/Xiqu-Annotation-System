import {
  decodeFloat32LittleEndian,
  decodeMediaAnalysisTile,
  decodeMediaAnalysisTileBatch,
  type AnnotationMediaAnalysisStatus,
  type MediaAnalysisAssetDescriptor,
  type UpdateAnalysisAudioRequest,
} from "@xiqu/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlatformClient } from "../api/platformClient";
import type { SpectrogramAnalysisPreset, SpectrogramData, WaveformData } from "../types";
import {
  abortPlatformAnalysisBatches,
  buildAdjacentPlatformAnalysisWindows,
  buildPlatformAnalysisRequestWindow,
  cancelPlatformAnalysisBatchesOutsideViewport,
  partitionMediaAnalysisAssetBatches,
  PlatformMediaAnalysisAssetCache,
  selectContiguousLoadedAnalysisAssetsAroundVisible,
  type PlatformAnalysisRequestWindow,
  type PlatformMediaAnalysisBatchRegistry,
  type PlatformAnalysisViewport,
} from "./platformMediaAnalysisLoading";
import {
  platformMediaAnalysisPersistentCache,
  type PlatformMediaAnalysisPersistentCache,
} from "./platformMediaAnalysisCache";

const STATUS_POLL_INTERVAL_MS = 2_000;
const VIEWPORT_LOAD_DEBOUNCE_MS = 250;
const VIEWPORT_SETTLE_PREFETCH_MS = 800;
const ANALYSIS_BATCH_CANCEL_MARGIN_SECONDS = 60;
const MAX_CONCURRENT_ASSET_BATCHES = 2;
const PROGRESSIVE_BATCH_BYTES = 2 * 1024 * 1024;
const BACKGROUND_BATCH_BYTES = 16 * 1024 * 1024;
const COMPLETE_LIST_WINDOW_SECONDS = 30 * 180;

export type { PlatformAnalysisViewport } from "./platformMediaAnalysisLoading";

type Options = {
  client: PlatformClient | null;
  currentUserId: string | null;
  annotationFileId: string | null;
  enabled: boolean;
  canWrite: boolean;
  viewport: PlatformAnalysisViewport | null;
  spectrogramVisible: boolean;
  analysisPreset: SpectrogramAnalysisPreset;
  showPitch: boolean;
};

/**
 * 平台分析状态独立于 ProjectData：负责轮询、来源 mutation、按窗瓦片请求、取消和有界内存缓存。
 * 文件切换通过 generation 丢弃迟到响应，旧 run 的瓦片不能复活到新来源。
 */
export function usePlatformMediaAnalysis(options: Options) {
  const [status, setStatus] = useState<AnnotationMediaAnalysisStatus | null>(null);
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  const [spectrogramData, setSpectrogramData] = useState<SpectrogramData | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [preloadPending, setPreloadPending] = useState(false);
  const [preloadProgress, setPreloadProgress] = useState<{ completed: number; total: number } | null>(null);
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const cacheRef = useRef(new PlatformMediaAnalysisAssetCache());
  const inFlightAssetsRef = useRef(new Map<string, Promise<Uint8Array>>());
  const batchRegistryRef = useRef<PlatformMediaAnalysisBatchRegistry>(new Map());
  const assetSessionAbortControllerRef = useRef(new AbortController());
  const preloadAbortControllerRef = useRef<AbortController | null>(null);
  const preloadAssetIdsRef = useRef(new Set<string>());
  const assetSessionKeyRef = useRef<string | null>(null);
  const viewportLoadIdRef = useRef(0);
  const previousViewportStartRef = useRef<number | null>(null);
  const statusRefreshInFlightRef = useRef<Promise<AnnotationMediaAnalysisStatus | null> | null>(null);

  const resetAssetSession = useCallback(() => {
    abortPlatformAnalysisBatches(batchRegistryRef.current);
    assetSessionAbortControllerRef.current.abort();
    preloadAbortControllerRef.current?.abort();
    preloadAbortControllerRef.current = null;
    preloadAssetIdsRef.current.clear();
    previousViewportStartRef.current = null;
    assetSessionAbortControllerRef.current = new AbortController();
    inFlightAssetsRef.current.clear();
    batchRegistryRef.current.clear();
    cacheRef.current.clear();
    viewportLoadIdRef.current += 1;
    setPreloadProgress(null);
    setPreloadPending(false);
    setPreloadError(null);
  }, []);

  const refresh = useCallback(() => {
    if (!options.enabled || !options.client || !options.annotationFileId) return null;
    if (statusRefreshInFlightRef.current) return statusRefreshInFlightRef.current;
    const generation = generationRef.current;
    setStatusLoading(true);
    const request = options.client.getAnnotationMediaAnalysis(options.annotationFileId)
      .then((next) => {
        if (generation !== generationRef.current) return null;
        setStatus(next);
        setError(null);
        return next;
      })
      .catch((nextError: unknown) => {
        if (generation === generationRef.current) setError(describeError(nextError));
        return null;
      })
      .finally(() => {
        // 文件切换会把 ref 指向新请求；旧请求结束时不能清掉新会话的单飞门禁。
        if (statusRefreshInFlightRef.current === request) {
          statusRefreshInFlightRef.current = null;
        }
        if (generation === generationRef.current) setStatusLoading(false);
      });
    statusRefreshInFlightRef.current = request;
    return request;
  }, [options.annotationFileId, options.client, options.enabled]);

  useEffect(() => {
    generationRef.current += 1;
    statusRefreshInFlightRef.current = null;
    assetSessionKeyRef.current = null;
    resetAssetSession();
    setStatus(null);
    setWaveformData(null);
    setSpectrogramData(null);
    setError(null);
    if (options.enabled) void refresh();
  }, [options.annotationFileId, options.currentUserId, options.enabled, refresh, resetAssetSession]);

  useEffect(() => {
    if (status?.currentRun?.status !== "queued" && status?.currentRun?.status !== "running") {
      return;
    }
    // 定时器不能依赖服务端 updatedAt 续接：一次无变化响应也必须继续轮询后续心跳和最终状态。
    const timer = window.setInterval(() => void refresh(), STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, status?.currentRun?.status]);

  const currentRun = status?.currentRun;
  const assetSessionKey = currentRun
    ? `${options.currentUserId ?? ""}:${options.annotationFileId ?? ""}:${currentRun.id}:${currentRun.completedAt ?? "pending"}`
    : null;
  useEffect(() => {
    if (assetSessionKeyRef.current === assetSessionKey) return;
    assetSessionKeyRef.current = assetSessionKey;
    resetAssetSession();
    setWaveformData(null);
    setSpectrogramData(null);
  }, [assetSessionKey, resetAssetSession]);

  const requestWindow = options.viewport && currentRun
    ? buildPlatformAnalysisRequestWindow(
        options.viewport,
        currentRun.sourceOffsetSeconds,
        currentRun.tileDurationSeconds,
      )
    : null;

  useEffect(() => {
    const client = options.client;
    const currentUserId = options.currentUserId;
    const annotationFileId = options.annotationFileId;
    const run = status?.currentRun;
    if (
      !options.enabled ||
      !client ||
      !currentUserId ||
      !annotationFileId ||
      !requestWindow ||
      run?.status !== "succeeded"
    ) {
      setWaveformData(null);
      setSpectrogramData(null);
      setAssetsLoading(false);
      return;
    }

    const generation = generationRef.current;
    const viewportLoadId = viewportLoadIdRef.current + 1;
    viewportLoadIdRef.current = viewportLoadId;
    const listAbortController = new AbortController();
    let cancelled = false;
    let prefetchTimer: number | null = null;
    const sourceOffset = run.sourceOffsetSeconds;
    const viewportStartTime = options.viewport?.startTime ?? 0;
    const viewportEndTime = options.viewport?.endTime ?? viewportStartTime;
    const visibleSourceRange = {
      startTime: Math.max(0, viewportStartTime - sourceOffset),
      endTime: Math.max(
        Math.max(0, viewportStartTime - sourceOffset),
        viewportEndTime - sourceOffset,
      ),
    };
    const previousViewportStart = previousViewportStartRef.current;
    const prefetchDirection = previousViewportStart !== null &&
      requestWindow.startTime < previousViewportStart
      ? "backward"
      : "forward";
    previousViewportStartRef.current = requestWindow.startTime;
    // 新视口建立时按时间范围清理旧批次；主动预加载资产由保护集合保留。
    cancelPlatformAnalysisBatchesOutsideViewport(
      batchRegistryRef.current,
      visibleSourceRange,
      preloadAssetIdsRef.current,
      ANALYSIS_BATCH_CANCEL_MARGIN_SECONDS,
    );
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setAssetsLoading(true);
      void loadVisibleAnalysisWindow({
        client,
        currentUserId,
        annotationFileId,
        runId: run.id,
        sourceOffset,
        requestWindow,
        visibleStartTime: visibleSourceRange.startTime,
        visibleEndTime: visibleSourceRange.endTime,
        prefetchDirection,
        spectrogramVisible: options.spectrogramVisible,
        analysisPreset: options.analysisPreset,
        showPitch: options.showPitch,
        listSignal: listAbortController.signal,
        assetSignal: assetSessionAbortControllerRef.current.signal,
        cache: cacheRef.current,
        inFlight: inFlightAssetsRef.current,
        batchRegistry: batchRegistryRef.current,
        protectedAssetIds: preloadAssetIdsRef.current,
        isCurrent: () => !cancelled &&
          generation === generationRef.current &&
          viewportLoadIdRef.current === viewportLoadId,
        onWaveform: setWaveformData,
        onSpectrogram: setSpectrogramData,
      }).then(() => {
        if (
          cancelled ||
          generation !== generationRef.current ||
          viewportLoadIdRef.current !== viewportLoadId
        ) return;
        setError(null);
        // 可视区稳定后再预取，避免用户快速拖动时反复启动和取消低优先级请求。
        prefetchTimer = window.setTimeout(() => {
          if (cancelled) return;
          void prefetchAdjacentAnalysisWindows({
            client,
            currentUserId,
            annotationFileId,
            runId: run.id,
            requestWindow,
            visibleStartTime: visibleSourceRange.startTime,
            visibleEndTime: visibleSourceRange.endTime,
            prefetchDirection,
            spectrogramVisible: options.spectrogramVisible,
            analysisPreset: options.analysisPreset,
            showPitch: options.showPitch,
            listSignal: listAbortController.signal,
            assetSignal: assetSessionAbortControllerRef.current.signal,
            cache: cacheRef.current,
            inFlight: inFlightAssetsRef.current,
            batchRegistry: batchRegistryRef.current,
            isCurrent: () => !cancelled &&
              generation === generationRef.current &&
              viewportLoadIdRef.current === viewportLoadId,
          }).catch((prefetchError) => {
            if (!isAbortError(prefetchError)) {
              console.warn("相邻分析窗口预取失败", prefetchError);
            }
          });
        }, VIEWPORT_SETTLE_PREFETCH_MS);
      }).catch((nextError: unknown) => {
        if (cancelled || generation !== generationRef.current || isAbortError(nextError)) return;
        setError(describeError(nextError));
      }).finally(() => {
        if (
          !cancelled &&
          generation === generationRef.current &&
          viewportLoadIdRef.current === viewportLoadId
        ) setAssetsLoading(false);
      });
    }, VIEWPORT_LOAD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
      listAbortController.abort();
    };
  }, [
    options.analysisPreset,
    options.annotationFileId,
    options.client,
    options.currentUserId,
    options.enabled,
    options.showPitch,
    options.spectrogramVisible,
    requestWindow?.endTime,
    requestWindow?.startTime,
    requestWindow?.waveformLevel,
    currentRun?.id,
    currentRun?.sourceOffsetSeconds,
    currentRun?.status,
  ]);

  useEffect(() => {
    // 预加载绑定的是波形层级、频谱预设和 F0 开关；这些设置变化后，旧任务的结果不再代表当前配置。
    // 取消只影响预加载自己的控制器，已落入内存/IndexedDB 的资产仍可按新配置自然复用。
    preloadAbortControllerRef.current?.abort();
  }, [options.analysisPreset, options.showPitch, options.spectrogramVisible, requestWindow?.waveformLevel]);

  const updateSource = useCallback(async (request: UpdateAnalysisAudioRequest) => {
    if (!options.client || !options.annotationFileId || !options.canWrite) return false;
    const generation = generationRef.current;
    const annotationFileId = options.annotationFileId;
    setMutationPending(true);
    try {
      const next = await options.client.updateAnalysisAudio(annotationFileId, request);
      if (generation !== generationRef.current) return false;
      generationRef.current += 1;
      statusRefreshInFlightRef.current = null;
      assetSessionKeyRef.current = null;
      resetAssetSession();
      setStatus(next);
      setWaveformData(null);
      setSpectrogramData(null);
      setError(null);
      // 成功保存会主动推进 generation；因此在推进后的 finally 之外结束本次 mutation 状态。
      setMutationPending(false);
      return true;
    } catch (nextError) {
      if (generation === generationRef.current) setError(describeError(nextError));
      return false;
    } finally {
      if (generation === generationRef.current) setMutationPending(false);
    }
  }, [options.annotationFileId, options.canWrite, options.client, resetAssetSession]);

  const startAnalysis = useCallback(async (force = false) => {
    if (!options.client || !options.annotationFileId || !options.canWrite) return false;
    const generation = generationRef.current;
    const annotationFileId = options.annotationFileId;
    setMutationPending(true);
    try {
      const run = await options.client.createMediaAnalysis(
        annotationFileId,
        { force },
      );
      if (generation !== generationRef.current) return false;
      const latest = await options.client.getAnnotationMediaAnalysis(annotationFileId);
      if (generation !== generationRef.current) return false;
      setStatus({ ...latest, currentRun: run });
      setError(null);
      return true;
    } catch (nextError) {
      if (generation === generationRef.current) setError(describeError(nextError));
      return false;
    } finally {
      if (generation === generationRef.current) setMutationPending(false);
    }
  }, [options.annotationFileId, options.canWrite, options.client]);

  /**
   * 用户主动预加载当前分析配置；它与可视窗口共用缓存和在途请求，但使用独立控制器，
   * 因而既不会阻塞当前播放，也可以在设置变化或用户点击停止时安全退出。
   */
  const startPreload = useCallback(async () => {
    const client = options.client;
    const currentUserId = options.currentUserId;
    const annotationFileId = options.annotationFileId;
    const run = status?.currentRun;
    if (
      !client ||
      !currentUserId ||
      !annotationFileId ||
      run?.status !== "succeeded" ||
      !run.duration ||
      run.duration <= 0 ||
      preloadAbortControllerRef.current
    ) return false;

    const generation = generationRef.current;
    const controller = new AbortController();
    preloadAbortControllerRef.current = controller;
    setPreloadPending(true);
    setPreloadProgress({ completed: 0, total: 0 });
    setPreloadError(null);
    const completedAssetIds = new Set<string>();
    try {
      const lists = await listCompleteAnalysisAssets({
        client,
        annotationFileId,
        runId: run.id,
        duration: run.duration,
        tileDurationSeconds: run.tileDurationSeconds,
        waveformLevel: requestWindow?.waveformLevel ?? 3,
        spectrogramVisible: options.spectrogramVisible,
        analysisPreset: options.analysisPreset,
        showPitch: options.showPitch,
        listSignal: controller.signal,
      });
      if (generation !== generationRef.current || controller.signal.aborted) return false;
      const descriptors = [...lists.waveform, ...lists.spectrogram, ...lists.pitch];
      preloadAssetIdsRef.current = new Set(descriptors.map(({ id }) => id));
      setPreloadProgress({ completed: 0, total: descriptors.length });
      await loadAnalysisAssets({
        currentUserId,
        annotationFileId,
        runId: run.id,
        descriptors,
        client,
        cache: cacheRef.current,
        persistentCache: platformMediaAnalysisPersistentCache,
        inFlight: inFlightAssetsRef.current,
        batchRegistry: batchRegistryRef.current,
        signal: controller.signal,
        maxConcurrentBatches: 1,
        maxBatchBytes: BACKGROUND_BATCH_BYTES,
        onPersistentCacheError: reportPersistentCacheError,
        onBatchLoaded: (batch, batchBytes) => {
          if (generation !== generationRef.current || controller.signal.aborted) return;
          for (const descriptor of batch) {
            if (batchBytes.has(descriptor.id)) completedAssetIds.add(descriptor.id);
          }
          setPreloadProgress({
            completed: completedAssetIds.size,
            total: descriptors.length,
          });
        },
      });
      if (generation !== generationRef.current || controller.signal.aborted) return false;
      setPreloadProgress({ completed: descriptors.length, total: descriptors.length });
      return true;
    } catch (preloadFailure) {
      if (!controller.signal.aborted && generation === generationRef.current) {
        setPreloadError(describeError(preloadFailure));
      }
      return false;
    } finally {
      if (preloadAbortControllerRef.current === controller) {
        preloadAbortControllerRef.current = null;
        preloadAssetIdsRef.current.clear();
        setPreloadPending(false);
      }
    }
  }, [
    options.analysisPreset,
    options.annotationFileId,
    options.client,
    options.currentUserId,
    options.showPitch,
    options.spectrogramVisible,
    requestWindow?.waveformLevel,
    status?.currentRun,
  ]);

  const cancelPreload = useCallback(() => {
    preloadAbortControllerRef.current?.abort();
  }, []);

  return {
    status,
    waveformData,
    spectrogramData,
    statusLoading,
    assetsLoading,
    mutationPending,
    preloadPending,
    preloadProgress,
    preloadError,
    error,
    refresh,
    updateSource,
    startAnalysis,
    startPreload,
    cancelPreload,
  };
}

type AnalysisWindowAssetLists = {
  waveform: MediaAnalysisAssetDescriptor[];
  spectrogram: MediaAnalysisAssetDescriptor[];
  pitch: MediaAnalysisAssetDescriptor[];
};

type AnalysisWindowReadContext = {
  client: Pick<PlatformClient, "listMediaAnalysisAssets" | "getMediaAnalysisAssetBatch">;
  currentUserId: string;
  annotationFileId: string;
  runId: string;
  requestWindow: PlatformAnalysisRequestWindow;
  visibleStartTime: number;
  visibleEndTime: number;
  prefetchDirection: "forward" | "backward";
  spectrogramVisible: boolean;
  analysisPreset: SpectrogramAnalysisPreset;
  showPitch: boolean;
  listSignal: AbortSignal;
  assetSignal: AbortSignal;
  cache: PlatformMediaAnalysisAssetCache;
  inFlight: Map<string, Promise<Uint8Array>>;
  batchRegistry: PlatformMediaAnalysisBatchRegistry;
  isCurrent: () => boolean;
};

type VisibleAnalysisWindowContext = AnalysisWindowReadContext & {
  sourceOffset: number;
  protectedAssetIds: ReadonlySet<string>;
  onWaveform: (data: WaveformData | null) => void;
  onSpectrogram: (data: SpectrogramData | null) => void;
};

/**
 * 当前窗口只做一次 descriptor 汇总，再以波形、频谱、F0 的稳定顺序渐进下载。
 * 所有回调都复核 isCurrent，旧窗口即使晚到也不能覆盖用户最终停留位置。
 */
async function loadVisibleAnalysisWindow(context: VisibleAnalysisWindowContext) {
  const lists = await listAnalysisWindowAssets(context);
  if (!context.isCurrent()) return;
  const descriptors = [
    ...lists.waveform,
    ...lists.spectrogram,
    ...lists.pitch,
  ];
  const retainedAssetIds = new Set([
    ...descriptors.map(({ id }) => id),
    ...context.protectedAssetIds,
  ]);
  cancelPlatformAnalysisBatchesOutsideViewport(
    context.batchRegistry,
    { startTime: context.visibleStartTime, endTime: context.visibleEndTime },
    retainedAssetIds,
    ANALYSIS_BATCH_CANCEL_MARGIN_SECONDS,
  );

  const loadedBytes = new Map<string, Uint8Array>();
  // 每次只把当前已经到达的字节合并进局部快照；局部快照避免把后台预取资产误绘制到当前窗口。
  const commitProgress = (_batch: readonly MediaAnalysisAssetDescriptor[], batchBytes: ReadonlyMap<string, Uint8Array>) => {
    if (!context.isCurrent()) return;
    for (const [assetId, value] of batchBytes) loadedBytes.set(assetId, value);

    const waveformPrefix = selectContiguousLoadedAnalysisAssetsAroundVisible(
      lists.waveform,
      loadedBytes,
      context.visibleStartTime,
      context.visibleEndTime,
    );
    if (waveformPrefix.length > 0) {
      context.onWaveform(assemblePlatformWaveform(
        waveformPrefix,
        loadedBytes,
        context.sourceOffset,
      ));
    }
    if (!context.spectrogramVisible) {
      context.onSpectrogram(null);
      return;
    }
    const spectrogramPrefix = selectContiguousLoadedAnalysisAssetsAroundVisible(
      lists.spectrogram,
      loadedBytes,
      context.visibleStartTime,
      context.visibleEndTime,
    );
    if (spectrogramPrefix.length === 0) return;
    const pitchPrefix = selectContiguousLoadedAnalysisAssetsAroundVisible(
      lists.pitch,
      loadedBytes,
      context.visibleStartTime,
      context.visibleEndTime,
    );
    context.onSpectrogram(assemblePlatformSpectrogram(
      spectrogramPrefix,
      pitchPrefix,
      loadedBytes,
      context.analysisPreset,
      context.sourceOffset,
    ));
  };

  const bytes = await loadAnalysisAssets({
    currentUserId: context.currentUserId,
    annotationFileId: context.annotationFileId,
    runId: context.runId,
    descriptors,
    client: context.client,
    cache: context.cache,
    persistentCache: platformMediaAnalysisPersistentCache,
    inFlight: context.inFlight,
    batchRegistry: context.batchRegistry,
    signal: context.assetSignal,
    maxConcurrentBatches: MAX_CONCURRENT_ASSET_BATCHES,
    maxBatchBytes: PROGRESSIVE_BATCH_BYTES,
    onBatchLoaded: commitProgress,
    onPersistentCacheError: reportPersistentCacheError,
  });
  if (!context.isCurrent()) return;
  commitProgress(descriptors, bytes);
}

/**
 * 相邻窗口预取在当前窗口完成后串行执行，每次只放行一个网络批次。
 * 它不修改显示状态；新视口到来时会由可视请求取消不再相交的旧批次。
 */
async function prefetchAdjacentAnalysisWindows(context: AnalysisWindowReadContext) {
  const visibleDuration = Math.max(0.001, context.visibleEndTime - context.visibleStartTime);
  for (const requestWindow of buildAdjacentPlatformAnalysisWindows(
    context.requestWindow,
    visibleDuration,
    context.prefetchDirection,
  )) {
    if (!context.isCurrent()) return;
    const lists = await listAnalysisWindowAssets({ ...context, requestWindow });
    if (!context.isCurrent()) return;
    const descriptors = [...lists.waveform, ...lists.spectrogram, ...lists.pitch];
    await loadAnalysisAssets({
      currentUserId: context.currentUserId,
      annotationFileId: context.annotationFileId,
      runId: context.runId,
      descriptors,
      client: context.client,
      cache: context.cache,
      persistentCache: platformMediaAnalysisPersistentCache,
      inFlight: context.inFlight,
      batchRegistry: context.batchRegistry,
      signal: context.assetSignal,
      maxConcurrentBatches: 1,
      maxBatchBytes: BACKGROUND_BATCH_BYTES,
      onPersistentCacheError: reportPersistentCacheError,
    });
  }
}

/** 三类 descriptor 查询保持同一窗口和 run，调用方只处理完整快照。 */
async function listAnalysisWindowAssets(context: {
  client: Pick<PlatformClient, "listMediaAnalysisAssets">;
  annotationFileId: string;
  runId: string;
  requestWindow: PlatformAnalysisRequestWindow;
  spectrogramVisible: boolean;
  analysisPreset: SpectrogramAnalysisPreset;
  showPitch: boolean;
  listSignal: AbortSignal;
}) {
  const [waveform, spectrogram, pitch] = await Promise.all([
    context.client.listMediaAnalysisAssets(context.annotationFileId, {
      runId: context.runId,
      kind: "waveform",
      preset: "default",
      level: context.requestWindow.waveformLevel,
      startTime: context.requestWindow.startTime,
      endTime: context.requestWindow.endTime,
    }, context.listSignal),
    context.spectrogramVisible
      ? context.client.listMediaAnalysisAssets(context.annotationFileId, {
          runId: context.runId,
          kind: "spectrogram",
          preset: context.analysisPreset,
          level: 0,
          startTime: context.requestWindow.startTime,
          endTime: context.requestWindow.endTime,
        }, context.listSignal)
      : Promise.resolve({ runId: context.runId, assets: [] }),
    context.spectrogramVisible && context.showPitch
      ? context.client.listMediaAnalysisAssets(context.annotationFileId, {
          runId: context.runId,
          kind: "pitch",
          preset: "yin-v1",
          level: 0,
          startTime: context.requestWindow.startTime,
          endTime: context.requestWindow.endTime,
        }, context.listSignal)
      : Promise.resolve({ runId: context.runId, assets: [] }),
  ]);
  return {
    waveform: waveform.assets,
    spectrogram: spectrogram.assets,
    pitch: pitch.assets,
  } satisfies AnalysisWindowAssetLists;
}

/**
 * 完整预加载按有界时间窗口分段列目录，避开服务端单次 200 条上限。
 * 结果按 asset id 去重，边界重合或未来 tile 时长变化也不会形成重复下载。
 */
async function listCompleteAnalysisAssets(context: {
  client: Pick<PlatformClient, "listMediaAnalysisAssets">;
  annotationFileId: string;
  runId: string;
  duration: number;
  tileDurationSeconds: number;
  waveformLevel: number;
  spectrogramVisible: boolean;
  analysisPreset: SpectrogramAnalysisPreset;
  showPitch: boolean;
  listSignal: AbortSignal;
}) {
  const aggregate: AnalysisWindowAssetLists = {
    waveform: [],
    spectrogram: [],
    pitch: [],
  };
  for (let startTime = 0; startTime < context.duration; startTime += COMPLETE_LIST_WINDOW_SECONDS) {
    const lists = await listAnalysisWindowAssets({
      ...context,
      requestWindow: {
        startTime,
        endTime: Math.min(context.duration, startTime + COMPLETE_LIST_WINDOW_SECONDS),
        waveformLevel: context.waveformLevel,
        tileDurationSeconds: context.tileDurationSeconds,
      },
    });
    aggregate.waveform.push(...lists.waveform);
    aggregate.spectrogram.push(...lists.spectrogram);
    aggregate.pitch.push(...lists.pitch);
  }
  return {
    waveform: deduplicateAssetDescriptors(aggregate.waveform),
    spectrogram: deduplicateAssetDescriptors(aggregate.spectrogram),
    pitch: deduplicateAssetDescriptors(aggregate.pitch),
  } satisfies AnalysisWindowAssetLists;
}

function deduplicateAssetDescriptors(descriptors: MediaAnalysisAssetDescriptor[]) {
  return [...new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])).values()];
}

type LoadAnalysisAssetsOptions = {
  currentUserId: string;
  annotationFileId: string;
  runId: string;
  descriptors: MediaAnalysisAssetDescriptor[];
  client: Pick<PlatformClient, "getMediaAnalysisAssetBatch">;
  cache: PlatformMediaAnalysisAssetCache;
  persistentCache?: PlatformMediaAnalysisPersistentCache;
  inFlight: Map<string, Promise<Uint8Array>>;
  batchRegistry?: PlatformMediaAnalysisBatchRegistry;
  signal: AbortSignal;
  maxConcurrentBatches?: number;
  maxBatchBytes?: number;
  onBatchLoaded?: (
    descriptors: readonly MediaAnalysisAssetDescriptor[],
    bytes: ReadonlyMap<string, Uint8Array>,
  ) => void;
  onPersistentCacheError?: (error: unknown) => void;
};

/**
 * 加载顺序固定为内存、IndexedDB、进行中请求、网络；网络批次使用共享 registry 和有界 worker。
 * 每批完成立即回调，调用方可渐进绘制，不需要等待当前窗口全部字节。
 */
export async function loadAnalysisAssets(options: LoadAnalysisAssetsOptions) {
  const descriptorIds = new Set(options.descriptors.map(({ id }) => id));
  if (descriptorIds.size !== options.descriptors.length) {
    throw new Error("媒体分析资产列表包含重复项目。");
  }
  const bytes = new Map<string, Uint8Array>();
  const memoryHits = new Map<string, Uint8Array>();
  const pending: Promise<void>[] = [];
  const missing: MediaAnalysisAssetDescriptor[] = [];
  const persistentCandidates: MediaAnalysisAssetDescriptor[] = [];

  for (const descriptor of options.descriptors) {
    const cached = options.cache.get(descriptor.id);
    if (cached) {
      bytes.set(descriptor.id, cached);
      memoryHits.set(descriptor.id, cached);
      continue;
    }
    const existing = options.inFlight.get(descriptor.id);
    if (existing) {
      pending.push(existing.then((value) => {
        bytes.set(descriptor.id, value);
      }));
      continue;
    }
    if (options.persistentCache) persistentCandidates.push(descriptor);
    else missing.push(descriptor);
  }
  if (memoryHits.size > 0) {
    options.onBatchLoaded?.(
      options.descriptors.filter(({ id }) => memoryHits.has(id)),
      memoryHits,
    );
  }

  if (persistentCandidates.length > 0 && options.persistentCache) {
    const persistentHits = new Map<string, Uint8Array>();
    try {
      const stored = await options.persistentCache.getMany(
        persistentCandidates.map((descriptor) =>
          buildPersistentCacheIdentity(options, descriptor)),
      );
      for (const descriptor of persistentCandidates) {
        const value = stored.get(descriptor.id);
        if (!value) {
          missing.push(descriptor);
          continue;
        }
        options.cache.set(descriptor.id, value);
        bytes.set(descriptor.id, value);
        persistentHits.set(descriptor.id, value);
      }
    } catch (persistentError) {
      // 浏览器 quota/隐私模式故障只能降级到网络，不能阻断当前编辑器。
      options.onPersistentCacheError?.(persistentError);
      missing.push(...persistentCandidates);
    }
    if (persistentHits.size > 0) {
      options.onBatchLoaded?.(
        persistentCandidates.filter(({ id }) => persistentHits.has(id)),
        persistentHits,
      );
    }
  }

  // 先消费缓存和共享在途请求，再把真正缺失的资产切成有界批次，避免一次宽视口占满网络连接。
  const batches = partitionMediaAnalysisAssetBatches(missing, {
    maxBytes: options.maxBatchBytes,
  });
  let nextBatchIndex = 0;
  const batchRegistry = options.batchRegistry ?? new Map();
  const workerCount = Math.min(
    Math.max(1, options.maxConcurrentBatches ?? MAX_CONCURRENT_ASSET_BATCHES),
    batches.length,
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextBatchIndex < batches.length) {
      const batch = batches[nextBatchIndex];
      nextBatchIndex += 1;
      await loadAnalysisAssetBatch(options, batch, bytes, batchRegistry);
    }
  });

  await Promise.all([...pending, ...workers]);
  options.signal.throwIfAborted();
  return bytes;
}

/** 单批注册独立 AbortController；session signal 和快速跳转都可以终止同一底层 fetch。 */
async function loadAnalysisAssetBatch(
  options: LoadAnalysisAssetsOptions,
  batch: MediaAnalysisAssetDescriptor[],
  output: Map<string, Uint8Array>,
  registry: PlatformMediaAnalysisBatchRegistry,
) {
  const registryKey = Symbol("media-analysis-batch");
  const controller = new AbortController();
  const abortFromSession = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) abortFromSession();
  else options.signal.addEventListener("abort", abortFromSession, { once: true });
  registry.set(registryKey, {
    controller,
    assetIds: new Set(batch.map(({ id }) => id)),
    minStartTime: Math.min(...batch.map(({ startTime }) => startTime)),
    maxEndTime: Math.max(...batch.map(({ endTime }) => endTime)),
  });

  const batchPromise = options.client.getMediaAnalysisAssetBatch(
    options.annotationFileId,
    { runId: options.runId, assetIds: batch.map(({ id }) => id) },
    controller.signal,
  ).then((response) => {
    const decoded = decodeMediaAnalysisTileBatch(response);
    if (
      decoded.size !== batch.length ||
      batch.some(({ id }) => !decoded.has(id))
    ) throw new Error("媒体分析批次响应与请求不一致。");
    return decoded;
  });

  const resolvedBatch = new Map<string, Uint8Array>();
  const assetPromises = batch.map((descriptor) => {
    const assetPromise = batchPromise.then((decoded) => {
      const value = decoded.get(descriptor.id);
      if (!value || value.byteLength !== descriptor.size) {
        throw new Error("媒体分析瓦片大小与清单不一致。");
      }
      options.cache.set(descriptor.id, value);
      output.set(descriptor.id, value);
      resolvedBatch.set(descriptor.id, value);
      return value;
    });
    options.inFlight.set(descriptor.id, assetPromise);
    return assetPromise.finally(() => {
      if (options.inFlight.get(descriptor.id) === assetPromise) {
        options.inFlight.delete(descriptor.id);
      }
    });
  });

  try {
    await Promise.all(assetPromises);
    if (options.persistentCache) {
      void options.persistentCache.putMany(batch.map((descriptor) => ({
        identity: buildPersistentCacheIdentity(options, descriptor),
        bytes: resolvedBatch.get(descriptor.id)!,
      }))).catch((persistentError) => options.onPersistentCacheError?.(persistentError));
    }
    options.onBatchLoaded?.(batch, resolvedBatch);
  } finally {
    options.signal.removeEventListener("abort", abortFromSession);
    if (registry.get(registryKey)?.controller === controller) registry.delete(registryKey);
  }
}

function buildPersistentCacheIdentity(
  options: Pick<LoadAnalysisAssetsOptions, "currentUserId" | "annotationFileId" | "runId">,
  descriptor: MediaAnalysisAssetDescriptor,
) {
  return {
    userId: options.currentUserId,
    annotationFileId: options.annotationFileId,
    runId: options.runId,
    assetId: descriptor.id,
    size: descriptor.size,
  };
}

export function assemblePlatformWaveform(
  descriptors: MediaAnalysisAssetDescriptor[],
  bytes: Map<string, Uint8Array>,
  sourceOffsetSeconds = 0,
): WaveformData | null {
  const sorted = [...descriptors].sort((left, right) => left.tileIndex - right.tileIndex);
  if (sorted.length === 0) return null;
  assertContinuousAssetSequence(sorted, "波形");
  const samples: number[] = [];
  let samplesPerBucket = 0;
  for (const descriptor of sorted) {
    const value = bytes.get(descriptor.id);
    if (!value) throw new Error("波形资产内容不完整，请刷新后重试。");
    const tile = decodeMediaAnalysisTile(value);
    const tileSamplesPerBucket = Number(tile.header.samplesPerBucket);
    if (!Number.isInteger(tileSamplesPerBucket) || tileSamplesPerBucket <= 0) {
      throw new Error("波形资产格式不正确。");
    }
    if (samplesPerBucket !== 0 && samplesPerBucket !== tileSamplesPerBucket) {
      throw new Error("波形资产层级不一致，请重新分析。");
    }
    samplesPerBucket = tileSamplesPerBucket;
    const buckets = decodeFloat32LittleEndian(tile.sections[0] ?? new Uint8Array());
    if (buckets.length % 3 !== 0) throw new Error("波形资产格式不正确。");
    for (let index = 0; index + 2 < buckets.length; index += 3) {
      const min = buckets[index];
      const max = buckets[index + 1];
      samples.push(Math.abs(min) > Math.abs(max) ? min : max);
    }
  }
  if (!samplesPerBucket || samples.length === 0) return null;
  return {
    samples: Float32Array.from(samples),
    sampleRate: 16_000 / samplesPerBucket,
    duration: sorted[sorted.length - 1].endTime - sorted[0].startTime,
    timeOffset: sorted[0].startTime + sourceOffsetSeconds,
    keypoints: [],
  };
}

export function assemblePlatformSpectrogram(
  descriptors: MediaAnalysisAssetDescriptor[],
  pitchDescriptors: MediaAnalysisAssetDescriptor[],
  bytes: Map<string, Uint8Array>,
  preset: SpectrogramAnalysisPreset,
  sourceOffsetSeconds = 0,
): SpectrogramData | null {
  const sorted = [...descriptors].sort((left, right) => left.tileIndex - right.tileIndex);
  if (sorted.length === 0) return null;
  assertContinuousAssetSequence(sorted, "频谱");
  if (pitchDescriptors.length > 0) {
    assertContinuousAssetSequence(
      [...pitchDescriptors].sort((left, right) => left.tileIndex - right.tileIndex),
      "音高",
    );
  }
  const magnitudeChunks: Uint8Array[] = [];
  let frequencyBins = new Float32Array();
  let frameCount = 0;
  let metadata: Record<string, unknown> | null = null;
  for (const descriptor of sorted) {
    const value = bytes.get(descriptor.id);
    if (!value) throw new Error("频谱资产内容不完整，请刷新后重试。");
    const tile = decodeMediaAnalysisTile(value);
    if (metadata) assertCompatibleSpectrogramMetadata(metadata, tile.header);
    metadata ??= tile.header;
    const magnitudes = tile.sections[0] ?? new Uint8Array();
    const tileFrameCount = Number(tile.header.frameCount);
    const tileFrequencyBinCount = Number(tile.header.frequencyBinCount);
    if (
      !Number.isInteger(tileFrameCount) || tileFrameCount <= 0 ||
      !Number.isInteger(tileFrequencyBinCount) || tileFrequencyBinCount <= 0 ||
      magnitudes.length !== tileFrameCount * tileFrequencyBinCount
    ) throw new Error("频谱资产格式不正确。");
    magnitudeChunks.push(magnitudes);
    if (frequencyBins.length === 0 && tile.sections[1]) {
      frequencyBins = new Float32Array(
        decodeFloat32LittleEndian(tile.sections[1]),
      );
    }
    frameCount += tileFrameCount;
  }
  if (!metadata || magnitudeChunks.length === 0 || frequencyBins.length === 0) return null;
  const magnitudes = concatenateBytes(magnitudeChunks);
  const pitchFrames = [...pitchDescriptors]
    .sort((left, right) => left.tileIndex - right.tileIndex)
    .flatMap((descriptor) => {
    const value = bytes.get(descriptor.id);
    if (!value) throw new Error("音高资产内容不完整，请刷新后重试。");
    const tile = decodeMediaAnalysisTile(value);
    const values = decodeFloat32LittleEndian(tile.sections[0] ?? new Uint8Array());
    const frames = [];
    for (let index = 0; index + 2 < values.length; index += 3) {
      frames.push({
        time: descriptor.startTime + sourceOffsetSeconds + values[index],
        frequency: values[index + 1],
        confidence: values[index + 2],
        voiced: true,
      });
    }
    return frames;
    });
  return {
    magnitudes,
    frequencyBins,
    frameCount,
    frequencyBinCount: Number(metadata.frequencyBinCount),
    sampleRate: Number(metadata.sampleRate),
    duration: sorted[sorted.length - 1].endTime - sorted[0].startTime,
    timeOffset: sorted[0].startTime + sourceOffsetSeconds,
    hopLength: Number(metadata.hopLength),
    fftSize: Number(metadata.fftSize),
    minFrequency: Number(metadata.minFrequency),
    maxFrequency: Number(metadata.maxFrequency),
    dbMin: Number(metadata.dbMin),
    dbMax: Number(metadata.dbMax),
    analysisPreset: preset,
    pitchFrames: pitchFrames.length > 0 ? pitchFrames : undefined,
  };
}

/** 可见窗口只允许拼接连续瓦片；缺号时宁可显示错误，也不能把后段数据压缩到错误时间。 */
function assertContinuousAssetSequence(
  descriptors: MediaAnalysisAssetDescriptor[],
  label: string,
) {
  for (let index = 1; index < descriptors.length; index += 1) {
    const previous = descriptors[index - 1];
    const current = descriptors[index];
    if (
      current.tileIndex !== previous.tileIndex + 1 ||
      Math.abs(current.startTime - previous.endTime) > 0.001
    ) {
      throw new Error(`${label}资产时间瓦片不连续，请重新分析。`);
    }
  }
}

/** 同一频谱视图只能拼接算法参数完全一致的瓦片，避免矩阵错位或跨瓦片颜色标尺跳变。 */
function assertCompatibleSpectrogramMetadata(
  expected: Record<string, unknown>,
  current: Record<string, unknown>,
) {
  const stableFields = [
    "frequencyBinCount",
    "sampleRate",
    "hopLength",
    "fftSize",
    "minFrequency",
    "maxFrequency",
    "dbMin",
    "dbMax",
  ] as const;
  if (stableFields.some((field) => Number(expected[field]) !== Number(current[field]))) {
    throw new Error("频谱资产参数不一致，请重新分析。");
  }
}

function concatenateBytes(chunks: Uint8Array[]) {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "读取媒体分析失败。";
}

/** Abort 是视口切换和任务取消的正常控制流，不应显示为加载失败。 */
function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/** 持久缓存只是性能层；失败需要留开发日志，但不能覆盖可继续使用的网络结果。 */
function reportPersistentCacheError(error: unknown) {
  console.warn("媒体分析 IndexedDB 缓存不可用，已降级为网络读取", error);
}
