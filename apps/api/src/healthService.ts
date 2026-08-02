import type { PrismaClient } from "@prisma/client";
import type {
  HealthComponentStatus,
  ServiceHealthResponse,
} from "@xiqu/shared";
import type { LocalObjectStorage } from "./storage.js";

// 健康服务区分进程存活与外部依赖就绪，避免数据库故障触发无意义的进程重启循环。
export class HealthService {
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: LocalObjectStorage,
  ) {}

  getLiveness(): ServiceHealthResponse {
    return {
      status: "ok",
      service: "xiqu-platform-api",
      time: new Date().toISOString(),
      startedAt: this.startedAt,
    };
  }

  async getReadiness(): Promise<ServiceHealthResponse> {
    // 两个探针彼此独立并行执行，单项失败仍保留另一项状态，便于定位故障边界。
    const [database, storage] = await Promise.all([
      measureComponent(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      measureComponent(() => this.storage.checkReadiness()),
    ]);
    return {
      status: database.status === "ok" && storage.status === "ok"
        ? "ready"
        : "unavailable",
      service: "xiqu-platform-api",
      time: new Date().toISOString(),
      startedAt: this.startedAt,
      components: { database, storage },
    };
  }
}

// 探针错误只转成安全类别，不回传驱动、连接串或服务器绝对路径。
async function measureComponent(
  operation: () => Promise<void>,
): Promise<HealthComponentStatus> {
  const started = performance.now();
  try {
    await operation();
    return {
      status: "ok",
      latencyMs: roundLatency(performance.now() - started),
    };
  } catch {
    return {
      status: "unavailable",
      latencyMs: roundLatency(performance.now() - started),
      message: "依赖当前不可用。",
    };
  }
}

// 两位小数足以诊断本地依赖延迟，也避免响应随浮点噪声频繁变化。
function roundLatency(value: number) {
  return Math.round(value * 100) / 100;
}
