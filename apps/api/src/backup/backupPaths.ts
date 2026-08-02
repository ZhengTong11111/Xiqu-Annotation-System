import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { BackupDatabaseIdentity } from "./backupTypes.js";

// 存储 key 与备份相对路径都必须是规范 POSIX 相对路径，防止恢复时越过目标目录。
export function assertSafeRelativePath(value: string, label = "相对路径") {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new Error(`${label}不是安全的相对路径：“${value}”。`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../")) {
    throw new Error(`${label}包含路径穿越或非规范片段：“${value}”。`);
  }
  return value;
}

// 所有相对路径落盘前都再次约束在根目录内，不能仅依赖 manifest 已通过解析。
export function resolveInsideRoot(root: string, relativePath: string) {
  assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`路径“${relativePath}”越过受控根目录。`);
  }
  return target;
}

// 备份 staging 与 final 位于同一父目录，最后一次 rename 才发布完整备份包。
export function createBackupDirectoryNames(now = new Date()) {
  const timestamp = now.toISOString().replaceAll(":", "-").replace(".", "-");
  const suffix = randomUUID().slice(0, 8);
  const finalName = `xiqu-backup-${timestamp}-${suffix}`;
  return { finalName, stagingName: `.${finalName}.staging` };
}

// 输出目录不能位于对象根内，也不能包含对象根，避免递归复制或把源对象误当备份产物。
export function assertSeparatedDirectories(storageRoot: string, outputRoot: string) {
  const storage = path.resolve(storageRoot);
  const output = path.resolve(outputRoot);
  if (storage === output || isInside(storage, output) || isInside(output, storage)) {
    throw new Error("备份输出目录与对象存储目录必须彼此分离。 ");
  }
}

// 目录创建后再比较真实物理路径，防止 output 或其祖先 symlink 绕过词法分离检查。
export async function assertPhysicallySeparatedDirectories(
  storageRoot: string,
  outputRoot: string,
) {
  const [storage, output] = await Promise.all([
    resolvePhysicalPath(storageRoot),
    resolvePhysicalPath(outputRoot),
  ]);
  assertSeparatedDirectories(storage, output);
}

// 恢复对象目录必须为空且不与源目录/备份目录重叠，禁止覆盖现有资产。
export async function assertSafeRestoreStorage(
  targetStorage: string,
  sourceStorage: string,
  backupDirectory: string,
) {
  const [target, source, backup] = await Promise.all([
    resolvePhysicalPath(targetStorage),
    resolvePhysicalPath(sourceStorage),
    resolvePhysicalPath(backupDirectory),
  ]);
  if (
    target === source || target === backup || isInside(source, target) ||
    isInside(target, source) || isInside(backup, target) || isInside(target, backup)
  ) {
    throw new Error("恢复对象目录不能与源存储或备份目录重叠。 ");
  }
  try {
    const linkMetadata = await lstat(path.resolve(targetStorage));
    if (linkMetadata.isSymbolicLink()) throw new Error("恢复对象目录不能是符号链接。 ");
    const metadata = await stat(target);
    if (!metadata.isDirectory()) throw new Error("恢复对象目标不是目录。");
    if ((await readdir(target)).length > 0) {
      throw new Error("恢复对象目录必须为空。 ");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

// 恢复报告是演练产物，必须在写库前确认不会污染不可变备份包、对象目录或覆盖既有报告。
export async function assertSafeRestoreReport(
  reportPath: string,
  backupDirectory: string,
  targetStorage: string,
) {
  const report = path.resolve(reportPath);
  const backup = path.resolve(backupDirectory);
  const target = path.resolve(targetStorage);
  if (report === backup || report === target || isInside(backup, report) || isInside(target, report)) {
    throw new Error("恢复报告不能写入备份包或恢复对象目录。 ");
  }
  try {
    await lstat(report);
    throw new Error("恢复报告目标已存在。 ");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

// 不存在的目标通过最近已存在祖先的 realpath 解析，连父目录 symlink 也不能隐藏真实重叠关系。
async function resolvePhysicalPath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await resolvePhysicalPath(parent), path.basename(absolute));
  }
}

// 恢复演练必须使用不同数据库；schema 不同仍可能污染同一数据库实例中的真实数据。
export function assertIsolatedDatabaseTarget(
  source: BackupDatabaseIdentity,
  target: BackupDatabaseIdentity,
) {
  // 数据库名必须显式不同；即使 host 别名变化，也不能靠 localhost/127.0.0.1 绕过保护。
  if (source.database === target.database) {
    throw new Error("恢复演练目标数据库不能与备份源数据库相同。 ");
  }
  if (!target.database || ["postgres", "template0", "template1"].includes(target.database)) {
    throw new Error("恢复演练不能写入 PostgreSQL 系统数据库。 ");
  }
}

// 子路径判断统一使用 path.relative，避免字符串前缀把 storage-old 误认为 storage 子目录。
function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// 仅 ENOENT 表示可以继续解析尚未创建的目标，其余权限/IO 错误不能吞掉。
function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
