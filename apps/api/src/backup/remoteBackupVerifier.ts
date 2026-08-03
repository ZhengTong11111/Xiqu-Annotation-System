import type { ObjectStorage } from "../objectStorage.js";
import type { BackupVerificationResult } from "./backupTypes.js";
import { digestReadable } from "./checksum.js";
import {
  formatRemoteBackupError,
  readRemoteBackupPackageIndex,
} from "./remoteBackupPackage.js";

// 远端校验以 manifest 作为完成标志，并逐项复算内容；它不连接数据库也不修改远端对象。
export async function verifyRemoteBackup(
  storage: Pick<ObjectStorage, "getObjectStream" | "listStoredObjects">,
  backupId: string,
): Promise<BackupVerificationResult> {
  let packageIndex;
  try {
    packageIndex = await readRemoteBackupPackageIndex(storage, backupId);
  } catch (error) {
    return {
      valid: false,
      manifest: null,
      errors: [formatRemoteBackupError(error)],
    };
  }
  const errors = [...packageIndex.objectSetErrors];

  // 单个文件失败不会中止后续摘要检查，使运维一次看到全部可诊断损坏。
  for (const file of packageIndex.files) {
    try {
      const digest = await digestReadable(await storage.getObjectStream(file.remoteKey));
      if (digest.size !== file.entry.size) errors.push(`${file.remoteKey} 大小不一致。`);
      if (digest.sha256 !== file.entry.sha256) {
        errors.push(`${file.remoteKey} SHA-256 不一致。`);
      }
    } catch (error) {
      errors.push(`${file.remoteKey} 无法校验：${formatRemoteBackupError(error)}`);
    }
  }
  return {
    valid: errors.length === 0,
    manifest: packageIndex.manifest,
    errors,
  };
}
