import type { PrismaClient } from "@prisma/client";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ApiUser } from "../domain.js";
import type { MaintenanceCoordinator } from "../maintenanceCoordinator.js";
import { requireLocalSnapshotRoot, type ObjectStorage } from "../objectStorage.js";
import { normalizeBackupManifest, writeBackupManifest } from "./backupManifest.js";
import {
  assertSafeRelativePath,
  assertPhysicallySeparatedDirectories,
  assertSeparatedDirectories,
  createBackupDirectoryNames,
  resolveInsideRoot,
} from "./backupPaths.js";
import type {
  BackupDatabaseSummary,
  BackupManifest,
  BackupObjectEntry,
} from "./backupTypes.js";
import { BACKUP_DATABASE_FILE, BACKUP_OBJECTS_DIRECTORY } from "./backupTypes.js";
import { verifyBackupDirectory } from "./backupVerifier.js";
import { digestFile, syncDirectory, syncFile } from "./checksum.js";
import {
  parsePostgresConnection,
  readPostgresToolVersion,
  resolvePostgresTool,
  runPostgresTool,
} from "./postgresTools.js";

export type CreateBackupOptions = {
  prisma: PrismaClient;
  maintenance: MaintenanceCoordinator;
  operator: ApiUser;
  databaseUrl: string;
  storage: ObjectStorage;
  outputRoot: string;
  maintenanceReason: string;
  keepMaintenanceOnFailure?: boolean;
  signal?: AbortSignal;
};

