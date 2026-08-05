import { computeMediaAnalysisSpectrogramTile } from "@xiqu/shared";
import type { SpectrogramAnalysisConfig } from "../types";

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

workerSelf.onmessage = (event: MessageEvent<ComputeSpectrogramMessage>) => {
  const message = event.data;
  if (message.type !== "compute-spectrogram") return;

  try {
    // 浏览器与后台 worker 共用同一纯算法，避免两套 STFT/YIN 随后产生不同研究结果。
    const data = computeMediaAnalysisSpectrogramTile(
      message.samples,
      message.sampleRate,
      message.duration,
      message.config,
      message.computePitch,
    );
    workerSelf.postMessage(
      { type: "spectrogram-result", data },
      [data.magnitudes.buffer, data.frequencyBins.buffer],
    );
  } catch (error) {
    workerSelf.postMessage({
      type: "spectrogram-error",
      message: error instanceof Error
        ? error.message
        : "Unknown spectrogram worker error",
    });
  }
};
