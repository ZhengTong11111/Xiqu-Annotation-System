import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
import { assertGeneratedPrismaClientMatchesSchema } from "./prismaClientSchemaGuard.js";

/**
 * 建立显式绑定 PostgreSQL schema 的 Prisma 连接。
 *
 * `?schema=` 是 Prisma URL 约定，node-postgres 本身不会据此修改 search_path。两层必须使用同一个
 * schema，否则 Prisma 生成查询与 resourceService 中的 raw SQL 会访问不同数据表。
 */
export function createPrismaConnection(databaseUrl: string) {
  // 所有数据库入口共用同一门禁，旧 Prisma Client 不能在 API、worker 或运维 CLI 中带病运行。
  assertGeneratedPrismaClientMatchesSchema();
  const schema = parseDatabaseSchema(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  // 请求级 advisory permit 可能持续到响应结束，必须与 Prisma 业务连接分池，避免并发写入自锁。
  const maintenancePool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 20,
    // 门禁池耗尽时必须在 API/Nginx 超时前返回稳定 503，不能让登录和保存请求无限排队。
    connectionTimeoutMillis: 5_000,
  });
  // 三条 LISTEN 会长期独占连接；额外容量供 NOTIFY、重连交叠和同进程受控 app 装配使用。
  // 该池仍与 Prisma 查询及维护 advisory permit 隔离，避免协作流量反压业务事务。
  const collaborationPool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 8,
  });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema }),
  });
  return { prisma, pool, maintenancePool, collaborationPool, schema };
}

export type PrismaReadOnlyConnectionOptions = {
  statementTimeoutMs: number;
  maxConnections?: number;
};

/**
 * 为离线审计/规划 CLI 建立数据库强制只读连接。
 *
 * 只读和 statement timeout 通过 PostgreSQL 启动参数施加到池中每一条物理连接，不能只在某一条临时
 * client 上执行 SET 后假设 Prisma 会复用它。普通 API 继续使用上面的完整连接，不受该门禁影响。
 */
export function createPrismaReadOnlyConnection(
  databaseUrl: string,
  options: PrismaReadOnlyConnectionOptions,
) {
  assertGeneratedPrismaClientMatchesSchema();
  if (!Number.isInteger(options.statementTimeoutMs) || options.statementTimeoutMs <= 0) {
    throw new Error("只读数据库连接必须配置正整数 statement timeout。");
  }
  const maxConnections = options.maxConnections ?? 2;
  if (!Number.isInteger(maxConnections) || maxConnections < 2 || maxConnections > 10) {
    throw new Error("只读数据库连接池大小必须在 2 到 10 之间。");
  }
  const schema = parseDatabaseSchema(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: [
      `-c search_path=${schema}`,
      "-c default_transaction_read_only=on",
      `-c statement_timeout=${options.statementTimeoutMs}`,
      "-c application_name=xiqu_annotation_history_dry_run",
    ].join(" "),
    max: maxConnections,
    connectionTimeoutMillis: 5_000,
  });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, { schema }),
  });
  return { prisma, pool, schema };
}

export function parseDatabaseSchema(databaseUrl: string) {
  const schema = new URL(databaseUrl).searchParams.get("schema") ?? "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`DATABASE_URL 包含非法 schema 名称“${schema}”。`);
  }
  return schema;
}
