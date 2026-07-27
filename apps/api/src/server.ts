import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import pg from "pg";
import { HttpError } from "./errors.js";
import { PrismaPlatformRepository } from "./repository.js";
import { registerApiRoutes } from "./router.js";
import { LocalObjectStorage } from "./storage.js";

const port = Number(process.env.PORT ?? 4317);
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://xiqu:xiqu_dev_password@localhost:54329/xiqu_platform?schema=public";
const pool = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
});
const repository = new PrismaPlatformRepository(prisma);
const storage = new LocalObjectStorage();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  bodyLimit: 1024 * 1024 * 1024,
});

await app.register(cors, {
  origin: true,
  credentials: true,
});

await app.register(multipart, {
  limits: {
    fileSize: 1024 * 1024 * 1024,
    files: 1,
  },
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
  // Fastify 自身会为 JSON 解析、multipart 限制等客户端错误提供 4xx。
  // 这些错误不能落入 500，否则前端无法区分请求格式问题与服务端故障。
  if (hasClientErrorStatus(error)) {
    void response.status(error.statusCode).send({
      error: {
        code: "bad_request",
        message: error.statusCode === 413 ? "请求内容过大。" : "请求格式不正确。",
      },
    });
    return;
  }
  app.log.error(error);
  void response.status(500).send({
    error: {
      code: "internal_error",
      message: "服务端内部错误。",
    },
  });
});

app.addHook("preSerialization", async (_request, _response, payload) => {
  if (payload === null || payload === undefined || typeof payload !== "object" || isStreamLike(payload)) {
    return payload;
  }
  if ("error" in payload) {
    return payload;
  }
  return { data: payload };
});

registerApiRoutes(app, repository, storage);

try {
  await repository.ensureSeedData();
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Xiqu platform API listening on http://localhost:${port}`);
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}

async function shutdown() {
  await app.close();
  await prisma.$disconnect();
  await pool.end();
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

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
