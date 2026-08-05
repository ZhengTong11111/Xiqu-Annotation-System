import type { WaveformData } from "../types";

const MAX_LOCAL_BROWSER_ANALYSIS_BYTES = 256 * 1024 * 1024;
const WAVEFORM_KEYPOINT_MIN_SPACING_SECONDS = 0.06;
const WAVEFORM_KEYPOINT_MAX_COUNT = 1600;
const WAVEFORM_KEYPOINT_FRAME_DURATION_SECONDS = 0.012;

/**
 * 本机编辑模式的小文件回退：只读取 Blob/本机 URL，并在完整下载前后分别检查上限。
 * 平台 uploaded/VOD 媒体不得调用这里，它们统一走服务端分块分析资产。
 */
export async function buildLocalWaveformData(
  mediaUrl: string,
  signal?: AbortSignal,
): Promise<WaveformData | null> {
  const AudioContextCtor = window.AudioContext || (window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }).webkitAudioContext;
  if (!AudioContextCtor) return null;

  const response = await fetch(mediaUrl, { signal });
  if (!response.ok) throw new Error(`无法读取本机媒体（HTTP ${response.status}）。`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_LOCAL_BROWSER_ANALYSIS_BYTES) {
    throw new Error("本机媒体超过浏览器分析上限，请改用平台后台分析或选择较小音频。");
  }
  const mediaBlob = await response.blob();
  if (mediaBlob.size > MAX_LOCAL_BROWSER_ANALYSIS_BYTES) {
    throw new Error("本机媒体超过浏览器分析上限，请改用平台后台分析或选择较小音频。");
  }
  signal?.throwIfAborted();
  const buffer = await mediaBlob.arrayBuffer();
  const audioContext = new AudioContextCtor();

  try {
    const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
    const mixedChannel = mixAudioBufferChannels(audioBuffer);
    return {
      samples: mixedChannel,
      sampleRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
      keypoints: detectWaveformKeypoints(
        mixedChannel,
        audioBuffer.sampleRate,
        audioBuffer.duration,
      ),
    };
  } finally {
    void audioContext.close();
  }
}

/** 多声道只在本机有界回退中混为单声道，避免时间轴为每个声道保留整段副本。 */
function mixAudioBufferChannels(audioBuffer: AudioBuffer) {
  const mixed = new Float32Array(audioBuffer.length);
  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < audioBuffer.length; sampleIndex += 1) {
      mixed[sampleIndex] += channelData[sampleIndex] / audioBuffer.numberOfChannels;
    }
  }
  return mixed;
}

/** 提取有界的能量起点供既有吸附预览使用；结果仅是浏览器缓存，不进入项目文件。 */
function detectWaveformKeypoints(
  samples: Float32Array,
  sampleRate: number,
  duration: number,
) {
  if (samples.length === 0 || sampleRate <= 0 || duration <= 0) return [];

  const frameSize = Math.max(64, Math.round(sampleRate * WAVEFORM_KEYPOINT_FRAME_DURATION_SECONDS));
  const hopSize = Math.max(32, Math.round(frameSize / 2));
  const envelopeLength = Math.max(1, Math.ceil(samples.length / hopSize));
  const envelope = new Float32Array(envelopeLength);
  for (let frameIndex = 0; frameIndex < envelopeLength; frameIndex += 1) {
    const start = frameIndex * hopSize;
    const end = Math.min(samples.length, start + frameSize);
    let rmsSum = 0;
    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const value = samples[sampleIndex] ?? 0;
      peak = Math.max(peak, Math.abs(value));
      rmsSum += value * value;
    }
    envelope[frameIndex] = peak * 0.55 + Math.sqrt(rmsSum / Math.max(1, end - start)) * 0.85;
  }

  const smoothed = new Float32Array(envelopeLength);
  for (let index = 0; index < envelopeLength; index += 1) {
    const previous = envelope[Math.max(0, index - 1)] ?? envelope[index] ?? 0;
    const current = envelope[index] ?? 0;
    const next = envelope[Math.min(envelopeLength - 1, index + 1)] ?? current;
    smoothed[index] = previous * 0.25 + current * 0.5 + next * 0.25;
  }

  let averageLevel = 0;
  const positiveDiffs: number[] = [];
  for (let index = 0; index < smoothed.length; index += 1) {
    averageLevel += smoothed[index] ?? 0;
    if (index > 0) {
      const diff = (smoothed[index] ?? 0) - (smoothed[index - 1] ?? 0);
      if (diff > 0) positiveDiffs.push(diff);
    }
  }
  averageLevel /= Math.max(smoothed.length, 1);
  const averagePositiveDiff = positiveDiffs.length > 0
    ? positiveDiffs.reduce((sum, value) => sum + value, 0) / positiveDiffs.length
    : 0;
  const onsetThreshold = Math.max(averagePositiveDiff * 1.8, averageLevel * 0.18, 0.01);
  const levelThreshold = Math.max(averageLevel * 0.6, 0.025);
  const keypoints: number[] = [];

  for (let index = 1; index < smoothed.length - 1; index += 1) {
    const current = smoothed[index] ?? 0;
    const previous = smoothed[index - 1] ?? 0;
    const next = smoothed[index + 1] ?? 0;
    if (current < levelThreshold || current - previous < onsetThreshold || current < next) continue;
    const time = Math.min(duration, (index * hopSize) / sampleRate);
    const previousTime = keypoints[keypoints.length - 1];
    if (previousTime !== undefined && time - previousTime < WAVEFORM_KEYPOINT_MIN_SPACING_SECONDS) {
      continue;
    }
    keypoints.push(time);
    if (keypoints.length >= WAVEFORM_KEYPOINT_MAX_COUNT) break;
  }
  return keypoints;
}
