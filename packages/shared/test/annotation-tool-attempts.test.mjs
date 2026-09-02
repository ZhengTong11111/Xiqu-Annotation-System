import assert from "node:assert/strict";
import test from "node:test";
import { parseAnnotationToolAttemptBatchRequest } from "../dist/annotationToolAttempts.js";

test("工具尝试批次严格解析生命周期状态", () => {
  const parsed = parseAnnotationToolAttemptBatchRequest({ attempts: [createAttempt()] });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.success ? parsed.data.attempts[0] : null, createAttempt());
});

test("外部批次拒绝 committed、额外字段、重复 id 和倒序时间", () => {
  assert.equal(parseAnnotationToolAttemptBatchRequest({
    attempts: [{ ...createAttempt(), outcome: "committed", finishedAt: "2026-09-02T00:00:02.000Z" }],
  }).success, false);
  assert.equal(parseAnnotationToolAttemptBatchRequest({
    attempts: [{ ...createAttempt(), unexpected: true }],
  }).success, false);
  assert.equal(parseAnnotationToolAttemptBatchRequest({
    attempts: [createAttempt(), createAttempt()],
  }).success, false);
  assert.equal(parseAnnotationToolAttemptBatchRequest({
    attempts: [{
      ...createAttempt(),
      confirmedAt: "2026-09-01T23:59:59.000Z",
    }],
  }).success, false);
});

function createAttempt() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    eventName: "sentence_character_even_timing_reset",
    annotationFileId: "file-1",
    sentenceId: "sentence-1",
    entryPoint: "sentence_list",
    invokedAt: "2026-09-02T00:00:00.000Z",
    confirmedAt: null,
    finishedAt: null,
    outcome: null,
    suppressPrompt: false,
    characterCount: 4,
    sentenceDurationMs: 2_000,
    details: null,
  };
}
