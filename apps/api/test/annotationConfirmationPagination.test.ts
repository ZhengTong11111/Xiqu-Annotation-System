import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAnnotationConfirmationCursor,
  encodeAnnotationConfirmationCursor,
} from "../src/annotationConfirmationPagination.js";

test("确认游标绑定文件和复合排序锚点", () => {
  const source = {
    annotationFileId: "file-1",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    id: "confirmation-1",
  };
  const encoded = encodeAnnotationConfirmationCursor(source);

  assert.deepEqual(decodeAnnotationConfirmationCursor(encoded, "file-1"), source);
  assert.equal(decodeAnnotationConfirmationCursor(encoded, "file-2"), null);
  assert.equal(decodeAnnotationConfirmationCursor("not-a-cursor", "file-1"), null);
});
