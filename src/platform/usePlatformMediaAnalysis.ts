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
  buildPlatformAnalysisRequestWindow,
  partitionMediaAnalysisAssetBatches,
  PlatformMediaAnalysisAssetCache,
  type PlatformAnalysisViewport,
} from "./platformMediaAnalysisLoading";

const STATUS_POLL_INTERVAL_MS = 2_000;
const VIEWPORT_LOAD_DEBOUNCE_MS = 120;

export type { PlatformAnalysisViewport } from "./platformMediaAnalysisLoading";

type Options = {
  client: PlatformClient | null;
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
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const cacheRef = useRef(new PlatformMediaAnalysisAssetCache());
  const inFlightAssetsRef = useRef(new Map<string, Promise<Uint8Array>>());
  const assetSessionAbortControllerRef = useRef(new AbortController());
  const assetSessionKeyRef = useRef<string | null>(null);
  const viewportLoadIdRef = useRef(0);
  const statusRefreshInFlightRef = useRef<Promise<AnnotationMediaAnalysisStatus | null> | null>(null);

  const resetAssetSession = useCallback(() => {
    assetSessionAbortControllerRef.current.abort();
    assetSessionAbortControllerRef.current = new AbortController();
    inFlightAssetsRef.current.clear();
    cacheRef.current.clear();
    viewportLoadIdRef.current += 1;
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
  }, [options.annotationFileId, options.enabled, refresh, resetAssetSession]);

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
    ? `${options.annotationFileId ?? ""}:${currentRun.id}:${currentRun.completedAt ?? "pending"}`
    : null;
  useEffect(() => {
    if (assetSessionKeyRef.current === assetSessionKey) return;
    assetSessionKeyRef.current = assetSessionKey;
    resetAssetSession();
    setWaveformData(null);
    setSpectrogramData(null);
  }, [assetSessionKey, resetAssetSession]);

  const requestWindow = options.viewport && currentRun
    ? buildPlatformAnalysisRequestWindow(options.viewport, currentRun.sourceOffsetSeconds)
    : null;

  useEffect(() => {
    const client = options.client;
    const annotationFileId = options.annotationFileId;
    const run = status?.currentRun;
    if (
      !options.enabled ||
      !client ||
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
    const sourceOffset = run.sourceOffsetSeconds;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setAssetsLoading(true);
      void Promise.all([
        client.listMediaAnalysisAssets(annotationFileId, {
          runId: run.id,
          kind: "waveform",
          preset: "default",
          level: requestWindow.waveformLevel,
          startTime: requestWindow.startTime,
          endTime: requestWindow.endTime,
        }, listAbortController.signal),
        options.spectrogramVisible
          ? client.listMediaAnalysisAssets(annotationFileId, {
              runId: run.id,
              kind: "spectrogram",
              preset: options.analysisPreset,
              level: 0,
              startTime: requestWindow.startTime,
              endTime: requestWindow.endTime,
            }, listAbortController.signal)
          : Promise.resolve({ runId: run.id, assets: [] }),
        options.spectrogramVisible && options.showPitch
          ? client.listMediaAnalysisAssets(annotationFileId, {
              runId: run.id,
              kind: "pitch",
              preset: "yin-v1",
              level: 0,
              startTime: requestWindow.startTime,
              endTime: requestWindow.endTime,
            }, listAbortController.signal)
          : Promise.resolve({ runId: run.id, assets: [] }),
      ]).then(async ([waveform, spectrogram, pitch]) => {
        const descriptors = [
          ...waveform.assets,
          ...spectrogram.assets,
          ...pitch.assets,
        ];
        const bytes = await loadAnalysisAssets({
          annotationFileId,
          runId: run.id,
          descriptors,
          client,
          cache: cacheRef.current,
          inFlight: inFlightAssetsRef.current,
          signal: assetSessionAbortControllerRef.current.signal,
        });
        if (cancelled || generation !== generationRef.current) return;
        setWaveformData(assemblePlatformWaveform(waveform.assets, bytes, sourceOffset));
        setSpectrogramData(options.spectrogramVisible
          ? assemblePlatformSpectrogram(
              spectrogram.assets,
              pitch.assets,
              bytes,
              options.analysisPreset,
              sourceOffset,
            )
          : null);
        setError(null);
      }).catch((nextError: unknown) => {
        if (cancelled || generation !== generationRef.current) return;
        setError(describeError(nextError));
      }).finally(() => {
        if (
          !cancelled &&
          generation === generationRef.current &&
          viewportLoadIdRef.current === viewportLoadId
        ) {
          setAssetsLoading(false);
        }
      });
    }, VIEWPORT_LOAD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      listAbortController.abort();
    };
  }, [
    options.analysisPreset,
    options.annotationFileId,
    options.client,
    options.enabled,
    options.showPitch,
    options.spectrogramVisible,
    requestWindow?.endTime,
    requestWindow?.startTime,
    requestWindow?.waveformLevel,
    currentRun,
  ]);

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

  return {
    status,
    waveformData,
    spectrogramData,
    statusLoading,
    assetsLoading,
    mutationPending,
    error,
    refresh,
    updateSource,
    startAnalysis,
  };
}

