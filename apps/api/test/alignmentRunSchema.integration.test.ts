import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { createAlignmentRunIdentity } from "../src/alignmentRunIdentity.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

const migrationUrl = new URL(
  "../../../prisma/migrations/20260902030000_alignment_runs/migration.sql",
  import.meta.url,
);

test("FA-D2a migration 只扩展 schema 且不改写既有核心事实", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of [
    "annotation_files",
    "annotation_operations",
    "annotation_recovery_snapshots",
    "media_analysis_runs",
    "processing_jobs",
  ]) {
    assert.doesNotMatch(sql, new RegExp(`(?:UPDATE|DELETE\\s+FROM|DROP\\s+TABLE)\\s+"${table}"`, "iu"));
  }
  assert.match(sql, /ALTER TYPE "ProcessingJobType" ADD VALUE 'force_alignment'/u);
  assert.match(sql, /ON DELETE SET NULL/iu);
  assert.match(sql, /CREATE UNIQUE INDEX "alignment_runs_identity_hash_key"/u);
  assert.match(sql, /"size" BETWEEN 0 AND 536870912/u);
  assert.match(sql, /"analysis_run_id" IS NULL AND "type"::text = 'force_alignment'/u);
});

test("对齐 run 保留来源快照，artifact/job 受严格关系与容量门禁保护", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const user = await prisma.user.create({
      data: { accountName: "alignment-owner", displayName: "对齐测试", passwordHash: "test" },
    });
    const annotationId = "alignment-annotation";
    const mediaId = "alignment-media";
    const trackId = "alignment-track";
    await prisma.resourceEntry.createMany({ data: [
      { id: annotationId, type: "annotation_file", name: "对齐.json", ownerUserId: user.id },
      { id: mediaId, type: "media_file", name: "对齐.mp3", ownerUserId: user.id },
    ] });
    const file = await prisma.fileObject.create({
      data: {
        name: "对齐.mp3",
        mimeType: "audio/mpeg",
        size: 1_024n,
        storageKey: "alignment-test/source.mp3",
        checksum: "f".repeat(64),
        ownerUserId: user.id,
      },
    });
    await prisma.mediaFile.create({
      data: {
        resourceId: mediaId,
        sourceType: "uploaded",
        mediaKind: "audio",
        fileId: file.id,
        mimeType: "audio/mpeg",
        size: file.size,
      },
    });
    await prisma.annotationFile.create({
      data: { resourceId: annotationId, payload: {}, revision: 7, mediaResourceId: mediaId, lastEditedBy: user.id },
    });
    await prisma.mediaAudioTrack.create({
      data: {
        id: trackId,
        primaryMediaResourceId: mediaId,
        name: "原声",
        kind: "original",
        sortOrder: 0,
        createdBy: user.id,
      },
    });
    const mediaAnalysis = await prisma.mediaAnalysisRun.create({
      data: {
        sourceMediaResourceId: mediaId,
        sourceFingerprint: "b".repeat(64),
        algorithmVersion: "analysis-v1",
        configHash: "c".repeat(64),
        config: {},
        status: "succeeded",
        progress: 1,
        manifest: {},
        createdBy: user.id,
        completedAt: new Date(),
      },
    });
    const identity = createAlignmentRunIdentity({
      annotationFileId: annotationId,
      inputRevision: 7,
      inputTextFingerprint: "a".repeat(64),
      inputSentenceCount: 2,
      inputCharacterCount: 16,
      sourceMediaResourceId: mediaId,
      sourceFingerprint: "b".repeat(64),
      mediaAudioTrackId: trackId,
      audioOffsetMicros: 5_000n,
      mediaAnalysisFingerprint: "d".repeat(64),
      modelName: "kunqu-aligner",
      modelVersion: "model-v1",
      dictionaryVersion: "dict-v1",
      codeVersion: "code-v1",
      config: { sampleRate: 16_000 },
    });
    const run = await prisma.alignmentRun.create({
      data: {
        annotationFileId: annotationId,
        annotationFileIdSnapshot: annotationId,
        inputRevision: 7,
        inputTextFingerprint: "a".repeat(64),
        inputSentenceCount: 2,
        inputCharacterCount: 16,
        sourceMediaResourceId: mediaId,
        sourceMediaResourceIdSnapshot: mediaId,
        sourceFingerprint: "b".repeat(64),
        mediaAudioTrackId: trackId,
        mediaAudioTrackIdSnapshot: trackId,
        audioOffsetMicros: 5_000n,
        mediaAnalysisRunId: mediaAnalysis.id,
        mediaAnalysisFingerprint: "d".repeat(64),
        modelName: "kunqu-aligner",
        modelVersion: "model-v1",
        dictionaryVersion: "dict-v1",
        codeVersion: "code-v1",
        configHash: identity.configHash,
        config: identity.config,
        identityHash: identity.identityHash,
        status: "queued",
        createdBy: user.id,
      },
    });
    const artifact = await prisma.alignmentArtifact.create({
      data: {
        runId: run.id,
        kind: "prediction",
        formatVersion: 1,
        mimeType: "application/json+gzip",
        size: 256n,
        checksum: "e".repeat(64),
        storageKey: `alignment/${run.id}/prediction.json.gz`,
      },
    });
    const job = await prisma.processingJob.create({
      data: {
        type: "force_alignment",
        status: "queued",
        createdBy: user.id,
        alignmentRunId: run.id,
        deduplicationKey: identity.deduplicationKey,
      },
    });

    await assert.rejects(
      prisma.alignmentRun.create({ data: {
        ...toDuplicateRunData(run),
        id: "duplicate-alignment-run",
      } }),
      (error: unknown) => Boolean(
        error && typeof error === "object" && "code" in error && error.code === "P2002",
      ),
    );
    await assert.rejects(
      prisma.$executeRaw`UPDATE alignment_runs SET annotation_file_id_snapshot = 'other-file' WHERE id = ${run.id}`,
      /alignment_runs_source_snapshot_check/u,
    );
    await assert.rejects(
      prisma.processingJob.create({ data: {
        type: "force_alignment",
        status: "queued",
        createdBy: user.id,
        analysisRunId: mediaAnalysis.id,
        alignmentRunId: run.id,
        deduplicationKey: "invalid-dual-run",
      } }),
      /processing_jobs_alignment_run_type_check/u,
    );
    await assert.rejects(
      prisma.processingJob.create({ data: {
        type: "annotation_export",
        status: "queued",
        createdBy: user.id,
        alignmentRunId: run.id,
        deduplicationKey: "invalid-job-type",
      } }),
      /processing_jobs_alignment_run_type_check/u,
    );

    // 删除当前来源只清空可导航外键；snapshot/hash、预测对象和任务溯源继续保留。
    await prisma.resourceEntry.delete({ where: { id: annotationId } });
    await prisma.resourceEntry.delete({ where: { id: mediaId } });
    const retained = await prisma.alignmentRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(retained.annotationFileId, null);
    assert.equal(retained.sourceMediaResourceId, null);
    assert.equal(retained.mediaAudioTrackId, null);
    assert.equal(retained.mediaAnalysisRunId, null);
    assert.equal(retained.annotationFileIdSnapshot, annotationId);
    assert.equal(retained.sourceMediaResourceIdSnapshot, mediaId);
    assert.equal(retained.mediaAudioTrackIdSnapshot, trackId);
    assert.equal(retained.inputTextFingerprint, "a".repeat(64));
    assert.equal(await prisma.alignmentArtifact.count({ where: { id: artifact.id } }), 1);
    assert.equal(await prisma.processingJob.count({ where: { id: job.id } }), 1);

    await prisma.alignmentRun.delete({ where: { id: run.id } });
    assert.equal(await prisma.alignmentArtifact.count({ where: { id: artifact.id } }), 0);
    assert.equal(await prisma.processingJob.count({ where: { id: job.id } }), 0);
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
  }
});

