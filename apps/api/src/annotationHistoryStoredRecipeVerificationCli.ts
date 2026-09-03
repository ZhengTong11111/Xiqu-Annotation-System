import { writeFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { createPrismaReadOnlyConnection } from "./database.js";
import { parseAnnotationHistoryStoredRecipeVerificationCliOptions } from "./annotationHistoryStoredRecipeVerificationCliOptions.js";
import { AnnotationHistoryStoredRecipeVerificationService } from "./annotationHistoryStoredRecipeVerificationService.js";

const STORED_RECIPE_VERIFY_LOCK_NAME = "xiqu:annotation-history-stored-recipe-verify-cli:v1";

async function run() {
  const options = parseAnnotationHistoryStoredRecipeVerificationCliOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("缺少 DATABASE_URL，无法执行影子 recipe 只读复核。");
  const connection = createPrismaReadOnlyConnection(databaseUrl, {
    statementTimeoutMs: options.statementTimeoutMs,
    maxConnections: 2,
  });
  const abortController = new AbortController();
  const handleSignal = () => abortController.abort();
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  let lockClient: PoolClient | null = null;
  try {
    lockClient = await connection.pool.connect();
    const lockResult = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [STORED_RECIPE_VERIFY_LOCK_NAME],
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error("已有影子 recipe 只读复核正在运行，请等待其结束后重试。");
    }

    let report;
    try {
      report = await new AnnotationHistoryStoredRecipeVerificationService(connection.prisma)
        .verifyFileRecipes({
          annotationFileId: options.annotationFileId,
          limitCandidates: options.limitCandidates,
          signal: abortController.signal,
        });
    } catch {
      // 数据库和 Prisma 原始错误可能携带内部结构；CLI 只保留稳定上层诊断。
      throw new Error("影子 recipe 只读复核未完成，请检查数据库可用性与 migration 状态。");
    }
    const output = `${JSON.stringify({ version: 1, mode: "verify-stored", ...report }, null, 2)}\n`;
    if (options.outputPath) {
      await writeFile(options.outputPath, output, { encoding: "utf8", flag: "wx" });
      process.stdout.write(`${JSON.stringify({
        outputPath: options.outputPath,
        fileFound: report.fileFound,
        verifiedCount: report.verifiedCount,
        blockedCount: report.blockedCount,
        truncated: report.truncated,
        interrupted: report.interrupted,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(output);
    }
    if (report.interrupted) process.exitCode = 130;
    else if (!report.fileFound || report.blockedCount > 0) process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    if (lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [STORED_RECIPE_VERIFY_LOCK_NAME]);
      } finally {
        lockClient.release();
      }
    }
    await connection.prisma.$disconnect();
    await connection.pool.end();
  }
}

await run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(`影子 recipe 只读复核失败：${message}`);
  process.exitCode = 1;
});
