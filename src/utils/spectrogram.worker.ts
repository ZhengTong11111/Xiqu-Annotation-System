import type { PitchFrame, SpectrogramAnalysisConfig, SpectrogramData } from "../types";

type ComputeSpectrogramMessage = {
  type: "compute-spectrogram";
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  config: SpectrogramAnalysisConfig;
  computePitch: boolean;
};

const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<ComputeSpectrogramMessage>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
const PITCH_MIN_FREQUENCY = 50;
const PITCH_MAX_FREQUENCY = 800;
const PITCH_TARGET_SAMPLE_RATE = 11025;
const PITCH_FRAME_STEP = 2;
const YIN_THRESHOLD = 0.14;

workerSelf.onmessage = (event: MessageEvent<ComputeSpectrogramMessage>) => {
  const message = event.data;
  if (message.type !== "compute-spectrogram") {
    return;
  }

  try {
    const data = computeSpectrogramData(
      message.samples,
      message.sampleRate,
      message.duration,
      message.config,
      message.computePitch,
    );
    workerSelf.postMessage(
      {
        type: "spectrogram-result",
        data,
      },
      [data.magnitudes.buffer, data.frequencyBins.buffer],
    );
  } catch (error) {
    workerSelf.postMessage({
      type: "spectrogram-error",
      message: error instanceof Error ? error.message : "Unknown spectrogram worker error",
    });
  }
};

function computeSpectrogramData(
  samples: Float32Array,
  sampleRate: number,
  duration: number,
  config: SpectrogramAnalysisConfig,
  computePitch: boolean,
): SpectrogramData {
  const analysisSampleRate = Math.min(
    sampleRate,
    Math.max(config.analysisSampleRate, config.maxFrequency * 2),
  );
  const analysisSamples = analysisSampleRate < sampleRate
    ? resampleLinear(samples, sampleRate, analysisSampleRate)
    : samples;
  const fftSize = config.fftSize;
  const hopLength = config.hopLength;
  if (!Number.isInteger(fftSize) || fftSize <= 0 || (fftSize & (fftSize - 1)) !== 0) {
    throw new Error("Spectrogram fftSize must be a positive power of two.");
  }
  if (!Number.isInteger(hopLength) || hopLength <= 0) {
    throw new Error("Spectrogram hopLength must be positive.");
  }

  const nyquist = analysisSampleRate / 2;
  const maxFrequency = Math.min(config.maxFrequency, nyquist);
  const minFrequency = Math.max(0, Math.min(config.minFrequency, maxFrequency));
  const frequencyBinCount = Math.max(64, Math.min(config.outputFrequencyBinCount, fftSize / 2));
  const frameCount = Math.max(1, Math.ceil(analysisSamples.length / hopLength));
  const window = buildHannWindow(fftSize);
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  const frequencyBins = new Float32Array(frequencyBinCount);
  const sourceBins = new Uint16Array(frequencyBinCount);
  const rawDb = new Float32Array(frameCount * frequencyBinCount);
  let maxDb = Number.NEGATIVE_INFINITY;

  for (let binIndex = 0; binIndex < frequencyBinCount; binIndex += 1) {
    const unit = frequencyBinCount === 1 ? 0 : binIndex / (frequencyBinCount - 1);
    const frequency = minFrequency + (maxFrequency - minFrequency) * unit;
    frequencyBins[binIndex] = frequency;
    sourceBins[binIndex] = Math.max(
      1,
      Math.min(fftSize / 2, Math.round((frequency / analysisSampleRate) * fftSize)),
    );
  }

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frameStart = frameIndex * hopLength;
    real.fill(0);
    imag.fill(0);
    for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex += 1) {
      real[sampleIndex] = (analysisSamples[frameStart + sampleIndex] ?? 0) * window[sampleIndex];
    }

    fftRadix2(real, imag);

    const frameOffset = frameIndex * frequencyBinCount;
    for (let binIndex = 0; binIndex < frequencyBinCount; binIndex += 1) {
      const sourceBin = sourceBins[binIndex];
      const magnitude = Math.hypot(real[sourceBin] ?? 0, imag[sourceBin] ?? 0) / fftSize;
      const db = 20 * Math.log10(Math.max(magnitude, 1e-12));
      rawDb[frameOffset + binIndex] = db;
      if (db > maxDb) {
        maxDb = db;
      }
    }
  }

  const dbMax = Number.isFinite(maxDb) ? maxDb : 0;
  const dbMin = dbMax - config.dynamicRangeDb;
  const magnitudes = new Uint8Array(rawDb.length);
  const dbScale = 255 / Math.max(dbMax - dbMin, 1);
  for (let index = 0; index < rawDb.length; index += 1) {
    const normalized = Math.round((rawDb[index] - dbMin) * dbScale);
    magnitudes[index] = Math.max(0, Math.min(255, normalized));
  }

  return {
    magnitudes,
    frequencyBins,
    frameCount,
    frequencyBinCount,
    sampleRate: analysisSampleRate,
    duration,
    hopLength,
    fftSize,
    minFrequency,
    maxFrequency,
    dbMin,
    dbMax,
    pitchFrames: computePitch
      ? estimatePitchContour(analysisSamples, analysisSampleRate, frameCount, hopLength)
      : undefined,
  };
}

