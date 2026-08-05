import assert from "node:assert/strict";
import test from "node:test";
import { shouldBlockEditingForRemoteCatchUp } from "./platformRemoteEditGate";

const CLEAN_FACTS = {
  observedRemoteRevision: 18,
  appliedRemoteRevision: 17,
  hasUnsavedChanges: false,
  pendingOperationCount: 0,
  hasTransientEdit: false,
  hasInlineEdit: false,
  hasPendingMergeDraft: false,
  syncStatus: "saved" as const,
};

test("干净客户端得知更高 revision 后阻止从旧快照开始新编辑", () => {
  assert.equal(shouldBlockEditingForRemoteCatchUp(CLEAN_FACTS), true);
  assert.equal(shouldBlockEditingForRemoteCatchUp({
    ...CLEAN_FACTS,
    appliedRemoteRevision: 18,
  }), false);
});

test("已经开始的本地编辑不被远端通知半途截断", () => {
  for (const facts of [
    { ...CLEAN_FACTS, hasUnsavedChanges: true, syncStatus: "dirty" as const },
    { ...CLEAN_FACTS, pendingOperationCount: 1, syncStatus: "dirty" as const },
    { ...CLEAN_FACTS, hasTransientEdit: true },
    { ...CLEAN_FACTS, hasInlineEdit: true },
    { ...CLEAN_FACTS, hasPendingMergeDraft: true },
  ]) {
    assert.equal(shouldBlockEditingForRemoteCatchUp(facts), false);
  }
});
