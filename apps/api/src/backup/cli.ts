import path from "node:path";
import { createPrismaConnection } from "../database.js";
import { MaintenanceCoordinator } from "../maintenanceCoordinator.js";
import { requireLocalSnapshotRoot } from "../objectStorage.js";
import { createObjectStorageFromEnvironment } from "../objectStorageFactory.js";
import { ResourceAccessService } from "../resourceAccess.js";
import { createPlatformBackup } from "./backupService.js";
import { loadMaintenanceOperator } from "./maintenanceOperator.js";
import { runRestoreDrill } from "./restoreDrillService.js";
import { verifyBackupDirectory } from "./backupVerifier.js";
import { createRemotePlatformBackup } from "./remoteBackupService.js";
import { createRemoteBackupStorageFromEnvironment } from "./remoteBackupStorageFactory.js";
import { verifyRemoteBackup } from "./remoteBackupVerifier.js";

const DEFAULT_DATABASE_URL =
  "postgresql://xiqu:xiqu_dev_password@localhost:54329/xiqu_platform?schema=public";

// 命令白名单同时约束可取值参数和布尔 flag，未知参数不能被静默忽略。
const COMMAND_OPTIONS: Record<string, { values: string[]; flags: string[] }> = {
  "maintenance:status": { values: ["operator"], flags: [] },
  "maintenance:enable": { values: ["operator", "reason"], flags: [] },
  "maintenance:disable": { values: ["operator"], flags: [] },
  "backup:create": {
    values: ["operator", "output", "reason"],
    flags: ["keep-maintenance-on-failure"],
  },
  "backup:verify": { values: ["backup"], flags: [] },
  "backup:create-remote": {
    values: ["operator", "work-root", "reason"],
    flags: ["keep-maintenance-on-failure"],
  },
  "backup:verify-remote": { values: ["backup-id"], flags: [] },
  "backup:restore-drill": {
    values: ["backup", "target-database-url", "target-storage", "report"],
    flags: [],
  },
};

const abortController = new AbortController();
const onSignal = () => abortController.abort();
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);

try {
  // CLI 只有少量固定命令，严格解析也位于错误边界内，参数错误不会暴露原始堆栈。
  const { command, values, flags } = parseArguments(process.argv.slice(2));
  await runCommand(command, values, flags, abortController.signal);
} catch (error) {
  console.error(formatError(error));
  process.exitCode = abortController.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}

