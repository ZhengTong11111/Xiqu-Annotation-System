import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import pg from "pg";
import { HttpError } from "./errors.js";
import { PrismaPlatformRepository } from "./repository.js";
import { ResourceAccessService } from "./resourceAccess.js";
import { ResourceService } from "./resourceService.js";
import { registerApiRoutes } from "./router.js";
import { LocalObjectStorage } from "./storage.js";

const port = Number(process.env.PORT ?? 4317);
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://xiqu:xiqu_dev_password@localhost:54329/xiqu_platform?schema=public";
const pool = new pg.Pool({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const access = new ResourceAccessService(prisma);
const repository = new PrismaPlatformRepository(prisma, access);
const resources = new ResourceService(prisma, access);
const storage = new LocalObjectStorage();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: 1024 * 1024 * 1024,
});

await app.register(cors, {
  origin: true,
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
await app.register(multipart, {
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
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

registerApiRoutes(app, repository, resources, storage);

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

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

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
