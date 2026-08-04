import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnnotationPresenceChannel,
  parseAnnotationPresenceEventEnvelope,
  parseSerializedAnnotationPresenceEventEnvelope,
  serializeAnnotationPresenceEventEnvelope,
} from "../src/annotationPresenceEventEnvelope.js";

test("presence invalidation 严格往返且不携带成员数据", () => {
  const serialized = serializeAnnotationPresenceEventEnvelope("instance-a", {
    annotationFileId: "file-1",
  });
  assert.deepEqual(parseSerializedAnnotationPresenceEventEnvelope(serialized), {
    annotationFileId: "file-1",
  });
  assert.notEqual(
    createAnnotationPresenceChannel("public"),
    createAnnotationPresenceChannel("api_test"),
  );
  assert.throws(() => createAnnotationPresenceChannel("bad-schema"));
});

test("presence invalidation 拒绝额外字段和越界身份", () => {
  const valid = {
    version: 1,
    type: "annotation.presence.changed",
    sourceInstanceId: "instance-a",
    annotationFileId: "file-1",
  };
  for (const input of [
    null,
    [],
    { ...valid, version: 2 },
    { ...valid, type: "presence.snapshot" },
    { ...valid, members: [] },
    { ...valid, sourceInstanceId: "" },
    { ...valid, annotationFileId: "bad\nfile" },
  ]) assert.equal(parseAnnotationPresenceEventEnvelope(input), null);
  assert.equal(parseSerializedAnnotationPresenceEventEnvelope("not-json"), null);
});
