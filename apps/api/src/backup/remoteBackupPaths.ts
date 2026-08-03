import { createBackupDirectoryNames, assertSafeRelativePath } from "./backupPaths.js";
import {
  BACKUP_DATABASE_FILE,
  BACKUP_MANIFEST_FILE,
  BACKUP_OBJECTS_DIRECTORY,
} from "./backupTypes.js";

// 远端备份沿用本地备份的人类可读时间戳与随机后缀，同时拒绝调用方构造跨前缀 id。
export function createRemoteBackupId() {
  return createBackupDirectoryNames().finalName;
}

// backup id 必须是单一普通路径段，远端 verifier 不能借此读取相邻备份。
export function assertSafeRemoteBackupId(backupId: string) {
  assertSafeRelativePath(backupId, "远端备份 id");
  if (backupId.includes("/")) {
    throw new Error(`远端备份 id 不能包含目录分隔符：“${backupId}”。`);
  }
  return backupId;
}

// 所有包内相对路径先经过 manifest 的安全规则，再映射到唯一 backup id 命名空间。
export function remoteBackupKey(backupId: string, relativePath: string) {
  return `${assertSafeRemoteBackupId(backupId)}/${assertSafeRelativePath(relativePath, "备份文件路径")}`;
}

// 固定 key helper 让发布器、校验器与后续恢复器共享同一远端布局。
export const remoteBackupKeys = {
  manifest: (backupId: string) => remoteBackupKey(backupId, BACKUP_MANIFEST_FILE),
  database: (backupId: string) => remoteBackupKey(backupId, BACKUP_DATABASE_FILE),
  object: (backupId: string, storageKey: string) =>
    remoteBackupKey(backupId, `${BACKUP_OBJECTS_DIRECTORY}/${assertSafeRelativePath(storageKey, "storageKey")}`),
};
