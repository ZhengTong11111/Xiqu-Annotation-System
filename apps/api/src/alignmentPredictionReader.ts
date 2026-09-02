import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  parseAlignmentPredictionArtifact,
  type AlignmentPredictionArtifact,
} from "@xiqu/document-model";
import {
  MAX_PREDICTION_COMPRESSED_BYTES,
  MAX_PREDICTION_UNCOMPRESSED_BYTES,
  type PredictionArtifactMetadata,
} from "./alignmentArtifactMetadata.js";
import type { ObjectStorage } from "./objectStorage.js";

export type AlignmentPredictionReadErrorCode =
  | "alignment_artifact_corrupted"
  | "alignment_artifact_too_large";

export class AlignmentPredictionReadError extends Error {
  constructor(readonly code: AlignmentPredictionReadErrorCode) {
    super(code);
  }
}

/**
 * 从不可变 final 对象读取 prediction，并逐层验证实际大小、SHA-256、gzip、JSON 和版本合同。
 * storage key 与底层错误不会离开服务端边界。
 */
export async function readAlignmentPrediction(
  storage: Pick<ObjectStorage, "getObjectStream">,
  artifact: PredictionArtifactMetadata,
): Promise<AlignmentPredictionArtifact> {
  const expectedSize = Number(artifact.size);
  if (!Number.isSafeInteger(expectedSize) ||
      expectedSize < 1 || expectedSize > MAX_PREDICTION_COMPRESSED_BYTES) {
    throw new AlignmentPredictionReadError("alignment_artifact_too_large");
  }
  let compressed: Buffer;
  try {
    compressed = await readBoundedStream(
      await storage.getObjectStream(artifact.storageKey),
      MAX_PREDICTION_COMPRESSED_BYTES,
    );
  } catch (error) {
    if (error instanceof AlignmentPredictionReadError) throw error;
    throw new AlignmentPredictionReadError("alignment_artifact_corrupted");
  }
  if (
    compressed.byteLength !== expectedSize ||
    createHash("sha256").update(compressed).digest("hex") !== artifact.checksum
  ) {
    throw new AlignmentPredictionReadError("alignment_artifact_corrupted");
  }

  let uncompressed: Buffer;
  try {
    const gunzip = createGunzip();
    Readable.from([compressed]).pipe(gunzip);
    uncompressed = await readBoundedStream(gunzip, MAX_PREDICTION_UNCOMPRESSED_BYTES);
  } catch (error) {
    if (error instanceof AlignmentPredictionReadError) throw error;
    throw new AlignmentPredictionReadError("alignment_artifact_corrupted");
  }
  try {
    const prediction = parseAlignmentPredictionArtifact(
      JSON.parse(uncompressed.toString("utf8")),
    );
    if (!prediction) throw new Error("invalid prediction");
    return prediction;
  } catch {
    throw new AlignmentPredictionReadError("alignment_artifact_corrupted");
  }
}

async function readBoundedStream(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maxBytes) {
      stream.destroy();
      throw new AlignmentPredictionReadError("alignment_artifact_too_large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
