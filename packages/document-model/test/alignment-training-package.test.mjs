import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ALIGNMENT_TRAINING_PACKAGE_MAX_TARGET_BYTES,
  buildAlignmentTrainingInputManifest,
  buildAlignmentTrainingManifest,
  buildAlignmentTrainingPackageManifest,
  buildAlignmentTrainingPackagePlan,
  canonicalAlignmentTrainingJson,
  parseAlignmentTrainingPackageManifest,
  parseAlignmentTrainingPackagePlan,
} from "../dist/index.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("训练包计划不受输入快照顺序影响并生成稳定安全路径", () => {
  const fixture = createFixture();
  const first = buildAlignmentTrainingPackagePlan(fixture, sha256);
  const second = buildAlignmentTrainingPackagePlan({
    ...fixture,
    snapshots: fixture.snapshots.toReversed(),
  }, sha256);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.canonicalJson, first.canonicalJson);
  assert.deepEqual(first.value.items.map(({ alignmentApplicationId }) => alignmentApplicationId), [uuid(1), uuid(2)]);
  assert.match(first.value.items[0].prediction.path, /^samples\/0001_[0-9a-f-]+\/prediction\.json\.gz$/u);
  assert.equal(parseAlignmentTrainingPackagePlan(JSON.parse(first.canonicalJson), sha256).ok, true);
});

test("训练包计划拒绝目标、来源、sample 和容量篡改", () => {
  const fixture = createFixture();
  const built = buildAlignmentTrainingPackagePlan(fixture, sha256);
  assert.equal(built.ok, true);

  const wrongTarget = structuredClone(fixture);
  wrongTarget.snapshots[0].targetSnapshot.characterCount += 1;
  assert.equal(buildAlignmentTrainingPackagePlan(wrongTarget, sha256).ok, false);

  for (const mutate of [
    (plan) => { plan.items[0].sample.content.annotationFileId = uuid(999); },
    (plan) => { plan.items[0].sample.bytes += 1; },
    (plan) => { plan.items[0].sourceFingerprint = sha256("other-source"); },
    (plan) => { plan.items[0].target.bytes = ALIGNMENT_TRAINING_PACKAGE_MAX_TARGET_BYTES + 1; },
    (plan) => { plan.items.reverse(); },
    (plan) => { plan.items[0].unexpected = true; },
  ]) {
    const value = structuredClone(built.value);
    mutate(value);
    resign(value);
    assert.equal(parseAlignmentTrainingPackagePlan(value, sha256).ok, false);
  }
});

test("最终 manifest 精确绑定计划 inventory 并拒绝重算 checksum 后的篡改", () => {
  const fixture = createFixture();
  const planResult = buildAlignmentTrainingPackagePlan(fixture, sha256);
  assert.equal(planResult.ok, true);
  const inventory = createInventory(planResult.value);
  const built = buildAlignmentTrainingPackageManifest(planResult.value, inventory, sha256);
  assert.equal(built.ok, true);
  assert.equal(
    parseAlignmentTrainingPackageManifest(JSON.parse(built.canonicalJson), planResult.value, sha256).ok,
    true,
  );

  const missing = inventory.slice(1);
  assert.equal(buildAlignmentTrainingPackageManifest(planResult.value, missing, sha256).ok, false);
  const duplicate = [...inventory, inventory[0]];
  assert.equal(buildAlignmentTrainingPackageManifest(planResult.value, duplicate, sha256).ok, false);

  for (const mutate of [
    (manifest) => { manifest.totalBytes += 1; },
    (manifest) => { manifest.inventory[0].bytes += 1; },
    (manifest) => { manifest.inventory.reverse(); },
    (manifest) => { manifest.planChecksum = sha256("other-plan"); },
  ]) {
    const value = structuredClone(built.value);
    mutate(value);
    resign(value);
    assert.equal(parseAlignmentTrainingPackageManifest(value, planResult.value, sha256).ok, false);
  }
});

