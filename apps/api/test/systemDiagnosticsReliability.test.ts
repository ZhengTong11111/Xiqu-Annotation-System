import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceHealthResponse } from "@xiqu/shared";
import {
  buildDiagnosticAlerts,
  buildReliabilityDiagnostics,
} from "../src/systemDiagnosticsService.js";
import type { ProcessingJobReliabilitySnapshot } from "../src/processingJobReliability.js";

const healthy: ServiceHealthResponse = {
  status: "ready",
  service: "xiqu-platform-api",
  time: "2026-08-30T12:00:00.000Z",
  startedAt: "2026-08-30T10:00:00.000Z",
  components: {
    database: { status: "ok", latencyMs: 1 },
    storage: { status: "ok", latencyMs: 1 },
  },
};

function reliability(
  patch: Partial<ProcessingJobReliabilitySnapshot> = {},
): ProcessingJobReliabilitySnapshot {
  return {
    recentWindowMinutes: 60,
    staleAfterMs: 120_000,
    oldestQueuedAgeMs: null,
    oldestActiveHeartbeatAgeMs: null,
    oldestCancellingAgeMs: null,
    staleClaims: { running: 0, cancelling: 0 },
    recentOutcomes: { succeeded: 0, failed: 0, cancelled: 0 },
    averageDurationsMs: { queueWait: null, run: null, cancellation: null },
    ...patch,
  };
}

test("诊断只对近期失败告警，不把累计历史失败变成永久告警", () => {
  const alerts = buildDiagnosticAlerts({
    health: healthy,
    capacity: {
      platformUsedBytes: 0,
      platformQuotaBytes: 100,
      accountUsedBytes: 0,
      accountQuotaBytes: 100,
    },
    issuesByCategory: {
      staged_binary: 0,
      orphan_binary: 0,
      unreferenced_file: 0,
      missing_binary: 0,
    },
    cleanupEligibleCount: 0,
    reliability: reliability(),
  });
  assert.deepEqual(alerts, []);
});

test("陈旧 claim 生成严重告警并把可靠性结论标为停滞", () => {
  const stalled = reliability({
    oldestActiveHeartbeatAgeMs: 180_000,
    staleClaims: { running: 1, cancelling: 1 },
  });
  const diagnostic = buildReliabilityDiagnostics(stalled);
  assert.equal(diagnostic.state, "stalled");
  assert.match(diagnostic.summary, /2 个陈旧/);

  const alerts = buildDiagnosticAlerts({
    health: healthy,
    capacity: {
      platformUsedBytes: 0,
      platformQuotaBytes: 100,
      accountUsedBytes: 0,
      accountQuotaBytes: 100,
    },
    issuesByCategory: {
      staged_binary: 0,
      orphan_binary: 0,
      unreferenced_file: 0,
      missing_binary: 0,
    },
    cleanupEligibleCount: 0,
    reliability: stalled,
  });
  assert.equal(alerts.find((alert) => alert.code === "stale_job_claims")?.severity, "critical");
});
