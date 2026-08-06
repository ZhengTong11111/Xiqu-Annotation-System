import {
  MAX_MEDIA_ANALYSIS_BATCH_ASSETS,
  MAX_MEDIA_ANALYSIS_BATCH_BYTES,
  type MediaAnalysisAssetDescriptor,
} from "@xiqu/shared";

export const LEGACY_ANALYSIS_TILE_DURATION_SECONDS = 30;
const DEFAULT_MAX_CACHE_ASSETS = 96;
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const WAVEFORM_SAMPLES_PER_BUCKET = [64, 256, 1000, 4000] as const;

export type PlatformMediaAnalysisBatchRequest = {
  assetIds: ReadonlySet<string>;
  controller: AbortController;
  /** 批次内资产的源时间范围，用于快速跳转时取消远离视口的混合批次。 */
  minStartTime: number;
  maxEndTime: number;
};

export type PlatformMediaAnalysisBatchRegistry = Map<symbol, PlatformMediaAnalysisBatchRequest>;

export type PlatformAnalysisRequestWindow = {
  startTime: number;
  endTime: number;
  waveformLevel: number;
  tileDurationSeconds: number;
};

export type PlatformAnalysisViewport = {
  startTime: number;
  endTime: number;
  zoom: number;
};

/**
 * 把连续像素滚动量化到当前 run 的真实瓦片边界；只要所需瓦片集合不变，就不重新读取三个 descriptor 列表。
 */
export function buildPlatformAnalysisRequestWindow(
  viewport: PlatformAnalysisViewport,
  sourceOffsetSeconds: number,
  tileDurationSeconds = LEGACY_ANALYSIS_TILE_DURATION_SECONDS,
): PlatformAnalysisRequestWindow {
  // 服务端 DTO 是权威来源，但前端仍对旧版本/异常响应做有界回退，避免零值导致除零和无穷请求。
  const safeTileDuration = Number.isFinite(tileDurationSeconds) && tileDurationSeconds > 0
    ? tileDurationSeconds
    : LEGACY_ANALYSIS_TILE_DURATION_SECONDS;
  const viewportDuration = Math.max(0.001, viewport.endTime - viewport.startTime);
  // 只保留一小段滚动缓冲：足以吸收短距离移动，又不会把一次请求扩成数倍可视区。
  const requestPadding = Math.min(
    Math.max(safeTileDuration, viewportDuration * 0.25),
    90,
  );
  const rawStart = Math.max(
    0,
    viewport.startTime - requestPadding - sourceOffsetSeconds,
  );
  const rawEnd = Math.max(
    rawStart + 0.001,
    viewport.endTime + requestPadding - sourceOffsetSeconds,
  );
  return {
    startTime: Math.floor(rawStart / safeTileDuration) * safeTileDuration,
    endTime: Math.max(
      safeTileDuration,
      Math.ceil(rawEnd / safeTileDuration) * safeTileDuration,
    ),
    waveformLevel: chooseWaveformLevel(viewport.zoom),
    tileDurationSeconds: safeTileDuration,
  };
}

/**
 * 相邻预取只覆盖一个可视区大小的窗口，并优先沿用户最近的移动方向读取。
 * 预取不是显示必需数据，因此不能再按含 padding 的请求窗成倍扩张下载量。
 */
export function buildAdjacentPlatformAnalysisWindows(
  current: PlatformAnalysisRequestWindow,
  visibleDuration = current.endTime - current.startTime,
  direction: "forward" | "backward" = "forward",
) {
  const duration = Math.max(current.tileDurationSeconds, visibleDuration);
  const windows: PlatformAnalysisRequestWindow[] = [];
  if (direction === "backward" && current.startTime > 0) {
    windows.push({
      startTime: Math.max(0, current.startTime - duration),
      endTime: current.startTime,
      waveformLevel: current.waveformLevel,
      tileDurationSeconds: current.tileDurationSeconds,
    });
  } else {
    windows.push({
      startTime: current.endTime,
      endTime: current.endTime + duration,
      waveformLevel: current.waveformLevel,
      tileDurationSeconds: current.tileDurationSeconds,
    });
  }
  return windows;
}

