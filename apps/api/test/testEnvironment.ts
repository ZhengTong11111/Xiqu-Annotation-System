import type { PrismaClient } from "@prisma/client";
import { createPrismaConnection } from "../src/database.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ??
  "postgresql://xiqu:xiqu_dev_password@localhost:54329/xiqu_platform?schema=api_test";

/**
 * 所有会清空数据的测试入口都必须先经过这层检查。
 * 仅依赖环境变量很容易误清开发表，因此 PostgreSQL schema 必须显式以 `_test` 结尾。
 */
export function assertSafeTestDatabaseUrl(databaseUrl = TEST_DATABASE_URL) {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const schemaName = parsed.searchParams.get("schema") ?? "";
  if (!databaseName || !schemaName.endsWith("_test")) {
    throw new Error(
      `拒绝清理非测试 schema“${schemaName || "<empty>"}”；schema 名必须以 _test 结尾。`,
    );
  }
  return { parsed, databaseName, schemaName };
}

export function createTestPrisma(databaseUrl = TEST_DATABASE_URL) {
  assertSafeTestDatabaseUrl(databaseUrl);
  return createPrismaConnection(databaseUrl);
}

export async function truncateTestDatabase(prisma: PrismaClient) {
  const { schemaName } = assertSafeTestDatabaseUrl();
  const [connection] = await prisma.$queryRaw<Array<{ schema: string }>>`
    SELECT current_schema() AS schema
  `;
  if (connection?.schema !== schemaName) {
    throw new Error(
      `拒绝清理实际 schema“${connection?.schema ?? "<empty>"}”；预期为“${schemaName}”。`,
    );
  }
  // 只清空当前 schema 的业务表，保留 Prisma migration history 以便重复执行测试。
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = current_schema()
      AND tablename <> '_prisma_migrations'
  `;
  if (!tables.length) return;
  const quotedNames = tables
    .map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`)
    .join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quotedNames} CASCADE`);
}
