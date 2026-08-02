// 备份包格式使用显式版本号；未知版本必须拒绝，避免用旧恢复器误读未来格式。
export const BACKUP_MANIFEST_VERSION = 1 as const;
export const BACKUP_MANIFEST_FILE = "manifest.json";
export const BACKUP_DATABASE_FILE = "database.dump";
export const BACKUP_OBJECTS_DIRECTORY = "objects";

// 文件摘要覆盖数据库 dump 和每个对象，恢复前可完全离线验证内容完整性。
export type BackupFileDigest = {
  relativePath: string;
  size: number;
  sha256: string;
};

// 清单只记录无秘密的数据库身份，禁止保存密码、完整连接串或本机绝对路径。
export type BackupDatabaseIdentity = {
  host: string;
  port: number;
  database: string;
  schema: string;
};

// FileObject 摘要用于恢复后交叉检查数据库元数据和对象目录，而非代替数据库 dump。
export type BackupDatabaseFileObject = {
  storageKey: string;
  size: number;
  checksum: string | null;
};

export type BackupDatabaseSummary = {
  resourceCount: number;
  annotationFileCount: number;
  mediaFileCount: number;
  fileObjectCount: number;
  fileObjects: BackupDatabaseFileObject[];
};

export type BackupObjectEntry = BackupFileDigest & {
  storageKey: string;
};

export type BackupManifest = {
  format: "xiqu-platform-backup";
  version: typeof BACKUP_MANIFEST_VERSION;
  createdAt: string;
  operator: {
    accountName: string;
    userId: string;
  };
  maintenanceReason: string;
  database: {
    identity: BackupDatabaseIdentity;
    postgresToolVersion: string;
    dump: BackupFileDigest;
    summary: BackupDatabaseSummary;
  };
  objects: {
    count: number;
    totalBytes: number;
    entries: BackupObjectEntry[];
  };
  warnings: string[];
};

// 离线校验返回全部问题，便于运维一次定位多个损坏点，而不是修一个再失败一次。
export type BackupVerificationResult = {
  valid: boolean;
  manifest: BackupManifest | null;
  errors: string[];
};

export type RestoreDrillReport = {
  format: "xiqu-platform-restore-drill";
  version: 1;
  startedAt: string;
  completedAt: string;
  sourceBackupCreatedAt: string;
  sourceDatabase: BackupDatabaseIdentity;
  targetDatabase: BackupDatabaseIdentity;
  targetStorage: string;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  passed: boolean;
};