function resampleLinear(samples: Float32Array, sourceSampleRate: number, targetSampleRate: number) {
  const ratio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.max(1, Math.floor(samples.length / ratio));
  const resampled = new Float32Array(targetLength);
  for (let index = 0; index < targetLength; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const weight = sourcePosition - leftIndex;
    const left = samples[leftIndex] ?? 0;
    const right = samples[rightIndex] ?? left;
    resampled[index] = left + (right - left) * weight;
  }
  return resampled;
}

function buildHannWindow(size: number) {
  const window = new Float32Array(size);
  const denominator = Math.max(1, size - 1);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / denominator);
  }
  return window;
}

function fftRadix2(real: Float32Array, imag: Float32Array) {
  const size = real.length;
  let reversed = 0;
  for (let index = 1; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) {
      reversed ^= bit;
    }
    reversed ^= bit;
    if (index < reversed) {
      const realValue = real[index];
      real[index] = real[reversed];
      real[reversed] = realValue;
      const imagValue = imag[index];
      imag[index] = imag[reversed];
      imag[reversed] = imagValue;
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      const halfLength = length >> 1;
      for (let offset = 0; offset < halfLength; offset += 1) {
        const evenIndex = start + offset;
        const oddIndex = evenIndex + halfLength;
        const oddReal = real[oddIndex] * twiddleReal - imag[oddIndex] * twiddleImag;
        const oddImag = real[oddIndex] * twiddleImag + imag[oddIndex] * twiddleReal;
        real[oddIndex] = real[evenIndex] - oddReal;
        imag[oddIndex] = imag[evenIndex] - oddImag;
        real[evenIndex] += oddReal;
        imag[evenIndex] += oddImag;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
}

function estimatePitchContour(
  samples: Float32Array,
  sampleRate: number,
  frameCount: number,
  hopLength: number,
): PitchFrame[] {
  const downsampleFactor = Math.max(1, Math.round(sampleRate / PITCH_TARGET_SAMPLE_RATE));
  const analysisSampleRate = sampleRate / downsampleFactor;
  const analysisSamples = downsampleForPitch(samples, downsampleFactor);
  const analysisHop = Math.max(1, Math.round(hopLength / downsampleFactor));
  const pitchFrameSize = Math.max(1024, nextPowerOfTwo(Math.round(analysisSampleRate * 0.08)));
  const pitchFrames: PitchFrame[] = [];
  let previousFrequency = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += PITCH_FRAME_STEP) {
    const analysisStart = frameIndex * analysisHop;
    const pitch = estimatePitchYinFrame(
      analysisSamples,
      analysisStart,
      pitchFrameSize,
      analysisSampleRate,
      previousFrequency,
    );
    previousFrequency = pitch.voiced ? pitch.frequency : previousFrequency;
    pitchFrames.push({
      time: (frameIndex * hopLength) / sampleRate + pitchFrameSize / 2 / analysisSampleRate,
      ...pitch,
    });
  }

  return pitchFrames;
}

function downsampleForPitch(samples: Float32Array, factor: number) {
  if (factor <= 1) {
    return samples;
  }
  const length = Math.ceil(samples.length / factor);
  const downsampled = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    let count = 0;
    const sourceStart = index * factor;
    for (let offset = 0; offset < factor; offset += 1) {
      const value = samples[sourceStart + offset];
      if (value === undefined) {
        continue;
      }
      sum += value;
      count += 1;
    }
    downsampled[index] = count > 0 ? sum / count : 0;
  }
  return downsampled;
}

