import assert from "node:assert/strict";
import test from "node:test";
import {
  createAlignmentTrainingExportJobDeduplicationKey,
  createAlignmentTrainingExportRequestFingerprint,
} from "../src/alignmentTrainingExportJobIdentity.js";

test("训练导出执行 identity 只随不可变导出输入变化", () => {
  const identity = {
    exportId: uuid(1),
    provenanceManifestChecksum: "a".repeat(64),
    inputManifestChecksum: "b".repeat(64),
  };
  const first = createAlignmentTrainingExportJobDeduplicationKey(identity);
  assert.equal(first, createAlignmentTrainingExportJobDeduplicationKey({ ...identity }));
  assert.notEqual(first, createAlignmentTrainingExportJobDeduplicationKey({
    ...identity,
    inputManifestChecksum: "c".repeat(64),
  }));
  assert.match(first, /^alignment-training-export:v1:[0-9a-f]{64}$/u);
});

test("训练导出请求指纹绑定 export 与 canonical execution", () => {
  const first = createAlignmentTrainingExportRequestFingerprint({
    exportId: uuid(1),
    deduplicationKey: "alignment-training-export:v1:" + "a".repeat(64),
  });
  const second = createAlignmentTrainingExportRequestFingerprint({
    exportId: uuid(2),
    deduplicationKey: "alignment-training-export:v1:" + "a".repeat(64),
  });
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{64}$/u);
});

function uuid(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
