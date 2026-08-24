import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMediaAnalysisMigrationPlan,
  type MediaAnalysisMigrationRunFact,
} from "../src/mediaAnalysisMigrationPlan.js";

const BASE_TIME = "2026-08-24T00:00:00.000Z";

function fact(
  id: string,
  overrides: Partial<MediaAnalysisMigrationRunFact> = {},
): MediaAnalysisMigrationRunFact {
  return {
    id,
    sourceMediaResourceId: "media-1",
    sourceFingerprint: "fingerprint-1",
    algorithmVersion: "v1",
    configHash: "config-1",
    configFingerprint: "payload-1",
    status: "succeeded",
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    completedAt: BASE_TIME,
    supersededByRunId: null,
    activeJobCount: 0,
    assetCount: 7,
    assetFactsFingerprint: `assets-${id}`,
    assetValidation: "valid",
    ...overrides,
  };
}

test("迁移计划优先选择较新的完整 succeeded run", () => {
  const plan = buildMediaAnalysisMigrationPlan([
    fact("old"),
    fact("new", {
      completedAt: "2026-08-24T01:00:00.000Z",
      updatedAt: "2026-08-24T01:00:00.000Z",
    }),
    fact("failed", { status: "failed", completedAt: null, assetCount: 0 }),
  ]);
  assert.equal(plan.actionableGroupCount, 1);
  assert.equal(plan.blockedGroupCount, 0);
  assert.equal(plan.groups[0]?.canonicalRunId, "new");
  assert.deepEqual(plan.groups[0]?.duplicateRunIds, ["failed", "old"]);
});

test("活跃任务、资产损坏和同 hash 配置漂移分别阻断整组", () => {
  const plan = buildMediaAnalysisMigrationPlan([
    fact("one", { activeJobCount: 1 }),
    fact("two", { assetValidation: "invalid", configFingerprint: "other" }),
  ]);
  assert.deepEqual(plan.groups[0]?.blockCodes, [
    "active_job",
    "asset_validation_failed",
    "config_mismatch",
  ]);
  assert.equal(plan.actionableGroupCount, 0);
});

test("跨 identity 或指向已 superseded run 的关系会被拒绝", () => {
  const plan = buildMediaAnalysisMigrationPlan([
    fact("canonical"),
    fact("middle", { supersededByRunId: "canonical" }),
    fact("chain", { supersededByRunId: "middle" }),
    fact("foreign", {
      sourceMediaResourceId: "media-2",
      supersededByRunId: "canonical",
    }),
  ]);
  assert.ok(plan.groups.some((group) => group.blockCodes.includes("invalid_supersession")));
});

test("已完成的单层归并再次规划时保持幂等且没有可执行组", () => {
  const plan = buildMediaAnalysisMigrationPlan([
    fact("canonical"),
    fact("duplicate", { supersededByRunId: "canonical" }),
  ]);
  assert.equal(plan.actionableGroupCount, 0);
  assert.equal(plan.blockedGroupCount, 0);
  assert.deepEqual(plan.groups[0]?.duplicateRunIds, []);
});

test("候选或资产事实变化必然改变计划 fingerprint", () => {
  const initial = buildMediaAnalysisMigrationPlan([fact("one"), fact("two")]);
  const changed = buildMediaAnalysisMigrationPlan([
    fact("one"),
    fact("two", { assetFactsFingerprint: "changed" }),
  ]);
  assert.notEqual(initial.fingerprint, changed.fingerprint);
});

test("不同媒体级 identity 独立计划且输出 identity 只保留 hash", () => {
  const plan = buildMediaAnalysisMigrationPlan([
    fact("a1"),
    fact("a2"),
    fact("b1", { sourceMediaResourceId: "media-2" }),
    fact("b2", { sourceMediaResourceId: "media-2" }),
  ]);
  assert.equal(plan.groups.length, 2);
  assert.ok(plan.groups.every((group) => /^[a-f0-9]{64}$/u.test(group.identity)));
});
