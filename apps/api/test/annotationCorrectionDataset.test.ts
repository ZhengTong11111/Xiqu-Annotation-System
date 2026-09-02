import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnotationTransactionEnvelope,
  buildTimelineTimingUpdateEnvelope,
} from "@xiqu/shared";
import {
  buildAnnotationCorrectionDatasetCsv,
  extractAnnotationCorrectionRows,
  type AnnotationCorrectionOperationFact,
} from "../src/annotationCorrectionDataset.js";

test("直接拖动与事务内平均重置都提取精确微秒 before/after", () => {
  const timing = buildTimelineTimingUpdateEnvelope([{
    entityType: "character",
    entityId: "char-1",
    before: { startTime: 1.001, endTime: 2.002 },
    after: { startTime: 1.011, endTime: 2.022 },
  }, {
    entityType: "sentence",
    entityId: "sentence-1",
    before: { startTime: 1, endTime: 3 },
    after: { startTime: 1.1, endTime: 3 },
  }]);
  assert.ok(timing);

  const manualRows = extractAnnotationCorrectionRows(createOperation(timing));
  assert.equal(manualRows.length, 1);
  assert.equal(manualRows[0]?.origin, "manual_timing_edit");
  assert.equal(manualRows[0]?.beforeStartMicros, 1_001_000);
  assert.equal(manualRows[0]?.afterStartMicros, 1_011_000);
  assert.equal(manualRows[0]?.startDeltaMicros, 10_000);
  assert.equal(manualRows[0]?.endDeltaMicros, 20_000);

  const transaction = buildAnnotationTransactionEnvelope([timing]);
  assert.ok(transaction);
  const resetRows = extractAnnotationCorrectionRows(createOperation(transaction, {
    toolAttempt: createCommittedAttempt(),
  }));
  assert.equal(resetRows.length, 1);
  assert.equal(resetRows[0]?.origin, "sentence_even_reset");
  assert.equal(resetRows[0]?.sentenceId, "sentence-1");
  assert.equal(resetRows[0]?.toolAttemptId, "attempt-1");
});

test("坏命令、非 timing 命令和未提交 operation 不会被猜测为修正数据", () => {
  assert.deepEqual(extractAnnotationCorrectionRows(createOperation({ unexpected: true })), []);
  assert.deepEqual(extractAnnotationCorrectionRows(createOperation({
    version: 1,
    command: { type: "timeline.items.timing.update", items: [] },
  })), []);
  assert.deepEqual(extractAnnotationCorrectionRows(createOperation({ unexpected: true }, {
    committedAt: null,
    committedRevision: null,
  })), []);
});

test("修正 CSV 不导出文字正文、任意 details、媒体地址或凭据", () => {
  const timing = buildTimelineTimingUpdateEnvelope([{
    entityType: "character",
    entityId: "=char-formula",
    before: { startTime: 1, endTime: 2 },
    after: { startTime: 1.1, endTime: 2.1 },
  }]);
  // 严格命令 id 会阻断公式前缀，因此使用合法数据验证固定投影不泄露 operation 之外的字段。
  assert.equal(timing, null);
  const validTiming = buildTimelineTimingUpdateEnvelope([{
    entityType: "character",
    entityId: "char-1",
    before: { startTime: 1, endTime: 2 },
    after: { startTime: 1.1, endTime: 2.1 },
  }]);
  assert.ok(validTiming);
  const csv = buildAnnotationCorrectionDatasetCsv(
    extractAnnotationCorrectionRows(createOperation(validTiming)),
  );
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /manual_timing_edit/u);
  assert.doesNotMatch(csv, /ProjectData|AccessKey|PlayAuth|https?:\/\/|标注正文/u);
});

function createOperation(
  payload: unknown,
  overrides: Partial<AnnotationCorrectionOperationFact> = {},
): AnnotationCorrectionOperationFact {
  return {
    id: "operation-1",
    annotationFileId: "file-1",
    actorUserId: "user-1",
    sequence: 3,
    baseRevision: 4,
    committedRevision: 5,
    committedAt: new Date("2026-09-02T12:00:00.000Z"),
    payload,
    toolAttempt: null,
    ...overrides,
  };
}

function createCommittedAttempt(): NonNullable<AnnotationCorrectionOperationFact["toolAttempt"]> {
  return {
    id: "attempt-1",
    eventName: "sentence_character_even_timing_reset",
    sentenceId: "sentence-1",
    entryPoint: "sentence_list",
    invokedAt: new Date("2026-09-02T11:59:58.000Z"),
    confirmedAt: new Date("2026-09-02T11:59:59.000Z"),
    suppressPrompt: true,
    outcome: "committed",
  };
}
