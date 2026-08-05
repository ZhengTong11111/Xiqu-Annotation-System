import { spawn } from "node:child_process";
import pg from "pg";
import {
  assertSafeTestDatabaseUrl,
  TEST_DATABASE_URL,
} from "./testEnvironment.js";

const { parsed, schemaName } = assertSafeTestDatabaseUrl();
const maintenanceUrl = new URL(parsed);
maintenanceUrl.search = "";

const maintenancePool = new pg.Pool({
  connectionString: maintenanceUrl.toString(),
});

try {
  // 本地开发账号通常没有 CREATE DATABASE；独立 schema 仍能隔离表、枚举和 migration history。
  const quotedName = `"${schemaName.replaceAll('"', '""')}"`;
  await maintenancePool.query(`CREATE SCHEMA IF NOT EXISTS ${quotedName}`);
} finally {
  await maintenancePool.end();
}

await runPrismaMigrateDeploy(TEST_DATABASE_URL);

async function runPrismaMigrateDeploy(databaseUrl: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["prisma", "migrate", "deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prisma migrate deploy 失败，退出码 ${code ?? "null"}。`));
    });
  });
}
