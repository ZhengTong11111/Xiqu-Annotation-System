import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProcessingJobRequestMatch,
  createMediaAnalysisJobDeduplicationKey,
  createMediaAnalysisRequestFingerprint,
  isValidProcessingJobClientRequestId,
} from "../src/processingJobIdentity.js";

test("媒体分析执行键只随 canonical 分析身份变化", () => {
  const base = {
    sourceMediaResourceId: "11111111-1111-4111-8111-111111111111",
    mediaFingerprint: "a".repeat(64),
    sourceVodRenditionJobId: null,
    algorithmVersion: "analysis-v1",
    configHash: "b".repeat(64),
  };
  const first = createMediaAnalysisJobDeduplicationKey(base);
  assert.equal(first, createMediaAnalysisJobDeduplicationKey({ ...base }));
  assert.notEqual(first, createMediaAnalysisJobDeduplicationKey({
    ...base,
    sourceVodRenditionJobId: "rendition-2",
  }));
});

test("任务请求编号必须使用规范 UUID", () => {
  assert.equal(isValidProcessingJobClientRequestId("018f1e2d-4c4b-7a31-8abc-0123456789ab"), true);
  assert.equal(isValidProcessingJobClientRequestId("not-a-uuid"), false);
  assert.equal(isValidProcessingJobClientRequestId(""), false);
});

test("同一任务请求编号不能改绑 force 或音轨语义", () => {
  const base = {
    deduplicationKey: "media-analysis:v1:key",
    contextResourceId: "annotation-1",
    audioTrackId: "track-1",
    force: false,
  };
  const fingerprint = createMediaAnalysisRequestFingerprint(base);
  assert.doesNotThrow(() => assertProcessingJobRequestMatch(fingerprint, fingerprint));
  assert.throws(
    () => assertProcessingJobRequestMatch(
      fingerprint,
      createMediaAnalysisRequestFingerprint({ ...base, force: true }),
    ),
    (error: unknown) => Boolean(
      error &&
      typeof error === "object" &&
      "statusCode" in error &&
      error.statusCode === 409,
    ),
  );
});
