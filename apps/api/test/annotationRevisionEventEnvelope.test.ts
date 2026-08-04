import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnnotationRevisionChannel,
  parseAnnotationRevisionEventEnvelope,
  parseSerializedAnnotationRevisionEventEnvelope,
  serializeAnnotationRevisionEventEnvelope,
} from "../src/annotationRevisionEventEnvelope.js";

test("revision event envelope 严格往返且 channel 按 schema 隔离", () => {
  const serialized = serializeAnnotationRevisionEventEnvelope("instance-a", {
    annotationFileId: "file-1",
    revision: 3,
    operationCursor: "cursor-3",
  });
  assert.deepEqual(parseSerializedAnnotationRevisionEventEnvelope(serialized), {
    version: 1,
    type: "annotation.revision.advanced",
    sourceInstanceId: "instance-a",
    annotationFileId: "file-1",
    revision: 3,
    operationCursor: "cursor-3",
  });
  assert.equal(createAnnotationRevisionChannel("public").length < 64, true);
  assert.notEqual(
    createAnnotationRevisionChannel("public"),
    createAnnotationRevisionChannel("api_test"),
  );
  assert.throws(() => createAnnotationRevisionChannel("bad-schema;DROP"));
});

test("revision event envelope 拒绝未知、越界和非精确输入", () => {
  const valid = {
    version: 1,
    type: "annotation.revision.advanced",
    sourceInstanceId: "instance-a",
    annotationFileId: "file-1",
    revision: 1,
    operationCursor: "cursor-1",
  };
  for (const input of [
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, type: "presence" },
    { ...valid, extra: true },
    { ...valid, sourceInstanceId: "" },
    { ...valid, annotationFileId: "bad\nfile" },
    { ...valid, revision: 0 },
    { ...valid, revision: 1.5 },
    { ...valid, operationCursor: "" },
    { ...valid, operationCursor: "x".repeat(2_049) },
  ]) {
    assert.equal(parseAnnotationRevisionEventEnvelope(input), null);
  }
  assert.equal(parseSerializedAnnotationRevisionEventEnvelope("not-json"), null);
  assert.equal(
    parseSerializedAnnotationRevisionEventEnvelope(JSON.stringify({
      ...valid,
      operationCursor: "x".repeat(7_001),
    })),
    null,
  );
});
