import type { FastifyInstance } from "fastify";
import { buildApiApp } from "./app.js";
import { createPrismaConnection } from "./database.js";

const port = Number(process.env.PORT ?? 4317);
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://xiqu:xiqu_dev_password@localhost:54329/xiqu_platform?schema=public";
const { prisma, pool, maintenancePool, collaborationPool, schema } = createPrismaConnection(databaseUrl);
let app: FastifyInstance;

try {
  app = await buildApiApp({
    prisma,
    maintenancePool,
    collaborationPool,
    databaseSchema: schema,
    seed: true,
  });
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Xiqu platform API listening on http://localhost:${port}`);
} catch (error) {
  console.error("Xiqu platform API 启动失败", error);
  await closeDependencies();
  process.exit(1);
}

let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await app.close();
  await closeDependencies();
}

async function closeDependencies() {
  await prisma.$disconnect();
  await pool.end();
  await maintenancePool.end();
  await collaborationPool.end();
}

process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
