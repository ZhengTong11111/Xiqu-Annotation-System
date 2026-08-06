import assert from "node:assert/strict";
import test from "node:test";
import { canReplaceProjectFromRemote } from "./projectDocumentState";

// clean saved/error 可接收权威远端状态；dirty/pending/transient 和其他同步状态仍然 fail closed。
test("远端项目替换允许完全 clean 的 saved 或 error 文档", () => {
  assert.equal(canReplaceProjectFromRemote({
    hasDocumentChanges: false,
    pendingOperationCount: 0,
    hasTransientProject: false,
    syncStatus: "saved",
  }), true);
  assert.equal(canReplaceProjectFromRemote({
    hasDocumentChanges: false,
    pendingOperationCount: 0,
    hasTransientProject: false,
    syncStatus: "error",
  }), true);

  for (const facts of [
    { hasDocumentChanges: true, pendingOperationCount: 0, hasTransientProject: false, syncStatus: "saved" as const },
    { hasDocumentChanges: false, pendingOperationCount: 1, hasTransientProject: false, syncStatus: "saved" as const },
    { hasDocumentChanges: false, pendingOperationCount: 0, hasTransientProject: true, syncStatus: "saved" as const },
    { hasDocumentChanges: false, pendingOperationCount: 0, hasTransientProject: false, syncStatus: "saving" as const },
    { hasDocumentChanges: false, pendingOperationCount: 0, hasTransientProject: false, syncStatus: "conflict" as const },
    { hasDocumentChanges: true, pendingOperationCount: 0, hasTransientProject: false, syncStatus: "error" as const },
    { hasDocumentChanges: false, pendingOperationCount: 1, hasTransientProject: false, syncStatus: "error" as const },
    { hasDocumentChanges: false, pendingOperationCount: 0, hasTransientProject: true, syncStatus: "error" as const },
  ]) {
    assert.equal(canReplaceProjectFromRemote(facts), false);
  }
});
