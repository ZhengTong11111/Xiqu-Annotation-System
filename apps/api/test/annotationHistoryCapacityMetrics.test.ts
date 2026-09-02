import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  AnnotationHistoryCapacityMetricsCollector,
  parseAnnotationHistoryCapacityRow,
} from "../src/annotationHistoryCapacityMetrics.js";

test("容量查询 bigint 严格映射为固定低基数快照", () => {
  const snapshot = parseAnnotationHistoryCapacityRow(createCapacityRow());
  assert.deepEqual(snapshot, {
    relationTotalBytes: 4_096,
    snapshotsByStorageMode: { inline: 3, reconstructible: 0, archived: 0 },
    payloadsByState: { present: 3, missing: 0 },
    hashesByState: { present: 1, missing: 2 },
    recentCreated: { "24h": 1, "7d": 2 },
  });
});

test("缺列、负数和超出安全整数的聚合值都会 fail closed", () => {
  assert.throws(() => parseAnnotationHistoryCapacityRow({
    ...createCapacityRow(),
    inlineCount: undefined,
  }), /inlineCount/u);
  assert.throws(() => parseAnnotationHistoryCapacityRow({
    ...createCapacityRow(),
    recent7dCount: -1n,
  }), /recent7dCount/u);
  assert.throws(() => parseAnnotationHistoryCapacityRow({
    ...createCapacityRow(),
    relationTotalBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  }), /relationTotalBytes/u);
});

test("五分钟缓存命中不查询数据库，过期后刷新", async () => {
  let queryCount = 0;
  const collector = new AnnotationHistoryCapacityMetricsCollector({
    $queryRaw: async () => {
      queryCount += 1;
      return [createCapacityRow()];
    },
  } as unknown as PrismaClient, 5 * 60 * 1_000);
  const now = new Date("2026-09-02T00:00:00.000Z");

  await collector.collect(now);
  await collector.collect(new Date(now.getTime() + 4 * 60 * 1_000));
  assert.equal(queryCount, 1);
  await collector.collect(new Date(now.getTime() + 5 * 60 * 1_000));
  assert.equal(queryCount, 2);
});

test("并发采集共享查询，失败不进入缓存", async () => {
  let queryCount = 0;
  let release!: (rows: ReturnType<typeof createCapacityRow>[]) => void;
  const blocked = new Promise<ReturnType<typeof createCapacityRow>[]>((resolve) => {
    release = resolve;
  });
  const concurrentCollector = new AnnotationHistoryCapacityMetricsCollector({
    $queryRaw: async () => {
      queryCount += 1;
      return blocked;
    },
  } as unknown as PrismaClient);
  const now = new Date("2026-09-02T00:00:00.000Z");
  const first = concurrentCollector.collect(now);
  const second = concurrentCollector.collect(now);
  assert.equal(queryCount, 1);
  release([createCapacityRow()]);
  assert.deepEqual(await first, await second);

  let failureCount = 0;
  const retryCollector = new AnnotationHistoryCapacityMetricsCollector({
    $queryRaw: async () => {
      failureCount += 1;
      if (failureCount === 1) throw new Error("temporary");
      return [createCapacityRow()];
    },
  } as unknown as PrismaClient);
  await assert.rejects(retryCollector.collect(now), /temporary/u);
  await retryCollector.collect(now);
  assert.equal(failureCount, 2);
});

function createCapacityRow() {
  return {
    relationTotalBytes: 4_096n,
    inlineCount: 3n,
    reconstructibleCount: 0n,
    archivedCount: 0n,
    payloadPresentCount: 3n,
    payloadMissingCount: 0n,
    hashPresentCount: 1n,
    hashMissingCount: 2n,
    recent24hCount: 1n,
    recent7dCount: 2n,
  };
}
