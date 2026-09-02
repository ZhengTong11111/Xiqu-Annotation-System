import * as archiverRuntime from "archiver";
import type archiver from "archiver";
import {
  ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_BYTES,
  canonicalAlignmentTrainingJson,
  type AlignmentTrainingPackageManifest,
  type AlignmentTrainingPackagePlan,
  type AlignmentTrainingPackagePlanItem,
} from "@xiqu/document-model";
import type { Readable } from "node:stream";
import {
  visitAlignmentTrainingPackageEntries,
  type AlignmentTrainingPackageStreamEntry,
} from "./alignmentTrainingPackageStream.js";
import {
  cleanupUncommittedStagedBinary,
  StorageSizeLimitError,
  type ObjectStorage,
  type StagedBinary,
} from "./objectStorage.js";

const ZIP_ENTRY_DATE = new Date("1980-01-01T00:00:00.000Z");
const MAX_FINAL_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_OVERHEAD_BYTES = 64 * 1024 * 1024;
export const ALIGNMENT_TRAINING_PACKAGE_MAX_ARCHIVE_BYTES =
  ALIGNMENT_TRAINING_PACKAGE_MAX_TOTAL_BYTES + MAX_ZIP_OVERHEAD_BYTES;

// archiver v8 已改为 ESM 命名导出，但当前 DefinitelyTyped 仍描述旧默认工厂；适配只集中在这一行。
const ZipArchive = (archiverRuntime as unknown as {
  ZipArchive: new (options: archiver.ArchiverOptions) => archiver.Archiver;
}).ZipArchive;

export type AlignmentTrainingPackageWriterErrorCode =
  | "package_write_aborted"
  | "package_archive_failed"
  | "package_storage_failed"
  | "package_manifest_too_large";

export class AlignmentTrainingPackageWriterError extends Error {
  constructor(readonly code: AlignmentTrainingPackageWriterErrorCode) {
    super(code);
  }
}

type OpenEntry = (
  item: AlignmentTrainingPackagePlanItem,
  signal: AbortSignal,
) => Promise<Readable> | Readable;

export type AlignmentTrainingPackageWriteResult = {
  staged: StagedBinary;
  manifest: AlignmentTrainingPackageManifest;
};

/**
 * 直接把确定性条目流写入对象存储的 staged ZIP64。归档器与存储上传并行背压，
 * 当前条目消费完成后才打开下一项，过程中不会形成整包 Buffer 或宿主临时 ZIP。
 */
export async function writeAlignmentTrainingPackageToStage(input: {
  storage: ObjectStorage;
  finalStorageKey: string;
  plan: AlignmentTrainingPackagePlan;
  provenanceJson: string;
  inputJson: string;
  signal: AbortSignal;
  openPrediction: OpenEntry;
  openTarget: OpenEntry;
  openAudio: OpenEntry;
}): Promise<AlignmentTrainingPackageWriteResult> {
  if (input.signal.aborted) throw new AlignmentTrainingPackageWriterError("package_write_aborted");
  const internalAbort = new AbortController();
  const workSignal = AbortSignal.any([input.signal, internalAbort.signal]);
  const archive = new ZipArchive({
    forceZip64: true,
    forceLocalTime: false,
    store: true,
  });
  let archiveFailed = false;
  let storageFailure: unknown = null;
  let stagedResult: StagedBinary | null = null;
  const failArchive = () => {
    archiveFailed = true;
    internalAbort.abort("alignment_training_archive_failed");
  };
  archive.once("warning", failArchive);
  archive.once("error", failArchive);

  // 先启动对象存储消费，archiver 的背压会一直传递到当前输入条目。
  const stagedPromise = input.storage.putStagedObject(
    input.finalStorageKey,
    archive,
    ALIGNMENT_TRAINING_PACKAGE_MAX_ARCHIVE_BYTES,
  ).then((result) => {
    stagedResult = result;
    return result;
  }).catch((error) => {
    storageFailure = error;
    internalAbort.abort("alignment_training_storage_failed");
    archive.abort();
    archive.destroy();
    throw error;
  });

  try {
    const manifest = await visitAlignmentTrainingPackageEntries({
      plan: input.plan,
      provenanceJson: input.provenanceJson,
      inputJson: input.inputJson,
      signal: workSignal,
      openPrediction: input.openPrediction,
      openTarget: input.openTarget,
      openAudio: input.openAudio,
      onEntry: async (entry) => appendStreamEntry(archive, entry),
    });
    const manifestJson = canonicalAlignmentTrainingJson(manifest);
    if (Buffer.byteLength(manifestJson, "utf8") > MAX_FINAL_MANIFEST_BYTES) {
      throw new AlignmentTrainingPackageWriterError("package_manifest_too_large");
    }
    archive.append(Buffer.from(manifestJson, "utf8"), entryOptions("manifest.json"));
    await archive.finalize();
    return { staged: await stagedPromise, manifest };
  } catch (error) {
    internalAbort.abort("alignment_training_package_failed");
    archive.abort();
    // abort() 只停止队列；destroy() 才能让正在消费 ZIP 的本地/S3 pipeline 立即结束。
    archive.destroy();
    await stagedPromise.catch(() => undefined);
    if (stagedResult) {
      // 归档失败时对象后端仍可能把提前闭合的残缺 ZIP 当作成功上传；统一补偿两个 key。
      const cleanupFailures = await cleanupUncommittedStagedBinary(input.storage, stagedResult);
      if (cleanupFailures.length > 0) {
        throw new AlignmentTrainingPackageWriterError("package_storage_failed");
      }
    }
    if (input.signal.aborted) {
      throw new AlignmentTrainingPackageWriterError("package_write_aborted");
    }
    if (error instanceof AlignmentTrainingPackageWriterError) throw error;
    if (storageFailure instanceof StorageSizeLimitError) throw storageFailure;
    if (storageFailure) {
      throw new AlignmentTrainingPackageWriterError("package_storage_failed");
    }
    if (archiveFailed) throw new AlignmentTrainingPackageWriterError("package_archive_failed");
    throw error;
  } finally {
    archive.removeListener("warning", failArchive);
    archive.removeListener("error", failArchive);
  }
}

function appendStreamEntry(
  archive: archiver.Archiver,
  entry: AlignmentTrainingPackageStreamEntry,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      entry.stream.removeListener("end", complete);
      entry.stream.removeListener("error", fail);
    };
    const complete = () => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    entry.stream.once("end", complete);
    entry.stream.once("error", fail);
    archive.append(entry.stream, entryOptions(entry.path));
  });
}

function entryOptions(name: string) {
  return {
    name,
    date: ZIP_ENTRY_DATE,
    mode: 0o600,
    store: true,
  } as const;
}
