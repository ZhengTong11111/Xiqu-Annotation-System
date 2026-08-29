export const SYNCHRONIZED_AUDIO_DRIFT_POLICY = Object.freeze({
  toleranceSeconds: 0.01,
  hardResyncSeconds: 0.15,
  maximumRateCorrection: 0.04,
  proportionalRateGain: 2,
});

export type ExternalAudioTimelinePosition =
  | { status: "invalid_time" }
  | { status: "before_start"; audioTime: 0 }
  | { status: "playable"; audioTime: number }
  | { status: "after_end"; audioTime: number };

export type ExternalAudioDriftDecision =
  | {
      action: "invalid_time";
      driftSeconds: null;
    }
  | {
      action: "within_tolerance";
      driftSeconds: number;
      playbackRateMultiplier: 1;
    }
  | {
      action: "adjust_rate";
      driftSeconds: number;
      playbackRateMultiplier: number;
    }
  | {
      action: "hard_resync";
      reason: "forced" | "large_drift";
      driftSeconds: number;
    };

// 音轨偏移只改变源时间到项目时间的映射，不参与分析 run 身份或重新计算。
export function mapMasterTimeToAudioTime(input: {
  masterTime: number;
  offsetSeconds: number;
  audioDuration: number | null;
}): ExternalAudioTimelinePosition {
  if (
    !Number.isFinite(input.masterTime) ||
    input.masterTime < 0 ||
    !Number.isFinite(input.offsetSeconds) ||
    (input.audioDuration !== null &&
      (!Number.isFinite(input.audioDuration) || input.audioDuration < 0))
  ) {
    return { status: "invalid_time" };
  }

  const audioTime = input.masterTime - input.offsetSeconds;
  if (!Number.isFinite(audioTime)) return { status: "invalid_time" };
  if (audioTime < 0) return { status: "before_start", audioTime: 0 };
  if (input.audioDuration !== null && audioTime >= input.audioDuration) {
    return { status: "after_end", audioTime };
  }
  return { status: "playable", audioTime };
}

/**
 * 10 ms 以内不干预；中等漂移通过小幅速率伺服平滑追回，只有大漂移才硬 seek。
 * multiplier 大于 1 表示从音轨落后，需要暂时加速；小于 1 表示从音轨超前。
 */
export function classifyExternalAudioDrift(input: {
  actualAudioTime: number;
  expectedAudioTime: number;
  forceHardResync?: boolean;
  hardResyncSeconds?: number;
}): ExternalAudioDriftDecision {
  if (
    !Number.isFinite(input.actualAudioTime) ||
    !Number.isFinite(input.expectedAudioTime) ||
    input.actualAudioTime < 0 ||
    input.expectedAudioTime < 0
  ) {
    return {
      action: "invalid_time",
      driftSeconds: null,
    };
  }

  const driftSeconds = input.actualAudioTime - input.expectedAudioTime;
  if (input.forceHardResync) {
    return {
      action: "hard_resync",
      reason: "forced",
      driftSeconds,
    };
  }

  const absoluteDrift = Math.abs(driftSeconds);
  if (absoluteDrift <= SYNCHRONIZED_AUDIO_DRIFT_POLICY.toleranceSeconds) {
    return {
      action: "within_tolerance",
      driftSeconds,
      playbackRateMultiplier: 1,
    };
  }
  const configuredHardResyncSeconds = input.hardResyncSeconds;
  const hardResyncSeconds = typeof configuredHardResyncSeconds === "number" &&
      Number.isFinite(configuredHardResyncSeconds) &&
      configuredHardResyncSeconds >= SYNCHRONIZED_AUDIO_DRIFT_POLICY.toleranceSeconds
    ? configuredHardResyncSeconds
    : SYNCHRONIZED_AUDIO_DRIFT_POLICY.hardResyncSeconds;
  if (absoluteDrift > hardResyncSeconds) {
    return {
      action: "hard_resync",
      reason: "large_drift",
      driftSeconds,
    };
  }

  const unclampedCorrection = -driftSeconds *
    SYNCHRONIZED_AUDIO_DRIFT_POLICY.proportionalRateGain;
  const boundedCorrection = Math.max(
    -SYNCHRONIZED_AUDIO_DRIFT_POLICY.maximumRateCorrection,
    Math.min(
      SYNCHRONIZED_AUDIO_DRIFT_POLICY.maximumRateCorrection,
      unclampedCorrection,
    ),
  );
  return {
    action: "adjust_rate",
    driftSeconds,
    playbackRateMultiplier: 1 + boundedCorrection,
  };
}

/**
 * 恢复播放前只判断两条媒体是否已经足够接近，不推进周期采样使用的连续漂移状态。
 * 已经位于 10 ms 容差内时重复 seek 只会清空浏览器解码缓冲，并制造一次可感知的停顿。
 */
export function isExternalAudioWithinSyncTolerance(input: {
  actualAudioTime: number;
  expectedAudioTime: number;
}) {
  return classifyExternalAudioDrift(input).action === "within_tolerance";
}
