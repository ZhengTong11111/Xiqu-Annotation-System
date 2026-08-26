import { AnalysisAudioSettingMigrationService } from "./analysisAudioSettingMigrationService.js";
import { createPrismaConnection } from "./database.js";
import { loadApiServerRuntimeConfig } from "./serverConfig.js";

type MigrationCliCommand =
  | { mode: "dry-run" }
  | { mode: "execute"; operatorAccountName: string; planFingerprint: string };

async function run() {
  const command = parseAnalysisAudioSettingMigrationCliCommand(process.argv.slice(2));
  const config = loadApiServerRuntimeConfig();
  const connection = createPrismaConnection(config.databaseUrl);
  try {
    const service = new AnalysisAudioSettingMigrationService(connection.prisma);
    const result = command.mode === "dry-run"
      ? await service.dryRun()
      : await service.execute({
          operatorAccountName: command.operatorAccountName,
          expectedPlanFingerprint: command.planFingerprint,
        });
    // 输出只有有限计划、稳定 ID、计数和阻断码，不暴露资源名、路径、媒体 URL 或凭据。
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.plan.blockedCount > 0) process.exitCode = 2;
  } finally {
    await connection.prisma.$disconnect();
    await connection.pool.end();
    await connection.maintenancePool.end();
    await connection.collaborationPool.end();
  }
}

export function parseAnalysisAudioSettingMigrationCliCommand(
  args: readonly string[],
): MigrationCliCommand {
  if (args.length === 1 && args[0] === "dry-run") return { mode: "dry-run" };
  if (args[0] !== "execute") {
    throw new Error(
      "用法：analysis-audio-settings:migrate dry-run | execute --operator <账号> --plan-fingerprint <sha256>",
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("旧分析音频设置迁移参数不完整。");
    }
    if (values.has(key)) throw new Error("旧分析音频设置迁移参数重复：" + key + "。");
    values.set(key, value);
  }
  if ([...values.keys()].some((key) =>
    key !== "--operator" && key !== "--plan-fingerprint")) {
    throw new Error("旧分析音频设置迁移包含未知参数。");
  }
  const operatorAccountName = values.get("--operator")?.trim() ?? "";
  const planFingerprint = values.get("--plan-fingerprint")?.trim() ?? "";
  if (!operatorAccountName || !/^[a-f0-9]{64}$/u.test(planFingerprint)) {
    throw new Error("execute 必须提供 operator 账号和 dry-run 返回的完整 fingerprint。");
  }
  return { mode: "execute", operatorAccountName, planFingerprint };
}

await run().catch((error: unknown) => {
  // CLI 只输出稳定业务消息，禁止透传连接串、Prisma cause 或媒体来源详情。
  const message = error instanceof Error ? error.message : "未知错误";
  console.error("旧分析音频设置迁移失败：" + message);
  process.exitCode = 1;
});
