import type { Readable } from "node:stream";

// 暂存对象同时携带发布 key 与完整性摘要，数据库只能在 promote 成功后引用 final key。
export type StagedBinary = {
  finalStorageKey: string;
  stagedStorageKey: string;
  checksum: string;
  size: number;
  header: Uint8Array;
};

// 生命周期审计只消费安全对象摘要，不应获得本地路径或远端服务内部标识。
export type StoredObjectSummary = {
  storageKey: string;
  size: number;
  modifiedAt: Date;
  staged: boolean;
};

// Range 使用闭区间，与 HTTP Range 的 start/end 语义保持一致。
export type ObjectReadRange = { start: number; end: number };

// 后端描述使用判别联合；只有 local 分支允许备份命令读取受控根目录。
export type ObjectStorageBackendDescriptor =
  | { kind: "local"; rootDirectory: string }
  | { kind: "remote"; provider: string; location: string };

// 对象存储端口表达现有业务真实需要的 staged publish、Range、巡检和健康语义。
export interface ObjectStorage {
  describeBackend(): ObjectStorageBackendDescriptor;
  createStorageKey(extension: string): string;
  putStagedObject(
    finalStorageKey: string,
    stream: Readable,
    maxBytes: number,
  ): Promise<StagedBinary>;
  promoteStagedObject(staged: StagedBinary): Promise<void>;
  getObjectStream(storageKey: string, range?: ObjectReadRange): Promise<Readable>;
  objectExists(storageKey: string): Promise<boolean>;
  deleteObject(storageKey: string): Promise<void>;
  checkReadiness(): Promise<void>;
  listStoredObjects(): Promise<StoredObjectSummary[]>;
}

export type UncommittedObjectCleanupFailure = {
  stage: "final" | "staged";
  error: unknown;
};

// promote 在远端可能出现“复制已成功，但响应或 staged 删除失败”的不确定结果。
// 数据库尚未提交时必须同时幂等删除 final 与 staged，不能依赖调用方猜测远端已走到哪一步。
export async function cleanupUncommittedStagedBinary(
  storage: Pick<ObjectStorage, "deleteObject">,
  staged: StagedBinary,
): Promise<UncommittedObjectCleanupFailure[]> {
  const failures: UncommittedObjectCleanupFailure[] = [];
  for (const [stage, storageKey] of [
    ["final", staged.finalStorageKey],
    ["staged", staged.stagedStorageKey],
  ] as const) {
    try {
      await storage.deleteObject(storageKey);
    } catch (error) {
      failures.push({ stage, error });
    }
  }
  return failures;
}

// 所有后端都用同一超限错误向上传业务报告流式大小边界，不泄漏具体 SDK/文件系统异常。
export class StorageSizeLimitError extends Error {}

// 本地一致备份必须在进入维护前完成能力收窄；远端后端不能伪造 rootDirectory 绕过专用策略。
export function requireLocalSnapshotRoot(storage: ObjectStorage) {
  const descriptor = storage.describeBackend();
  if (descriptor.kind !== "local") {
    throw new Error(
      `当前备份命令只支持本地对象存储，实际后端为“${descriptor.provider}”。`,
    );
  }
  return descriptor.rootDirectory;
}
