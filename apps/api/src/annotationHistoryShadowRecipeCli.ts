import { writeFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { createPrismaConnection, createPrismaReadOnlyConnection } from "./database.js";
import { AnnotationHistoryCompactionPlanner } from "./annotationHistoryCompactionPlanner.js";
import { PrismaAnnotationHistoryCompactionRepository } from "./annotationHistoryCompactionRepository.js";
import { parseAnnotationHistoryShadowRecipeCliOptions } from "./annotationHistoryShadowRecipeCliOptions.js";
import { AnnotationHistoryShadowRecipeService } from "./annotationHistoryShadowRecipeService.js";

const SHADOW_RECIPE_LOCK_NAME = "xiqu:annotation-history-shadow-recipe-cli:v1";

async function run() {
  const options = parseAnnotationHistoryShadowRecipeCliOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("缺少 DATABASE_URL，无法执行恢复历史影子复核。");
  const writableConnection = options.apply ? createPrismaConnection(databaseUrl) : null;
  const readOnlyConnection = options.apply
    ? null
    : createPrismaReadOnlyConnection(databaseUrl, {
        statementTimeoutMs: options.planner.statementTimeoutMs,
        maxConnections: 2,
      });
  const connection = writableConnection ?? readOnlyConnection!;
  let lockClient: PoolClient | null = null;
  try {
    lockClient = await connection.pool.connect();
    const lockResult = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [SHADOW_RECIPE_LOCK_NAME],
    );
    if (!lockResult.rows[0]?.locked) {
      throw new Error("已有恢复历史影子复核正在运行，请等待其结束后重试。");
    }

    const annotationFile = await connection.prisma.annotationFile.findUnique({
      where: { resourceId: options.planner.annotationFileId },
      select: { revision: true },
    });
    if (!annotationFile) throw new Error("指定标注文件不存在。");
    const planner = new AnnotationHistoryCompactionPlanner(
      new PrismaAnnotationHistoryCompactionRepository(connection.prisma),
    );
    const plan = await planner.plan({
      annotationFileId: options.planner.annotationFileId,
      maxRevisionsPerFile: options.planner.maxRevisionsPerFile,
      maxOperationsPerFile: options.planner.maxOperationsPerFile,
      policy: options.planner.policy,
    });
    const filePlan = plan.files[0];
    if (!filePlan || filePlan.errorCode || filePlan.snapshotScanTruncated || filePlan.operationScanTruncated) {
      throw new Error("单文件规划不完整，拒绝进入影子 recipe 写入。");
    }
    const selected = filePlan.decisions
      .filter(({ decision, recipe }) => decision === "reconstructible" && recipe !== null)
      .sort((left, right) => left.revision - right.revision)
      .slice(0, options.limitCandidates);

    const writeReport = options.apply
      ? await new AnnotationHistoryShadowRecipeService(connection.prisma).writeFileRecipes({
          annotationFileId: options.planner.annotationFileId,
          expectedAnnotationRevision: annotationFile.revision,
          decisions: filePlan.decisions,
          limitCandidates: options.limitCandidates,
        })
      : null;
    const report = {
      version: 1,
      mode: options.apply ? "apply" : "dry-run",
      annotationFileId: options.planner.annotationFileId,
      expectedAnnotationRevision: annotationFile.revision,
      selectedCandidates: selected.map(({ snapshotId, revision }) => ({ snapshotId, revision })),
      plannerSummary: plan.summary,
      writeReport,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.planner.outputPath) {
      await writeFile(options.planner.outputPath, json, { encoding: "utf8", flag: "wx" });
      process.stdout.write(`${JSON.stringify({
        outputPath: options.planner.outputPath,
        mode: report.mode,
        selectedCandidateCount: selected.length,
        writeSummary: writeReport ? {
          writtenCount: writeReport.writtenCount,
          alreadyVerifiedCount: writeReport.alreadyVerifiedCount,
          blockedCount: writeReport.blockedCount,
        } : null,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(json);
    }
    if (writeReport?.blockedCount) process.exitCode = 2;
  } finally {
    if (lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [SHADOW_RECIPE_LOCK_NAME]);
      } finally {
        lockClient.release();
      }
    }
    await connection.prisma.$disconnect();
    await connection.pool.end();
    if (writableConnection) {
      await writableConnection.maintenancePool.end();
      await writableConnection.collaborationPool.end();
    }
  }
}

await run().catch((error: unknown) => {
  // CLI 只输出固定上层消息，数据库错误、payload、operation body 和连接凭据均不得进入日志。
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(`恢复历史影子 recipe 失败：${message}`);
  process.exitCode = 1;
});