/**
 * 快速跳转时取消整体远离当前视口的批次。
 * 混合批次只要仍包含保护资产就保留，避免把即将复用的共享请求取消后再次发送。
 */
export function cancelPlatformAnalysisBatchesOutsideViewport(
  registry: PlatformMediaAnalysisBatchRegistry,
  viewport: { startTime: number; endTime: number },
  retainedAssetIds: ReadonlySet<string>,
  marginSeconds = 60,
) {
  const margin = Math.max(0, marginSeconds);
  const lowerBound = viewport.startTime - margin;
  const upperBound = viewport.endTime + margin;
  let cancelled = 0;
  for (const request of registry.values()) {
    if ([...request.assetIds].some((assetId) => retainedAssetIds.has(assetId))) continue;
    if (request.maxEndTime >= lowerBound && request.minStartTime <= upperBound) continue;
    request.controller.abort();
    cancelled += 1;
  }
  return cancelled;
}

/** 文件、账号或 run 切换时中止全部批次；registry 最终由各 Promise 的 finally 清理。 */
export function abortPlatformAnalysisBatches(registry: PlatformMediaAnalysisBatchRegistry) {
  for (const request of registry.values()) request.controller.abort();
}

/**
 * 渐进绘制只能使用连续已加载的时间段，不能跳过缺块后压缩后段时间。
 */
export function selectContiguousLoadedAnalysisAssets(
  descriptors: readonly MediaAnalysisAssetDescriptor[],
  loadedBytes: ReadonlyMap<string, Uint8Array>,
) {
  const sorted = [...descriptors].sort((left, right) => left.tileIndex - right.tileIndex);
  const prefix: MediaAnalysisAssetDescriptor[] = [];
  for (const descriptor of sorted) {
    if (!loadedBytes.has(descriptor.id)) break;
    if (prefix.length > 0) {
      const previous = prefix[prefix.length - 1];
      if (
        descriptor.tileIndex !== previous.tileIndex + 1 ||
        Math.abs(descriptor.startTime - previous.endTime) > 0.001
      ) break;
    }
    prefix.push(descriptor);
  }
  return prefix;
}

/**
 * 优先返回覆盖当前可视区的连续时间段，让用户先看到眼前内容；左右 padding 可以稍后补齐。
 * 若可视区还没有任何已加载瓦片，则回退到窗口前缀，保持旧数据能尽快显示。
 */
export function selectContiguousLoadedAnalysisAssetsAroundVisible(
  descriptors: readonly MediaAnalysisAssetDescriptor[],
  loadedBytes: ReadonlyMap<string, Uint8Array>,
  visibleStartTime: number,
  visibleEndTime = visibleStartTime,
) {
  const sorted = [...descriptors].sort((left, right) => left.tileIndex - right.tileIndex);
  if (sorted.length === 0) return [];
  const visibleEnd = Math.max(visibleStartTime, visibleEndTime);
  const anchor = sorted.findIndex((descriptor) =>
    loadedBytes.has(descriptor.id) &&
    descriptor.endTime > visibleStartTime &&
    descriptor.startTime < visibleEnd,
  );
  if (anchor < 0) return selectContiguousLoadedAnalysisAssets(sorted, loadedBytes);

  let start = anchor;
  while (start > 0 && isContiguousAnalysisAssetPair(sorted[start - 1], sorted[start]) &&
    loadedBytes.has(sorted[start - 1].id)) {
    start -= 1;
  }
  let end = anchor;
  while (end < sorted.length - 1 && isContiguousAnalysisAssetPair(sorted[end], sorted[end + 1]) &&
    loadedBytes.has(sorted[end + 1].id)) {
    end += 1;
  }
  return sorted.slice(start, end + 1);
}

