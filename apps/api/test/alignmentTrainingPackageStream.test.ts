import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import {
  buildAlignmentTrainingInputManifest,
  buildAlignmentTrainingManifest,
  buildAlignmentTrainingPackagePlan,
  canonicalAlignmentTrainingJson,
} from "@xiqu/document-model";
import {
  AlignmentTrainingPackageStreamError,
  visitAlignmentTrainingPackageEntries,
} from "../src/alignmentTrainingPackageStream.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("训练包条目按顺序惰性打开并在消费后形成最终 inventory", async () => {
  const fixture = createFixture();
  const events: string[] = [];
  const result = await visitAlignmentTrainingPackageEntries({
    plan: fixture.plan,
    provenanceJson: fixture.provenanceJson,
    inputJson: fixture.inputJson,
    signal: new AbortController().signal,
    openPrediction: () => {
      assert.equal(events.includes("prediction:done"), false);
      events.push("prediction:open");
      return fragmented(fixture.predictionBytes);
    },
    openTarget: () => {
      assert.equal(events.includes("prediction:done"), true);
      events.push("target:open");
      return fragmented(fixture.targetBytes);
    },
    openAudio: () => {
      assert.equal(events.includes("target:done"), true);
      events.push("audio:open");
      return fragmented(Buffer.from("normalized-flac"));
    },
    onEntry: async ({ kind, stream }) => {
      for await (const _chunk of stream) {
        // 测试分片消费，确保 adapter 不依赖单块 Buffer 或整包 read-all。
      }
      events.push(`${kind}:done`);
    },
  });
  assert.equal(result.itemCount, 1);
  assert.deepEqual(events.filter((event) => event.endsWith(":open")), [
    "prediction:open",
    "target:open",
    "audio:open",
  ]);
});

test("取消后不再打开后续条目", async () => {
  const fixture = createFixture();
  const controller = new AbortController();
  let targetOpened = false;
  await assert.rejects(
    visitAlignmentTrainingPackageEntries({
      plan: fixture.plan,
      provenanceJson: fixture.provenanceJson,
      inputJson: fixture.inputJson,
      signal: controller.signal,
      openPrediction: () => fragmented(fixture.predictionBytes),
      openTarget: () => {
        targetOpened = true;
        return fragmented(fixture.targetBytes);
      },
      openAudio: () => fragmented(Buffer.from("audio")),
      onEntry: async ({ kind, stream }) => {
        for await (const _chunk of stream) {}
        if (kind === "prediction") controller.abort();
      },
    }),
    (error: unknown) => error instanceof AlignmentTrainingPackageStreamError &&
      error.code === "package_aborted",
  );
  assert.equal(targetOpened, false);
});

test("prediction checksum 或字节不一致时稳定失败", async () => {
  const fixture = createFixture();
  await assert.rejects(
    visitAlignmentTrainingPackageEntries({
      plan: fixture.plan,
      provenanceJson: fixture.provenanceJson,
      inputJson: fixture.inputJson,
      signal: new AbortController().signal,
      openPrediction: () => fragmented(Buffer.from("wrong")),
      openTarget: () => fragmented(fixture.targetBytes),
      openAudio: () => fragmented(Buffer.from("audio")),
      onEntry: async ({ stream }) => {
        for await (const _chunk of stream) {}
      },
    }),
    (error: unknown) => error instanceof AlignmentTrainingPackageStreamError &&
      ["package_entry_size_mismatch", "package_entry_checksum_mismatch"].includes(error.code),
  );
});

function createFixture() {
  const predictionBytes = Buffer.from("compressed-prediction-fixture");
  const sample = {
    alignmentApplicationId: uuid(1),
    alignmentRunId: uuid(2),
    alignmentArtifactId: uuid(3),
    annotationFileId: uuid(4),
    baseRevision: 1,
    committedRevision: 2,
    observationEndRevision: 2,
    artifact: { checksum: sha256(predictionBytes.toString("utf8")), size: predictionBytes.length, formatVersion: 1 },
    predictionSummaryState: "ready" as const,
    evidenceState: "complete" as const,
    unrated: false,
    manualTiming: { operationCount: 0, editedCharacterCount: 0, totalBoundaryDeltaMicros: 0, maxBoundaryDeltaMicros: 0 },
    quality: { verdict: "correct" as const, issueCodes: [], assessmentIds: [uuid(5)] },
    signals: ["ambiguous_prediction" as const],
    groupReferences: [
      { kind: "work" as const, id: uuid(6) },
      { kind: "performer" as const, id: uuid(7) },
    ],
  };
  const provenance = buildAlignmentTrainingManifest({
    splitSeedHash: sha256("stream-seed"),
    splitRatios: { train: 10_000, validation: 0, test: 0 },
    samples: [sample],
  }, sha256);
  assert.equal(provenance.ok, true);
  const target = {
    format: "xiqu-alignment-training-target" as const,
    version: 1 as const,
    inputTextFingerprint: sha256("input"),
    sentenceCount: 1,
    characterCount: 1,
    sentences: [{
      sentenceId: "sentence-1",
      startMicros: 0,
      endMicros: 1_000_000,
      characters: [{ characterId: "character-1", startMicros: 0, endMicros: 1_000_000 }],
    }],
  };
  const source = {
    format: "xiqu-alignment-training-source" as const,
    version: 1 as const,
    kind: "uploaded" as const,
    sourceMediaResourceId: uuid(8),
    sourceFingerprint: sha256("source"),
    mediaKind: "audio" as const,
    audioOffsetMicros: 0,
    fileId: uuid(9),
    fileChecksum: sha256("file"),
    fileSize: 1_024,
    mimeType: "audio/flac",
  };
  const targetJson = canonicalAlignmentTrainingJson(target);
  const input = buildAlignmentTrainingInputManifest({
    provenanceManifestChecksum: provenance.manifest.checksum,
    items: [{
      alignmentApplicationId: sample.alignmentApplicationId,
      alignmentArtifactId: sample.alignmentArtifactId,
      artifactChecksum: sample.artifact.checksum,
      targetSnapshotChecksum: sha256(targetJson),
      targetSentenceCount: 1,
      targetCharacterCount: 1,
      targetSnapshotBytes: Buffer.byteLength(targetJson),
      sourceSnapshotChecksum: sha256(canonicalAlignmentTrainingJson(source)),
    }],
  }, sha256);
  assert.equal(input.ok, true);
  const plan = buildAlignmentTrainingPackagePlan({
    exportId: uuid(10),
    provenanceManifest: provenance.manifest,
    inputManifest: input.manifest,
    snapshots: [{ alignmentApplicationId: sample.alignmentApplicationId, targetSnapshot: target, sourceSnapshot: source }],
  }, sha256);
  assert.equal(plan.ok, true);
  return {
    plan: plan.value,
    provenanceJson: provenance.canonicalJson,
    inputJson: input.canonicalJson,
    predictionBytes,
    targetBytes: Buffer.from(targetJson),
  };
}

function fragmented(value: Buffer) {
  const midpoint = Math.max(1, Math.floor(value.length / 2));
  return Readable.from([value.subarray(0, midpoint), value.subarray(midpoint)]);
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
