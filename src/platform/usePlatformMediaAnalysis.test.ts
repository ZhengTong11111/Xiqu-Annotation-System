import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeMediaAnalysisTileBatchHeader,
  type MediaAnalysisAssetDescriptor,
} from "@xiqu/shared";
import { computeMediaAnalysisAssets } from "../../apps/api/src/mediaAnalysisComputation.js";
import {
  assemblePlatformSpectrogram,
  assemblePlatformWaveform,
  loadAnalysisAssets,
} from "./usePlatformMediaAnalysis.js";
import { intersectTimedMediaRange } from "../utils/mediaAnalysisRange.js";
import { PlatformMediaAnalysisAssetCache } from "./platformMediaAnalysisLoading.js";

test("分析资产时间交集保留偏移空白且拒绝完全不相交范围", () => {
  assert.deepEqual(intersectTimedMediaRange(0, 20, 5, 10), {
    startTime: 5,
    endTime: 15,
  });
  assert.deepEqual(intersectTimedMediaRange(0, 20, -5, 10), {
    startTime: 0,
    endTime: 5,
  });
  assert.equal(intersectTimedMediaRange(0, 4, 5, 10), null);
  assert.equal(intersectTimedMediaRange(15, 20, 5, 10), null);
});

test("平台瓦片组装保留全局时间偏移并合并连续频谱帧", () => {
  const first = computeMediaAnalysisAssets(sine(16_000, 0.1, 220), 16_000, 2);
  const second = computeMediaAnalysisAssets(sine(16_000, 0.1, 330), 16_000, 3);
  const all = [...first, ...second];
  const descriptors = all.map((asset, index): MediaAnalysisAssetDescriptor => ({
    id: `asset-${index}`,
    kind: asset.kind,
    preset: asset.preset,
    level: asset.level,
    tileIndex: asset.tileIndex,
    // 测试样本只有 0.1 秒，手工构造两个连续瓦片，避免为组装测试计算两段 30 秒频谱。
    startTime: 60 + (asset.tileIndex - 2) * 0.1,
    endTime: 60.1 + (asset.tileIndex - 2) * 0.1,
    mimeType: asset.mimeType,
    size: asset.bytes.byteLength,
  }));
  const bytes = new Map(descriptors.map((descriptor, index) => [
    descriptor.id,
    all[index].bytes,
  ]));
  const waveformDescriptors = descriptors.filter(({ kind, level }) =>
    kind === "waveform" && level === 0);
  const waveform = assemblePlatformWaveform(waveformDescriptors, bytes, 1.5);
  assert.ok(waveform);
  assert.equal(waveform.timeOffset, 61.5);
  assert.ok(waveform.samples.length > 0);

  const spectrogramDescriptors = descriptors.filter(({ kind, preset }) =>
    kind === "spectrogram" && preset === "time-detail");
  const pitchDescriptors = descriptors.filter(({ kind }) => kind === "pitch");
  const spectrogram = assemblePlatformSpectrogram(
    spectrogramDescriptors,
    pitchDescriptors,
    bytes,
    "time-detail",
    1.5,
  );
  assert.ok(spectrogram);
  assert.equal(spectrogram.timeOffset, 61.5);
  assert.ok(spectrogram.frameCount > 2);
  assert.equal(
    spectrogram.magnitudes.length,
    spectrogram.frameCount * spectrogram.frequencyBinCount,
  );
  assert.ok(spectrogram.pitchFrames?.every(({ time }) => time >= 61.5));
});

test("平台瓦片组装拒绝缺号，避免把后段分析压缩到错误时间", () => {
  const assets = [
    ...computeMediaAnalysisAssets(sine(16_000, 0.05, 220), 16_000, 0),
    ...computeMediaAnalysisAssets(sine(16_000, 0.05, 330), 16_000, 2),
  ].filter(({ kind, level }) => kind === "waveform" && level === 0);
  const descriptors = assets.map((asset, index): MediaAnalysisAssetDescriptor => ({
    id: `gap-${index}`,
    kind: asset.kind,
    preset: asset.preset,
    level: asset.level,
    tileIndex: asset.tileIndex,
    startTime: index * 0.05,
    endTime: (index + 1) * 0.05,
    mimeType: asset.mimeType,
    size: asset.bytes.byteLength,
  }));
  const bytes = new Map(descriptors.map((descriptor, index) => [
    descriptor.id,
    assets[index].bytes,
  ]));
  assert.throws(
    () => assemblePlatformWaveform(descriptors, bytes),
    /时间瓦片不连续/,
  );
});

