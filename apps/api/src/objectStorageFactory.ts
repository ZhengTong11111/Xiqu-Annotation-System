import type { ObjectStorage } from "./objectStorage.js";
import { LocalObjectStorage } from "./storage.js";

// composition root 通过显式 backend 选择唯一生产实现；未知值 fail closed，不能悄悄把远端配置写回本地。
export function createObjectStorageFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ObjectStorage {
  const configured = environment.XIQU_OBJECT_STORAGE_BACKEND;
  const backend = configured === undefined ? "local" : configured.trim();
  if (backend === "local") {
    return new LocalObjectStorage(environment.XIQU_STORAGE_ROOT);
  }
  throw new Error(
    `不支持对象存储后端“${backend || "<empty>"}”；当前可用值只有 local。`,
  );
}
