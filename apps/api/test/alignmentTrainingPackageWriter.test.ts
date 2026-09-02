import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import {
  buildAlignmentTrainingInputManifest,
  buildAlignmentTrainingManifest,
  buildAlignmentTrainingPackagePlan,
  canonicalAlignmentTrainingJson,
} from "@xiqu/document-model";
import {
  AlignmentTrainingPackageWriterError,
  writeAlignmentTrainingPackageToStage,
} from "../src/alignmentTrainingPackageWriter.js";
import { LocalObjectStorage } from "../src/storage.js";

test("训练包 ZIP64 以固定顺序逐项流入 staged 对象并最后写 manifest", async () => {
  await withStorage(async (storage) => {
    const fixture = createPackageFixture();
    const opened: string[] = [];
    const result = await writeAlignmentTrainingPackageToStage({
      storage,
      finalStorageKey: storage.createStorageKey("zip"),
      plan: fixture.plan,
      provenanceJson: fixture.provenanceJson,
      inputJson: fixture.inputJson,
      signal: new AbortController().signal,
      openPrediction: () => {
        opened.push("prediction");
        return Readable.from([fixture.prediction.subarray(0, 3), fixture.prediction.subarray(3)]);
      },
      openTarget: () => {
        opened.push("target");
        return Readable.from([fixture.target]);
      },
      openAudio: () => {
        opened.push("audio");
        return Readable.from([Buffer.from("fLaC"), Buffer.from("-fixture")]);
      },
    });
    assert.deepEqual(opened, ["prediction", "target", "audio"]);
    assert.equal(result.manifest.inventory.length, 6);
    await storage.promoteStagedObject(result.staged);
    const archive = await readStream(await storage.getObjectStream(result.staged.finalStorageKey));
    assert.equal(archive.subarray(0, 2).toString("ascii"), "PK");
    for (const name of [
      "provenance-manifest.json",
      "input-manifest.json",
      "prediction.json.gz",
      "target.json",
      "audio.flac",
      "sample.json",
      "manifest.json",
    ]) assert.equal(archive.includes(Buffer.from(name)), true, `ZIP 应包含 ${name}`);
  });
});

test("训练包取消会销毁当前条目且不留下 staged/final 对象", async () => {
  await withStorage(async (storage) => {
    const fixture = createPackageFixture();
    const controller = new AbortController();
    const blocked = new PassThrough();
    let predictionOpened = false;
    const writing = writeAlignmentTrainingPackageToStage({
      storage,
      finalStorageKey: storage.createStorageKey("zip"),
      plan: fixture.plan,
      provenanceJson: fixture.provenanceJson,
      inputJson: fixture.inputJson,
      signal: controller.signal,
      openPrediction: () => {
        predictionOpened = true;
        return blocked;
      },
      openTarget: () => Readable.from([fixture.target]),
      openAudio: () => Readable.from([Buffer.from("fLaC")]),
    });
    await waitUntil(() => predictionOpened);
    controller.abort();
    await assert.rejects(
      writing,
      (error: unknown) => error instanceof AlignmentTrainingPackageWriterError &&
        error.code === "package_write_aborted",
    );
    assert.deepEqual(await storage.listStoredObjects(), []);
  });
});

function createPackageFixture() {
  const applicationId = uuid(1);
  const artifactId = uuid(2);
  const prediction = Buffer.from("prediction-fixture");
  const targetSnapshot = {
    format: "xiqu-alignment-training-target",
    version: 1,
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
  const sourceSnapshot = {
    format: "xiqu-alignment-training-source",
    version: 1,
    kind: "uploaded",
    sourceMediaResourceId: uuid(3),
    sourceFingerprint: sha256("source"),
    mediaKind: "audio",
    audioOffsetMicros: 0,
    fileId: uuid(4),
    fileChecksum: sha256("file"),
    fileSize: 100,
    mimeType: "audio/flac",
  };
  const provenance = buildAlignmentTrainingManifest({
    splitSeedHash: sha256("seed"),
    splitRatios: { train: 10_000, validation: 0, test: 0 },
    samples: [{
      alignmentApplicationId: applicationId,
      alignmentRunId: uuid(5),
      alignmentArtifactId: artifactId,
      annotationFileId: uuid(6),
      baseRevision: 1,
      committedRevision: 2,
      observationEndRevision: 2,
      artifact: { checksum: sha256(prediction), size: prediction.byteLength, formatVersion: 1 },
      predictionSummaryState: "ready",
      evidenceState: "complete",
      unrated: false,
      manualTiming: {
        operationCount: 0,
        editedCharacterCount: 0,
        totalBoundaryDeltaMicros: 0,
        maxBoundaryDeltaMicros: 0,
      },
      quality: { verdict: "correct", issueCodes: [], assessmentIds: [uuid(7)] },
      signals: [],
      groupReferences: [
        { kind: "work", id: uuid(8) },
        { kind: "performer", id: uuid(9) },
      ],
    }],
  }, sha256);
  assert.equal(provenance.ok, true);
  if (!provenance.ok) throw new Error("provenance fixture failed");
  const target = Buffer.from(canonicalAlignmentTrainingJson(targetSnapshot), "utf8");
  const inputs = buildAlignmentTrainingInputManifest({
    provenanceManifestChecksum: provenance.manifest.checksum,
    items: [{
      alignmentApplicationId: applicationId,
      alignmentArtifactId: artifactId,
      artifactChecksum: sha256(prediction),
      targetSnapshotChecksum: sha256(target),
      targetSentenceCount: 1,
      targetCharacterCount: 1,
      targetSnapshotBytes: target.byteLength,
      sourceSnapshotChecksum: sha256(canonicalAlignmentTrainingJson(sourceSnapshot)),
    }],
  }, sha256);
  assert.equal(inputs.ok, true);
  if (!inputs.ok) throw new Error("input fixture failed");
  const plan = buildAlignmentTrainingPackagePlan({
    exportId: uuid(10),
    provenanceManifest: provenance.manifest,
    inputManifest: inputs.manifest,
    snapshots: [{ alignmentApplicationId: applicationId, targetSnapshot, sourceSnapshot }],
  }, sha256);
  assert.equal(plan.ok, true);
  if (!plan.ok) throw new Error("plan fixture failed");
  return {
    plan: plan.value,
    provenanceJson: canonicalAlignmentTrainingJson(provenance.manifest),
    inputJson: canonicalAlignmentTrainingJson(inputs.manifest),
    prediction,
    target,
  };
}

async function withStorage(callback: (storage: LocalObjectStorage) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-training-package-writer-"));
  try {
    await callback(new LocalObjectStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readStream(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待训练包测试状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
