import type { Readable } from "node:stream";
import type { ObjectStorage } from "../objectStorage.js";
import { parseBackupManifestText } from "./backupManifest.js";
import type { BackupFileDigest, BackupManifest } from "./backupTypes.js";
import {
  assertSafeRemoteBackupId,
  remoteBackupKey,
  remoteBackupKeys,
} from "./remoteBackupPaths.js";

// 远端 manifest 只保存元数据；上限既能容纳大量对象摘要，也限制损坏对象的内存占用。
export const MAX_REMOTE_MANIFEST_BYTES = 8 * 1024 * 1024;

// 包索引只描述经过 manifest 校验的 payload 和远端 key，不携带 SDK 或本地路径信息。
export type RemoteBackupPackageFile = {
  entry: BackupFileDigest;
  remoteKey: string;
};

export type RemoteBackupPackageIndex = {
  backupId: string;
  manifest: BackupManifest;
  files: RemoteBackupPackageFile[];
  objectSetErrors: string[];
};

// 校验器和物化器共享同一包索引：manifest、远端 key 映射和精确对象集合不能各维护一份规则。
export async function readRemoteBackupPackageIndex(
  storage: Pick<ObjectStorage, "getObjectStream" | "listStoredObjects">,
  backupId: string,
): Promise<RemoteBackupPackageIndex> {
  const safeBackupId = assertSafeRemoteBackupId(backupId);
  const manifestText = await readUtf8WithLimit(
    await storage.getObjectStream(remoteBackupKeys.manifest(safeBackupId)),
    MAX_REMOTE_MANIFEST_BYTES,
  );
  const manifest = parseBackupManifestText(manifestText);
  const files = [manifest.database.dump, ...manifest.objects.entries].map((entry) => ({
    entry,
    remoteKey: remoteBackupKey(safeBackupId, entry.relativePath),
  }));

  // 同一个 backup id 下只允许 manifest 声明的 final 对象，额外 staged/final 对象都表示包不完整或受污染。
  const expectedKeys = new Set([
    remoteBackupKeys.manifest(safeBackupId),
    ...files.map((file) => file.remoteKey),
  ]);
  const objectSetErrors: string[] = [];
  try {
    const actualObjects = (await storage.listStoredObjects())
      .filter((object) => object.storageKey.startsWith(`${safeBackupId}/`));
    const actualKeys = new Set(actualObjects.map((object) => object.storageKey));
    for (const expectedKey of expectedKeys) {
      if (!actualKeys.has(expectedKey)) {
        objectSetErrors.push(`远端备份缺少文件：${expectedKey}。`);
      }
    }
    for (const object of actualObjects) {
      if (!expectedKeys.has(object.storageKey)) {
        objectSetErrors.push(`远端备份包含 manifest 未声明的对象：${object.storageKey}。`);
      }
    }
  } catch (error) {
    objectSetErrors.push(`无法列举远端备份对象：${formatRemoteBackupError(error)}`);
  }
  return { backupId: safeBackupId, manifest, files, objectSetErrors };
}

// manifest 读取超过上限时立即销毁流，避免继续聚合不受信任的远端内容。
export async function readUtf8WithLimit(stream: Readable, maxBytes: number) {
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

// 对外错误只保留可操作消息，不能把 SDK 对象、凭据或堆栈写入运维输出。
export function formatRemoteBackupError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
