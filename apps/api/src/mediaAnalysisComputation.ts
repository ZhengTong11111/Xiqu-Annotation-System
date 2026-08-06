import {
  computeMediaAnalysisSpectrogramTile,
  computeMediaAnalysisWaveformBuckets,
  encodeFloat32LittleEndian,
  encodeMediaAnalysisTile,
  type MediaAnalysisAssetKind,
  type MediaAnalysisSpectrogramConfig,
} from "@xiqu/shared";

export const MEDIA_ANALYSIS_TILE_DURATION_SECONDS = 10;
// 每个层级都整除 10 秒 * 16 kHz，客户端跨瓦片拼接时不会累积桶宽误差。
export const MEDIA_ANALYSIS_WAVEFORM_LEVELS = [64, 256, 1000, 4000] as const;
export const MEDIA_ANALYSIS_SPECTROGRAM_PRESETS = {
  "time-detail": {
    analysisPreset: "time-detail",
    fftSize: 1024,
    hopLength: 128,
    minFrequency: 50,
    maxFrequency: 8000,
    dynamicRangeDb: 85,
    analysisSampleRate: 16000,
    outputFrequencyBinCount: 512,
  },
  "frequency-detail": {
    analysisPreset: "frequency-detail",
    fftSize: 4096,
    // 400 个采样点正好把 10 秒瓦片分成 400 帧，避免每块半帧误差累积为时间漂移。
    hopLength: 400,
    minFrequency: 50,
    maxFrequency: 8000,
    dynamicRangeDb: 85,
    analysisSampleRate: 16000,
    outputFrequencyBinCount: 512,
  },
} satisfies Record<string, MediaAnalysisSpectrogramConfig>;

export type ComputedMediaAnalysisAsset = {
  kind: MediaAnalysisAssetKind;
  preset: string;
  level: number;
  tileIndex: number;
  startTime: number;
  endTime: number;
  mimeType: string;
  bytes: Uint8Array;
};

/**
 * 将任意 FFmpeg stdout 分片收敛为固定 10 秒 PCM 瓦片。
 * pending 上限始终小于“一瓦片 + 一个 stdout chunk”，不会随媒体时长增长。
 */
export class MediaAnalysisPcmTileAccumulator {
  private pending: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private tileIndex = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly consumeTile: (
      samples: Float32Array,
      tileIndex: number,
    ) => Promise<void>,
  ) {}

  async push(samples: Float32Array) {
    this.pending = concatenateFloat32(this.pending, samples);
    const tileSampleCount = this.sampleRate * MEDIA_ANALYSIS_TILE_DURATION_SECONDS;
    while (this.pending.length >= tileSampleCount) {
      const tile = new Float32Array(this.pending.slice(0, tileSampleCount));
      this.pending = this.pending.slice(tileSampleCount);
      await this.consumeTile(tile, this.tileIndex);
      this.tileIndex += 1;
    }
  }

  async finish() {
    if (this.pending.length === 0) return;
    const tile = new Float32Array(this.pending);
    this.pending = new Float32Array(0);
    await this.consumeTile(tile, this.tileIndex);
    this.tileIndex += 1;
  }

  get processedTileCount() {
    return this.tileIndex;
  }
}

/** 为一个有界 PCM 瓦片生成波形层级、两种频谱预设和 voiced-only F0。 */
export function computeMediaAnalysisAssets(
  samples: Float32Array,
  sampleRate: number,
  tileIndex: number,
): ComputedMediaAnalysisAsset[] {
  const startTime = tileIndex * MEDIA_ANALYSIS_TILE_DURATION_SECONDS;
  const duration = samples.length / sampleRate;
  const endTime = startTime + duration;
  const assets: ComputedMediaAnalysisAsset[] = [];

  for (let level = 0; level < MEDIA_ANALYSIS_WAVEFORM_LEVELS.length; level += 1) {
    const samplesPerBucket = MEDIA_ANALYSIS_WAVEFORM_LEVELS[level];
    const buckets = computeMediaAnalysisWaveformBuckets(samples, samplesPerBucket);
    const values = new Float32Array(buckets.length * 3);
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      values[index * 3] = bucket.min;
      values[index * 3 + 1] = bucket.max;
      values[index * 3 + 2] = bucket.rms;
    }
    assets.push({
      kind: "waveform",
      preset: "default",
      level,
      tileIndex,
      startTime,
      endTime,
      mimeType: "application/vnd.xiqu.waveform-tile",
      bytes: encodeMediaAnalysisTile({
        version: 1,
        kind: "waveform",
        sampleRate,
        samplesPerBucket,
        bucketCount: buckets.length,
      }, [encodeFloat32LittleEndian(values)]),
    });
  }

  for (const [preset, config] of Object.entries(MEDIA_ANALYSIS_SPECTROGRAM_PRESETS)) {
    const spectrogram = computeMediaAnalysisSpectrogramTile(
      samples,
      sampleRate,
      duration,
      config,
      preset === "time-detail",
    );
    assets.push({
      kind: "spectrogram",
      preset,
      level: 0,
      tileIndex,
      startTime,
      endTime,
      mimeType: "application/vnd.xiqu.spectrogram-tile",
      bytes: encodeMediaAnalysisTile({
        version: 1,
        kind: "spectrogram",
        frameCount: spectrogram.frameCount,
        frequencyBinCount: spectrogram.frequencyBinCount,
        sampleRate: spectrogram.sampleRate,
        duration: spectrogram.duration,
        hopLength: spectrogram.hopLength,
        fftSize: spectrogram.fftSize,
        minFrequency: spectrogram.minFrequency,
        maxFrequency: spectrogram.maxFrequency,
        dbMin: spectrogram.dbMin,
        dbMax: spectrogram.dbMax,
      }, [
        spectrogram.magnitudes,
        encodeFloat32LittleEndian(spectrogram.frequencyBins),
      ]),
    });

    if (preset === "time-detail") {
      const voiced = (spectrogram.pitchFrames ?? []).filter((frame) => frame.voiced);
      const values = new Float32Array(voiced.length * 3);
      for (let index = 0; index < voiced.length; index += 1) {
        const frame = voiced[index];
        values[index * 3] = frame.time;
        values[index * 3 + 1] = frame.frequency;
        values[index * 3 + 2] = frame.confidence;
      }
      assets.push({
        kind: "pitch",
        preset: "yin-v1",
        level: 0,
        tileIndex,
        startTime,
        endTime,
        mimeType: "application/vnd.xiqu.pitch-tile",
        bytes: encodeMediaAnalysisTile({
          version: 1,
          kind: "pitch",
          frameCount: voiced.length,
        }, [encodeFloat32LittleEndian(values)]),
      });
    }
  }
  return assets;
}

function concatenateFloat32(left: Float32Array, right: Float32Array) {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;
  const output = new Float32Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}
