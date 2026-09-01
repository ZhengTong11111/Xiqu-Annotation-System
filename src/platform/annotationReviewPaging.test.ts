import assert from "node:assert/strict";
import test from "node:test";
import { mergeAnnotationReviewPage } from "./annotationReviewPaging";

test("审核记录续页保持服务端顺序并按 id 去重", () => {
  assert.deepEqual(
    mergeAnnotationReviewPage(
      [{ id: "newest" }, { id: "boundary" }],
      [{ id: "boundary" }, { id: "older" }],
    ),
    [{ id: "newest" }, { id: "boundary" }, { id: "older" }],
  );
});
