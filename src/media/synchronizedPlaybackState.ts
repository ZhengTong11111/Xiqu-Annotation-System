import { isStableMediaAudioIdentity } from "@xiqu/shared";

export type SynchronizedPlaybackPhase =
  | "original"
  | "preparing_external"
  | "ready_paused"
  | "starting"
  | "playing_synced"
  | "resyncing"
  | "buffering_external"
  | "error_external"
  | "disposed";

export type SynchronizedPlaybackState = {
  phase: SynchronizedPlaybackPhase;
  sourceGeneration: number;
  selectedTrackId: string | null;
  desiredPlayback: "paused" | "playing";
  errorCode: string | null;
};

export type SynchronizedPlaybackEvent =
  | { type: "select_original"; desiredPlayback: "paused" | "playing" }
  | {
      type: "select_external";
      trackId: string;
      desiredPlayback: "paused" | "playing";
    }
  | { type: "select_unavailable"; trackId: string; errorCode: string }
  | { type: "suspend_selection"; errorCode: string }
  | { type: "external_ready"; generation: number }
  | { type: "play_requested" }
  | { type: "pause_requested" }
  | { type: "external_started"; generation: number }
  | { type: "external_buffering"; generation: number }
  | { type: "external_recovered"; generation: number }
  | { type: "resync_required"; generation: number }
  | { type: "resync_completed"; generation: number }
  | { type: "external_failed"; generation: number; errorCode: string }
  | { type: "dispose" };

export type SynchronizedPlaybackTransition = {
  status: "applied" | "stale_event" | "invalid_transition";
  state: SynchronizedPlaybackState;
};

export const INITIAL_SYNCHRONIZED_PLAYBACK_STATE: SynchronizedPlaybackState =
  Object.freeze({
    phase: "original",
    sourceGeneration: 0,
    selectedTrackId: null,
    desiredPlayback: "paused",
    errorCode: null,
  });

const isGenerationEvent = (
  event: SynchronizedPlaybackEvent,
): event is Extract<SynchronizedPlaybackEvent, { generation: number }> =>
  "generation" in event;

const applied = (
  state: SynchronizedPlaybackState,
): SynchronizedPlaybackTransition => ({ status: "applied", state });

const invalid = (
  state: SynchronizedPlaybackState,
): SynchronizedPlaybackTransition => ({ status: "invalid_transition", state });

const isStableErrorCode = (value: string) =>
  value.length >= 1 &&
  value.length <= 128 &&
  /^[a-z0-9][a-z0-9_.-]*$/u.test(value);

