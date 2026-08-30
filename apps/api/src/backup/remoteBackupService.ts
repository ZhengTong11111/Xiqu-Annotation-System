import type { PrismaClient } from "@prisma/client";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ApiUser } from "../domain.js";
import type { MaintenanceCoordinator } from "../maintenanceCoordinator.js";
import type { ObjectStorage } from "../objectStorage.js";
import { normalizeBackupManifest, serializeBackupManifest } from "./backupManifest.js";
import { buildConsistencyWarnings, readDatabaseSummary } from "./backupService.js";
import type {
  BackupDatabaseSummary,
  BackupManifest,
  BackupObjectEntry,
} from "./backupTypes.js";
import { BACKUP_DATABASE_FILE, BACKUP_OBJECTS_DIRECTORY } from "./backupTypes.js";
import { syncFile } from "./checksum.js";
import {
  parsePostgresConnection,
  readPostgresToolVersion,
  resolvePostgresTool,
  runPostgresTool,
} from "./postgresTools.js";
import { createRemoteBackupId, remoteBackupKey, remoteBackupKeys } from "./remoteBackupPaths.js";
import { assertSeparatedStorageNamespaces } from "./remoteBackupStorageFactory.js";
import { verifyRemoteBackup } from "./remoteBackupVerifier.js";
import {
  enterBackupMaintenanceWindow,
  leaveBackupMaintenanceWindow,
  type BackupMaintenanceMode,
} from "./backupMaintenanceWindow.js";

// 顶层选项显式注入线上源和远端目标，调用者不能通过环境默认值混淆两个命名空间。
export type CreateRemoteBackupOptions = {
  prisma: PrismaClient;
  maintenance: MaintenanceCoordinator;
  operator: ApiUser;
  databaseUrl: string;
  sourceStorage: ObjectStorage;
  backupStorage: ObjectStorage;
  workRoot: string;
  maintenanceReason: string;
  maintenanceMode?: BackupMaintenanceMode;
  keepMaintenanceOnFailure?: boolean;
  signal?: AbortSignal;
};

