export const DEFAULT_REMOTE_BACKUP_INCOMPLETE_GRACE_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_REMOTE_BACKUP_RETENTION_DAYS = 30;
export const DEFAULT_REMOTE_BACKUP_MIN_RETAINED = 3;

export type RemoteBackupRetentionPolicy = {
  incompleteGraceMs: number;
  retentionDays: number;
  minimumRetained: number;
};

export type RemoteBackupRetentionOverrides = {
  incompleteGraceMs?: string;
  retentionDays?: string;
  minimumRetained?: string;
};

// 环境和 CLI 覆盖共用同一数值边界；错误配置必须在扫描 bucket 前 fail closed。
export function resolveRemoteBackupRetentionPolicy(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: RemoteBackupRetentionOverrides = {},
): RemoteBackupRetentionPolicy {
  return {
    incompleteGraceMs: readBoundedInteger(
      overrides.incompleteGraceMs ?? environment.XIQU_REMOTE_BACKUP_INCOMPLETE_GRACE_MS,
      DEFAULT_REMOTE_BACKUP_INCOMPLETE_GRACE_MS,
      60_000,
      30 * 24 * 60 * 60 * 1_000,
      "远端未完成备份宽限毫秒数",
    ),
    retentionDays: readBoundedInteger(
      overrides.retentionDays ?? environment.XIQU_REMOTE_BACKUP_RETENTION_DAYS,
      DEFAULT_REMOTE_BACKUP_RETENTION_DAYS,
      1,
      3_650,
      "远端完整备份保留天数",
    ),
    minimumRetained: readBoundedInteger(
      overrides.minimumRetained ?? environment.XIQU_REMOTE_BACKUP_MIN_RETAINED,
      DEFAULT_REMOTE_BACKUP_MIN_RETAINED,
      1,
      1_000,
      "远端完整备份最少保留数量",
    ),
  };
}

// 策略数值只接受十进制正整数，禁止小数、指数、空白和超大值形成意外清理窗口。
function readBoundedInteger(
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (rawValue === undefined) return fallback;
  const value = rawValue.trim();
  if (!/^\d+$/.test(value)) throw new Error(`${label}必须是整数。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label}必须在 ${minimum} 到 ${maximum} 之间。`);
  }
  return parsed;
}
