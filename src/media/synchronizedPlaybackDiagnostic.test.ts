import assert from "node:assert/strict";
import test from "node:test";
import {
  describeSynchronizedPlaybackDiagnostic,
  normalizeBufferingDurationMilliseconds,
  normalizeDiagnosticDriftMilliseconds,
  type SynchronizedPlaybackDiagnostic,
} from "./synchronizedPlaybackDiagnostic";

test("漂移诊断使用有限整数毫秒并钳制极端值", () => {
  assert.equal(normalizeDiagnosticDriftMilliseconds(0.1004), 100);
  assert.equal(normalizeDiagnosticDriftMilliseconds(-0.1006), -101);
  assert.equal(normalizeDiagnosticDriftMilliseconds(200), 60_000);
  assert.equal(normalizeDiagnosticDriftMilliseconds(-200), -60_000);
  assert.equal(normalizeDiagnosticDriftMilliseconds(Number.NaN), null);
});

test("缓冲时长拒绝无效时钟事实并保持有界", () => {
  assert.equal(normalizeBufferingDurationMilliseconds(1250.4), 1_250);
  assert.equal(normalizeBufferingDurationMilliseconds(9_000_000), 3_600_000);
  assert.equal(normalizeBufferingDurationMilliseconds(-1), null);
  assert.equal(normalizeBufferingDurationMilliseconds(Number.POSITIVE_INFINITY), null);
});

test("封闭诊断事件生成有限中文摘要", () => {
  const diagnostics: SynchronizedPlaybackDiagnostic[] = [
    {
      kind: "drift_resync",
      phase: "started",
      reason: "large_drift",
      driftMilliseconds: 100,
    },
    {
      kind: "drift_resync",
      phase: "succeeded",
      reason: "large_drift",
      driftMilliseconds: -200,
    },
    {
      kind: "drift_resync",
      phase: "failed",
      reason: "forced",
      driftMilliseconds: 0,
    },
    { kind: "buffering", phase: "started", durationMilliseconds: null },
    { kind: "buffering", phase: "recovery_started", durationMilliseconds: 900 },
    { kind: "buffering", phase: "recovered", durationMilliseconds: 1_250 },
    { kind: "buffering", phase: "failed", durationMilliseconds: 2_000 },
  ];

  assert.deepEqual(diagnostics.map(describeSynchronizedPlaybackDiagnostic), [
    "检测到较大时间漂移，正在重新同步（+100 ms）",
    "替换音轨已重新同步（-200 ms）",
    "替换音轨重新同步失败（0 ms）",
    "替换音轨正在缓冲，视频已暂停",
    "缓冲结束，正在重新对齐（900 ms）",
    "替换音轨缓冲已恢复（1.3 s）",
    "替换音轨缓冲恢复失败（2 s）",
  ]);
});
