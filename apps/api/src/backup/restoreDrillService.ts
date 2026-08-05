import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { createPrismaConnection } from "../database.js";
import type { ObjectStorage } from "../objectStorage.js";
import { LocalObjectStorage } from "../storage.js";
import { readDatabaseSummary } from "./backupService.js";
import {
  assertIsolatedDatabaseTarget,
  assertSafeRestoreReport,
  assertSafeRestoreStorage,
  resolveInsideRoot,
} from "./backupPaths.js";
import type {
  BackupDatabaseSummary,
  RestoreDrillReport,
} from "./backupTypes.js";
import { verifyBackupDirectory } from "./backupVerifier.js";
import { digestReadable } from "./checksum.js";
import {
  parsePostgresConnection,
  resolvePostgresTool,
  runPostgresTool,
} from "./postgresTools.js";

export type RestoreDrillOptions = {
  backupDirectory: string;
  sourceStorageRoot?: string;
  targetDatabaseUrl: string;
  targetStorageRoot: string;
  reportPath?: string;
  signal?: AbortSignal;
};

// 恢复演练先离线验证，再拒绝危险目标，最后才向隔离数据库和对象目录写入。
export async function runRestoreDrill(options: RestoreDrillOptions) {
  const startedAt = new Date().toISOString();
  const verification = await verifyBackupDirectory(options.backupDirectory);
  if (!verification.valid || !verification.manifest) {
    throw new Error(`备份校验失败，未开始恢复：${verification.errors.join("；")}`);
  }
  const manifest = verification.manifest;
  const targetConnection = parsePostgresConnection(options.targetDatabaseUrl);
  assertIsolatedDatabaseTarget(manifest.database.identity, targetConnection.identity);
  if (targetConnection.identity.schema !== manifest.database.identity.schema) {
    throw new Error(
      `恢复目标 schema 必须与备份源一致（${manifest.database.identity.schema}）。`,
    );
  }
  await assertSafeRestoreStorage(
    options.targetStorageRoot,
    options.sourceStorageRoot,
    options.backupDirectory,
  );
  const reportPath = options.reportPath ??
    path.join(path.dirname(path.resolve(options.targetStorageRoot)), "restore-drill-report.json");
  await assertSafeRestoreReport(reportPath, options.backupDirectory, options.targetStorageRoot);
  await assertEmptyTargetDatabase(options.targetDatabaseUrl, targetConnection.identity.schema);

  const pgRestore = await resolvePostgresTool("pg_restore");
  await runPostgresTool(pgRestore, [
    // pg_restore 与 pg_dump 不同，即使已有 PGDATABASE 也要求显式 -d；这里只传无秘密的数据库名。
    `--dbname=${targetConnection.identity.database}`,
    "--exit-on-error",
    "--single-transaction",
    // schema dump 会携带 CREATE SCHEMA；目标已确认无业务表，因此在同一事务内先清理空 schema。
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    path.join(path.resolve(options.backupDirectory), manifest.database.dump.relativePath),
  ], { environment: targetConnection.childEnvironment, signal: options.signal });

  await restoreObjectsAtomically(options, manifest.objects.entries);

  const checks: RestoreDrillReport["checks"] = [];
  const { prisma, pool, maintenancePool, collaborationPool } = createPrismaConnection(
    options.targetDatabaseUrl,
  );
  try {
    // 恢复库必须包含 migration history 和运行状态表，证明不是只恢复了部分业务表。
    const migrationTable = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass(current_schema() || '._prisma_migrations') IS NOT NULL AS exists
    `;
    checks.push({
      name: "migration-history",
      passed: migrationTable[0]?.exists === true,
      detail: migrationTable[0]?.exists ? "迁移历史存在。" : "缺少 _prisma_migrations。",
    });
    const runtimeTable = await prisma.$queryRaw<Array<{
      exists: boolean;
      maintenance_mode: boolean | null;
    }>>`
      SELECT
        to_regclass(current_schema() || '.platform_runtime_state') IS NOT NULL AS exists,
        (SELECT maintenance_mode FROM platform_runtime_state WHERE id = 'platform') AS maintenance_mode
    `;
    checks.push({
      name: "runtime-state",
      passed: runtimeTable[0]?.exists === true && runtimeTable[0]?.maintenance_mode === true,
      detail: runtimeTable[0]?.exists && runtimeTable[0]?.maintenance_mode
        ? "恢复库保留维护状态，需由运维人员确认后显式恢复写入。"
        : "恢复库缺少运行状态或未处于安全维护状态。",
    });
    const restoredSummary = await readDatabaseSummary(prisma);
    checks.push(compareDatabaseSummary(manifest.database.summary, restoredSummary));
    checks.push(await compareRestoredObjects(
      manifest.database.summary,
      manifest.objects.entries,
      new LocalObjectStorage(options.targetStorageRoot),
    ));
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }

  const report: RestoreDrillReport = {
    format: "xiqu-platform-restore-drill",
    version: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    sourceBackupCreatedAt: manifest.createdAt,
    sourceDatabase: manifest.database.identity,
    targetDatabase: targetConnection.identity,
    targetStorage: path.basename(path.resolve(options.targetStorageRoot)),
    checks,
    passed: checks.every((check) => check.passed),
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  if (!report.passed) throw new Error(`恢复演练一致性检查失败，报告：${reportPath}`);
  return { report, reportPath };
}

// 目标数据库任何非系统 schema 出现普通表都视为非空，拒绝用 restore 演练覆盖已有数据。
async function assertEmptyTargetDatabase(databaseUrl: string, schema: string) {
  const parsed = new URL(databaseUrl);
  parsed.searchParams.delete("schema");
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    options: `-c search_path=${schema}`,
  });
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) {
      throw new Error(`恢复目标数据库不是空的（目标 schema：${schema}）。`);
    }
  } finally {
    await pool.end();
  }
}

// 对象先恢复到同级 staging，全部完成后才替换已确认为空的目标目录，避免暴露半恢复目录。
async function restoreObjectsAtomically(
  options: RestoreDrillOptions,
  objects: Array<{ relativePath: string; storageKey: string }>,
) {
  const targetRoot = path.resolve(options.targetStorageRoot);
  const stagingRoot = `${targetRoot}.restore-${randomUUID()}`;
  await mkdir(stagingRoot, { recursive: false });
  try {
    for (const object of objects) {
      if (options.signal?.aborted) throw new Error("恢复对象复制已中止。 ");
      const source = resolveInsideRoot(options.backupDirectory, object.relativePath);
      const target = resolveInsideRoot(stagingRoot, object.storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(createReadStream(source), createWriteStream(target, { flags: "wx" }));
    }
    try {
      // 允许调用者预先创建空目录，但发布前再次确认空并只删除这个已验证目标。
      if ((await readdir(targetRoot)).length > 0) throw new Error("恢复对象目录不再为空。 ");
      await rmdir(targetRoot);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    await rename(stagingRoot, targetRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

// 数据库摘要逐字段比较，避免依赖 JSON 对象属性顺序形成脆弱的相等判断。
function compareDatabaseSummary(
  expected: BackupDatabaseSummary,
  actual: BackupDatabaseSummary,
) {
  const expectedDerived = expected.derivedObjects ?? [];
  const actualDerived = actual.derivedObjects ?? [];
  const passed = expected.resourceCount === actual.resourceCount &&
    expected.annotationFileCount === actual.annotationFileCount &&
    expected.mediaFileCount === actual.mediaFileCount &&
    expected.fileObjectCount === actual.fileObjectCount &&
    expected.fileObjects.length === actual.fileObjects.length &&
    expected.fileObjects.every((file, index) => {
      const restored = actual.fileObjects[index];
      return restored?.storageKey === file.storageKey && restored.size === file.size &&
        restored.checksum === file.checksum;
    }) &&
    (expected.derivedObjectCount ?? 0) === (actual.derivedObjectCount ?? 0) &&
    expectedDerived.length === actualDerived.length &&
    expectedDerived.every((asset, index) => {
      const restored = actualDerived[index];
      return restored?.storageKey === asset.storageKey && restored.size === asset.size &&
        restored.checksum === asset.checksum;
    });
  return {
    name: "database-summary",
    passed,
    detail: passed ? "数据库计数、FileObject 与派生对象摘要一致。" : "恢复后的数据库摘要与 manifest 不一致。",
  };
}

// 恢复后允许诚实保留源备份已有 missing/orphan，但不能新增、丢失或篡改任何对象状态。
async function compareRestoredObjects(
  database: BackupDatabaseSummary,
  expectedObjects: Array<{ storageKey: string; size: number; sha256: string }>,
  storage: Pick<ObjectStorage, "listStoredObjects" | "getObjectStream">,
) {
  const actualObjects = await storage.listStoredObjects();
  const expectedByKey = new Map(expectedObjects.map((object) => [object.storageKey, object]));
  const failures: string[] = [];
  if (actualObjects.length !== expectedObjects.length) failures.push("对象数量不一致");
  for (const object of actualObjects) {
    const expected = expectedByKey.get(object.storageKey);
    if (!expected) {
      failures.push(`出现额外对象 ${object.storageKey}`);
      continue;
    }
    const digest = await digestReadable(await storage.getObjectStream(object.storageKey));
    if (digest.size !== expected.size || digest.sha256 !== expected.sha256) {
      failures.push(`对象内容不一致 ${object.storageKey}`);
    }
  }
  const referencedObjects = [
    ...database.fileObjects,
    ...(database.derivedObjects ?? []),
  ];
  const databaseMissingCount = referencedObjects
    .filter((file) => !expectedByKey.has(file.storageKey)).length;
  const databaseKeys = new Set(referencedObjects.map((file) => file.storageKey));
  const orphanCount = expectedObjects.filter((object) => !databaseKeys.has(object.storageKey)).length;
  return {
    name: "object-storage",
    passed: failures.length === 0,
    detail: failures.length
      ? failures.join("；")
      : `对象内容一致；保留源状态 missing=${databaseMissingCount}、orphan=${orphanCount}。`,
  };
}

// 原子发布允许目标目录尚不存在，其余文件系统错误必须继续上抛。
function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
