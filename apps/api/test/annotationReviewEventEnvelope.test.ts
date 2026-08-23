import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnnotationReviewChannel,
  parseAnnotationReviewEventEnvelope,
  parseSerializedAnnotationReviewEventEnvelope,
  serializeAnnotationReviewEventEnvelope,
} from "../src/annotationReviewEventEnvelope.js";

test("审核失效 envelope 严格往返且按数据库 schema 隔离", () => {
  const serialized = serializeAnnotationReviewEventEnvelope("instance-a", {
    annotationFileId: "file-1",
    eventId: "event-1",
    occurredAt: "2026-08-22T00:00:00.000Z",
  });
  assert.deepEqual(parseSerializedAnnotationReviewEventEnvelope(serialized), {
    version: 1,
    type: "annotation.review.changed",
    sourceInstanceId: "instance-a",
    annotationFileId: "file-1",
    eventId: "event-1",
    occurredAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(createAnnotationReviewChannel("public").length < 64, true);
  assert.notEqual(createAnnotationReviewChannel("public"), createAnnotationReviewChannel("api_test"));
  assert.throws(() => createAnnotationReviewChannel("bad-schema;DROP"));
});

test("审核失效 envelope 拒绝正文、额外字段和非法时间", () => {
  const valid = {
    version: 1,
    type: "annotation.review.changed",
    sourceInstanceId: "instance-a",
    annotationFileId: "file-1",
    eventId: "event-1",
    occurredAt: "2026-08-22T00:00:00.000Z",
  };
  for (const value of [
    null,
    { ...valid, version: 2 },
    { ...valid, body: "不得进入通知" },
    { ...valid, eventId: "" },
    { ...valid, occurredAt: "not-a-time" },
  ]) assert.equal(parseAnnotationReviewEventEnvelope(value), null);
});