function toDuplicateRunData(run: {
  annotationFileId: string | null;
  annotationFileIdSnapshot: string;
  inputRevision: number;
  inputTextFingerprint: string;
  inputSentenceCount: number;
  inputCharacterCount: number;
  sourceMediaResourceId: string | null;
  sourceMediaResourceIdSnapshot: string;
  sourceFingerprint: string;
  mediaAudioTrackId: string | null;
  mediaAudioTrackIdSnapshot: string;
  audioOffsetMicros: bigint;
  mediaAnalysisRunId: string | null;
  mediaAnalysisFingerprint: string | null;
  modelName: string;
  modelVersion: string;
  dictionaryVersion: string;
  codeVersion: string;
  configHash: string;
  config: Prisma.JsonValue;
  identityHash: string;
  createdBy: string;
}) {
  return {
    annotationFileId: run.annotationFileId,
    annotationFileIdSnapshot: run.annotationFileIdSnapshot,
    inputRevision: run.inputRevision,
    inputTextFingerprint: run.inputTextFingerprint,
    inputSentenceCount: run.inputSentenceCount,
    inputCharacterCount: run.inputCharacterCount,
    sourceMediaResourceId: run.sourceMediaResourceId,
    sourceMediaResourceIdSnapshot: run.sourceMediaResourceIdSnapshot,
    sourceFingerprint: run.sourceFingerprint,
    mediaAudioTrackId: run.mediaAudioTrackId,
    mediaAudioTrackIdSnapshot: run.mediaAudioTrackIdSnapshot,
    audioOffsetMicros: run.audioOffsetMicros,
    mediaAnalysisRunId: run.mediaAnalysisRunId,
    mediaAnalysisFingerprint: run.mediaAnalysisFingerprint,
    modelName: run.modelName,
    modelVersion: run.modelVersion,
    dictionaryVersion: run.dictionaryVersion,
    codeVersion: run.codeVersion,
    configHash: run.configHash,
    config: run.config as Prisma.InputJsonValue,
    identityHash: run.identityHash,
    status: "queued" as const,
    createdBy: run.createdBy,
  };
}
