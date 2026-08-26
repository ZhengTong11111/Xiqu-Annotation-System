export type SynchronizedDriftResyncReason =
  | "forced"
  | "large_drift"
  | "confirmed_medium_drift";

export type SynchronizedPlaybackDiagnostic =
  | {
      kind: "drift_resync";
      phase: "started" | "succeeded" | "failed";
      reason: SynchronizedDriftResyncReason;
      driftMilliseconds: number;
    }
  | {
      kind: "buffering";
      phase: "started";
      durationMilliseconds: null;
    }
  | {
      kind: "buffering";
      phase: "recovery_started" | "recovered" | "failed";
      durationMilliseconds: number;
    };

const MAX_ABSOLUTE_DRIFT_MILLISECONDS = 60_000;
const MAX_BUFFERING_DURATION_MILLISECONDS = 3_600_000;

/** 漂移诊断只保留有限整数毫秒；极端媒体值不能扩散成无界遥测。 */
export function normalizeDiagnosticDriftMilliseconds(driftSeconds: number) {
  if (!Number.isFinite(driftSeconds)) return null;
  return clampInteger(
    Math.round(driftSeconds * 1_000),
    -MAX_ABSOLUTE_DRIFT_MILLISECONDS,
    MAX_ABSOLUTE_DRIFT_MILLISECONDS,
  );
}

/** 缓冲时长来自单调时钟，负值或非有限值说明时钟事实无效，应拒绝而不是伪造为零。 */
export function normalizeBufferingDurationMilliseconds(durationMilliseconds: number) {
  if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 0) return null;
  return clampInteger(
    Math.round(durationMilliseconds),
    0,
    MAX_BUFFERING_DURATION_MILLISECONDS,
  );
}

/**
 * 面向标注员的摘要只消费封闭事件，不拼接 provider 错误或资源身份。
 * 因此这段文案可安全显示在当前文件会话中，也不会成为凭据泄漏通道。
 */
export function describeSynchronizedPlaybackDiagnostic(
  diagnostic: SynchronizedPlaybackDiagnostic | null,
) {
  if (!diagnostic) return null;
  if (diagnostic.kind === "drift_resync") {
    const drift = formatSignedMilliseconds(diagnostic.driftMilliseconds);
    if (diagnostic.phase === "started") {
      return `${getDriftReasonLabel(diagnostic.reason)}，正在重新同步（${drift}）`;
    }
    if (diagnostic.phase === "succeeded") {
      return `替换音轨已重新同步（${drift}）`;
    }
    return `替换音轨重新同步失败（${drift}）`;
  }
  if (diagnostic.phase === "started") {
    return "替换音轨正在缓冲，视频已暂停";
  }
  const duration = formatDuration(diagnostic.durationMilliseconds);
  if (diagnostic.phase === "recovery_started") {
    return `缓冲结束，正在重新对齐（${duration}）`;
  }
  if (diagnostic.phase === "recovered") {
    return `替换音轨缓冲已恢复（${duration}）`;
  }
  return `替换音轨缓冲恢复失败（${duration}）`;
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function getDriftReasonLabel(reason: SynchronizedDriftResyncReason) {
  if (reason === "forced") return "检测到音轨意外暂停";
  if (reason === "large_drift") return "检测到较大时间漂移";
  return "检测到持续时间漂移";
}

function formatSignedMilliseconds(value: number) {
  if (value === 0) return "0 ms";
  return `${value > 0 ? "+" : ""}${value} ms`;
}

function formatDuration(value: number) {
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")} s`;
}
