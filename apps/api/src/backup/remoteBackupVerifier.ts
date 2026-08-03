import type { Readable } from "node:stream";
import type { ObjectStorage } from "../objectStorage.js";
import { parseBackupManifestText } from "./backupManifest.js";
import type { BackupVerificationResult } from "./backupTypes.js";
import { digestReadable } from "./checksum.js";
import { assertSafeRemoteBackupId, remoteBackupKey, remoteBackupKeys } from "./remoteBackupPaths.js";

// manifest 只保存元数据；8 MiB 上限可容纳大量对象摘要，同时限制恶意或损坏对象的内存占用。
const MAX_REMOTE_MANIFEST_BYTES = 8 * 1024 * 1024;

// 远端校验以 manifest 作为完成标志，并逐项复算内容；它不连接数据库也不修改远端对象。
export async function verifyRemoteBackup(
  storage: Pick<ObjectStorage, "getObjectStream" | "listStoredObjects">,
  backupId: string,
): Promise<BackupVerificationResult> {
  const safeBackupId = assertSafeRemoteBackupId(backupId);
  let manifest;
  try {
    const text = await readUtf8WithLimit(
      await storage.getObjectStream(remoteBackupKeys.manifest(safeBackupId)),
      MAX_REMOTE_MANIFEST_BYTES,
    );
    manifest = parseBackupManifestText(text);
  } catch (error) {
    return { valid: false, manifest: null, errors: [formatError(error)] };
  }

  // 允许集合由 manifest 精确声明；同一 backup id 下任何额外 final/staged 对象都视为不完整或污染。
  const files = [manifest.database.dump, ...manifest.objects.entries];
  const expectedKeys = new Set([
    remoteBackupKeys.manifest(safeBackupId),
    ...files.map((entry) => remoteBackupKey(safeBackupId, entry.relativePath)),
  ]);
  const errors: string[] = [];
  try {
    const actualObjects = (await storage.listStoredObjects())
      .filter((object) => object.storageKey.startsWith(`${safeBackupId}/`));
    const actualKeys = new Set(actualObjects.map((object) => object.storageKey));
    for (const expectedKey of expectedKeys) {
      if (!actualKeys.has(expectedKey)) errors.push(`远端备份缺少文件：${expectedKey}。`);
    }
    for (const object of actualObjects) {
      if (!expectedKeys.has(object.storageKey)) {
        errors.push(`远端备份包含 manifest 未声明的对象：${object.storageKey}。`);
      }
    }
  } catch (error) {
    errors.push(`无法列举远端备份对象：${formatError(error)}`);
  }

  // 单个文件失败不会中止后续摘要检查，使运维一次看到全部可诊断损坏。
  for (const entry of files) {
    const key = remoteBackupKey(safeBackupId, entry.relativePath);
    try {
      const digest = await digestReadable(await storage.getObjectStream(key));
      if (digest.size !== entry.size) errors.push(`${key} 大小不一致。`);
      if (digest.sha256 !== entry.sha256) errors.push(`${key} SHA-256 不一致。`);
    } catch (error) {
      errors.push(`${key} 无法校验：${formatError(error)}`);
    }
  }
  return { valid: errors.length === 0, manifest, errors };
}

// manifest 有明确内存上限；超过上限时立即销毁流，不能继续聚合不受信任的远端内容。
async function readUtf8WithLimit(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new Error("远端备份 manifest 超过允许大小。 ");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

// 校验结果只保留可操作消息，不把 SDK 对象、凭据或堆栈写入输出。
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
