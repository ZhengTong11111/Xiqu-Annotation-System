import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationPresenceMember } from "@xiqu/shared";
import { AnnotationCollaborationHub } from "../src/annotationCollaborationHub.js";
import { AnnotationPresenceCoordinator } from "../src/annotationPresenceCoordinator.js";

test("没有本地订阅者时不读取 presence 数据库快照", async () => {
  let reads = 0;
  const coordinator = new AnnotationPresenceCoordinator(
    { listActive: async () => { reads += 1; return []; } },
    new AnnotationCollaborationHub(),
    { error: () => undefined },
  );
  assert.equal(coordinator.requestRefresh("file-1"), "duplicate");
  await coordinator.close();
  assert.equal(reads, 0);
});

test("查询期间的重复失效只追加一轮，最终投递最新成员快照", async () => {
  const hub = new AnnotationCollaborationHub();
  const snapshots: AnnotationPresenceMember[][] = [];
  hub.subscribe("file-1", {
    send: (message) => {
      if (message.type === "presence.snapshot") snapshots.push(message.members);
    },
    close: () => undefined,
  });
  const first = createDeferred<AnnotationPresenceMember[]>();
  const second = createDeferred<AnnotationPresenceMember[]>();
  let reads = 0;
  const coordinator = new AnnotationPresenceCoordinator(
    {
      listActive: async () => {
        reads += 1;
        return reads === 1 ? first.promise : second.promise;
      },
    },
    hub,
    { error: () => undefined },
  );

  assert.equal(coordinator.requestRefresh("file-1"), "accepted");
  assert.equal(coordinator.requestRefresh("file-1"), "duplicate");
  first.resolve([member("user-1")]);
  await flushPromises();
  assert.equal(reads, 2, "第一轮完成后必须执行一次合并后的补读");
  second.resolve([member("user-1"), member("user-2")]);
  await flushPromises();
  await coordinator.close();

  assert.equal(reads, 2);
  assert.deepEqual(snapshots.map((items) => items.length), [1, 2]);
});

function member(userId: string): AnnotationPresenceMember {
  return {
    userId,
    accountName: userId,
    displayName: userId,
    connectionCount: 1,
    lastSeenAt: "2026-08-04T00:00:00.000Z",
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
