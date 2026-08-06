import {
  MAX_MEDIA_ANALYSIS_BATCH_ASSETS,
  MAX_MEDIA_ANALYSIS_BATCH_BYTES,
  type MediaAnalysisAssetDescriptor,
} from "@xiqu/shared";

const ANALYSIS_TILE_DURATION_SECONDS = 30;
const DEFAULT_MAX_CACHE_ASSETS = 96;
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const WAVEFORM_SAMPLES_PER_BUCKET = [64, 256, 1000, 4000] as const;

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

/** 按共享数量/字节预算切分请求，避免一个宽视口形成无界响应。 */
export function partitionMediaAnalysisAssetBatches(
  descriptors: readonly MediaAnalysisAssetDescriptor[],
) {
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
      (current.length >= MAX_MEDIA_ANALYSIS_BATCH_ASSETS ||
        currentBytes + descriptor.size > MAX_MEDIA_ANALYSIS_BATCH_BYTES)
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
