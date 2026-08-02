import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readBackupManifest } from "./backupManifest.js";
import { resolveInsideRoot } from "./backupPaths.js";
import { digestFile } from "./checksum.js";
import type { BackupVerificationResult } from "./backupTypes.js";

// 离线校验不连接数据库，逐项复算 dump/对象摘要并汇总全部可诊断错误。
export async function verifyBackupDirectory(directory: string): Promise<BackupVerificationResult> {
  const root = path.resolve(directory);
  try {
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("备份路径不是目录。 ");
  } catch (error) {
    return { valid: false, manifest: null, errors: [formatError(error)] };
  }
  let manifest;
  try {
    manifest = await readBackupManifest(root);
  } catch (error) {
    return { valid: false, manifest: null, errors: [formatError(error)] };
  }
  const errors: string[] = [];
  const files = [manifest.database.dump, ...manifest.objects.entries];
  const expectedPaths = new Set(["manifest.json", ...files.map((entry) => entry.relativePath)]);
  for (const actualPath of await listPackageFiles(root, errors)) {
    if (!expectedPaths.has(actualPath)) errors.push(`备份包包含 manifest 未声明的文件：${actualPath}。`);
  }
  for (const entry of files) {
    try {
      const actual = await digestFile(resolveInsideRoot(root, entry.relativePath));
      if (actual.size !== entry.size) errors.push(`${entry.relativePath} 大小不一致。`);
      if (actual.sha256 !== entry.sha256) errors.push(`${entry.relativePath} SHA-256 不一致。`);
    } catch (error) {
      errors.push(`${entry.relativePath} 无法校验：${formatError(error)}`);
    }
  }
  return { valid: errors.length === 0, manifest, errors };
}

// 包目录扫描拒绝 symlink，并把全部普通文件转成规范 POSIX 相对路径供白名单比较。
async function listPackageFiles(root: string, errors: string[]) {
  const files: string[] = [];
  await walk(root);
  return files;

  // 递归扫描只收集普通文件；目录本身不需要出现在 manifest 中。
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (metadata.isSymbolicLink()) {
        errors.push(`备份包包含不允许的符号链接：${relative}。`);
      } else if (metadata.isDirectory()) {
        await walk(absolute);
      } else if (metadata.isFile()) {
        files.push(relative);
      }
    }
  }
}

// 错误格式化仅暴露可操作消息，调用方负责决定是否打印开发堆栈。
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
