import type { FastifyInstance } from "fastify";
import { buildApiApp } from "./app.js";
import { createPrismaConnection } from "./database.js";
import { loadApiServerRuntimeConfig } from "./serverConfig.js";
import { createAliyunVodProvider } from "./aliyunVodGateway.js";

/**
 * 生产入口先完成全部配置校验，再创建数据库连接和监听端口。
 * 这样错误的数据库、seed 或 CORS 配置不会留下一个看似存活但边界不安全的进程。
 */
async function startApiServer() {
  const runtimeConfig = loadApiServerRuntimeConfig();
  const connection = createPrismaConnection(runtimeConfig.databaseUrl);
  let app: FastifyInstance | null = null;
  let shutdownStarted = false;

  async function closeDependencies() {
    const errors: unknown[] = [];
    // 各连接池必须逐项尝试释放；其中一个关闭失败不能阻止其余独立连接退出。
    for (const close of [
      () => connection.prisma.$disconnect(),
      () => connection.pool.end(),
      () => connection.maintenancePool.end(),
      () => connection.collaborationPool.end(),
    ]) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "API 依赖关闭不完整。");
    }
  }

  // 信号关闭和启动失败共用同一释放顺序，避免 PostgreSQL LISTEN/presence 连接遗留。
  async function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    let appCloseError: unknown;
    try {
      if (app) await app.close();
    } catch (error) {
      appCloseError = error;
    }

    // 即使 Fastify 某个 onClose hook 失败，也必须继续释放 Prisma 和专用 PostgreSQL 连接池。
    try {
      await closeDependencies();
    } catch (dependencyError) {
      if (appCloseError !== undefined) {
        throw new AggregateError(
          [appCloseError, dependencyError],
          "API 与依赖均未完整关闭。",
        );
      }
      throw dependencyError;
    }
    if (appCloseError !== undefined) throw appCloseError;
  }

  const handleSignal = () => {
    void shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Xiqu platform API 关闭失败", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    app = await buildApiApp({
      prisma: connection.prisma,
      maintenancePool: connection.maintenancePool,
      collaborationPool: connection.collaborationPool,
      databaseSchema: connection.schema,
      seed: runtimeConfig.seedDevelopmentData,
      corsOrigin: runtimeConfig.corsOrigin,
      aliyunVod: runtimeConfig.aliyunVod.enabled
        ? createAliyunVodProvider(runtimeConfig.aliyunVod.region)
        : null,
      aliyunVodWebPlayerLicense: runtimeConfig.aliyunVod.webPlayerLicense,
    });
    await app.listen({ port: runtimeConfig.port, host: runtimeConfig.host });
    app.log.info(
      `Xiqu platform API listening on ${runtimeConfig.host}:${runtimeConfig.port}`,
    );
  } catch (error) {
    await shutdown();
    throw error;
  }
}

await startApiServer().catch((error: unknown) => {
  // 启动错误只输出稳定消息，不把 Error 对象中的连接参数、堆栈或对象存储凭据写入 journald。
  const message = error instanceof Error ? error.message : "未知启动错误。";
  console.error(`Xiqu platform API 启动失败：${message}`);
  process.exitCode = 1;
});
