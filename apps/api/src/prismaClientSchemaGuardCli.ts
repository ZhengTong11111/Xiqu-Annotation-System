import { assertGeneratedPrismaClientMatchesSchema } from "./prismaClientSchemaGuard.js";

try {
  // 候选 release 在切换 current 前主动执行该命令，避免依赖 systemd 重启后才发现产物失配。
  assertGeneratedPrismaClientMatchesSchema();
  console.log("Prisma Client schema 校验通过。");
} catch (error) {
  const message = error instanceof Error ? error.message : "未知校验错误。";
  console.error(`Prisma Client schema 校验失败：${message}`);
  process.exitCode = 1;
}