function isContiguousAnalysisAssetPair(
  previous: MediaAnalysisAssetDescriptor,
  next: MediaAnalysisAssetDescriptor,
) {
  return next.tileIndex === previous.tileIndex + 1 &&
    Math.abs(next.startTime - previous.endTime) <= 0.001;
}

/** 按共享数量/字节预算切分请求，避免一个宽视口形成无界响应。 */
export function partitionMediaAnalysisAssetBatches(
  descriptors: readonly MediaAnalysisAssetDescriptor[],
  limits: { maxBytes?: number; maxAssets?: number } = {},
) {
  const maxBytes = limits.maxBytes ?? MAX_MEDIA_ANALYSIS_BATCH_BYTES;
  const maxAssets = limits.maxAssets ?? MAX_MEDIA_ANALYSIS_BATCH_ASSETS;
  if (
    !Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
    maxBytes > MAX_MEDIA_ANALYSIS_BATCH_BYTES ||
    !Number.isSafeInteger(maxAssets) || maxAssets <= 0 ||
    maxAssets > MAX_MEDIA_ANALYSIS_BATCH_ASSETS
  ) throw new Error("媒体分析批次预算不正确。");
  const batches: MediaAnalysisAssetDescriptor[][] = [];
  let current: MediaAnalysisAssetDescriptor[] = [];
  let currentBytes = 0;
  for (const descriptor of descriptors) {
    if (
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size <= 0 ||
      descriptor.size > MAX_MEDIA_ANALYSIS_BATCH_BYTES
    ) {
      throw new Error("媒体分析瓦片大小不正确。");
    }
    if (
      current.length > 0 &&
      (!belongsToSameAnalysisSeries(current[0], descriptor) ||
        current.length >= maxAssets ||
        currentBytes + descriptor.size > maxBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(descriptor);
    currentBytes += descriptor.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 波形、频谱、F0 和不同精度不能混进同一批，确保轻量波形可以先于大频谱完成。 */
function belongsToSameAnalysisSeries(
  first: MediaAnalysisAssetDescriptor,
  candidate: MediaAnalysisAssetDescriptor,
) {
  return first.kind === candidate.kind &&
    first.preset === candidate.preset &&
    first.level === candidate.level;
}

/** 数量和总字节双限 LRU；get 会刷新热度，超大单项不会挤掉整个可用窗口。 */
export class PlatformMediaAnalysisAssetCache {
  private readonly values = new Map<string, Uint8Array>();
  private totalBytes = 0;

  constructor(
    private readonly maxAssets = DEFAULT_MAX_CACHE_ASSETS,
    private readonly maxBytes = DEFAULT_MAX_CACHE_BYTES,
  ) {}

  get(id: string) {
    const value = this.values.get(id);
    if (!value) return undefined;
    this.values.delete(id);
    this.values.set(id, value);
    return value;
  }

  set(id: string, value: Uint8Array) {
    const previous = this.values.get(id);
    if (previous) {
      this.values.delete(id);
      this.totalBytes -= previous.byteLength;
    }
    if (value.byteLength > this.maxBytes) return;
    this.values.set(id, value);
    this.totalBytes += value.byteLength;
    while (this.values.size > this.maxAssets || this.totalBytes > this.maxBytes) {
      const oldestId = this.values.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.values.get(oldestId);
      this.values.delete(oldestId);
      this.totalBytes -= oldest?.byteLength ?? 0;
    }
  }

  clear() {
    this.values.clear();
    this.totalBytes = 0;
  }

  get size() {
    return this.values.size;
  }

  get byteLength() {
    return this.totalBytes;
  }
}

function chooseWaveformLevel(zoom: number) {
  let bestLevel = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let level = 0; level < WAVEFORM_SAMPLES_PER_BUCKET.length; level += 1) {
    const cssWidth = (WAVEFORM_SAMPLES_PER_BUCKET[level] / 16_000) * zoom;
    const distance = Math.abs(Math.log2(Math.max(cssWidth, 0.001)));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLevel = level;
    }
  }
  return bestLevel;
}
