import assert from "node:assert/strict";
import test from "node:test";
import type { MediaAnalysisAssetDescriptor } from "@xiqu/shared";
import { computeMediaAnalysisAssets } from "../../apps/api/src/mediaAnalysisComputation.js";
import {
  assemblePlatformSpectrogram,
  assemblePlatformWaveform,
} from "./usePlatformMediaAnalysis.js";
import { intersectTimedMediaRange } from "../utils/mediaAnalysisRange.js";

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

function sine(sampleRate: number, duration: number, frequency: number) {
  return Float32Array.from(
    { length: Math.round(sampleRate * duration) },
    (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.5,
  );
}