// 状态机只接收稳定身份和播放意图；媒体元素、临时 URL 与供应商凭据始终由后续 backend owner 管理。
export function reduceSynchronizedPlaybackState(
  state: SynchronizedPlaybackState,
  event: SynchronizedPlaybackEvent,
): SynchronizedPlaybackTransition {
  if (state.phase === "disposed") {
    return event.type === "dispose" ? applied(state) : invalid(state);
  }

  // 浏览器和供应商事件可能在切换音轨后迟到；generation 是唯一有效来源边界。
  if (isGenerationEvent(event) && event.generation !== state.sourceGeneration) {
    return { status: "stale_event", state };
  }

  if (event.type === "dispose") {
    return applied({
      phase: "disposed",
      sourceGeneration: state.sourceGeneration + 1,
      selectedTrackId: null,
      desiredPlayback: "paused",
      errorCode: null,
    });
  }

  if (event.type === "select_original") {
    return applied({
      phase: "original",
      sourceGeneration: state.sourceGeneration + 1,
      selectedTrackId: null,
      desiredPlayback: event.desiredPlayback,
      errorCode: null,
    });
  }

  if (event.type === "select_external") {
    if (!isStableMediaAudioIdentity(event.trackId)) return invalid(state);
    return applied({
      phase: "preparing_external",
      sourceGeneration: state.sourceGeneration + 1,
      selectedTrackId: event.trackId,
      desiredPlayback: event.desiredPlayback,
      errorCode: null,
    });
  }

  if (event.type === "select_unavailable") {
    if (
      !isStableMediaAudioIdentity(event.trackId) ||
      !isStableErrorCode(event.errorCode)
    ) {
      return invalid(state);
    }
    return applied({
      phase: "error_external",
      sourceGeneration: state.sourceGeneration + 1,
      selectedTrackId: event.trackId,
      desiredPlayback: "paused",
      errorCode: event.errorCode,
    });
  }

  if (event.type === "suspend_selection") {
    if (!isStableErrorCode(event.errorCode)) return invalid(state);
    return applied({
      phase: "error_external",
      sourceGeneration: state.sourceGeneration + 1,
      selectedTrackId: null,
      desiredPlayback: "paused",
      errorCode: event.errorCode,
    });
  }

  if (event.type === "play_requested") {
    if (state.phase === "original") {
      return applied({ ...state, desiredPlayback: "playing" });
    }
    if (state.phase === "preparing_external" || state.phase === "buffering_external") {
      return applied({ ...state, desiredPlayback: "playing" });
    }
    if (state.phase === "ready_paused") {
      return applied({ ...state, phase: "starting", desiredPlayback: "playing" });
    }
    if (state.phase === "starting" || state.phase === "playing_synced") {
      return applied({ ...state, desiredPlayback: "playing" });
    }
    return invalid(state);
  }

  if (event.type === "pause_requested") {
    if (state.phase === "original") {
      return applied({ ...state, desiredPlayback: "paused" });
    }
    if (state.phase === "preparing_external" || state.phase === "error_external") {
      return applied({ ...state, desiredPlayback: "paused" });
    }
    if (
      state.phase === "ready_paused" ||
      state.phase === "starting" ||
      state.phase === "playing_synced" ||
      state.phase === "resyncing" ||
      state.phase === "buffering_external"
    ) {
      return applied({
        ...state,
        phase: "ready_paused",
        desiredPlayback: "paused",
      });
    }
    return invalid(state);
  }

  if (event.type === "external_ready") {
    // ready/canplay 在浏览器中可能重复到达；同一来源已经就绪后将其视为幂等事实。
    if (
      state.phase === "ready_paused" ||
      state.phase === "starting" ||
      state.phase === "playing_synced"
    ) {
      return applied(state);
    }
    if (state.phase !== "preparing_external") return invalid(state);
    return applied({
      ...state,
      phase: state.desiredPlayback === "playing" ? "starting" : "ready_paused",
    });
  }

  if (event.type === "external_started") {
    if (state.phase === "playing_synced") return applied(state);
    if (state.phase !== "starting") return invalid(state);
    return applied({ ...state, phase: "playing_synced", desiredPlayback: "playing" });
  }

  if (event.type === "external_buffering") {
    if (state.phase === "buffering_external") return applied(state);
    if (
      state.phase !== "starting" &&
      state.phase !== "playing_synced" &&
      state.phase !== "resyncing"
    ) {
      return invalid(state);
    }
    return applied({ ...state, phase: "buffering_external" });
  }

  if (event.type === "external_recovered") {
    if (state.phase === "resyncing") return applied(state);
    if (state.phase !== "buffering_external") return invalid(state);
    return applied({ ...state, phase: "resyncing" });
  }

  if (event.type === "resync_required") {
    if (state.phase === "resyncing") return applied(state);
    if (state.phase !== "starting" && state.phase !== "playing_synced") {
      return invalid(state);
    }
    return applied({ ...state, phase: "resyncing" });
  }

  if (event.type === "resync_completed") {
    if (state.phase !== "resyncing") return invalid(state);
    return applied({
      ...state,
      phase: state.desiredPlayback === "playing" ? "starting" : "ready_paused",
    });
  }

  if (event.type === "external_failed") {
    if (!isStableErrorCode(event.errorCode) || state.phase === "original") {
      return invalid(state);
    }
    if (state.phase === "error_external") {
      return event.errorCode === state.errorCode ? applied(state) : invalid(state);
    }
    return applied({
      ...state,
      phase: "error_external",
      desiredPlayback: "paused",
      errorCode: event.errorCode,
    });
  }

  return invalid(state);
}
