import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type { PrismaClient } from "@prisma/client";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { HttpError } from "./errors.js";
import { PrismaPlatformRepository } from "./repository.js";
import { ResourceAccessService } from "./resourceAccess.js";
import { ResourceService } from "./resourceService.js";
import { registerApiRoutes } from "./router.js";
import { LocalObjectStorage } from "./storage.js";
import { MediaUploadService } from "./mediaUploadService.js";
import { ObjectLifecycleService } from "./objectLifecycleService.js";
import { ApiObservability } from "./observability.js";
import { HealthService } from "./healthService.js";
import { SystemDiagnosticsService } from "./systemDiagnosticsService.js";
import { loadUploadPolicy, type UploadPolicy } from "./uploadPolicy.js";

export type BuildApiAppOptions = {
  prisma: PrismaClient;
  storage?: LocalObjectStorage;
  logger?: FastifyServerOptions["logger"] | FastifyBaseLogger;
  seed?: boolean;
  uploadPolicy?: Partial<UploadPolicy>;
  metricsToken?: string | null;
};

/**
 * 构建一个尚未监听端口的 Fastify 应用。
 *
 * 生产入口和集成测试共用这一个装配函数，避免测试复制路由、错误处理或权限依赖。
 * 数据库和对象存储由调用方持有，因此调用方也负责在 app.close() 后释放它们。
 */
export async function buildApiApp(
  options: BuildApiAppOptions,
): Promise<FastifyInstance> {
  const access = new ResourceAccessService(options.prisma);
  const repository = new PrismaPlatformRepository(options.prisma, access);
  const resources = new ResourceService(options.prisma, access);
  const storage = options.storage ?? new LocalObjectStorage();
  const uploadPolicy = loadUploadPolicy(options.uploadPolicy);
  const observability = new ApiObservability();
  const health = new HealthService(options.prisma, storage);
  const mediaUploads = new MediaUploadService(
    resources,
    storage,
    uploadPolicy,
    observability,
  );
  const objectLifecycle = new ObjectLifecycleService(
    options.prisma,
    access,
    storage,
    uploadPolicy,
  );
  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: uploadPolicy.maxUploadBytes + 1024 * 1024,
  });
  observability.registerHttpHooks(app);
  const diagnostics = new SystemDiagnosticsService(
    options.prisma,
    access,
    storage,
    objectLifecycle,
    health,
    uploadPolicy,
  );

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, {
    limits: { fileSize: uploadPolicy.maxUploadBytes, files: 1 },
  });

  app.setErrorHandler((error, _request, response) => {
    if (error instanceof HttpError) {
      void response.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }
    if (isMultipartSizeError(error)) {
      void response.status(413).send({
        error: {
          code: "upload_too_large",
          message: "媒体文件超过单文件上传限制。",
          details: { maxBytes: uploadPolicy.maxUploadBytes },
        },
      });
      return;
    }
    if (hasClientErrorStatus(error)) {
      void response.status(error.statusCode).send({
        error: {
          code: "bad_request",
          message: error.statusCode === 413
            ? "请求内容过大。"
            : "请求格式不正确。",
        },
      });
      return;
    }
    app.log.error(error);
    void response.status(500).send({
      error: { code: "internal_error", message: "服务端内部错误。" },
    });
  });

  app.addHook("preSerialization", async (_request, _response, payload) => {
    if (
      payload === null ||
      payload === undefined ||
      typeof payload !== "object" ||
      isStreamLike(payload) ||
      "error" in payload
    ) return payload;
    return { data: payload };
  });

  registerApiRoutes(
    app,
    repository,
    resources,
    storage,
    mediaUploads,
    objectLifecycle,
    health,
    diagnostics,
    observability,
    options.metricsToken === undefined
      ? process.env.XIQU_METRICS_TOKEN ?? null
      : options.metricsToken,
  );
  if (options.seed) await repository.ensureSeedData();
  return app;
}

// multipart 在消费流时使用稳定 Fastify code 报超限，统一映射为平台上传错误合同。
function isMultipartSizeError(error: unknown) {
  return error instanceof Error && "code" in error &&
    error.code === "FST_REQ_FILE_TOO_LARGE";
}

function isStreamLike(payload: object) {
  return "pipe" in payload && typeof payload.pipe === "function";
}

function hasClientErrorStatus(
  error: unknown,
): error is { statusCode: number } {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return false;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" &&
    statusCode >= 400 &&
    statusCode < 500;
}