// 备份服务拥有完整静默窗口：预检不改状态，进入维护后才 dump/copy，校验成功才发布 final。
export async function createPlatformBackup(options: CreateBackupOptions) {
  const storageRoot = requireLocalSnapshotRoot(options.storage);
  const outputRoot = path.resolve(options.outputRoot);
  assertSeparatedDirectories(storageRoot, outputRoot);
  await options.storage.checkReadiness();
  if ((await lstat(storageRoot)).isSymbolicLink()) {
    throw new Error("对象存储根目录不能是符号链接。 ");
  }
  await mkdir(outputRoot, { recursive: true });
  await assertPhysicallySeparatedDirectories(storageRoot, outputRoot);
  const connection = parsePostgresConnection(options.databaseUrl);
  const pgDump = await resolvePostgresTool("pg_dump");
  const toolVersion = await readPostgresToolVersion(pgDump);
  const existingStatus = await options.maintenance.getStatus(options.operator);
  if (existingStatus.enabled) {
    throw new Error("平台已处于维护模式；当前备份命令不会接管既有维护窗口。 ");
  }

  const names = createBackupDirectoryNames();
  const stagingDirectory = path.join(outputRoot, names.stagingName);
  const finalDirectory = path.join(outputRoot, names.finalName);
  let published = false;
  let operationError: unknown;
  let result: { directory: string; manifest: BackupManifest } | undefined;

  await options.maintenance.setMaintenance(options.operator, {
    enabled: true,
    reason: options.maintenanceReason,
  });
  try {
    await mkdir(stagingDirectory, { recursive: false });
    const dumpPath = path.join(stagingDirectory, BACKUP_DATABASE_FILE);
    await runPostgresTool(pgDump, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--schema=${connection.identity.schema}`,
      `--file=${dumpPath}`,
    ], { environment: connection.childEnvironment, signal: options.signal });
    await syncFile(dumpPath);
    const dumpDigest = await digestFile(dumpPath);

    // 对象复制和摘要在同一个维护窗口完成；任何 symlink 都中止备份，不能静默遗漏潜在资产。
    const objectEntries = await copyStorageTree(
      storageRoot,
      path.join(stagingDirectory, BACKUP_OBJECTS_DIRECTORY),
      options.signal,
    );
    const databaseSummary = await readDatabaseSummary(options.prisma);
    const warnings = buildConsistencyWarnings(databaseSummary, objectEntries);
    const manifest = normalizeBackupManifest({
      format: "xiqu-platform-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      operator: { accountName: options.operator.accountName, userId: options.operator.id },
      maintenanceReason: options.maintenanceReason,
      database: {
        identity: connection.identity,
        postgresToolVersion: toolVersion,
        dump: { relativePath: BACKUP_DATABASE_FILE, ...dumpDigest },
        summary: databaseSummary,
      },
      objects: {
        count: objectEntries.length,
        totalBytes: objectEntries.reduce((sum, entry) => sum + entry.size, 0),
        entries: objectEntries,
      },
      warnings,
    });
    await writeBackupManifest(stagingDirectory, manifest);
    const verification = await verifyBackupDirectory(stagingDirectory);
    if (!verification.valid) {
      throw new Error(`备份发布前校验失败：${verification.errors.join("；")}`);
    }
    await rename(stagingDirectory, finalDirectory);
    await syncDirectory(outputRoot);
    published = true;
    result = { directory: finalDirectory, manifest };
  } catch (error) {
    operationError = error;
    if (!published) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  // 受控成功始终恢复写入；普通失败默认恢复，显式 keep 仅用于需要保留现场的运维场景。
  const shouldDisable = !operationError || !options.keepMaintenanceOnFailure;
  if (shouldDisable) {
    try {
      await options.maintenance.setMaintenance(options.operator, { enabled: false });
    } catch (maintenanceError) {
      if (operationError) {
        throw new AggregateError(
          [operationError, maintenanceError],
          "备份失败且恢复平台写入也失败，请运行 maintenance:disable。",
        );
      }
      throw maintenanceError;
    }
  }
  if (operationError) throw operationError;
  if (!result) throw new Error("备份流程未返回结果。 ");
  return result;
}

// 数据库摘要采用稳定排序，并只包含恢复一致性需要的文件元数据和计数。
export async function readDatabaseSummary(prisma: PrismaClient): Promise<BackupDatabaseSummary> {
  const [resourceCount, annotationFileCount, mediaFileCount, fileObjects] = await Promise.all([
    prisma.resourceEntry.count(),
    prisma.annotationFile.count(),
    prisma.mediaFile.count(),
    prisma.fileObject.findMany({
      select: { storageKey: true, size: true, checksum: true },
      orderBy: { storageKey: "asc" },
    }),
  ]);
  return {
    resourceCount,
    annotationFileCount,
    mediaFileCount,
    fileObjectCount: fileObjects.length,
    fileObjects,
  };
}

// 整棵对象目录逐文件流式复制；相对 key 保持 POSIX 形式并在写目标前验证。
async function copyStorageTree(
  sourceRoot: string,
  targetRoot: string,
  signal?: AbortSignal,
) {
  const entries: BackupObjectEntry[] = [];
  await mkdir(targetRoot, { recursive: true });
  await walk(sourceRoot);
  return entries.sort((left, right) => left.storageKey.localeCompare(right.storageKey));

  // 每层目录顺序遍历，确保同一源文件只被复制一次且中断边界明确。
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // SIGINT/SIGTERM 在文件边界停止复制，外层 finally 负责删除 staging 并恢复维护状态。
      if (signal?.aborted) throw new Error("备份对象复制已中止。 ");
      const sourcePath = path.join(directory, entry.name);
      const metadata = await lstat(sourcePath);
      if (metadata.isSymbolicLink()) {
        const unsafeKey = path.relative(sourceRoot, sourcePath).split(path.sep).join("/");
        throw new Error(`对象存储包含不允许备份的符号链接：“${unsafeKey}”。`);
      }
      if (metadata.isDirectory()) {
        await walk(sourcePath);
        continue;
      }
      if (!metadata.isFile()) continue;
      const storageKey = path.relative(sourceRoot, sourcePath).split(path.sep).join("/");
      assertSafeRelativePath(storageKey, "对象 storageKey");
      const relativePath = `${BACKUP_OBJECTS_DIRECTORY}/${storageKey}`;
      const targetPath = resolveInsideRoot(path.dirname(targetRoot), relativePath);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await pipeline(createReadStream(sourcePath), createWriteStream(targetPath, { flags: "wx" }));
      await syncFile(targetPath);
      entries.push({ storageKey, relativePath, ...await digestFile(targetPath) });
    }
  }
}

// 已有缺失对象和磁盘孤儿作为 warning 原样保留；备份任务不擅自清理开发库。
function buildConsistencyWarnings(
  summary: BackupDatabaseSummary,
  objects: BackupObjectEntry[],
) {
  const warnings: string[] = [];
  const objectByKey = new Map(objects.map((entry) => [entry.storageKey, entry]));
  const databaseKeys = new Set(summary.fileObjects.map((file) => file.storageKey));
  for (const file of summary.fileObjects) {
    const object = objectByKey.get(file.storageKey);
    if (!object) {
      warnings.push(`数据库对象缺少磁盘文件：${file.storageKey}`);
      continue;
    }
    if (file.size !== object.size) warnings.push(`数据库对象大小不一致：${file.storageKey}`);
    if (file.checksum && file.checksum !== object.sha256) {
      warnings.push(`数据库对象校验和不一致：${file.storageKey}`);
    }
  }
  for (const object of objects) {
    if (!databaseKeys.has(object.storageKey)) warnings.push(`磁盘孤儿对象：${object.storageKey}`);
    if (object.storageKey.includes(".upload-")) warnings.push(`暂存上传对象：${object.storageKey}`);
  }
  return warnings;
}
