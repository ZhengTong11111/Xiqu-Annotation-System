import assert from "node:assert/strict";
import test from "node:test";
import { canReplaceProjectFromRemote } from "./projectDocumentState";

// clean/saved 是唯一允许远端替换的组合；其余状态逐项验证为 fail closed。
test("远端项目替换只允许完全 clean 的 saved 文档", () => {
  assert.equal(canReplaceProjectFromRemote({
    hasDocumentChanges: false,
    pendingOperationCount: 0,
    hasTransientProject: false,
    syncStatus: "saved",
  }), true);

  for (const facts of [
    { hasDocumentChanges: true, pendingOperationCount: 0, hasTransientProject: false, syncStatus: "saved" as const },
    { hasDocumentChanges: false, pendingOperationCount: 1, hasTransientProject: false, syncStatus: "saved" as const },
    { hasDocumentChanges: false, pendingOperationCount: 0, hasTransientProject: true, syncStatus: "saved" as const },
    { hasDocumentChanges: false, pendingOperationCount: 0, hasTransientProject: false, syncStatus: "saving" as const },
    { hasDocumentChanges: false, pendingOperationCount: 0, hasTransientProject: false, syncStatus: "conflict" as const },
    { hasDocumentChanges: false, pendingOperationCount: 0, hasTransientProject: false, syncStatus: "error" as const },
  ]) {
    assert.equal(canReplaceProjectFromRemote(facts), false);
  }
});
