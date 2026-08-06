import {
  MAX_MEDIA_ANALYSIS_BATCH_ASSETS,
  MAX_MEDIA_ANALYSIS_BATCH_BYTES,
  type MediaAnalysisAssetDescriptor,
} from "@xiqu/shared";

const ANALYSIS_TILE_DURATION_SECONDS = 30;
const DEFAULT_MAX_CACHE_ASSETS = 96;
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const WAVEFORM_SAMPLES_PER_BUCKET = [64, 256, 1000, 4000] as const;

export type PlatformMediaAnalysisBatchRequest = {
  assetIds: ReadonlySet<string>;
  controller: AbortController;
};

export type PlatformMediaAnalysisBatchRegistry = Map<symbol, PlatformMediaAnalysisBatchRequest>;

export type PlatformAnalysisRequestWindow = {
  startTime: number;
  endTime: number;
  waveformLevel: number;
};

export type PlatformAnalysisViewport = {
  startTime: number;
  endTime: number;
  zoom: number;
};

/**
 * 把连续像素滚动量化到服务端真实 30 秒瓦片边界；只要所需瓦片集合不变，就不重新读取三个 descriptor 列表。
 */
export function buildPlatformAnalysisRequestWindow(
  viewport: PlatformAnalysisViewport,
  sourceOffsetSeconds: number,
): PlatformAnalysisRequestWindow {
  const viewportDuration = Math.max(0.001, viewport.endTime - viewport.startTime);
  const requestPadding = Math.max(ANALYSIS_TILE_DURATION_SECONDS, viewportDuration * 0.6);
  const rawStart = Math.max(
    0,
    viewport.startTime - requestPadding - sourceOffsetSeconds,
  );
  const rawEnd = Math.max(
    rawStart + 0.001,
    viewport.endTime + requestPadding - sourceOffsetSeconds,
  );
  return {
    startTime: Math.floor(rawStart / ANALYSIS_TILE_DURATION_SECONDS) * ANALYSIS_TILE_DURATION_SECONDS,
    endTime: Math.max(
      ANALYSIS_TILE_DURATION_SECONDS,
      Math.ceil(rawEnd / ANALYSIS_TILE_DURATION_SECONDS) * ANALYSIS_TILE_DURATION_SECONDS,
    ),
    waveformLevel: chooseWaveformLevel(viewport.zoom),
  };
}

/**
 * 相邻预取沿用当前窗口跨度和波形层级；前段越过 0 时省略，避免生成与当前窗口重复的无效请求。
 */
export function buildAdjacentPlatformAnalysisWindows(
  current: PlatformAnalysisRequestWindow,
) {
  const duration = current.endTime - current.startTime;
  const windows: PlatformAnalysisRequestWindow[] = [];
  if (current.startTime > 0) {
    windows.push({
      startTime: Math.max(0, current.startTime - duration),
      endTime: current.startTime,
      waveformLevel: current.waveformLevel,
    });
  }
  windows.push({
    startTime: current.endTime,
    endTime: current.endTime + duration,
    waveformLevel: current.waveformLevel,
  });
  return windows;
}

/**
 * 快速跳转后只取消与保留资产集合完全不相交的批次。
 * 含有任一仍需要资产的共享批次必须继续，避免取消后立即重发同一对象。
 */
export function cancelPlatformAnalysisBatchesOutsideRetainedAssets(
  registry: PlatformMediaAnalysisBatchRegistry,
  retainedAssetIds: ReadonlySet<string>,
) {
  let cancelled = 0;
  for (const request of registry.values()) {
    if ([...request.assetIds].some((assetId) => retainedAssetIds.has(assetId))) continue;
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
 * 渐进绘制只能使用从当前窗口第一块开始的连续已加载前缀，不能跳过缺块后压缩后段时间。
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
