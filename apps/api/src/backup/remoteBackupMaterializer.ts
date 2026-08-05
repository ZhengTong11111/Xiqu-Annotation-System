import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStorage } from "../objectStorage.js";
import { writeBackupManifest } from "./backupManifest.js";
import { resolveInsideRoot } from "./backupPaths.js";
import type { BackupManifest } from "./backupTypes.js";
import {
  readRemoteBackupPackageIndex,
  type RemoteBackupPackageFile,
} from "./remoteBackupPackage.js";

// 物化参数显式限制在远端读取与本地工作根，不赋予数据库或恢复目标写入能力。
export type MaterializeRemoteBackupOptions = {
  storage: Pick<ObjectStorage, "getObjectStream" | "listStoredObjects">;
  backupId: string;
  workRoot: string;
  signal?: AbortSignal;
};

export type MaterializedRemoteBackup = {
  directory: string;
  manifest: BackupManifest;
};

// 远端物化只负责把一个完整包单次下载到唯一临时目录，不连接数据库也不触碰恢复目标。
export async function materializeRemoteBackup(
  options: MaterializeRemoteBackupOptions,
): Promise<MaterializedRemoteBackup> {
  const packageIndex = await readRemoteBackupPackageIndex(options.storage, options.backupId);
  if (packageIndex.objectSetErrors.length > 0) {
    throw new Error(`远端备份对象集合无效：${packageIndex.objectSetErrors.join("；")}`);
  }

  const workRoot = path.resolve(options.workRoot);
  await mkdir(workRoot, { recursive: true });
  const workMetadata = await lstat(workRoot);
  if (workMetadata.isSymbolicLink() || !workMetadata.isDirectory()) {
    throw new Error("远端恢复工作根必须是普通目录，不能是符号链接。 ");
  }
  const directory = await mkdtemp(path.join(workRoot, ".xiqu-remote-restore-"));
  try {
    // payload 按顺序流式落盘并同步复算摘要，避免把大媒体读入内存或重复网络下载。
    for (const file of packageIndex.files) {
      if (options.signal?.aborted) throw new Error("远端备份物化已中止。 ");
      await materializePackageFile(options.storage, directory, file, options.signal);
    }

    // manifest 最后写入；因此只有 payload 全部通过摘要检查的目录才成为有效本地备份包。
    await writeBackupManifest(directory, packageIndex.manifest);
    return { directory, manifest: packageIndex.manifest };
  } catch (error) {
    await removeMaterializedRemoteBackup(directory, error);
    throw error;
  }
}

// 调用方完成恢复后必须删除临时包；主流程失败时同时保留主错误和清理错误。
export async function removeMaterializedRemoteBackup(
  directory: string,
  primaryError?: unknown,
) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (cleanupError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "远端恢复失败，且临时物化备份无法清理。",
      );
    }
    throw new AggregateError(
      [cleanupError],
      "远端恢复完成，但临时物化备份无法清理。",
    );
  }
}

// 单文件管线把摘要 Transform 放在写流前，远端字节只经过一次即可同时完成落盘与校验。
async function materializePackageFile(
  storage: Pick<ObjectStorage, "getObjectStream">,
  directory: string,
  file: RemoteBackupPackageFile,
  signal?: AbortSignal,
) {
  const target = resolveInsideRoot(directory, file.entry.relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const hash = createHash("sha256");
  let size = 0;
  const digestingStream = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      hash.update(bytes);
      callback(null, bytes);
    },
  });
  await pipeline(
    await storage.getObjectStream(file.remoteKey),
    digestingStream,
    createWriteStream(target, { flags: "wx" }),
    { signal },
  );
  const sha256 = hash.digest("hex");
  if (size !== file.entry.size || sha256 !== file.entry.sha256) {
    throw new Error(`远端备份文件摘要不一致：${file.remoteKey}。`);
  }
}
