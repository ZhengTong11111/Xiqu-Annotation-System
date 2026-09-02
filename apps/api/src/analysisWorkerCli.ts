import { createAliyunVodProvider } from "./aliyunVodGateway.js";
import { AlignmentWorkerService } from "./alignmentWorkerService.js";
import { openAlignmentTrainingFlacStream } from "./alignmentTrainingAudioFfmpeg.js";
import { AlignmentTrainingExportWorkerService } from "./alignmentTrainingExportWorkerService.js";
import { createPrismaConnection } from "./database.js";
import { ExternalForceAlignmentExecutor } from "./externalForceAlignmentExecutor.js";
import { MediaAnalysisWorkerService } from "./mediaAnalysisWorkerService.js";
import { createObjectStorageFromEnvironment } from "./objectStorageFactory.js";
import {
  ProcessingJobWorkerCoordinator,
  type ProcessingJobWorkerAdapter,
} from "./processingJobWorkerCoordinator.js";
import { ProcessingJobWorkerRuntime } from "./processingJobWorkerRuntime.js";
import { ResourceAccessService } from "./resourceAccess.js";
import { loadApiServerRuntimeConfig } from "./serverConfig.js";

async function startMediaAnalysisWorker() {
  const config = loadApiServerRuntimeConfig();
  const connection = createPrismaConnection(config.databaseUrl);
  const storage = createObjectStorageFromEnvironment();
  const logger = {
    info: (facts: Record<string, unknown>, message: string) =>
      console.info(message, JSON.stringify(facts)),
    warn: (facts: Record<string, unknown>, message: string) =>
      console.warn(message, JSON.stringify(facts)),
  };
  const aliyunVod = config.aliyunVod.enabled
    ? createAliyunVodProvider(config.aliyunVod.region)
    : null;
  const mediaAnalysis = new MediaAnalysisWorkerService(
    connection.prisma,
    storage,
    aliyunVod,
    process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg",
    logger,
  );
  const access = new ResourceAccessService(connection.prisma);
  const adapters: ProcessingJobWorkerAdapter[] = [mediaAnalysis];
  // 训练包和媒体分析共用 FFmpeg 路径、对象存储与唯一 worker runtime，不另建轮询进程。
  adapters.push(new AlignmentTrainingExportWorkerService(
    connection.prisma,
    storage,
    access,
    aliyunVod,
    (input, signal) => openAlignmentTrainingFlacStream(input, {
      signal,
      ffmpegPath: process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg",
    }),
    logger,
  ));
  if (config.forceAlignmentExecutorPath) {
    const executor = new ExternalForceAlignmentExecutor(config.forceAlignmentExecutorPath);
    // worker 启动时先验证可执行权限；错误只暴露固定配置问题，不会先 claim 再制造失败风暴。
    await executor.checkReadiness();
    adapters.push(new AlignmentWorkerService(
      connection.prisma,
      storage,
      access,
      aliyunVod,
      executor,
      logger,
    ));
  }
  const coordinator = new ProcessingJobWorkerCoordinator(adapters);
  const runtime = new ProcessingJobWorkerRuntime(coordinator, { logger });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
    await connection.prisma.$disconnect();
    await connection.pool.end();
    await connection.maintenancePool.end();
    await connection.collaborationPool.end();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await runtime.start();
}

await startMediaAnalysisWorker().catch((error: unknown) => {
  // 启动失败只输出稳定消息；数据库 URL、VOD 凭据和临时音频 URL 都不能进入服务日志。
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(`媒体分析 worker 启动失败：${message}`);
  process.exitCode = 1;
});
