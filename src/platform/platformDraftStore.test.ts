import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import { buildPlatformDraftRecord } from "./platformDraft";
import { createPlatformDraftStore } from "./platformDraftStore";

// 每个测试使用独立数据库，真实运行 idb 的建库、覆盖和删除 transaction。
test("IndexedDB 草稿仓库按账号和文件隔离并覆盖同 key", async () => {
  const databaseName = `xiqu-platform-draft-test-${crypto.randomUUID()}`;
  const store = createPlatformDraftStore(databaseName);
  const createRecord = (userId: string, annotationFileId: string, updatedAt: number) =>
    buildPlatformDraftRecord({
      userId,
      annotationFileId,
      remoteBaseRevision: 2,
      recoveryState: {
        currentProject: mockProject,
        savedProject: mockProject,
        currentTrackSnapEnabled: {},
        savedTrackSnapEnabled: {},
        pendingOperations: [],
        localRevision: 1,
        savedRevision: 0,
        lastChangedAt: updatedAt,
        lastSavedAt: null,
      },
      now: updatedAt,
    });

  try {
    await store.put(createRecord("user-a", "file-a", 100));
    await store.put(createRecord("user-b", "file-a", 200));
    await store.put(createRecord("user-a", "file-a", 300));
    const userA = await store.get("user-a", "file-a") as { updatedAt: number };
    const userB = await store.get("user-b", "file-a") as { updatedAt: number };
    assert.equal(userA.updatedAt, 300);
    assert.equal(userB.updatedAt, 200);

    await store.delete("user-a", "file-a");
    assert.equal(await store.get("user-a", "file-a"), null);
    assert.notEqual(await store.get("user-b", "file-a"), null);
  } finally {
    await store.close();
    await deleteDatabase(databaseName);
  }
});

// 测试清理等待 blocked/error/success，避免残留数据库影响后续用例。
function deleteDatabase(databaseName: string) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`测试数据库仍被占用：${databaseName}`));
  });
}
