import type { Prisma } from "@prisma/client";
import {
  ALIGNMENT_PREDICTION_FORMAT_VERSION,
  ALIGNMENT_PREDICTION_MIME_TYPE,
} from "@xiqu/document-model";

export const MAX_PREDICTION_COMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_PREDICTION_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export type PredictionArtifactMetadata = {
  id: string;
  formatVersion: number;
  mimeType: string;
  size: bigint;
  checksum: string;
  storageKey: string;
};

/** 公开读取与服务端应用共用同一 metadata/manifest 门禁，避免两条入口对“有效预测”给出不同结论。 */
export function isReadablePredictionArtifact(
  artifact: PredictionArtifactMetadata,
  manifest: Prisma.JsonValue | null,
) {
  if (
    artifact.formatVersion !== ALIGNMENT_PREDICTION_FORMAT_VERSION ||
    artifact.mimeType !== ALIGNMENT_PREDICTION_MIME_TYPE ||
    artifact.size < 1n ||
    artifact.size > BigInt(MAX_PREDICTION_COMPRESSED_BYTES) ||
    !/^[0-9a-f]{64}$/u.test(artifact.checksum) ||
    !artifact.storageKey
  ) return false;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const value = manifest as Record<string, unknown>;
  return value.version === 1 &&
    value.formatVersion === ALIGNMENT_PREDICTION_FORMAT_VERSION &&
    value.artifactId === artifact.id &&
    value.compressedSize === Number(artifact.size) &&
    value.checksum === artifact.checksum;
}
