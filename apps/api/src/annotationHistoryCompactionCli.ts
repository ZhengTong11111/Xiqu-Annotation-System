import { writeFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { createPrismaReadOnlyConnection } from "./database.js";
import { parseAnnotationHistoryCompactionCliOptions } from "./annotationHistoryCompactionCliOptions.js";
import { AnnotationHistoryCompactionPlanner } from "./annotationHistoryCompactionPlanner.js";
import { PrismaAnnotationHistoryCompactionRepository } from "./annotationHistoryCompactionRepository.js";

const DRY_RUN_LOCK_NAME = "xiqu:annotation-history-compaction-dry-run:v1";

async function run() {
  const options = parseAnnotationHistoryCompactionCliOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("缺少 DATABASE_URL，无法执行恢复历史只读规划。");
  const connection = createPrismaReadOnlyConnection(databaseUrl, {
    statementTimeoutMs: options.statementTimeoutMs,
    maxConnections: 2,
  });
  let lockClient: PoolClient | null = null;
  const abortController = new AbortController();
  const handleSignal = () => abortController.abort();
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    lockClient = await connection.pool.connect();
    const lockResult = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [DRY_RUN_LOCK_NAME],
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error("已有恢复历史 dry-run 正在运行，请等待其结束后重试。");
    }

    const planner = new AnnotationHistoryCompactionPlanner(
      new PrismaAnnotationHistoryCompactionRepository(connection.prisma),
    );
    const plan = await planner.plan({
      ...(options.annotationFileId ? { annotationFileId: options.annotationFileId } : {}),
      ...(options.limitFiles ? { limitFiles: options.limitFiles } : {}),
      maxRevisionsPerFile: options.maxRevisionsPerFile,
      maxOperationsPerFile: options.maxOperationsPerFile,
      policy: options.policy,
      signal: abortController.signal,
      onFilePlanned: (progress) => {
        // 进度只打印文件 id 和计数；JSON 正式报告仍保持 stdout/输出文件可机器解析。
        process.stderr.write(
          `已规划 ${progress.completedFileCount} 个文件：${progress.annotationFileId} ` +
          `(${progress.snapshotCount} snapshots)\n`,
        );
      },
    });
    const json = `${JSON.stringify(plan, null, 2)}\n`;
    if (options.outputPath) {
      await writeFile(options.outputPath, json, { encoding: "utf8", flag: "wx" });
      process.stdout.write(`${JSON.stringify({
        outputPath: options.outputPath,
        interrupted: plan.interrupted,
        summary: plan.summary,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(json);
    }
    if (plan.interrupted) process.exitCode = 130;
    else if (plan.summary.blockedCount > 0) process.exitCode = 2;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    if (lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [DRY_RUN_LOCK_NAME]);
      } finally {
        lockClient.release();
      }
    }
    await connection.prisma.$disconnect();
    await connection.pool.end();
  }
}

await run().catch((error: unknown) => {
  // CLI 只输出稳定消息；数据库 URL、标注 payload 和底层 SQL 错误不得进入终端日志。
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(`恢复历史 dry-run 失败：${message}`);
  process.exitCode = 1;
});
