import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import {
  createPlatformMediaAnalysisPersistentCache,
  type PlatformMediaAnalysisCacheIdentity,
} from "./platformMediaAnalysisCache.js";

test("分析瓦片持久缓存按账号、媒体和 run 隔离", async () => {
  const databaseName = `media-analysis-cache-isolation-${Date.now()}`;
  const cache = createPlatformMediaAnalysisPersistentCache(databaseName, {
    maxBytes: 100,
    maxAssets: 10,
  });
  const identity = createIdentity();
  try {
    await cache.put(identity, Uint8Array.from([1, 2, 3]));
    assert.deepEqual([...await cache.get(identity) ?? []], [1, 2, 3]);
    assert.equal(await cache.get({ ...identity, userId: "user-2" }), undefined);
    assert.equal(await cache.get({ ...identity, mediaResourceId: "media-2" }), undefined);
    assert.equal(await cache.get({ ...identity, runId: "run-2" }), undefined);
  } finally {
    await cache.close();
    await deleteDB(databaseName);
  }
});

test("分析瓦片持久缓存按最近访问顺序清理字节超限记录", async () => {
  const databaseName = `media-analysis-cache-lru-${Date.now()}`;
  const cache = createPlatformMediaAnalysisPersistentCache(databaseName, {
    maxBytes: 4,
    maxAssets: 2,
  });
  const originalNow = Date.now;
  let clock = 100;
  Date.now = () => clock += 1;
  try {
    await cache.put(createIdentity("a", 2), Uint8Array.from([1, 1]));
    await cache.put(createIdentity("b", 2), Uint8Array.from([2, 2]));
    assert.ok(await cache.get(createIdentity("a", 2)));
    await cache.put(createIdentity("c", 2), Uint8Array.from([3, 3]));
    assert.equal(await cache.get(createIdentity("b", 2)), undefined);
    assert.deepEqual([...await cache.get(createIdentity("a", 2)) ?? []], [1, 1]);
    assert.deepEqual([...await cache.get(createIdentity("c", 2)) ?? []], [3, 3]);
  } finally {
    Date.now = originalNow;
    await cache.close();
    await deleteDB(databaseName);
  }
});

function createIdentity(assetId = "asset-1", size = 3): PlatformMediaAnalysisCacheIdentity {
  return {
    userId: "user-1",
    mediaResourceId: "media-1",
    runId: "run-1",
    assetId,
    size,
  };
}
