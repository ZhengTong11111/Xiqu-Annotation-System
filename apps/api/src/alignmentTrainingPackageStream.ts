import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import {
  ALIGNMENT_TRAINING_PACKAGE_MAX_AUDIO_BYTES,
  buildAlignmentTrainingPackageManifest,
  canonicalAlignmentTrainingJson,
  parseAlignmentTrainingPackagePlan,
  type AlignmentTrainingPackageInventoryEntry,
  type AlignmentTrainingPackageManifest,
  type AlignmentTrainingPackagePlan,
  type AlignmentTrainingPackagePlanItem,
} from "@xiqu/document-model";

export type AlignmentTrainingPackageStreamErrorCode =
  | "package_aborted"
  | "package_entry_open_failed"
  | "package_entry_too_large"
  | "package_entry_checksum_mismatch"
  | "package_entry_size_mismatch"
  | "package_entry_consumer_failed"
  | "package_manifest_invalid";

export class AlignmentTrainingPackageStreamError extends Error {
  constructor(readonly code: AlignmentTrainingPackageStreamErrorCode) {
    super(code);
  }
}

export type AlignmentTrainingPackageStreamEntry = {
  path: string;
  kind: AlignmentTrainingPackageInventoryEntry["kind"];
  stream: Readable;
};

type OpenEntry = (
  item: AlignmentTrainingPackagePlanItem,
  signal: AbortSignal,
) => Promise<Readable> | Readable;

type VisitOptions = {
  plan: AlignmentTrainingPackagePlan;
  provenanceJson: string;
  inputJson: string;
  signal: AbortSignal;
  openPrediction: OpenEntry;
  openTarget: OpenEntry;
  openAudio: OpenEntry;
  onEntry: (entry: AlignmentTrainingPackageStreamEntry) => Promise<void>;
};

/**
 * 逐项访问训练包输入。调用方必须在 onEntry 返回前把 stream 消费完；函数会等待实际 EOF 和校验完成，
 * 因而不会提前打开下一条对象。这里不创建 ZIP、不写对象，也不持有整包 Buffer。
 */
export async function visitAlignmentTrainingPackageEntries(
  options: VisitOptions,
): Promise<AlignmentTrainingPackageManifest> {
  const parsedPlan = parseAlignmentTrainingPackagePlan(options.plan, sha256Hex);
  if (!parsedPlan.ok) throw new AlignmentTrainingPackageStreamError("package_manifest_invalid");
  const plan = parsedPlan.value;
  const inventory: AlignmentTrainingPackageInventoryEntry[] = [];

  await visitGeneratedEntry(options, inventory, {
    path: plan.provenanceEntry.path,
    kind: "provenance",
    content: options.provenanceJson,
    expectedChecksum: plan.provenanceEntry.checksum,
    expectedBytes: plan.provenanceEntry.bytes,
  });
  await visitGeneratedEntry(options, inventory, {
    path: plan.inputEntry.path,
    kind: "input",
    content: options.inputJson,
    expectedChecksum: plan.inputEntry.checksum,
    expectedBytes: plan.inputEntry.bytes,
  });

  for (const item of plan.items) {
    await visitOpenedEntry(options, inventory, item, {
      path: item.prediction.path,
      kind: "prediction",
      opener: options.openPrediction,
      expectedChecksum: item.prediction.checksum,
      expectedBytes: item.prediction.bytes,
      maxBytes: item.prediction.bytes,
    });
    await visitOpenedEntry(options, inventory, item, {
      path: item.target.path,
      kind: "target",
      opener: options.openTarget,
      expectedChecksum: item.target.checksum,
      expectedBytes: item.target.bytes,
      maxBytes: item.target.bytes,
    });
    await visitOpenedEntry(options, inventory, item, {
      path: item.audio.path,
      kind: "audio",
      opener: options.openAudio,
      expectedChecksum: null,
      expectedBytes: null,
      maxBytes: ALIGNMENT_TRAINING_PACKAGE_MAX_AUDIO_BYTES,
    });
    await visitGeneratedEntry(options, inventory, {
      path: item.sample.path,
      kind: "sample",
      content: canonicalAlignmentTrainingJson(item.sample.content),
      expectedChecksum: item.sample.checksum,
      expectedBytes: item.sample.bytes,
    });
  }

  const manifest = buildAlignmentTrainingPackageManifest(plan, inventory, sha256Hex);
  if (!manifest.ok) throw new AlignmentTrainingPackageStreamError("package_manifest_invalid");
  return manifest.value;
}

