import type { ObjectStorage, ObjectStorageBackendDescriptor } from "../objectStorage.js";
import { S3ObjectStorage } from "../s3ObjectStorage.js";
import { parseS3Options } from "../objectStorageFactory.js";

// 备份目标使用独立变量组，禁止悄悄复用线上对象存储凭据和 prefix。
export function createRemoteBackupStorageFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ObjectStorage {
  return new S3ObjectStorage(parseS3Options(environment, "XIQU_BACKUP_S3", true));
}

// 源与目标命名空间相同或互相包含时会递归备份自身，必须在进入维护前 fail closed。
export function assertSeparatedStorageNamespaces(
  source: ObjectStorageBackendDescriptor,
  target: ObjectStorageBackendDescriptor,
) {
  if (target.kind !== "remote") {
    throw new Error("远端备份目标必须是远端对象存储。 ");
  }
  if (source.kind !== "remote" || source.provider !== target.provider) return;
  const sourceLocation = trimLocation(source.location);
  const targetLocation = trimLocation(target.location);
  if (sourceLocation === targetLocation ||
    sourceLocation.startsWith(`${targetLocation}/`) ||
    targetLocation.startsWith(`${sourceLocation}/`)) {
    throw new Error("线上对象存储与远端备份目标必须使用互不包含的命名空间。 ");
  }
}

// 描述中的尾斜杠不应绕过 namespace 重叠判断。
function trimLocation(location: string) {
  return location.replace(/\/+$/, "");
}
