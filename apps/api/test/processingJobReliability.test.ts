import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  collectProcessingJobReliability,
  mapProcessingJobReliabilityAggregate,
  PROCESSING_JOB_STALE_AFTER_MS,
} from "../src/processingJobReliability.js";

test("任务可靠性聚合映射活动年龄、陈旧 claim 和近期终态", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const snapshot = mapProcessingJobReliabilityAggregate({
    oldestQueuedAt: new Date("2026-08-30T11:59:30.000Z"),
    oldestActiveHeartbeatAt: new Date("2026-08-30T11:57:00.000Z"),
    oldestCancellingAt: new Date("2026-08-30T11:58:00.000Z"),
    staleRunningCount: 2n,
    staleCancellingCount: 1n,
    recentSucceededCount: 4n,
    recentFailedCount: 1n,
    recentCancelledCount: 3n,
    averageQueueWaitMs: 1_250,
    averageRunMs: 40_000,
    averageCancellationMs: 800,
  }, now);

  assert.equal(snapshot.oldestQueuedAgeMs, 30_000);
  assert.equal(snapshot.oldestActiveHeartbeatAgeMs, 180_000);
  assert.equal(snapshot.oldestCancellingAgeMs, PROCESSING_JOB_STALE_AFTER_MS);
  assert.deepEqual(snapshot.staleClaims, { running: 2, cancelling: 1 });
  assert.deepEqual(snapshot.recentOutcomes, {
    succeeded: 4,
    failed: 1,
    cancelled: 3,
  });
  assert.deepEqual(snapshot.averageDurationsMs, {
    queueWait: 1_250,
    run: 40_000,
    cancellation: 800,
  });
});

test("空表和轻微未来时间戳生成安全的零值快照", () => {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const empty = mapProcessingJobReliabilityAggregate(undefined, now);
  assert.equal(empty.oldestQueuedAgeMs, null);
  assert.deepEqual(empty.staleClaims, { running: 0, cancelling: 0 });
  assert.equal(empty.averageDurationsMs.run, null);

  const future = mapProcessingJobReliabilityAggregate({
    oldestQueuedAt: new Date("2026-08-30T12:00:01.000Z"),
    oldestActiveHeartbeatAt: null,
    oldestCancellingAt: null,
    staleRunningCount: 0n,
    staleCancellingCount: 0n,
    recentSucceededCount: 0n,
    recentFailedCount: 0n,
    recentCancelledCount: 0n,
    averageQueueWaitMs: -10,
    averageRunMs: Number.NaN,
    averageCancellationMs: null,
  }, now);
  assert.equal(future.oldestQueuedAgeMs, 0);
  assert.equal(future.averageDurationsMs.queueWait, 0);
  assert.equal(future.averageDurationsMs.run, null);
});

test("数据库采集只返回聚合事实且不需要任务身份", async () => {
  let queryCalls = 0;
  const prisma = {
    $queryRaw: async () => {
      queryCalls += 1;
      return [{
        oldestQueuedAt: null,
        oldestActiveHeartbeatAt: null,
        oldestCancellingAt: null,
        staleRunningCount: 0n,
        staleCancellingCount: 0n,
        recentSucceededCount: 1n,
        recentFailedCount: 0n,
        recentCancelledCount: 0n,
        averageQueueWaitMs: 10,
        averageRunMs: 20,
        averageCancellationMs: null,
      }];
    },
  } as unknown as Pick<PrismaClient, "$queryRaw">;
  const snapshot = await collectProcessingJobReliability(prisma);
  assert.equal(queryCalls, 1);
  assert.equal(snapshot.recentOutcomes.succeeded, 1);
  assert.equal("jobId" in snapshot, false);
});