async function visitGeneratedEntry(
  options: VisitOptions,
  inventory: AlignmentTrainingPackageInventoryEntry[],
  entry: {
    path: string;
    kind: AlignmentTrainingPackageInventoryEntry["kind"];
    content: string;
    expectedChecksum: string;
    expectedBytes: number;
  },
) {
  const bytes = Buffer.from(entry.content, "utf8");
  await consumeObservedEntry(options, inventory, Readable.from([bytes]), {
    ...entry,
    maxBytes: entry.expectedBytes,
  });
}

async function visitOpenedEntry(
  options: VisitOptions,
  inventory: AlignmentTrainingPackageInventoryEntry[],
  item: AlignmentTrainingPackagePlanItem,
  entry: {
    path: string;
    kind: AlignmentTrainingPackageInventoryEntry["kind"];
    opener: OpenEntry;
    expectedChecksum: string | null;
    expectedBytes: number | null;
    maxBytes: number;
  },
) {
  assertNotAborted(options.signal);
  let source: Readable;
  try {
    source = await entry.opener(item, options.signal);
  } catch (error) {
    if (options.signal.aborted) throw new AlignmentTrainingPackageStreamError("package_aborted");
    if (error instanceof AlignmentTrainingPackageStreamError) throw error;
    throw new AlignmentTrainingPackageStreamError("package_entry_open_failed");
  }
  await consumeObservedEntry(options, inventory, source, entry);
}

async function consumeObservedEntry(
  options: VisitOptions,
  inventory: AlignmentTrainingPackageInventoryEntry[],
  source: Readable,
  entry: {
    path: string;
    kind: AlignmentTrainingPackageInventoryEntry["kind"];
    expectedChecksum: string | null;
    expectedBytes: number | null;
    maxBytes: number;
  },
) {
  assertNotAborted(options.signal);
  let bytes = 0;
  const hash = createHash("sha256");
  const observer = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > entry.maxBytes) {
        callback(new AlignmentTrainingPackageStreamError("package_entry_too_large"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const abort = () => {
    const error = new AlignmentTrainingPackageStreamError("package_aborted");
    source.destroy(error);
    observer.destroy(error);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  source.pipe(observer);
  try {
    await Promise.all([
      // 原始对象流和观察器都必须被 finished() 接管；取消时 source.destroy(error) 不能变成未处理事件。
      finished(source),
      finished(observer),
      Promise.resolve(options.onEntry({ path: entry.path, kind: entry.kind, stream: observer }))
        .catch((error) => {
          source.destroy();
          observer.destroy();
          if (error instanceof AlignmentTrainingPackageStreamError) throw error;
          throw new AlignmentTrainingPackageStreamError("package_entry_consumer_failed");
        }),
    ]);
  } catch (error) {
    if (options.signal.aborted) throw new AlignmentTrainingPackageStreamError("package_aborted");
    if (error instanceof AlignmentTrainingPackageStreamError) throw error;
    throw new AlignmentTrainingPackageStreamError("package_entry_consumer_failed");
  } finally {
    options.signal.removeEventListener("abort", abort);
    source.unpipe(observer);
  }
  const checksum = hash.digest("hex");
  if (entry.expectedBytes !== null && bytes !== entry.expectedBytes) {
    throw new AlignmentTrainingPackageStreamError("package_entry_size_mismatch");
  }
  if (entry.expectedChecksum !== null && checksum !== entry.expectedChecksum) {
    throw new AlignmentTrainingPackageStreamError("package_entry_checksum_mismatch");
  }
  inventory.push({ path: entry.path, kind: entry.kind, checksum, bytes });
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new AlignmentTrainingPackageStreamError("package_aborted");
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
