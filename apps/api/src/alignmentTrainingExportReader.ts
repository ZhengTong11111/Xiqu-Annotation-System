import { createHash } from "node:crypto";
import { AlignmentArtifactKind, Prisma } from "@prisma/client";
import {
  ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT,
  ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION,
  ALIGNMENT_TRAINING_MANIFEST_FORMAT,
  ALIGNMENT_TRAINING_MANIFEST_VERSION,
  canonicalAlignmentTrainingJson,
  parseAlignmentTrainingInputManifest,
  parseAlignmentTrainingManifest,
  parseAlignmentTrainingSourceSnapshot,
  parseAlignmentTrainingTargetSnapshot,
  type AlignmentTrainingInputManifest,
  type AlignmentTrainingManifestV1,
} from "@xiqu/document-model";
import type { AlignmentTrainingExportSummary } from "@xiqu/shared";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";
import { conflict } from "./errors.js";

/**
 * 冻结重放、任务预约和后续 worker 只从这一 include 读取不可变训练输入。
 * 关系行同时带上对象 identity，不能只相信 export 顶层 JSON 中自报的 checksum。
 */
export const ALIGNMENT_TRAINING_EXPORT_READY_INCLUDE = {
  items: {
    orderBy: { alignmentApplicationId: "asc" },
    select: {
      alignmentApplicationId: true,
      alignmentRunId: true,
      alignmentArtifactId: true,
      annotationFileIdSnapshot: true,
      artifact: {
        select: {
          id: true,
          runId: true,
          kind: true,
          formatVersion: true,
          mimeType: true,
          size: true,
          checksum: true,
          storageKey: true,
        },
      },
      input: {
        select: {
          sourceFileId: true,
          sourceFile: {
            select: {
              id: true,
              mimeType: true,
              size: true,
              checksum: true,
              storageKey: true,
            },
          },
          targetSnapshot: true,
          targetSnapshotChecksum: true,
          targetSentenceCount: true,
          targetCharacterCount: true,
          targetSnapshotBytes: true,
          sourceSnapshot: true,
          sourceSnapshotChecksum: true,
        },
      },
    },
  },
} satisfies Prisma.AlignmentTrainingExportInclude;

export type StoredAlignmentTrainingExport = Prisma.AlignmentTrainingExportGetPayload<{
  include: typeof ALIGNMENT_TRAINING_EXPORT_READY_INCLUDE;
}>;

export type ReadyAlignmentTrainingExport = {
  kind: "ready";
  row: StoredAlignmentTrainingExport;
  summary: AlignmentTrainingExportSummary;
  provenanceManifest: AlignmentTrainingManifestV1;
  inputManifest: AlignmentTrainingInputManifest;
};

export type ReadAlignmentTrainingExport =
  | ReadyAlignmentTrainingExport
  | {
      kind: "provenance_only";
      row: StoredAlignmentTrainingExport;
      summary: AlignmentTrainingExportSummary;
      provenanceManifest: AlignmentTrainingManifestV1;
    };

/** 解析数据库冻结事实；任何 all-null/all-present 或逐项关系破损都稳定 fail closed。 */
export function readStoredAlignmentTrainingExport(
  row: StoredAlignmentTrainingExport,
): ReadAlignmentTrainingExport {
  const provenance = parseAlignmentTrainingManifest(row.manifest, sha256Hex);
  if (
    !provenance.ok ||
    row.manifestFormat !== ALIGNMENT_TRAINING_MANIFEST_FORMAT ||
    row.manifestVersion !== ALIGNMENT_TRAINING_MANIFEST_VERSION ||
    provenance.value.checksum !== row.manifestChecksum ||
    provenance.value.splitSeedHash !== row.splitSeedHash ||
    provenance.value.sampleCount !== row.sampleCount ||
    provenance.value.componentCount !== row.componentCount ||
    stableJsonStringify(provenance.value.splitRatios) !== stableJsonStringify(row.splitRatios) ||
    stableJsonStringify(provenance.value.splitCounts) !== stableJsonStringify(row.splitCounts)
  ) throwCorruptExport();

  const summary = mapManifestSummary(row, provenance.value);
  const inputColumns = [
    row.inputManifestFormat,
    row.inputManifestVersion,
    row.inputManifestChecksum,
    row.inputManifest,
    row.targetSentenceCount,
    row.targetCharacterCount,
    row.targetSnapshotBytes,
  ];
  const presentInputColumns = inputColumns.filter((value) => value !== null).length;
  if (presentInputColumns === 0) {
    // 第 44 条 migration 前的冻结只允许“顶层全空 + 逐项全空”，供只读 provenance 页面继续展示。
    if (row.items.some((item) => item.input !== null)) throwCorruptExport();
    return { kind: "provenance_only", row, summary, provenanceManifest: provenance.value };
  }

  const parsedInput = parseAlignmentTrainingInputManifest(row.inputManifest, sha256Hex);
  if (
    presentInputColumns !== inputColumns.length ||
    !parsedInput.ok ||
    row.inputManifestFormat !== ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT ||
    row.inputManifestVersion !== ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION ||
    row.inputManifestChecksum !== parsedInput.manifest.checksum ||
    parsedInput.manifest.provenanceManifestChecksum !== row.manifestChecksum ||
    row.targetSentenceCount !== parsedInput.manifest.targetSentenceCount ||
    row.targetCharacterCount !== parsedInput.manifest.targetCharacterCount ||
    row.targetSnapshotBytes !== parsedInput.manifest.targetSnapshotBytes
  ) throwCorruptExport();

  validateStoredInputRows(row, provenance.value, parsedInput.manifest);
  return {
    kind: "ready",
    row,
    summary,
    provenanceManifest: provenance.value,
    inputManifest: parsedInput.manifest,
  };
}