// 远端备份编排保留本地 pg_dump 工作文件，但所有包内容都流式发布到独立对象命名空间。
export async function createRemotePlatformBackup(options: CreateRemoteBackupOptions) {
  assertSeparatedStorageNamespaces(
    options.sourceStorage.describeBackend(),
    options.backupStorage.describeBackend(),
  );
  await Promise.all([
    options.sourceStorage.checkReadiness(),
    options.backupStorage.checkReadiness(),
  ]);
  const backupId = createRemoteBackupId();
  await assertRemoteBackupIdUnused(options.backupStorage, backupId);
  const connection = parsePostgresConnection(options.databaseUrl);
  const pgDump = await resolvePostgresTool("pg_dump");
  const toolVersion = await readPostgresToolVersion(pgDump);
  const workRoot = path.resolve(options.workRoot);
  await mkdir(workRoot, { recursive: true });
  let workDirectory: string | undefined;
  let operationError: unknown;
  let result: { backupId: string; manifestKey: string; manifest: BackupManifest } | undefined;

  const maintenanceWindow = await enterBackupMaintenanceWindow({
    maintenance: options.maintenance,
    operator: options.operator,
    reason: options.maintenanceReason,
    mode: options.maintenanceMode ?? "managed",
  });
  try {
    // 临时目录只在维护窗口成功取得后创建，启用维护失败不会留下无主工作目录。
    workDirectory = await mkdtemp(path.join(workRoot, ".remote-backup-"));
    const dumpPath = path.join(workDirectory, BACKUP_DATABASE_FILE);
    await runPostgresTool(pgDump, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--schema=${connection.identity.schema}`,
      `--file=${dumpPath}`,
    ], { environment: connection.childEnvironment, signal: options.signal });
    await syncFile(dumpPath);
    const databaseSummary = await readDatabaseSummary(options.prisma);
    result = await publishRemoteBackupPackage({
      databaseSummary,
      operator: options.operator,
      sourceStorage: options.sourceStorage,
      backupStorage: options.backupStorage,
      backupId,
      dumpPath,
      databaseIdentity: connection.identity,
      postgresToolVersion: toolVersion,
      maintenanceReason: options.maintenanceReason,
      signal: options.signal,
    });
  } catch (error) {
    operationError = error;
  } finally {
    // 工作目录无论成功失败都只包含临时 dump，不作为恢复来源长期保留。
    if (workDirectory) {
      await rm(workDirectory, { recursive: true, force: true }).catch((cleanupError) => {
        operationError = operationError
          ? new AggregateError([operationError, cleanupError], "远端备份失败且临时目录清理失败。")
          : cleanupError;
      });
    }
  }

  // 外部部署窗口不由备份解除；独立远端备份仍维持既有的自动恢复写入语义。
  await leaveBackupMaintenanceWindow({
    maintenance: options.maintenance,
    operator: options.operator,
    window: maintenanceWindow,
    operationError,
    keepMaintenanceOnFailure: options.keepMaintenanceOnFailure ?? false,
    failureMessage: "远端备份失败且恢复平台写入也失败，请运行 maintenance:disable。",
  });
  if (operationError) throw operationError;
  if (!result) throw new Error("远端备份流程未返回结果。 ");
  return result;
}

// 发布器接收维护窗口内已读取的数据库摘要，因此可独立测试对象状态机且不自行查询数据库。
type PublishRemoteBackupPackageOptions = {
  databaseSummary: BackupDatabaseSummary;
  operator: ApiUser;
  sourceStorage: ObjectStorage;
  backupStorage: ObjectStorage;
  backupId: string;
  dumpPath: string;
  databaseIdentity: BackupManifest["database"]["identity"];
  postgresToolVersion: string;
  maintenanceReason: string;
  signal?: AbortSignal;
};

// 包发布器以 manifest-last 作为提交协议，并对每个可能形成 final 的 key 预登记补偿。
export async function publishRemoteBackupPackage(options: PublishRemoteBackupPackageOptions) {
  const cleanupKeys: string[] = [];
  try {
    const dumpMetadata = await stat(options.dumpPath);
    if (!dumpMetadata.isFile()) throw new Error("远端备份数据库 dump 不是普通文件。 ");
    const dumpKey = remoteBackupKeys.database(options.backupId);
    const dump = await uploadAndPromote(
      options.backupStorage,
      dumpKey,
      createReadStream(options.dumpPath),
      dumpMetadata.size,
      cleanupKeys,
    );

    const sourceObjects = (await options.sourceStorage.listStoredObjects())
      .sort((left, right) => left.storageKey.localeCompare(right.storageKey));
    const objectEntries: BackupObjectEntry[] = [];
    for (const object of sourceObjects) {
      if (options.signal?.aborted) throw new Error("远端备份对象复制已中止。 ");
      const relativePath = `${BACKUP_OBJECTS_DIRECTORY}/${object.storageKey}`;
      const uploaded = await uploadAndPromote(
        options.backupStorage,
        remoteBackupKey(options.backupId, relativePath),
        await options.sourceStorage.getObjectStream(object.storageKey),
        object.size,
        cleanupKeys,
      );
      objectEntries.push({
        storageKey: object.storageKey,
        relativePath,
        size: uploaded.size,
        sha256: uploaded.checksum,
      });
    }

    const manifest = normalizeBackupManifest({
      format: "xiqu-platform-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      operator: { accountName: options.operator.accountName, userId: options.operator.id },
      maintenanceReason: options.maintenanceReason,
      database: {
        identity: options.databaseIdentity,
        postgresToolVersion: options.postgresToolVersion,
        dump: { relativePath: BACKUP_DATABASE_FILE, size: dump.size, sha256: dump.checksum },
        summary: options.databaseSummary,
      },
      objects: {
        count: objectEntries.length,
        totalBytes: objectEntries.reduce((sum, entry) => sum + entry.size, 0),
        entries: objectEntries,
      },
      warnings: buildConsistencyWarnings(options.databaseSummary, objectEntries),
    });

    // manifest 最后 promote；此前即使 payload 可见，也不能被 verifier 识别成完整备份。
    const manifestText = serializeBackupManifest(manifest);
    const manifestKey = remoteBackupKeys.manifest(options.backupId);
    await uploadAndPromote(
      options.backupStorage,
      manifestKey,
      Readable.from([Buffer.from(manifestText, "utf8")]),
      Buffer.byteLength(manifestText),
      cleanupKeys,
    );
    const verification = await verifyRemoteBackup(options.backupStorage, options.backupId);
    if (!verification.valid) {
      throw new Error(`远端备份发布后校验失败：${verification.errors.join("；")}`);
    }
    return { backupId: options.backupId, manifestKey, manifest };
  } catch (error) {
    const cleanupErrors = await deletePublishedKeys(options.backupStorage, cleanupKeys);
    if (cleanupErrors.length) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "远端备份失败且部分已发布对象无法清理。",
      );
    }
    throw error;
  }
}

// final key 在 promote 前登记；即使 copy 成功而 staged 删除失败，也会进入外层补偿。
async function uploadAndPromote(
  storage: ObjectStorage,
  finalKey: string,
  stream: Readable,
  maxBytes: number,
  cleanupKeys: string[],
) {
  const staged = await storage.putStagedObject(finalKey, stream, maxBytes);
  cleanupKeys.push(finalKey);
  try {
    await storage.promoteStagedObject(staged);
  } catch (error) {
    // S3 copy 可能已经形成 final、却在删除 staged 时失败；这里幂等重试 staged 清理并保留双重错误。
    try {
      await storage.deleteObject(staged.stagedStorageKey);
    } catch (stagedCleanupError) {
      throw new AggregateError(
        [error, stagedCleanupError],
        `发布对象失败且暂存对象无法清理：“${finalKey}”。`,
      );
    }
    throw error;
  }
  return staged;
}

// 删除按发布逆序执行并收集全部错误，避免一个删除失败掩盖其他残留。
async function deletePublishedKeys(storage: ObjectStorage, keys: string[]) {
  const errors: unknown[] = [];
  for (const key of [...keys].reverse()) {
    try {
      await storage.deleteObject(key);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

// UUID backup id 理论上不碰撞，但发布前仍检查目标，禁止覆盖任何既有或未完成包。
async function assertRemoteBackupIdUnused(storage: ObjectStorage, backupId: string) {
  const existing = (await storage.listStoredObjects())
    .find((object) => object.storageKey.startsWith(`${backupId}/`));
  if (existing) throw new Error(`远端备份 id 已存在对象，拒绝覆盖：“${backupId}”。`);
}
