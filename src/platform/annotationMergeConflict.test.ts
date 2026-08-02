import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationMergePlan } from "./annotationMergePlan";
import {
  getAnnotationMergePlanFingerprint,
  getAnnotationMergePreparationState,
  normalizeMergeConflictResolutions,
} from "./annotationMergeConflict";

// 冲突必须逐项决定；计划变化后旧 key 会被清除且指纹保持确定。
test("冲突决策阻断准备并随计划收敛", () => {
  const plan = fixturePlan();
  assert.deepEqual(getAnnotationMergePreparationState(plan, {}), {
    canPrepare: false,
    unresolvedEntryKeys: ["characters:char-1"],
    reasons: ["仍有 1 项冲突尚未决定。"],
  });
  const resolutions = normalizeMergeConflictResolutions(plan, {
    "characters:char-1": "take-source",
    "subtitle_lines:old": "keep-target",
  });
  assert.deepEqual(resolutions, { "characters:char-1": "take-source" });
  assert.equal(getAnnotationMergePreparationState(plan, resolutions).canPrepare, true);
  assert.equal(getAnnotationMergePlanFingerprint(plan), getAnnotationMergePlanFingerprint(structuredClone(plan)));
});

function fixturePlan(): AnnotationMergePlan {
  return {
    direction: "left-to-right",
    sourceSide: "left",
    targetSide: "right",
    items: [{
      entryKey: "characters:char-1",
      domain: "characters",
      identity: "char-1",
      label: "那",
      role: "selected",
      action: "replace-conflict",
      requiredBy: [],
    }],
    issues: [],
    canApply: true,
    counts: { selected: 1, dependencies: 0, additions: 0, conflicts: 1, alreadyEqual: 0 },
  };
}
