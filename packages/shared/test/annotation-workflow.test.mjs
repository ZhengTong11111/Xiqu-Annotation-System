import assert from "node:assert/strict";
import test from "node:test";
import { getAnnotationWorkflowTransition } from "../dist/index.js";

test("标注工作流只允许编辑与审核职责各自控制相邻阶段", () => {
  assert.deepEqual(
    getAnnotationWorkflowTransition("unannotated", "annotated"),
    { kind: "allowed", requiredCapability: "write" },
  );
  assert.deepEqual(
    getAnnotationWorkflowTransition("annotated", "unannotated"),
    { kind: "allowed", requiredCapability: "write" },
  );
  assert.deepEqual(
    getAnnotationWorkflowTransition("annotated", "reviewed"),
    { kind: "allowed", requiredCapability: "review" },
  );
  assert.deepEqual(
    getAnnotationWorkflowTransition("reviewed", "annotated"),
    { kind: "allowed", requiredCapability: "review" },
  );
  assert.deepEqual(
    getAnnotationWorkflowTransition("unannotated", "reviewed"),
    { kind: "invalid_order" },
  );
  assert.deepEqual(
    getAnnotationWorkflowTransition("reviewed", "unannotated"),
    { kind: "invalid_order" },
  );
  assert.deepEqual(
    getAnnotationWorkflowTransition("reviewed", "reviewed"),
    { kind: "unchanged" },
  );
});
