import assert from "node:assert/strict";
import test from "node:test";
import {
  canSubmitAlignmentQualityAssessment,
  resolveAlignmentQualityAssessmentAction,
} from "./alignmentQualityAssessmentDraft.js";

test("评价提交严格区分 write 与 review scope", () => {
  assert.equal(canSubmitAlignmentQualityAssessment("editor", "correct", [], true, false), true);
  assert.equal(canSubmitAlignmentQualityAssessment("editor", "correct", [], false, true), false);
  assert.equal(canSubmitAlignmentQualityAssessment("reviewer", "correct", [], false, true), true);
  assert.equal(canSubmitAlignmentQualityAssessment("reviewer", "needs_adjustment", [], true, true), false);
  assert.equal(canSubmitAlignmentQualityAssessment(
    "reviewer",
    "needs_adjustment",
    ["boundary_offset"],
    true,
    true,
  ), true);
});

test("模糊失败仅在完整评价语义不变时复用 action UUID", () => {
  let sequence = 0;
  const createId = () => `action-${++sequence}`;
  const base = {
    applicationId: "application-1",
    scope: "editor" as const,
    verdict: "needs_adjustment" as const,
    issueCodes: ["boundary_offset" as const],
  };
  const first = resolveAlignmentQualityAssessmentAction(null, base, createId);
  assert.equal(first.actionId, "action-1");
  assert.equal(resolveAlignmentQualityAssessmentAction(first, base, createId), first);
  const changed = resolveAlignmentQualityAssessmentAction(first, {
    ...base,
    issueCodes: ["audio_desync"],
  }, createId);
  assert.equal(changed.actionId, "action-2");
  const otherApplication = resolveAlignmentQualityAssessmentAction(changed, {
    ...base,
    applicationId: "application-2",
  }, createId);
  assert.equal(otherApplication.actionId, "action-3");
});
