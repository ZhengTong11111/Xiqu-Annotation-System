import { Prisma, type PrismaClient } from "@prisma/client";

// worker 恢复、管理员诊断和 Prometheus 告警共用同一陈旧阈值，避免三处规则逐渐分叉。
export const PROCESSING_JOB_STALE_AFTER_MS = 2 * 60 * 1000;
export const PROCESSING_JOB_RECENT_WINDOW_MS = 60 * 60 * 1000;
export const PROCESSING_JOB_QUEUE_WARNING_AFTER_MS = 2 * 60 * 1000;

export type ProcessingJobReliabilitySnapshot = {
  recentWindowMinutes: number;
  staleAfterMs: number;
  oldestQueuedAgeMs: number | null;
  oldestActiveHeartbeatAgeMs: number | null;
  oldestCancellingAgeMs: number | null;
  staleClaims: {
    running: number;
    cancelling: number;
  };
  recentOutcomes: {
    succeeded: number;
    failed: number;
    cancelled: number;
  };
  averageDurationsMs: {
    queueWait: number | null;
    run: number | null;
    cancellation: number | null;
  };
};

type ProcessingJobReliabilityAggregate = {
  oldestQueuedAt: Date | null;
  oldestActiveHeartbeatAt: Date | null;
  oldestCancellingAt: Date | null;
  staleRunningCount: bigint | number;
  staleCancellingCount: bigint | number;
  recentSucceededCount: bigint | number;
  recentFailedCount: bigint | number;
  recentCancelledCount: bigint | number;
  averageQueueWaitMs: Prisma.Decimal | number | null;
  averageRunMs: Prisma.Decimal | number | null;
  averageCancellationMs: Prisma.Decimal | number | null;
};

/**
 * 任务可靠性只聚合活动任务和最近终态，不读取任务身份、资源或错误正文。
 * 单条 PostgreSQL 聚合让指标抓取与管理员诊断共享完全相同的时间语义。
 */
export async function collectProcessingJobReliability(
  prisma: Pick<PrismaClient, "$queryRaw">,
  now = new Date(),
): Promise<ProcessingJobReliabilitySnapshot> {
  const recentAfter = new Date(now.getTime() - PROCESSING_JOB_RECENT_WINDOW_MS);
  const staleBefore = new Date(now.getTime() - PROCESSING_JOB_STALE_AFTER_MS);
  const rows = await prisma.$queryRaw<ProcessingJobReliabilityAggregate[]>(Prisma.sql`
    SELECT
      MIN(created_at) FILTER (WHERE status::text = 'queued') AS "oldestQueuedAt",
      MIN(COALESCE(heartbeat_at, claimed_at, updated_at))
        FILTER (WHERE status::text IN ('running', 'cancelling')) AS "oldestActiveHeartbeatAt",
      MIN(COALESCE(cancel_requested_at, updated_at))
        FILTER (WHERE status::text = 'cancelling') AS "oldestCancellingAt",
      COUNT(*) FILTER (
        WHERE status::text = 'running'
          AND COALESCE(heartbeat_at, claimed_at, updated_at) < ${staleBefore}
      ) AS "staleRunningCount",
      COUNT(*) FILTER (
        WHERE status::text = 'cancelling'
          AND COALESCE(heartbeat_at, claimed_at, updated_at) < ${staleBefore}
      ) AS "staleCancellingCount",
      COUNT(*) FILTER (
        WHERE status::text = 'succeeded' AND finished_at >= ${recentAfter}
      ) AS "recentSucceededCount",
      COUNT(*) FILTER (
        WHERE status::text = 'failed' AND finished_at >= ${recentAfter}
      ) AS "recentFailedCount",
      COUNT(*) FILTER (
        WHERE status::text = 'cancelled' AND finished_at >= ${recentAfter}
      ) AS "recentCancelledCount",
      AVG(EXTRACT(EPOCH FROM (claimed_at - created_at)) * 1000)
        FILTER (WHERE finished_at >= ${recentAfter} AND claimed_at IS NOT NULL)
        AS "averageQueueWaitMs",
      AVG(EXTRACT(EPOCH FROM (finished_at - claimed_at)) * 1000)
        FILTER (WHERE finished_at >= ${recentAfter} AND claimed_at IS NOT NULL)
        AS "averageRunMs",
      AVG(EXTRACT(EPOCH FROM (finished_at - cancel_requested_at)) * 1000)
        FILTER (WHERE finished_at >= ${recentAfter} AND cancel_requested_at IS NOT NULL)
        AS "averageCancellationMs"
    FROM processing_jobs
    WHERE status::text IN ('queued', 'running', 'cancelling')
      OR finished_at >= ${recentAfter}
  `);
  return mapProcessingJobReliabilityAggregate(rows[0], now);
}

// 映射函数保持纯净，方便覆盖未来时间戳、空表和 bigint 等数据库边界。
export function mapProcessingJobReliabilityAggregate(
  row: ProcessingJobReliabilityAggregate | undefined,
  now: Date,
): ProcessingJobReliabilitySnapshot {
  return {
    recentWindowMinutes: PROCESSING_JOB_RECENT_WINDOW_MS / 60_000,
    staleAfterMs: PROCESSING_JOB_STALE_AFTER_MS,
    oldestQueuedAgeMs: ageMs(now, row?.oldestQueuedAt),
    oldestActiveHeartbeatAgeMs: ageMs(now, row?.oldestActiveHeartbeatAt),
    oldestCancellingAgeMs: ageMs(now, row?.oldestCancellingAt),
    staleClaims: {
      running: finiteCount(row?.staleRunningCount),
      cancelling: finiteCount(row?.staleCancellingCount),
    },
    recentOutcomes: {
      succeeded: finiteCount(row?.recentSucceededCount),
      failed: finiteCount(row?.recentFailedCount),
      cancelled: finiteCount(row?.recentCancelledCount),
    },
    averageDurationsMs: {
      queueWait: finiteDuration(row?.averageQueueWaitMs),
      run: finiteDuration(row?.averageRunMs),
      cancellation: finiteDuration(row?.averageCancellationMs),
    },
  };
}

function ageMs(now: Date, value: Date | null | undefined) {
  if (!value) return null;
  // 数据库与 API 主机存在轻微时钟偏差时按 0 处理，不能把负年龄送入指标。
  return Math.max(0, now.getTime() - value.getTime());
}

function finiteCount(value: bigint | number | undefined) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function finiteDuration(value: Prisma.Decimal | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : null;
}
