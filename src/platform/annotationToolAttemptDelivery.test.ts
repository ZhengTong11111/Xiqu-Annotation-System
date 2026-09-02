import assert from "node:assert/strict";
import test from "node:test";
import type {
  AnnotationToolAttemptRecord,
  AnnotationToolAttemptState,
} from "@xiqu/shared";
import { PlatformApiError } from "../api/platformClient";
import {
  createAnnotationToolAttemptDeliveryCoordinator,
  deliverAnnotationToolAttemptQueueBatch,
} from "./annotationToolAttemptDelivery";
import type {
  AnnotationToolAttemptQueueStore,
  QueuedAnnotationToolAttempt,
} from "./annotationToolAttemptQueue";

test("成功响应完整确认后清除本地批次", async () => {
  const store = createMemoryStore([createRow("10000000-0000-4000-8000-000000000001")]);
  const result = await deliverAnnotationToolAttemptQueueBatch({
    userId: "user-a",
    store,
    client: {
      async submitAnnotationToolAttempts(request) {
        return { attempts: request.attempts.map(toRecord) };
      },
    },
  });
  assert.deepEqual(result, { status: "progress", delivered: 1, dropped: 0 });
  assert.deepEqual(await store.listForUser("user-a"), []);
});

test("永久失败会二分隔离坏行而不阻塞同批有效记录", async () => {
  const good = createRow("10000000-0000-4000-8000-000000000001");
  const bad = createRow("10000000-0000-4000-8000-000000000002");
  const store = createMemoryStore([good, bad]);
  const dropped: string[] = [];
  const result = await deliverAnnotationToolAttemptQueueBatch({
    userId: "user-a",
    store,
    onPermanentDrop: ({ attemptId }) => dropped.push(attemptId),
    client: {
      async submitAnnotationToolAttempts(request) {
        if (request.attempts.some(({ id }) => id === bad.attempt.id)) {
          throw new PlatformApiError(403, "forbidden", "无权限。", null);
        }
        return { attempts: request.attempts.map(toRecord) };
      },
    },
  });
  assert.deepEqual(result, { status: "progress", delivered: 1, dropped: 1 });
  assert.deepEqual(dropped, [bad.attempt.id]);
  assert.deepEqual(await store.listForUser("user-a"), []);
});

test("网络或服务端临时失败保留原队列等待重试", async () => {
  const row = createRow("10000000-0000-4000-8000-000000000001");
  const store = createMemoryStore([row]);
  await assert.rejects(
    deliverAnnotationToolAttemptQueueBatch({
      userId: "user-a",
      store,
      client: {
        async submitAnnotationToolAttempts() {
          throw new PlatformApiError(503, "unavailable", "暂不可用。", null);
        },
      },
    }),
    (error) => error instanceof PlatformApiError && error.status === 503,
  );
  assert.equal((await store.listForUser("user-a")).length, 1);
});

test("账号凭据失效后协调器停止自动忙重试并保留队列", async () => {
  const row = createRow("10000000-0000-4000-8000-000000000001");
  const store = createMemoryStore([row]);
  let requestCount = 0;
  let resolveRequest!: () => void;
  const requestObserved = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  const scheduledDelays: number[] = [];
  const coordinator = createAnnotationToolAttemptDeliveryCoordinator({
    userId: "user-a",
    store,
    eventTarget: null,
    setTimer(callback, delay) {
      void callback;
      scheduledDelays.push(delay);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    client: {
      async submitAnnotationToolAttempts() {
        requestCount += 1;
        resolveRequest();
        throw new PlatformApiError(401, "unauthorized", "登录已失效。", null);
      },
    },
  });
  coordinator.start();
  await requestObserved;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1);
  assert.deepEqual(scheduledDelays, []);
  assert.equal((await store.listForUser("user-a")).length, 1);
  coordinator.dispose();
});

function createMemoryStore(initial: QueuedAnnotationToolAttempt[]): AnnotationToolAttemptQueueStore {
  const rows = new Map(initial.map((row) => [row.key, structuredClone(row)]));
  return {
    async upsert() {
      throw new Error("本测试不调用 upsert。");
    },
    async listForUser(userId, limit = 100) {
      return [...rows.values()].filter((row) => row.userId === userId).slice(0, limit);
    },
    async deleteIfVersion(record) {
      const current = rows.get(record.key);
      if (!current || current.version !== record.version) return false;
      rows.delete(record.key);
      return true;
    },
    async close() {},
  };
}

function createRow(id: string): QueuedAnnotationToolAttempt {
  return {
    key: `user-a|${id}`,
    userId: "user-a",
    version: 1,
    updatedAt: 1,
    attempt: {
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
    },
  };
}

function toRecord(attempt: AnnotationToolAttemptState): AnnotationToolAttemptRecord {
  return {
    ...attempt,
    actorUserId: "user-a",
    outcome: attempt.outcome ?? null,
    committedRevision: null,
    createdAt: attempt.invokedAt,
    updatedAt: attempt.invokedAt,
  };
}
