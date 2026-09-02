import type { PrismaClient } from "@prisma/client";

export const ANNOTATION_HISTORY_STORAGE_MODES = ["inline", "reconstructible", "archived"] as const;
export const ANNOTATION_HISTORY_COVERAGE_STATES = ["present", "missing"] as const;
export const ANNOTATION_HISTORY_GROWTH_WINDOWS = ["24h", "7d"] as const;
export const ANNOTATION_HISTORY_CAPACITY_CACHE_MS = 5 * 60 * 1_000;

export type AnnotationHistoryCapacityMetricsSnapshot = {
  relationTotalBytes: number;
  snapshotsByStorageMode: Record<typeof ANNOTATION_HISTORY_STORAGE_MODES[number], number>;
  payloadsByState: Record<typeof ANNOTATION_HISTORY_COVERAGE_STATES[number], number>;
  hashesByState: Record<typeof ANNOTATION_HISTORY_COVERAGE_STATES[number], number>;
  recentCreated: Record<typeof ANNOTATION_HISTORY_GROWTH_WINDOWS[number], number>;
};

type AnnotationHistoryCapacityRow = {
  relationTotalBytes: unknown;
  inlineCount: unknown;
  reconstructibleCount: unknown;
  archivedCount: unknown;
  payloadPresentCount: unknown;
  payloadMissingCount: unknown;
  hashPresentCount: unknown;
  hashMissingCount: unknown;
  recent24hCount: unknown;
  recent7dCount: unknown;
};

/**
 * 恢复历史容量按五分钟缓存，并复用同一份在途查询。缓存只保存聚合数字，失败不会覆盖上一份成功结果，
 * 也不会阻止下一轮重新查询数据库。
 */
export class AnnotationHistoryCapacityMetricsCollector {
  private cached: {
    expiresAtMs: number;
    snapshot: AnnotationHistoryCapacityMetricsSnapshot;
  } | null = null;
  private inFlight: Promise<AnnotationHistoryCapacityMetricsSnapshot> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheMs = ANNOTATION_HISTORY_CAPACITY_CACHE_MS,
  ) {
    if (!Number.isInteger(cacheMs) || cacheMs <= 0) {
      throw new Error("恢复历史容量指标缓存时间必须是正整数。");
    }
  }

  collect(now = new Date()): Promise<AnnotationHistoryCapacityMetricsSnapshot> {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      return Promise.reject(new Error("恢复历史容量指标时间无效。"));
    }
    if (this.cached && nowMs < this.cached.expiresAtMs) {
      return Promise.resolve(this.cached.snapshot);
    }
    if (!this.inFlight) {
      const operation = this.querySnapshot(now).then((snapshot) => {
        this.cached = { snapshot, expiresAtMs: nowMs + this.cacheMs };
        return snapshot;
      });
      this.inFlight = operation.finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async querySnapshot(now: Date): Promise<AnnotationHistoryCapacityMetricsSnapshot> {
    const recent24hBoundary = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const recent7dBoundary = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
    // 一条聚合 SQL 只访问轻量列；relation size 来自 PostgreSQL 目录，不读取或解压 TOAST payload。
    const rows = await this.prisma.$queryRaw<AnnotationHistoryCapacityRow[]>`
      SELECT
        pg_total_relation_size('annotation_recovery_snapshots'::regclass)::bigint AS "relationTotalBytes",
        COUNT(*) FILTER (WHERE storage_mode = 'inline')::bigint AS "inlineCount",
        COUNT(*) FILTER (WHERE storage_mode = 'reconstructible')::bigint AS "reconstructibleCount",
        COUNT(*) FILTER (WHERE storage_mode = 'archived')::bigint AS "archivedCount",
        COUNT(*) FILTER (WHERE payload IS NOT NULL)::bigint AS "payloadPresentCount",
        COUNT(*) FILTER (WHERE payload IS NULL)::bigint AS "payloadMissingCount",
        COUNT(*) FILTER (WHERE payload_sha256 IS NOT NULL)::bigint AS "hashPresentCount",
        COUNT(*) FILTER (WHERE payload_sha256 IS NULL)::bigint AS "hashMissingCount",
        COUNT(*) FILTER (WHERE created_at >= ${recent24hBoundary})::bigint AS "recent24hCount",
        COUNT(*) FILTER (WHERE created_at >= ${recent7dBoundary})::bigint AS "recent7dCount"
      FROM annotation_recovery_snapshots
    `;
    if (rows.length !== 1) {
      throw new Error("恢复历史容量指标查询结果行数无效。");
    }
    return parseAnnotationHistoryCapacityRow(rows[0]!);
  }
}

/** 查询结果必须完整且能无损进入 Prometheus number；坏结果不能静默变成零。 */
export function parseAnnotationHistoryCapacityRow(
  row: AnnotationHistoryCapacityRow,
): AnnotationHistoryCapacityMetricsSnapshot {
  return {
    relationTotalBytes: toSafeCount(row.relationTotalBytes, "relationTotalBytes"),
    snapshotsByStorageMode: {
      inline: toSafeCount(row.inlineCount, "inlineCount"),
      reconstructible: toSafeCount(row.reconstructibleCount, "reconstructibleCount"),
      archived: toSafeCount(row.archivedCount, "archivedCount"),
    },
    payloadsByState: {
      present: toSafeCount(row.payloadPresentCount, "payloadPresentCount"),
      missing: toSafeCount(row.payloadMissingCount, "payloadMissingCount"),
    },
    hashesByState: {
      present: toSafeCount(row.hashPresentCount, "hashPresentCount"),
      missing: toSafeCount(row.hashMissingCount, "hashMissingCount"),
    },
    recentCreated: {
      "24h": toSafeCount(row.recent24hCount, "recent24hCount"),
      "7d": toSafeCount(row.recent7dCount, "recent7dCount"),
    },
  };
}

function toSafeCount(value: unknown, field: string): number {
  const parsed = typeof value === "bigint"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  if (parsed === null || parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`恢复历史容量指标字段 ${field} 无效。`);
  }
  return Number(parsed);
}
