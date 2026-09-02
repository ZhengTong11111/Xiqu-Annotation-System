import {
  ALIGNMENT_TRAINING_SOURCE_FORMAT,
  ALIGNMENT_TRAINING_SOURCE_VERSION,
  buildAlignmentTextProjection,
  buildAlignmentTrainingTargetSnapshot,
  canonicalAlignmentTrainingJson,
  parseAlignmentTrainingSourceSnapshot,
  parseAlignmentTrainingTargetSnapshot,
  type AlignmentTrainingSourceSnapshot,
  type AlignmentTrainingTargetSnapshot,
  type ProjectData,
} from "@xiqu/document-model";
import type { ReadyAnalysisAudioSource } from "./analysisAudioSourceResolver.js";

export type PreparedAlignmentTrainingTarget = {
  snapshot: AlignmentTrainingTargetSnapshot;
  checksum: string;
  bytes: number;
};

export type PreparedAlignmentTrainingSource = {
  snapshot: AlignmentTrainingSourceSnapshot;
  checksum: string;
  sourceFileId: string | null;
};

export type AlignmentTrainingInputPreparationErrorCode =
  | "target_projection_mismatch"
  | "target_snapshot_invalid"
  | "source_snapshot_invalid";

export type AlignmentTrainingInputPreparationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AlignmentTrainingInputPreparationErrorCode };

/**
 * 历史 payload 只在内存中生成最小 target snapshot；projection 指纹先与 run 对齐，
 * 防止正文、拆字或句结构变化后仍把旧 prediction 与新标签拼成训练样本。
 */
export function prepareAlignmentTrainingTarget(
  project: ProjectData,
  expected: {
    inputTextFingerprint: string;
    inputSentenceCount: number;
    inputCharacterCount: number;
  },
  sha256Hex: (value: string) => string,
): AlignmentTrainingInputPreparationResult<PreparedAlignmentTrainingTarget> {
  const projection = buildAlignmentTextProjection(project);
  if (
    !projection.ok ||
    projection.sentenceCount !== expected.inputSentenceCount ||
    projection.characterCount !== expected.inputCharacterCount ||
    sha256Hex(canonicalAlignmentTrainingJson(projection.projection)) !== expected.inputTextFingerprint
  ) {
    return { ok: false, code: "target_projection_mismatch" };
  }
  const built = buildAlignmentTrainingTargetSnapshot(project, expected.inputTextFingerprint);
  if (!built.ok) return { ok: false, code: "target_snapshot_invalid" };
  const parsed = parseAlignmentTrainingTargetSnapshot(built.snapshot);
  if (!parsed.ok) return { ok: false, code: "target_snapshot_invalid" };
  const canonicalJson = canonicalAlignmentTrainingJson(parsed.value);
  return {
    ok: true,
    value: {
      snapshot: parsed.value,
      checksum: sha256Hex(canonicalJson),
      bytes: Buffer.byteLength(canonicalJson, "utf8"),
    },
  };
}

/** 来源摘要只固化稳定数据库/provider 身份；临时 VOD URL 与凭据不进入参数或返回值。 */
export function prepareAlignmentTrainingSource(
  source: ReadyAnalysisAudioSource,
  expectedOffsetMicros: bigint,
  sha256Hex: (value: string) => string,
): AlignmentTrainingInputPreparationResult<PreparedAlignmentTrainingSource> {
  const audioOffsetMicros = Number(expectedOffsetMicros);
  if (
    !Number.isSafeInteger(audioOffsetMicros) ||
    BigInt(audioOffsetMicros) !== expectedOffsetMicros ||
    BigInt(Math.round(source.offsetSeconds * 1_000_000)) !== expectedOffsetMicros
  ) return { ok: false, code: "source_snapshot_invalid" };

  let snapshot: AlignmentTrainingSourceSnapshot;
  if (source.media.sourceType === "uploaded") {
    const fileSize = source.media.file ? Number(source.media.file.size) : Number.NaN;
    if (
      !source.media.file ||
      !source.media.file.checksum ||
      !source.media.mimeType ||
      !Number.isSafeInteger(fileSize) ||
      fileSize < 1
    ) return { ok: false, code: "source_snapshot_invalid" };
    snapshot = {
      format: ALIGNMENT_TRAINING_SOURCE_FORMAT,
      version: ALIGNMENT_TRAINING_SOURCE_VERSION,
      kind: "uploaded",
      sourceMediaResourceId: source.media.resourceId,
      sourceFingerprint: source.mediaFingerprint,
      mediaKind: source.media.mediaKind,
      audioOffsetMicros,
      fileId: source.media.file.id,
      fileChecksum: source.media.file.checksum,
      fileSize,
      mimeType: source.media.mimeType,
    };
  } else {
    const durationMicros = source.media.duration === null
      ? null
      : Math.round(source.media.duration * 1_000_000);
    if (
      !source.media.aliyunVodRegion ||
      !source.media.aliyunVodVideoId ||
      (durationMicros !== null && (!Number.isSafeInteger(durationMicros) || durationMicros < 0))
    ) return { ok: false, code: "source_snapshot_invalid" };
    snapshot = {
      format: ALIGNMENT_TRAINING_SOURCE_FORMAT,
      version: ALIGNMENT_TRAINING_SOURCE_VERSION,
      kind: "aliyun_vod",
      sourceMediaResourceId: source.media.resourceId,
      sourceFingerprint: source.mediaFingerprint,
      mediaKind: source.media.mediaKind,
      audioOffsetMicros,
      region: source.media.aliyunVodRegion,
      videoId: source.media.aliyunVodVideoId,
      renditionJobId: source.sourceVodRenditionJobId,
      durationMicros,
    };
  }
  const parsed = parseAlignmentTrainingSourceSnapshot(snapshot);
  if (!parsed.ok) return { ok: false, code: "source_snapshot_invalid" };
  return {
    ok: true,
    value: {
      snapshot: parsed.value,
      checksum: sha256Hex(canonicalAlignmentTrainingJson(parsed.value)),
      sourceFileId: parsed.value.kind === "uploaded" ? parsed.value.fileId : null,
    },
  };
}
