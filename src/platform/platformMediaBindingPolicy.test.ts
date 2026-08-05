import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlatformMediaBindingBlockReason,
  type PlatformMediaBindingFacts,
} from "./platformMediaBindingPolicy";

const cleanFacts: PlatformMediaBindingFacts = {
  canWrite: true,
  hasUnsavedChanges: false,
  pendingOperationCount: 0,
  hasTransientEdit: false,
  hasInlineEdit: false,
  hasPendingMergeDraft: false,
  syncStatus: "saved",
  saveInFlight: false,
  appliedRemoteRevision: 3,
  observedRemoteRevision: 3,
};

test("clean 且可写的平台文件允许修改媒体关系", () => {
  assert.equal(getPlatformMediaBindingBlockReason(cleanFacts), undefined);
});

test("媒体改绑门禁覆盖本地编辑、保存、冲突和远端追赶状态", () => {
  const blocked: Array<Partial<PlatformMediaBindingFacts>> = [
    { canWrite: false },
    { hasUnsavedChanges: true },
    { pendingOperationCount: 1 },
    { hasTransientEdit: true },
    { hasInlineEdit: true },
    { hasPendingMergeDraft: true },
    { syncStatus: "saving" },
    { syncStatus: "conflict" },
    { syncStatus: "offline" },
    { syncStatus: "error" },
    { saveInFlight: true },
    { observedRemoteRevision: 4 },
  ];
  for (const override of blocked) {
    assert.ok(getPlatformMediaBindingBlockReason({ ...cleanFacts, ...override }));
  }
});