/** 后台任务不能把历史 provenance-only 冻结伪装成可导出输入。 */
export function requireReadyAlignmentTrainingExport(
  row: StoredAlignmentTrainingExport,
): ReadyAlignmentTrainingExport {
  const parsed = readStoredAlignmentTrainingExport(row);
  if (parsed.kind !== "ready") {
    throw conflict("该训练冻结只含历史溯源，不能创建训练包任务。", {
      code: "alignment_training_export_inputs_missing",
    });
  }
  return parsed;
}

function validateStoredInputRows(
  row: StoredAlignmentTrainingExport,
  provenance: AlignmentTrainingManifestV1,
  inputManifest: AlignmentTrainingInputManifest,
) {
  if (row.items.length !== inputManifest.itemCount || provenance.items.length !== row.items.length) {
    throwCorruptExport();
  }
  const storedByApplicationId = new Map(
    row.items.map((item) => [item.alignmentApplicationId, item]),
  );
  const provenanceByApplicationId = new Map(
    provenance.items.map((item) => [item.alignmentApplicationId, item]),
  );
  for (const item of inputManifest.items) {
    const stored = storedByApplicationId.get(item.alignmentApplicationId);
    const provenanceItem = provenanceByApplicationId.get(item.alignmentApplicationId);
    if (!stored?.input || !provenanceItem) throwCorruptExport();
    const artifactSize = Number(stored.artifact.size);
    if (
      stored.alignmentArtifactId !== item.alignmentArtifactId ||
      stored.artifact.id !== item.alignmentArtifactId ||
      stored.alignmentRunId !== provenanceItem.alignmentRunId ||
      stored.artifact.runId !== provenanceItem.alignmentRunId ||
      stored.artifact.kind !== AlignmentArtifactKind.prediction ||
      stored.artifact.formatVersion !== provenanceItem.artifact.formatVersion ||
      stored.artifact.checksum !== item.artifactChecksum ||
      provenanceItem.alignmentArtifactId !== item.alignmentArtifactId ||
      provenanceItem.annotationFileId !== stored.annotationFileIdSnapshot ||
      provenanceItem.artifact.checksum !== item.artifactChecksum ||
      !Number.isSafeInteger(artifactSize) ||
      artifactSize !== provenanceItem.artifact.size
    ) throwCorruptExport();

    const target = parseAlignmentTrainingTargetSnapshot(stored.input.targetSnapshot);
    const source = parseAlignmentTrainingSourceSnapshot(stored.input.sourceSnapshot);
    if (!target.ok || !source.ok) throwCorruptExport();
    const targetJson = canonicalAlignmentTrainingJson(target.value);
    const targetChecksum = sha256Hex(targetJson);
    const sourceChecksum = sha256Hex(canonicalAlignmentTrainingJson(source.value));
    const expectedSourceFileId = source.value.kind === "uploaded" ? source.value.fileId : null;
    const sourceFileMatches = source.value.kind === "uploaded"
      ? stored.input.sourceFile !== null &&
        stored.input.sourceFile.id === source.value.fileId &&
        stored.input.sourceFile.checksum === source.value.fileChecksum &&
        Number(stored.input.sourceFile.size) === source.value.fileSize &&
        stored.input.sourceFile.mimeType === source.value.mimeType
      : stored.input.sourceFile === null;
    if (
      stored.input.targetSnapshotChecksum !== targetChecksum ||
      item.targetSnapshotChecksum !== targetChecksum ||
      stored.input.targetSentenceCount !== target.value.sentenceCount ||
      item.targetSentenceCount !== target.value.sentenceCount ||
      stored.input.targetCharacterCount !== target.value.characterCount ||
      item.targetCharacterCount !== target.value.characterCount ||
      stored.input.targetSnapshotBytes !== Buffer.byteLength(targetJson, "utf8") ||
      item.targetSnapshotBytes !== stored.input.targetSnapshotBytes ||
      stored.input.sourceSnapshotChecksum !== sourceChecksum ||
      item.sourceSnapshotChecksum !== sourceChecksum ||
      stored.input.sourceFileId !== expectedSourceFileId ||
      !sourceFileMatches
    ) throwCorruptExport();
  }
}

function mapManifestSummary(
  row: Pick<StoredAlignmentTrainingExport, "id" | "createdAt">,
  manifest: AlignmentTrainingManifestV1,
): AlignmentTrainingExportSummary {
  return {
    id: row.id,
    manifestChecksum: manifest.checksum,
    sampleCount: manifest.sampleCount,
    componentCount: manifest.componentCount,
    splitCounts: manifest.splitCounts,
    createdAt: row.createdAt.toISOString(),
  };
}

function throwCorruptExport(): never {
  throw conflict("已冻结训练清单的完整性校验失败。", {
    code: "alignment_training_export_corrupt",
  });
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
