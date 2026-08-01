import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";

/**
 * 建立显式绑定 PostgreSQL schema 的 Prisma 连接。
 *
 * `?schema=` 是 Prisma URL 约定，node-postgres 本身不会据此修改 search_path。两层必须使用同一个
 * schema，否则 Prisma 生成查询与 resourceService 中的 raw SQL 会访问不同数据表。
 */
export function createPrismaConnection(databaseUrl: string) {
  const schema = parseDatabaseSchema(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
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