type LoadAnalysisAssetsOptions = {
  annotationFileId: string;
  runId: string;
  descriptors: MediaAnalysisAssetDescriptor[];
  client: Pick<PlatformClient, "getMediaAnalysisAssetBatch">;
  cache: PlatformMediaAnalysisAssetCache;
  inFlight: Map<string, Promise<Uint8Array>>;
  signal: AbortSignal;
};

/**
 * 当前窗口先复用已完成缓存和 session 级进行中请求，再把真正缺失项按预算批量读取。
 * 视口卸载不会取消这些共享 Promise；文件/run 切换会通过 session signal 一次性中止。
 */
export async function loadAnalysisAssets(options: LoadAnalysisAssetsOptions) {
  const descriptorIds = new Set(options.descriptors.map(({ id }) => id));
  if (descriptorIds.size !== options.descriptors.length) {
    throw new Error("媒体分析资产列表包含重复项目。");
  }
  const bytes = new Map<string, Uint8Array>();
  const pending: Promise<void>[] = [];
  const missing: MediaAnalysisAssetDescriptor[] = [];

  for (const descriptor of options.descriptors) {
    const cached = options.cache.get(descriptor.id);
    if (cached) {
      bytes.set(descriptor.id, cached);
      continue;
    }
    const existing = options.inFlight.get(descriptor.id);
    if (existing) {
      pending.push(existing.then((value) => {
        bytes.set(descriptor.id, value);
      }));
      continue;
    }
    missing.push(descriptor);
  }

  for (const batch of partitionMediaAnalysisAssetBatches(missing)) {
    const batchPromise = options.client.getMediaAnalysisAssetBatch(
      options.annotationFileId,
      { runId: options.runId, assetIds: batch.map(({ id }) => id) },
      options.signal,
    ).then((response) => {
      const decoded = decodeMediaAnalysisTileBatch(response);
      if (
        decoded.size !== batch.length ||
        batch.some(({ id }) => !decoded.has(id))
      ) {
        throw new Error("媒体分析批次响应与请求不一致。");
      }
      return decoded;
    });

    for (const descriptor of batch) {
      const assetPromise = batchPromise.then((decoded) => {
        const value = decoded.get(descriptor.id);
        if (!value || value.byteLength !== descriptor.size) {
          throw new Error("媒体分析瓦片大小与清单不一致。");
        }
        options.cache.set(descriptor.id, value);
        return value;
      });
      options.inFlight.set(descriptor.id, assetPromise);
      pending.push(assetPromise.then((value) => {
        bytes.set(descriptor.id, value);
      }).finally(() => {
        if (options.inFlight.get(descriptor.id) === assetPromise) {
          options.inFlight.delete(descriptor.id);
        }
      }));
    }
  }

  await Promise.all(pending);
  options.signal.throwIfAborted();
  return bytes;
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
