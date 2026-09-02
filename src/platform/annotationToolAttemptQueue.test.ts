import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { deleteDB } from "idb";
import type { AnnotationToolAttemptState } from "@xiqu/shared";
import {
  AnnotationToolAttemptQueueCapacityError,
  createAnnotationToolAttemptQueueStore,
} from "./annotationToolAttemptQueue";

test("工具尝试队列按账号隔离且迟到前缀不能覆盖终态", async () => {
  const databaseName = `annotation-tool-attempt-queue-${Date.now()}-isolation`;
  const store = createAnnotationToolAttemptQueueStore(databaseName);
  const invoked = createAttempt();
  const terminal: AnnotationToolAttemptState = {
    ...invoked,
    confirmedAt: "2026-09-02T00:00:01.000Z",
    finishedAt: "2026-09-02T00:00:02.000Z",
    outcome: "failed",
    details: { reasonCode: "command_rejected" },
  };
  try {
    await store.upsert("user-a", invoked);
    await store.upsert("user-a", terminal);
    await store.upsert("user-a", invoked);
    const userA = await store.listForUser("user-a");
    assert.equal(userA.length, 1);
    assert.deepEqual(userA[0].attempt, terminal);
    assert.deepEqual(await store.listForUser("user-b"), []);
  } finally {
    await store.close();
    await deleteDB(databaseName);
  }
});

test("送达期间出现新状态时旧 version 不能误删", async () => {
  const databaseName = `annotation-tool-attempt-queue-${Date.now()}-version`;
  const store = createAnnotationToolAttemptQueueStore(databaseName);
  try {
    const first = await store.upsert("user-a", createAttempt());
    const confirmed = await store.upsert("user-a", {
      ...first.attempt,
      confirmedAt: "2026-09-02T00:00:01.000Z",
    });
    assert.equal(await store.deleteIfVersion(first), false);
    assert.equal((await store.listForUser("user-a"))[0].version, confirmed.version);
    assert.equal(await store.deleteIfVersion(confirmed), true);
    assert.deepEqual(await store.listForUser("user-a"), []);
  } finally {
    await store.close();
    await deleteDB(databaseName);
  }
});

test("有界队列拒绝新增但允许同一 attempt 补写", async () => {
  const databaseName = `annotation-tool-attempt-queue-${Date.now()}-capacity`;
  const store = createAnnotationToolAttemptQueueStore(databaseName, {
    maxRecordsPerUser: 1,
    maxRecordsTotal: 2,
  });
  try {
    const first = createAttempt();
    await store.upsert("user-a", first);
    await store.upsert("user-a", { ...first, confirmedAt: "2026-09-02T00:00:01.000Z" });
    await assert.rejects(
      store.upsert("user-a", createAttempt("10000000-0000-4000-8000-000000000002")),
      AnnotationToolAttemptQueueCapacityError,
    );
    await store.upsert("user-b", createAttempt("10000000-0000-4000-8000-000000000003"));
  } finally {
    await store.close();
    await deleteDB(databaseName);
  }
});

function createAttempt(id = "10000000-0000-4000-8000-000000000001"): AnnotationToolAttemptState {
  return {
    id,
    eventName: "sentence_character_even_timing_reset",
    annotationFileId: "file-1",
    sentenceId: "line-1",
    entryPoint: "sentence_list",
    invokedAt: "2026-09-02T00:00:00.000Z",
    confirmedAt: null,
    finishedAt: null,
    outcome: null,
    suppressPrompt: false,
    characterCount: 4,
    sentenceDurationMs: 2_000,
    details: null,
  };
}