// 命令调度先处理不需要数据库的离线操作，再为维护/创建备份建立并负责关闭数据库依赖。
async function runCommand(
  command: string,
  values: Map<string, string>,
  flags: Set<string>,
  signal: AbortSignal,
) {
  validateCommandArguments(command, values, flags);
  if (command === "backup:verify") {
    const backup = requireValue(values, "backup");
    const result = await verifyBackupDirectory(backup);
    printJson({ valid: result.valid, errors: result.errors, createdAt: result.manifest?.createdAt ?? null });
    if (!result.valid) throw new Error("备份校验未通过。 ");
    return;
  }
  // 远端校验是纯对象存储操作，不能为了读取 manifest 误连业务数据库。
  if (command === "backup:verify-remote") {
    const result = await verifyRemoteBackup(
      createRemoteBackupStorageFromEnvironment(),
      requireValue(values, "backup-id"),
    );
    printJson({
      valid: result.valid,
      errors: result.errors,
      createdAt: result.manifest?.createdAt ?? null,
    });
    if (!result.valid) throw new Error("远端备份校验未通过。 ");
    return;
  }
  if (command === "backup:restore-drill") {
    const targetDatabaseUrl = values.get("target-database-url") ??
      process.env.XIQU_RESTORE_DATABASE_URL;
    if (!targetDatabaseUrl) {
      throw new Error("请通过 XIQU_RESTORE_DATABASE_URL 或 --target-database-url 指定隔离数据库。 ");
    }
    const sourceStorage = createObjectStorageFromEnvironment();
    const result = await runRestoreDrill({
      backupDirectory: requireValue(values, "backup"),
      sourceStorageRoot: requireLocalSnapshotRoot(sourceStorage),
      targetDatabaseUrl,
      targetStorageRoot: requireValue(values, "target-storage"),
      reportPath: values.get("report"),
      signal,
    });
    printJson({ passed: result.report.passed, reportPath: result.reportPath, checks: result.report.checks });
    return;
  }

  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const { prisma, pool, maintenancePool } = createPrismaConnection(databaseUrl);
  try {
    const access = new ResourceAccessService(prisma);
    const maintenance = new MaintenanceCoordinator(prisma, maintenancePool, access);
    const operator = await loadMaintenanceOperator(
      prisma,
      access,
      values.get("operator") ?? "admin",
    );
    if (command === "maintenance:status") {
      printJson(await maintenance.getStatus(operator));
      return;
    }
    if (command === "maintenance:enable") {
      printJson(await maintenance.setMaintenance(operator, {
        enabled: true,
        reason: requireValue(values, "reason"),
      }));
      return;
    }
    if (command === "maintenance:disable") {
      printJson(await maintenance.setMaintenance(operator, { enabled: false }));
      return;
    }
    if (command === "backup:create") {
      const result = await createPlatformBackup({
        prisma,
        maintenance,
        operator,
        databaseUrl,
        storage: createObjectStorageFromEnvironment(),
        outputRoot: values.get("output") ?? "./data/backups",
        maintenanceReason: values.get("reason") ?? "创建平台一致备份",
        keepMaintenanceOnFailure: flags.has("keep-maintenance-on-failure"),
        signal,
      });
      printJson({
        directory: path.relative(process.cwd(), result.directory),
        createdAt: result.manifest.createdAt,
        objectCount: result.manifest.objects.count,
        warningCount: result.manifest.warnings.length,
        warnings: result.manifest.warnings,
      });
      return;
    }
    // 远端创建复用当前数据库和线上对象源，但目标由独立 XIQU_BACKUP_S3_* 配置提供。
    if (command === "backup:create-remote") {
      const result = await createRemotePlatformBackup({
        prisma,
        maintenance,
        operator,
        databaseUrl,
        sourceStorage: createObjectStorageFromEnvironment(),
        backupStorage: createRemoteBackupStorageFromEnvironment(),
        workRoot: values.get("work-root") ?? "./data/remote-backup-work",
        maintenanceReason: values.get("reason") ?? "创建平台远端一致备份",
        keepMaintenanceOnFailure: flags.has("keep-maintenance-on-failure"),
        signal,
      });
      printJson({
        backupId: result.backupId,
        manifestKey: result.manifestKey,
        createdAt: result.manifest.createdAt,
        objectCount: result.manifest.objects.count,
        warningCount: result.manifest.warnings.length,
        warnings: result.manifest.warnings,
      });
      return;
    }
    throw new Error(`未知命令“${command}”。`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
  }
}

// 小型参数解析器区分取值参数和唯一布尔 flag，并拒绝重复值。
function parseArguments(args: string[]) {
  const [command = "", ...rest] = args;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) throw new Error(`无法识别参数“${token}”。`);
    const name = token.slice(2);
    if (name === "keep-maintenance-on-failure") {
      flags.add(name);
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 --${name} 缺少值。`);
    if (values.has(name)) throw new Error(`参数 --${name} 不能重复。`);
    values.set(name, value);
    index += 1;
  }
  return { command, values, flags };
}

// 参数白名单在建立数据库连接前执行，拼写错误不会触发任何平台副作用。
function validateCommandArguments(
  command: string,
  values: Map<string, string>,
  flags: Set<string>,
) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new Error(`未知命令“${command}”。`);
  for (const name of values.keys()) {
    if (!allowed.values.includes(name)) throw new Error(`命令 ${command} 不支持参数 --${name}。`);
  }
  for (const name of flags) {
    if (!allowed.flags.includes(name)) throw new Error(`命令 ${command} 不支持参数 --${name}。`);
  }
}

// 必需参数读取集中在一个出口，空值与遗漏产生一致错误。
function requireValue(values: Map<string, string>, name: string) {
  const value = values.get(name);
  if (!value) throw new Error(`缺少必需参数 --${name}。`);
  return value;
}

// CLI 成功输出保持结构化 JSON，便于 shell 或未来调度器消费。
function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

// AggregateError 展开补偿失败的全部原因，但不输出可能携带秘密的对象结构。
function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message}\n${error.errors.map(formatError).join("\n")}`;
  }
  return error instanceof Error ? error.message : String(error);
}
