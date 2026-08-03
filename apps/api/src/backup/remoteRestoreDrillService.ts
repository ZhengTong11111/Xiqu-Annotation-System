import type { ObjectStorage } from "../objectStorage.js";
import {
  materializeRemoteBackup,
  removeMaterializedRemoteBackup,
} from "./remoteBackupMaterializer.js";
import { assertPhysicallySeparatedDirectories } from "./backupPaths.js";
import { runRestoreDrill } from "./restoreDrillService.js";

// 编排参数把可选线上本地根与远端备份源分开，S3 source 不得伪造一个物理目录。
export type RemoteRestoreDrillOptions = {
  backupStorage: Pick<ObjectStorage, "getObjectStream" | "listStoredObjects">;
  backupId: string;
  workRoot: string;
  sourceStorageRoot?: string;
  targetDatabaseUrl: string;
  targetStorageRoot: string;
  reportPath?: string;
  signal?: AbortSignal;
};

// 远端恢复编排只管理临时包生命周期，数据库和对象恢复仍由唯一的本地恢复实现负责。
export async function runRemoteRestoreDrill(options: RemoteRestoreDrillOptions) {
  // 临时工作区不能进入线上对象根，也不能包含恢复目标，避免半包成为业务对象或被清理误伤。
  await assertPhysicallySeparatedDirectories(
    options.targetStorageRoot,
    options.workRoot,
    "远端恢复工作根必须与恢复对象目录彼此分离。 ",
  );
  if (options.sourceStorageRoot) {
    await assertPhysicallySeparatedDirectories(
      options.sourceStorageRoot,
      options.workRoot,
      "远端恢复工作根必须与线上本地对象存储彼此分离。 ",
    );
  }
  const materialized = await materializeRemoteBackup({
    storage: options.backupStorage,
    backupId: options.backupId,
    workRoot: options.workRoot,
    signal: options.signal,
  });
  let result;
  try {
    result = await runRestoreDrill({
      backupDirectory: materialized.directory,
      sourceStorageRoot: options.sourceStorageRoot,
      targetDatabaseUrl: options.targetDatabaseUrl,
      targetStorageRoot: options.targetStorageRoot,
      reportPath: options.reportPath,
      signal: options.signal,
    });
  } catch (error) {
    await removeMaterializedRemoteBackup(materialized.directory, error);
    throw error;
  }
  // 恢复成功后的清理失败属于独立运维故障，不应被误当成恢复失败后再次补偿。
  await removeMaterializedRemoteBackup(materialized.directory);
  return result;
}
