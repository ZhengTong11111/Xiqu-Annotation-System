export const SYNCHRONIZED_AUDIO_DRIFT_POLICY = Object.freeze({
  toleranceSeconds: 0.04,
  hardResyncSeconds: 0.15,
  mediumSamplesBeforeResync: 2,
});

export type ExternalAudioTimelinePosition =
  | { status: "invalid_time" }
  | { status: "before_start"; audioTime: 0 }
  | { status: "playable"; audioTime: number }
  | { status: "after_end"; audioTime: number };

export type DriftObservationState = {
  readonly consecutiveMediumSamples: number;
  readonly direction: -1 | 0 | 1;
};

export type ExternalAudioDriftDecision =
  | {
      action: "invalid_time";
      driftSeconds: null;
      nextObservation: DriftObservationState;
    }
  | {
      action: "within_tolerance" | "observe";
      driftSeconds: number;
      nextObservation: DriftObservationState;
    }
  | {
      action: "hard_resync";
      reason: "forced" | "large_drift" | "confirmed_medium_drift";
      driftSeconds: number;
      nextObservation: DriftObservationState;
    };

export const EMPTY_DRIFT_OBSERVATION: DriftObservationState = Object.freeze({
  consecutiveMediumSamples: 0,
  direction: 0,
});

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

function getDriftDirection(driftSeconds: number): -1 | 1 {
  return driftSeconds < 0 ? -1 : 1;
}

// 中等漂移只有同方向连续出现才触发重同步，避免一次媒体事件抖动造成可感知的硬 seek。
export function classifyExternalAudioDrift(input: {
  actualAudioTime: number;
  expectedAudioTime: number;
  previousObservation?: DriftObservationState;
  forceHardResync?: boolean;
}): ExternalAudioDriftDecision {
  const previous = input.previousObservation ?? EMPTY_DRIFT_OBSERVATION;
  if (
    !Number.isFinite(input.actualAudioTime) ||
    !Number.isFinite(input.expectedAudioTime) ||
    input.actualAudioTime < 0 ||
    input.expectedAudioTime < 0 ||
    !Number.isInteger(previous.consecutiveMediumSamples) ||
    previous.consecutiveMediumSamples < 0 ||
    ![-1, 0, 1].includes(previous.direction)
  ) {
    return {
      action: "invalid_time",
      driftSeconds: null,
      nextObservation: EMPTY_DRIFT_OBSERVATION,
    };
  }

  const driftSeconds = input.actualAudioTime - input.expectedAudioTime;
  if (input.forceHardResync) {
    return {
      action: "hard_resync",
      reason: "forced",
      driftSeconds,
      nextObservation: EMPTY_DRIFT_OBSERVATION,
    };
  }

  const absoluteDrift = Math.abs(driftSeconds);
  if (absoluteDrift <= SYNCHRONIZED_AUDIO_DRIFT_POLICY.toleranceSeconds) {
    return {
      action: "within_tolerance",
      driftSeconds,
      nextObservation: EMPTY_DRIFT_OBSERVATION,
    };
  }
  if (absoluteDrift > SYNCHRONIZED_AUDIO_DRIFT_POLICY.hardResyncSeconds) {
    return {
      action: "hard_resync",
      reason: "large_drift",
      driftSeconds,
      nextObservation: EMPTY_DRIFT_OBSERVATION,
    };
  }

  const direction = getDriftDirection(driftSeconds);
  const consecutiveMediumSamples = previous.direction === direction
    ? previous.consecutiveMediumSamples + 1
    : 1;
  if (
    consecutiveMediumSamples >=
    SYNCHRONIZED_AUDIO_DRIFT_POLICY.mediumSamplesBeforeResync
  ) {
    return {
      action: "hard_resync",
      reason: "confirmed_medium_drift",
      driftSeconds,
      nextObservation: EMPTY_DRIFT_OBSERVATION,
    };
  }
  return {
    action: "observe",
    driftSeconds,
    nextObservation: { consecutiveMediumSamples, direction },
  };
}