function estimatePitchYinFrame(
  samples: Float32Array,
  frameStart: number,
  frameSize: number,
  sampleRate: number,
  previousFrequency: number,
) {
  const minTau = Math.max(2, Math.floor(sampleRate / PITCH_MAX_FREQUENCY));
  const maxTau = Math.min(frameSize - 2, Math.ceil(sampleRate / PITCH_MIN_FREQUENCY));
  const analysisStep = 2;
  const difference = new Float32Array(maxTau + 1);
  let frameEnergy = 0;
  let energyCount = 0;

  for (let sampleIndex = 0; sampleIndex < frameSize; sampleIndex += analysisStep) {
    const value = samples[frameStart + sampleIndex] ?? 0;
    frameEnergy += value * value;
    energyCount += 1;
  }

  const rms = Math.sqrt(frameEnergy / Math.max(energyCount, 1));
  if (rms < 0.008) {
    return { frequency: 0, confidence: 0, voiced: false };
  }

  for (let tau = minTau; tau <= maxTau; tau += 1) {
    let sum = 0;
    const limit = frameSize - tau;
    for (let sampleIndex = 0; sampleIndex < limit; sampleIndex += analysisStep) {
      const delta = (samples[frameStart + sampleIndex] ?? 0) - (samples[frameStart + sampleIndex + tau] ?? 0);
      sum += delta * delta;
    }
    difference[tau] = sum;
  }

  let runningSum = 0;
  let bestTau = 0;
  let bestValue = Number.POSITIVE_INFINITY;
  for (let tau = minTau; tau <= maxTau; tau += 1) {
    runningSum += difference[tau];
    const normalized = runningSum > 0 ? (difference[tau] * tau) / runningSum : 1;
    difference[tau] = normalized;
    if (normalized < bestValue) {
      bestValue = normalized;
      bestTau = tau;
    }
    if (tau > minTau && normalized < YIN_THRESHOLD && normalized <= difference[tau - 1]) {
      while (tau + 1 <= maxTau && difference[tau + 1] < difference[tau]) {
        tau += 1;
      }
      bestTau = tau;
      bestValue = difference[tau];
      break;
    }
  }

  if (bestTau <= 0 || bestValue > 0.32) {
    return { frequency: 0, confidence: 0, voiced: false };
  }

  const refinedTau = refineTauParabolic(difference, bestTau, minTau, maxTau);
  const frequency = sampleRate / refinedTau;
  const confidence = Math.max(0, Math.min(1, 1 - bestValue));
  const jumpRatio = previousFrequency > 0
    ? Math.max(frequency, previousFrequency) / Math.max(Math.min(frequency, previousFrequency), 1)
    : 1;
  const voiced = confidence >= 0.68 && jumpRatio < 2.4;
  return {
    frequency: voiced ? frequency : 0,
    confidence: voiced ? confidence : 0,
    voiced,
  };
}

function refineTauParabolic(values: Float32Array, tau: number, minTau: number, maxTau: number) {
  if (tau <= minTau || tau >= maxTau) {
    return tau;
  }
  const left = values[tau - 1];
  const center = values[tau];
  const right = values[tau + 1];
  const denominator = left - 2 * center + right;
  if (Math.abs(denominator) < 1e-8) {
    return tau;
  }
  return tau + (left - right) / (2 * denominator);
}

function nextPowerOfTwo(value: number) {
  let power = 1;
  while (power < value) {
    power <<= 1;
  }
  return power;
}