test("相同资产的并发窗口复用一个批量请求并共同写入缓存", async () => {
  const assetBytes = Uint8Array.from([7, 8, 9]);
  const descriptor: MediaAnalysisAssetDescriptor = {
    id: "shared-asset",
    kind: "waveform",
    preset: "default",
    level: 0,
    tileIndex: 0,
    startTime: 0,
    endTime: 30,
    mimeType: "application/vnd.xiqu.waveform-tile",
    size: assetBytes.byteLength,
  };
  const batch = buildBatchResponse(descriptor.id, assetBytes);
  let requestCount = 0;
  const client = {
    async getMediaAnalysisAssetBatch() {
      requestCount += 1;
      await Promise.resolve();
      return batch;
    },
  };
  const cache = new PlatformMediaAnalysisAssetCache();
  const inFlight = new Map<string, Promise<Uint8Array>>();
  const controller = new AbortController();
  const options = {
    currentUserId: "user-1",
    annotationFileId: "file-1",
    mediaResourceId: "media-1",
    runId: "run-1",
    descriptors: [descriptor],
    client,
    cache,
    inFlight,
    signal: controller.signal,
  };

  const [first, second] = await Promise.all([
    loadAnalysisAssets(options),
    loadAnalysisAssets(options),
  ]);
  assert.equal(requestCount, 1);
  assert.deepEqual([...first.get(descriptor.id) ?? []], [...assetBytes]);
  assert.deepEqual([...second.get(descriptor.id) ?? []], [...assetBytes]);
  assert.equal(inFlight.size, 0);
  assert.deepEqual([...cache.get(descriptor.id) ?? []], [...assetBytes]);
});

test("不同分析序列按有界并发逐批回调", async () => {
  const descriptors: MediaAnalysisAssetDescriptor[] = [
    descriptorForSeries("wave", "waveform", "default"),
    descriptorForSeries("spectrogram", "spectrogram", "time-detail"),
    descriptorForSeries("pitch", "pitch", "yin-v1"),
  ];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const completedBatches: string[][] = [];
  const client = {
    async getMediaAnalysisAssetBatch(
      _resourceId: string,
      request: { assetIds: string[] },
    ) {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      return buildBatchResponseForAssets(
        request.assetIds.map((id) => ({ id, bytes: Uint8Array.of(id.length) })),
      );
    },
  };
  const result = await loadAnalysisAssets({
    currentUserId: "user-1",
    annotationFileId: "file-1",
    mediaResourceId: "media-1",
    runId: "run-1",
    descriptors,
    client,
    cache: new PlatformMediaAnalysisAssetCache(),
    inFlight: new Map(),
    batchRegistry: new Map(),
    signal: new AbortController().signal,
    maxConcurrentBatches: 2,
    onBatchLoaded(batch) {
      completedBatches.push(batch.map(({ id }) => id));
    },
  });
  assert.equal(maximumActiveRequests, 2);
  assert.equal(result.size, 3);
  assert.deepEqual(completedBatches.flat().sort(), ["pitch", "spectrogram", "wave"]);
});

function sine(sampleRate: number, duration: number, frequency: number) {
  return Float32Array.from(
    { length: Math.round(sampleRate * duration) },
    (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.5,
  );
}

function buildBatchResponse(id: string, bytes: Uint8Array) {
  return buildBatchResponseForAssets([{ id, bytes }]);
}

function buildBatchResponseForAssets(assets: Array<{ id: string; bytes: Uint8Array }>) {
  const header = encodeMediaAnalysisTileBatchHeader(assets.map(({ id, bytes }) => ({
    id,
    byteLength: bytes.byteLength,
  })));
  const response = new Uint8Array(
    header.byteLength + assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0),
  );
  response.set(header, 0);
  let offset = header.byteLength;
  for (const asset of assets) {
    response.set(asset.bytes, offset);
    offset += asset.bytes.byteLength;
  }
  return response;
}

function descriptorForSeries(
  id: string,
  kind: MediaAnalysisAssetDescriptor["kind"],
  preset: string,
): MediaAnalysisAssetDescriptor {
  return {
    id,
    kind,
    preset,
    level: 0,
    tileIndex: 0,
    startTime: 0,
    endTime: 30,
    mimeType: `application/vnd.xiqu.${kind}-tile`,
    size: 1,
  };
}
