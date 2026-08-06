import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFloat32LittleEndian,
  decodeMediaAnalysisTile,
} from "@xiqu/shared";
import {
  computeMediaAnalysisAssets,
  MEDIA_ANALYSIS_TILE_DURATION_SECONDS,
  MediaAnalysisPcmTileAccumulator,
} from "../src/mediaAnalysisComputation.js";

test("媒体分析瓦片包含波形层级、两种频谱和 voiced-only 音高", () => {
  const sampleRate = 16_000;
  const samples = sineWave(sampleRate, 0.15, 220);
  const assets = computeMediaAnalysisAssets(samples, sampleRate, 2);
  assert.equal(assets.filter(({ kind }) => kind === "waveform").length, 4);
  assert.equal(assets.filter(({ kind }) => kind === "spectrogram").length, 2);
  assert.equal(assets.filter(({ kind }) => kind === "pitch").length, 1);
  assert.ok(assets.every(({ startTime }) => startTime === 20));

  const waveform = assets.find(({ kind, level }) => kind === "waveform" && level === 0);
  assert.ok(waveform);
  const decoded = decodeMediaAnalysisTile(waveform.bytes);
  assert.equal(decoded.header.kind, "waveform");
  assert.equal(decoded.sections.length, 1);
  const buckets = decodeFloat32LittleEndian(decoded.sections[0]);
  assert.equal(buckets.length % 3, 0);
  assert.ok([...buckets].every(Number.isFinite));

  const spectrogram = assets.find(({ kind, preset }) =>
    kind === "spectrogram" && preset === "time-detail");
  assert.ok(spectrogram);
  const spectrogramTile = decodeMediaAnalysisTile(spectrogram.bytes);
  assert.equal(spectrogramTile.sections.length, 2);
  assert.equal(
    spectrogramTile.sections[0].byteLength,
    Number(spectrogramTile.header.frameCount)
      * Number(spectrogramTile.header.frequencyBinCount),
  );
  const pitch = assets.find(({ kind }) => kind === "pitch");
  assert.ok(pitch);
  const pitchTile = decodeMediaAnalysisTile(pitch.bytes);
  assert.ok(
    Number(pitchTile.header.frameCount) <= Math.ceil(0.15 * 25),
    "F0 输出密度必须保持有界，不能随频谱帧率无限增长",
  );
});

test("完整分析瓦片的波形桶和频谱帧严格落在共同时间边界", () => {
  const sampleRate = 16_000;
  const assets = computeMediaAnalysisAssets(
    new Float32Array(sampleRate * MEDIA_ANALYSIS_TILE_DURATION_SECONDS),
    sampleRate,
    1,
  );
  for (const asset of assets) {
    const decoded = decodeMediaAnalysisTile(asset.bytes);
    if (asset.kind === "waveform") {
      const bucketCount = Number(decoded.header.bucketCount);
      const samplesPerBucket = Number(decoded.header.samplesPerBucket);
      assert.equal(
        bucketCount * samplesPerBucket,
        sampleRate * MEDIA_ANALYSIS_TILE_DURATION_SECONDS,
      );
    }
    if (asset.kind === "spectrogram") {
      const frameCount = Number(decoded.header.frameCount);
      const hopLength = Number(decoded.header.hopLength);
      assert.equal(
        frameCount * hopLength,
        sampleRate * MEDIA_ANALYSIS_TILE_DURATION_SECONDS,
      );
    }
  }
});

test("PCM 累积器跨 stdout 分片严格切成固定时长并保留尾块", async () => {
  const tiles: Array<{ index: number; length: number; first: number }> = [];
  const accumulator = new MediaAnalysisPcmTileAccumulator(2, async (samples, index) => {
    tiles.push({ index, length: samples.length, first: samples[0] });
  });
  await accumulator.push(new Float32Array([1, 2, 3]));
  await accumulator.push(Float32Array.from({ length: 70 }, (_, index) => index + 4));
  await accumulator.finish();
  assert.deepEqual(tiles, [
    { index: 0, length: 20, first: 1 },
    { index: 1, length: 20, first: 21 },
    { index: 2, length: 20, first: 41 },
    { index: 3, length: 13, first: 61 },
  ]);
  assert.equal(accumulator.processedTileCount, 4);
});

test("频谱瓦片使用统一 dBFS 标尺而不是按瓦片峰值重新归一化", () => {
  const loud = computeMediaAnalysisAssets(sineWave(16_000, 0.1, 220, 0.8), 16_000, 0)
    .find(({ kind, preset }) => kind === "spectrogram" && preset === "time-detail");
  const quiet = computeMediaAnalysisAssets(sineWave(16_000, 0.1, 220, 0.08), 16_000, 1)
    .find(({ kind, preset }) => kind === "spectrogram" && preset === "time-detail");
  assert.ok(loud && quiet);
  const loudTile = decodeMediaAnalysisTile(loud.bytes);
  const quietTile = decodeMediaAnalysisTile(quiet.bytes);
  assert.equal(loudTile.header.dbMax, 0);
  assert.equal(quietTile.header.dbMax, 0);
  assert.equal(loudTile.header.dbMin, quietTile.header.dbMin);
  assert.ok(
    Math.max(...loudTile.sections[0]) > Math.max(...quietTile.sections[0]),
    "较响瓦片应在同一标尺下保持更高亮度",
  );
});

function sineWave(sampleRate: number, duration: number, frequency: number, amplitude = 0.5) {
  return Float32Array.from(
    { length: Math.round(sampleRate * duration) },
    (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude,
  );
}
