import { open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  BACKUP_DATABASE_FILE,
  BACKUP_MANIFEST_FILE,
  BACKUP_MANIFEST_VERSION,
  BACKUP_OBJECTS_DIRECTORY,
  type BackupManifest,
} from "./backupTypes.js";
import { assertSafeRelativePath } from "./backupPaths.js";
import { isSha256, syncDirectory } from "./checksum.js";

// 清单写入前统一排序，确保相同内容产生稳定、可审查的 JSON。
export function normalizeBackupManifest(manifest: BackupManifest): BackupManifest {
  return {
    ...manifest,
    database: {
      ...manifest.database,
      summary: {
        ...manifest.database.summary,
        fileObjects: [...manifest.database.summary.fileObjects]
          .sort((left, right) => left.storageKey.localeCompare(right.storageKey)),
      },
    },
    objects: {
      ...manifest.objects,
      entries: [...manifest.objects.entries]
        .sort((left, right) => left.storageKey.localeCompare(right.storageKey)),
    },
    warnings: [...manifest.warnings].sort(),
  };
}

// 临时文件完成并关闭后才 rename 成 manifest.json，避免进程中断留下可被误读的半个 JSON。
export async function writeBackupManifest(directory: string, manifest: BackupManifest) {
  validateBackupManifest(manifest);
  const temporary = path.join(directory, `${BACKUP_MANIFEST_FILE}.tmp`);
  const final = path.join(directory, BACKUP_MANIFEST_FILE);
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(serializeBackupManifest(manifest), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, final);
  await syncDirectory(directory);
}

// 外部备份包一律按 unknown 读取并完成运行时校验，TypeScript 类型不能充当恢复安全边界。
export async function readBackupManifest(directory: string) {
  const text = await readFile(path.join(directory, BACKUP_MANIFEST_FILE), "utf8");
  return parseBackupManifestText(text);
}

// 本地与远端备份共享同一稳定序列化出口，避免两种介质产生内容不同的 manifest。
export function serializeBackupManifest(manifest: BackupManifest) {
  validateBackupManifest(manifest);
  return `${JSON.stringify(normalizeBackupManifest(manifest), null, 2)}\n`;
}

// 远端读取和本地目录读取都必须从 unknown JSON 进入同一个运行时校验边界。
export function parseBackupManifestText(text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("备份 manifest 不是有效 JSON。 ");
  }
  validateBackupManifest(parsed);
  return parsed;
}

// 当前版本的验证覆盖恢复会依赖的全部字段和聚合不变量；未知额外字段保持向前兼容。
export function validateBackupManifest(value: unknown): asserts value is BackupManifest {
  if (!isRecord(value) || value.format !== "xiqu-platform-backup") {
    throw new Error("不是受支持的戏曲标注平台备份 manifest。 ");
  }
  if (value.version !== BACKUP_MANIFEST_VERSION) {
    throw new Error(`不支持备份 manifest 版本“${String(value.version)}”。`);
  }
  if (!isIsoDate(value.createdAt) || !isRecord(value.operator) ||
    !isNonEmptyString(value.operator.accountName) || !isNonEmptyString(value.operator.userId) ||
    !isNonEmptyString(value.maintenanceReason)) {
    throw new Error("备份 manifest 的创建或操作者信息无效。 ");
  }
  if (!isRecord(value.database) || !isRecord(value.database.identity) ||
    !isNonEmptyString(value.database.identity.host) ||
    !isPositiveInteger(value.database.identity.port) ||
    !isNonEmptyString(value.database.identity.database) ||
    !isNonEmptyString(value.database.identity.schema) ||
    !isNonEmptyString(value.database.postgresToolVersion)) {
    throw new Error("备份 manifest 的数据库身份无效。 ");
  }
  validateDigest(value.database.dump, BACKUP_DATABASE_FILE);
  validateDatabaseSummary(value.database.summary);
  if (!isRecord(value.objects) || !isNonNegativeInteger(value.objects.count) ||
    !isNonNegativeInteger(value.objects.totalBytes) || !Array.isArray(value.objects.entries)) {
    throw new Error("备份 manifest 的对象聚合无效。 ");
  }
  const keys = new Set<string>();
  let totalBytes = 0;
  for (const entry of value.objects.entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.storageKey)) {
      throw new Error("备份对象缺少 storageKey。 ");
    }
    assertSafeRelativePath(entry.storageKey, "storageKey");
    validateDigest(entry, `${BACKUP_OBJECTS_DIRECTORY}/${entry.storageKey}`);
    if (keys.has(entry.storageKey)) throw new Error(`备份对象 key 重复：“${entry.storageKey}”。`);
    keys.add(entry.storageKey);
    totalBytes += entry.size as number;
  }
  if (value.objects.count !== value.objects.entries.length || value.objects.totalBytes !== totalBytes) {
    throw new Error("备份对象数量或总字节聚合与明细不一致。 ");
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("备份 manifest 的 warnings 无效。 ");
  }
}

// 数据库摘要验证计数、FileObject 明细、checksum 和 storageKey 唯一性。
function validateDatabaseSummary(value: unknown) {
  if (!isRecord(value) || !isNonNegativeInteger(value.resourceCount) ||
    !isNonNegativeInteger(value.annotationFileCount) ||
    !isNonNegativeInteger(value.mediaFileCount) || !isNonNegativeInteger(value.fileObjectCount) ||
    !Array.isArray(value.fileObjects) || value.fileObjectCount !== value.fileObjects.length) {
    throw new Error("备份 manifest 的数据库摘要无效。 ");
  }
  const keys = new Set<string>();
  for (const file of value.fileObjects) {
    if (!isRecord(file) || !isNonEmptyString(file.storageKey) ||
      !isNonNegativeInteger(file.size) || (file.checksum !== null && !isSha256(file.checksum))) {
      throw new Error("备份 manifest 的 FileObject 摘要无效。 ");
    }
    assertSafeRelativePath(file.storageKey, "FileObject storageKey");
    if (keys.has(file.storageKey)) throw new Error(`FileObject storageKey 重复：“${file.storageKey}”。`);
    keys.add(file.storageKey);
  }
}

// 文件摘要必须与约定相对路径严格相等，不能由 manifest 任意重定向读取位置。
function validateDigest(value: unknown, expectedPath: string) {
  if (!isRecord(value) || value.relativePath !== expectedPath ||
    !isNonNegativeInteger(value.size) || !isSha256(value.sha256)) {
    throw new Error(`备份文件摘要无效：“${expectedPath}”。`);
  }
  assertSafeRelativePath(value.relativePath as string, "备份文件路径");
}

// 以下运行时守卫只负责 JSON 基础形状，领域约束仍由上层验证函数组合表达。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
