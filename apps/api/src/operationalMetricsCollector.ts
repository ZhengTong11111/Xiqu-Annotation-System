import type { PrismaClient } from "@prisma/client";
import type { HealthService } from "./healthService.js";

// 运维指标只使用固定依赖与任务状态，禁止把资源、账号或错误文本放进 Prometheus label。
export const OPERATIONAL_DEPENDENCIES = ["database", "storage"] as const;
export const OPERATIONAL_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
const DEFAULT_OPERATIONAL_METRICS_TIMEOUT_MS = 5_000;
const MAX_OPERATIONAL_METRICS_TIMEOUT_MS = 60_000;

export type OperationalMetricsSnapshot = {
  collectedAt: Date;
  dependencies: Record<typeof OPERATIONAL_DEPENDENCIES[number], 0 | 1>;
  platformStorageUsedBytes: number;
  platformStorageQuotaBytes: number;
  jobs: Record<typeof OPERATIONAL_JOB_STATUSES[number], number>;
};

// 环境超时使用明确边界，坏配置在启动阶段失败而不是运行时悄悄采用 NaN。
export function loadOperationalMetricsTimeout(
  value: string | undefined,
): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_OPERATIONAL_METRICS_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_OPERATIONAL_METRICS_TIMEOUT_MS
  ) {
    throw new Error(
      `XIQU_OPERATIONAL_METRICS_TIMEOUT_MS 必须是 1-${MAX_OPERATIONAL_METRICS_TIMEOUT_MS} 的整数。`,
    );
  }
  return parsed;
}

// 采集器将有限数据库聚合与 readiness 合并，并复用重叠抓取，避免监控请求制造查询风暴。
export class OperationalMetricsCollector {
  private inFlight: Promise<OperationalMetricsSnapshot> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly health: HealthService,
    private readonly platformStorageQuotaBytes: number,
    private readonly timeoutMs = DEFAULT_OPERATIONAL_METRICS_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("运维指标采集超时必须是正数。");
    }
  }

  // 同一实例同时到达的 scrape 共享一次采集；完成或失败后立即释放引用供下一轮刷新。
  collect(): Promise<OperationalMetricsSnapshot> {
    if (!this.inFlight) {
      const operation = this.collectSnapshot();
      this.inFlight = operation.finally(() => {
        this.inFlight = null;
      });
    }
    // 调用方可以按时结束 HTTP scrape，但底层 in-flight 保留到真实查询收敛，避免超时后重复启动。
    return withTimeout(this.inFlight, this.timeoutMs);
  }

  // 三类只读查询并行执行；readiness 返回 unavailable 仍是成功采集到的故障事实。
  private async collectSnapshot(): Promise<OperationalMetricsSnapshot> {
    const [health, storageUsage, jobGroups] = await Promise.all([
      this.health.getReadiness(),
      this.prisma.fileObject.aggregate({ _sum: { size: true } }),
      this.prisma.processingJob.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
    ]);
    const jobs = Object.fromEntries(
      OPERATIONAL_JOB_STATUSES.map((status) => [status, 0]),
    ) as OperationalMetricsSnapshot["jobs"];
    // groupBy 只返回实际存在的类别，未出现状态必须主动归零以清除上一轮 Gauge 值。
    for (const group of jobGroups) jobs[group.status] = group._count._all;
    return {
      collectedAt: new Date(),
      dependencies: {
        database: health.components?.database.status === "ok" ? 1 : 0,
        storage: health.components?.storage.status === "ok" ? 1 : 0,
      },
      platformStorageUsedBytes: storageUsage._sum.size ?? 0,
      platformStorageQuotaBytes: this.platformStorageQuotaBytes,
      jobs,
    };
  }
}

// 超时只结束当前 HTTP 等待；底层查询完成后仍由 Promise 收敛，不启动第二份并行采集。
function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("运维指标采集超时。")),
      timeoutMs,
    );
    void operation.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}
