import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildAlignmentTrainingInputManifest,
  parseAlignmentTrainingInputManifest,
  parseAlignmentTrainingSourceSnapshot,
} from "../dist/index.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("上传与 VOD 来源快照只接受有限稳定事实", () => {
  const uploaded = {
    format: "xiqu-alignment-training-source",
    version: 1,
    kind: "uploaded",
    sourceMediaResourceId: uuid(1),
    sourceFingerprint: sha256("uploaded"),
    mediaKind: "audio",
    audioOffsetMicros: -5_000,
    fileId: uuid(2),
    fileChecksum: sha256("file"),
    fileSize: 1024,
    mimeType: "audio/mpeg",
  };
  const vod = {
    format: "xiqu-alignment-training-source",
    version: 1,
    kind: "aliyun_vod",
    sourceMediaResourceId: uuid(3),
    sourceFingerprint: sha256("vod"),
    mediaKind: "video",
    audioOffsetMicros: 0,
    region: "cn-beijing",
    videoId: "vod-video-1",
    renditionJobId: "job-1",
    durationMicros: 10_000_000,
  };
  assert.equal(parseAlignmentTrainingSourceSnapshot(uploaded).ok, true);
  assert.equal(parseAlignmentTrainingSourceSnapshot(vod).ok, true);
  assert.equal(parseAlignmentTrainingSourceSnapshot({ ...vod, playAuth: "secret" }).ok, false);
  assert.equal(parseAlignmentTrainingSourceSnapshot({ ...uploaded, fileChecksum: null }).ok, false);
});

test("输入 manifest 规范排序、聚合并校验 checksum", () => {
  const items = [makeItem(2), makeItem(1)];
  const built = buildAlignmentTrainingInputManifest({
    provenanceManifestChecksum: sha256("provenance"),
    items,
  }, sha256);
  assert.equal(built.ok, true);
  assert.deepEqual(built.manifest.items.map(({ alignmentApplicationId }) => alignmentApplicationId), [uuid(1), uuid(2)]);
  assert.equal(built.manifest.targetCharacterCount, 5);
  assert.equal(built.manifest.targetSnapshotBytes, 2_003);
  assert.equal(parseAlignmentTrainingInputManifest(JSON.parse(built.canonicalJson), sha256).ok, true);
});

test("输入 manifest 拒绝重复、聚合、排序、checksum 和额外字段篡改", () => {
  assert.equal(buildAlignmentTrainingInputManifest({
    provenanceManifestChecksum: sha256("provenance"),
    items: [makeItem(1), makeItem(1)],
  }, sha256).ok, false);
  const built = buildAlignmentTrainingInputManifest({
    provenanceManifestChecksum: sha256("provenance"),
    items: [makeItem(1), makeItem(2)],
  }, sha256);
  assert.equal(built.ok, true);
  for (const mutate of [
    (value) => { value.targetCharacterCount += 1; },
    (value) => { value.items.reverse(); },
    (value) => { value.checksum = "0".repeat(64); },
    (value) => { value.items[0].text = "禁止正文"; },
  ]) {
    const value = structuredClone(built.manifest);
    mutate(value);
    assert.equal(parseAlignmentTrainingInputManifest(value, sha256).ok, false);
  }
});

function makeItem(index) {
  return {
    alignmentApplicationId: uuid(index),
    alignmentArtifactId: uuid(index + 100),
    artifactChecksum: sha256(`artifact-${index}`),
    targetSnapshotChecksum: sha256(`target-${index}`),
    targetSentenceCount: index,
    targetCharacterCount: index + 1,
    targetSnapshotBytes: 1000 + index,
    sourceSnapshotChecksum: sha256(`source-${index}`),
  };
}

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
