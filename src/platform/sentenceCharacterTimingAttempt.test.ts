import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmSentenceCharacterTimingAttempt,
  createSentenceCharacterTimingAttempt,
  finishSentenceCharacterTimingAttempt,
} from "./sentenceCharacterTimingAttempt";

test("平均重置 attempt 只保存有界元数据并单行推进生命周期", () => {
  const invoked = createSentenceCharacterTimingAttempt({
    annotationFileId: "file-1",
    sentenceId: "line-1",
    entryPoint: "timeline_context_menu",
    characterCount: 4,
    sentenceDurationSeconds: 2.345,
    suppressPrompt: false,
    id: "10000000-0000-4000-8000-000000000001",
    now: new Date("2026-09-02T00:00:00.000Z"),
  });
  const confirmed = confirmSentenceCharacterTimingAttempt(invoked, {
    suppressPrompt: true,
    now: new Date("2026-09-02T00:00:01.000Z"),
  });
  const failed = finishSentenceCharacterTimingAttempt(
    confirmed,
    "failed",
    "command_rejected",
    new Date("2026-09-02T00:00:02.000Z"),
  );
  assert.equal(invoked.sentenceDurationMs, 2_345);
  assert.equal(confirmed.suppressPrompt, true);
  assert.equal(failed.id, invoked.id);
  assert.equal(failed.confirmedAt, "2026-09-02T00:00:01.000Z");
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.details, { reasonCode: "command_rejected" });
  assert.equal("text" in failed, false);
  assert.equal("payload" in failed, false);
});

test("浏览器时钟回拨不会制造倒序生命周期", () => {
  const invoked = createSentenceCharacterTimingAttempt({
    annotationFileId: "file-1",
    sentenceId: "line-1",
    entryPoint: "sentence_list",
    characterCount: 1,
    sentenceDurationSeconds: 1,
    suppressPrompt: false,
    id: "10000000-0000-4000-8000-000000000002",
    now: new Date("2026-09-02T00:00:02.000Z"),
  });
  const confirmed = confirmSentenceCharacterTimingAttempt(invoked, {
    suppressPrompt: false,
    now: new Date("2026-09-02T00:00:01.000Z"),
  });
  const cancelled = finishSentenceCharacterTimingAttempt(
    confirmed,
    "cancelled",
    "user_cancelled",
    new Date("2026-09-02T00:00:00.000Z"),
  );
  assert.equal(confirmed.confirmedAt, invoked.invokedAt);
  assert.equal(cancelled.finishedAt, invoked.invokedAt);
});
