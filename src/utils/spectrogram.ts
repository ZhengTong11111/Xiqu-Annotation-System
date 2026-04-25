import type {
  SpectrogramAnalysisConfig,
  SpectrogramData,
  SpectrogramFrequencyPreset,
  SpectrogramSettings,
  WaveformData,
} from "../types";

export const spectrogramFrequencyPresets: Record<
  SpectrogramFrequencyPreset,
  { label: string; minFrequency: number; maxFrequency: number }
> = {
  "full-vocal": {
    label: "50-8000 Hz",
    minFrequency: 50,
    maxFrequency: 8000,
  },
  "vocal-2000": {
    label: "人声细节 50-2000 Hz",
    minFrequency: 50,
    maxFrequency: 2000,
  },
  "vocal-1500": {
    label: "人声细节 50-1500 Hz",
    minFrequency: 50,
    maxFrequency: 1500,
  },
};

export const defaultSpectrogramSettings: SpectrogramSettings = {
  visible: true,
  showPitchContour: false,
  frequencyScale: "log",
  frequencyPreset: "full-vocal",
};

export const defaultSpectrogramAnalysisConfig: SpectrogramAnalysisConfig = {
  fftSize: 4096,
  hopLength: 512,
  windowType: "hann",
  minFrequency: 50,
  maxFrequency: 8000,
  dynamicRangeDb: 85,
  analysisSampleRate: 16000,
  outputFrequencyBinCount: 512,
};

export function getSpectrogramFrequencyRange(settings: SpectrogramSettings) {
  const preset = spectrogramFrequencyPresets[settings.frequencyPreset];
  return {
    minFrequency: preset.minFrequency,
    maxFrequency: preset.maxFrequency,
  };
}

export function buildSpectrogramData(
  waveformData: WaveformData,
  computePitch: boolean,
  signal?: AbortSignal,
) {
  const samples = new Float32Array(waveformData.samples);
  const worker = new Worker(new URL("./spectrogram.worker.ts", import.meta.url), {
    type: "module",
  });

  return new Promise<SpectrogramData | null>((resolve, reject) => {
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      worker.terminate();
      signal?.removeEventListener("abort", handleAbort);
      callback();
    };

    const handleAbort = () => {
      finish(() => resolve(null));
    };

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: "spectrogram-result"; data: SpectrogramData }
        | { type: "spectrogram-error"; message: string };
      if (message.type === "spectrogram-error") {
        finish(() => reject(new Error(message.message)));
        return;
      }
      finish(() => resolve(message.data));
    };

    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message)));
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }

    worker.postMessage(
      {
        type: "compute-spectrogram",
        samples,
        sampleRate: waveformData.sampleRate,
        duration: waveformData.duration,
        config: defaultSpectrogramAnalysisConfig,
        computePitch,
      },
      [samples.buffer],
    );
  });
}