function createFixture() {
  const samples = [1, 2].map((index) => ({
    alignmentApplicationId: uuid(index),
    alignmentRunId: uuid(100 + index),
    alignmentArtifactId: uuid(200 + index),
    annotationFileId: uuid(300 + index),
    baseRevision: index * 10,
    committedRevision: index * 10 + 1,
    observationEndRevision: index * 10 + 3,
    artifact: { checksum: sha256(`prediction-${index}`), size: 1_000 + index, formatVersion: 1 },
    predictionSummaryState: "ready",
    evidenceState: "complete",
    unrated: false,
    manualTiming: {
      operationCount: 0,
      editedCharacterCount: 0,
      totalBoundaryDeltaMicros: 0,
      maxBoundaryDeltaMicros: 0,
    },
    quality: { verdict: "correct", issueCodes: [], assessmentIds: [uuid(500 + index)] },
    signals: ["ambiguous_prediction"],
    groupReferences: [
      { kind: "work", id: uuid(600 + index) },
      { kind: "performer", id: uuid(700 + index) },
    ],
  }));
  const provenance = buildAlignmentTrainingManifest({
    splitSeedHash: sha256("package-test-seed"),
    splitRatios: { train: 10_000, validation: 0, test: 0 },
    samples,
  }, sha256);
  assert.equal(provenance.ok, true);

  const snapshots = samples.map((sample, index) => {
    const targetSnapshot = makeTarget(index + 1);
    const sourceSnapshot = makeSource(index + 1);
    return { alignmentApplicationId: sample.alignmentApplicationId, targetSnapshot, sourceSnapshot };
  });
  const inputs = buildAlignmentTrainingInputManifest({
    provenanceManifestChecksum: provenance.manifest.checksum,
    items: snapshots.map((snapshot, index) => ({
      alignmentApplicationId: snapshot.alignmentApplicationId,
      alignmentArtifactId: samples[index].alignmentArtifactId,
      artifactChecksum: samples[index].artifact.checksum,
      targetSnapshotChecksum: sha256(canonicalAlignmentTrainingJson(snapshot.targetSnapshot)),
      targetSentenceCount: snapshot.targetSnapshot.sentenceCount,
      targetCharacterCount: snapshot.targetSnapshot.characterCount,
      targetSnapshotBytes: Buffer.byteLength(canonicalAlignmentTrainingJson(snapshot.targetSnapshot), "utf8"),
      sourceSnapshotChecksum: sha256(canonicalAlignmentTrainingJson(snapshot.sourceSnapshot)),
    })),
  }, sha256);
  assert.equal(inputs.ok, true);
  return {
    exportId: uuid(900),
    provenanceManifest: provenance.manifest,
    inputManifest: inputs.manifest,
    snapshots,
  };
}

function makeTarget(index) {
  return {
    format: "xiqu-alignment-training-target",
    version: 1,
    inputTextFingerprint: sha256(`input-${index}`),
    sentenceCount: 1,
    characterCount: 1,
    sentences: [{
      sentenceId: `sentence-${index}`,
      startMicros: 0,
      endMicros: 1_000_000,
      characters: [{ characterId: `character-${index}`, startMicros: 0, endMicros: 1_000_000 }],
    }],
  };
}

function makeSource(index) {
  return {
    format: "xiqu-alignment-training-source",
    version: 1,
    kind: "uploaded",
    sourceMediaResourceId: uuid(1_000 + index),
    sourceFingerprint: sha256(`source-${index}`),
    mediaKind: "audio",
    audioOffsetMicros: index * 1_000,
    fileId: uuid(1_100 + index),
    fileChecksum: sha256(`file-${index}`),
    fileSize: 2_000 + index,
    mimeType: "audio/flac",
  };
}

function createInventory(plan) {
  const inventory = [
    { path: plan.provenanceEntry.path, kind: "provenance", checksum: plan.provenanceEntry.checksum, bytes: plan.provenanceEntry.bytes },
    { path: plan.inputEntry.path, kind: "input", checksum: plan.inputEntry.checksum, bytes: plan.inputEntry.bytes },
    ...plan.items.flatMap((item, index) => [
      { path: item.prediction.path, kind: "prediction", checksum: item.prediction.checksum, bytes: item.prediction.bytes },
      { path: item.target.path, kind: "target", checksum: item.target.checksum, bytes: item.target.bytes },
      { path: item.audio.path, kind: "audio", checksum: sha256(`audio-${index}`), bytes: 4_096 + index },
      { path: item.sample.path, kind: "sample", checksum: item.sample.checksum, bytes: item.sample.bytes },
    ]),
  ];
  return inventory.sort((left, right) => left.path.localeCompare(right.path));
}

function resign(value) {
  const { checksum: _checksum, ...withoutChecksum } = value;
  value.checksum = sha256(canonicalAlignmentTrainingJson(withoutChecksum));
}

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
