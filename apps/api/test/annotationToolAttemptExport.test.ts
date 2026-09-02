import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_TOOL_ATTEMPT_EXPORT_HEADER,
  buildAnnotationToolAttemptCsv,
  type AnnotationToolAttemptExportRow,
} from "../src/annotationToolAttemptExport.js";

test("工具尝试 CSV 使用固定表头、UTF-8 BOM 与稳定轻量列", () => {
  const csv = buildAnnotationToolAttemptCsv([createRow()]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.endsWith("\r\n"));
  assert.equal(csv.split("\r\n")[0], `\uFEFF${ANNOTATION_TOOL_ATTEMPT_EXPORT_HEADER
    .map((cell) => `"${cell}"`)
    .join(",")}`);
  assert.match(csv, /"no_timing_change"/u);
  assert.match(csv, /"committed"/u);
  assert.doesNotMatch(csv, /ProjectData|媒体地址|命令正文/u);
});

test("工具尝试 CSV 阻断公式前缀且不导出 details 中的未知字段", () => {
  const csv = buildAnnotationToolAttemptCsv([createRow({
    id: "=SUM(1,1)",
    actorUserId: "+malicious-account",
    details: {
      reasonCode: "no_timing_change",
      secret: "AccessKey-should-not-leave-server",
      payload: { text: "不应导出的正文" },
    },
  })]);
  assert.match(csv, /"'=SUM\(1,1\)"/u);
  assert.match(csv, /"'\+malicious-account"/u);
  assert.doesNotMatch(csv, /AccessKey-should-not-leave-server|不应导出的正文/u);
});

test("工具尝试 CSV 对未知原因码留空而不透传自由文本", () => {
  const csv = buildAnnotationToolAttemptCsv([createRow({
    details: { reasonCode: "provider_error_with_private_detail" },
  })]);
  assert.doesNotMatch(csv, /provider_error_with_private_detail/u);
});

function createRow(
  overrides: Partial<AnnotationToolAttemptExportRow> = {},
): AnnotationToolAttemptExportRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    eventName: "sentence_character_even_timing_reset",
    actorUserId: "user-1",
    annotationFileId: "file-1",
    sentenceId: "sentence-1",
    entryPoint: "sentence_list",
    invokedAt: new Date("2026-09-02T00:00:00.000Z"),
    confirmedAt: new Date("2026-09-02T00:00:01.000Z"),
    finishedAt: new Date("2026-09-02T00:00:02.000Z"),
    outcome: "committed",
    suppressPrompt: true,
    characterCount: 4,
    sentenceDurationMs: 2_000,
    annotationOperationId: "operation-1",
    committedRevision: 2,
    details: { reasonCode: "no_timing_change" },
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:02.000Z"),
    ...overrides,
  };
}
