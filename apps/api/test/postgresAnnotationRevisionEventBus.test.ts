import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresAnnotationRevisionEventBus,
  type AnnotationRevisionEventTransport,
} from "../src/postgresAnnotationRevisionEventBus.js";
import { serializeAnnotationRevisionEventEnvelope } from "../src/annotationRevisionEventEnvelope.js";

type ListenerHandlers = Parameters<AnnotationRevisionEventTransport["openListener"]>[1];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function createHarness(options: {
  blockFirstNotify?: boolean;
  failFirstNotify?: boolean;
  failFirstOpen?: boolean;
  rejectFirstClose?: boolean;
  maxPendingFiles?: number;
} = {}) {
  const listeners: ListenerHandlers[] = [];
  const closedListeners: number[] = [];
  const notifications: Array<{ channel: string; payload: string }> = [];
  const firstNotify = deferred();
  let notifyCalls = 0;
  let openCalls = 0;
  const transport: AnnotationRevisionEventTransport = {
    async openListener(_channel, handlers) {
      openCalls += 1;
      if (options.failFirstOpen && openCalls === 1) {
        throw new Error("LISTEN unavailable");
      }
      const index = listeners.push(handlers) - 1;
      return {
        async close() {
          closedListeners.push(index);
          if (options.rejectFirstClose && index === 0) {
            throw new Error("listener close failed");
          }
        },
      };
    },
    async notify(channel, payload) {
      notifications.push({ channel, payload });
      notifyCalls += 1;
      if (options.blockFirstNotify && notifyCalls === 1) await firstNotify.promise;
      if (options.failFirstNotify && notifyCalls === 1) throw new Error("notify failed");
    },
  };
  const metricEvents: string[] = [];
  const delivered: number[] = [];
  const timers: Array<() => void> = [];
  const bus = new PostgresAnnotationRevisionEventBus({
    transport,
    channel: "xiqu_annotation_revision_test",
    instanceId: "instance-test",
    maxPendingFiles: options.maxPendingFiles,
    deliver: (event) => {
      if (delivered.includes(event.revision)) return "duplicate";
      delivered.push(event.revision);
      return "accepted";
    },
    observability: {
      setAnnotationRevisionBusConnected: (connected) => metricEvents.push(`connected:${connected}`),
      setAnnotationRevisionBusPendingFiles: (count) => metricEvents.push(`pending:${count}`),
      recordAnnotationRevisionBusPublish: (result) => metricEvents.push(`publish:${result}`),
      recordAnnotationRevisionBusInbound: (result) => metricEvents.push(`inbound:${result}`),
      recordAnnotationRevisionBusReconnect: () => metricEvents.push("reconnect"),
    },
    logger: { error: () => undefined },
    setTimer: (callback) => {
      timers.push(callback);
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
    random: () => 0.5,
  });
  return {
    bus,
    listeners,
    closedListeners,
    notifications,
    firstNotify,
    metricEvents,
    delivered,
    timers,
    getOpenCalls: () => openCalls,
  };
}

test("event bus 本机先投递，并合并同文件待发 revision", async () => {
  const harness = createHarness({ blockFirstNotify: true });
  await harness.bus.start();
  harness.bus.publishRevisionAdvanced({
    annotationFileId: "file-a",
    revision: 1,
    operationCursor: "cursor-1",
  });
  harness.bus.publishRevisionAdvanced({
    annotationFileId: "file-a",
    revision: 2,
    operationCursor: "cursor-2",
  });
  harness.bus.publishRevisionAdvanced({
    annotationFileId: "file-a",
    revision: 3,
    operationCursor: "cursor-3",
  });
  assert.deepEqual(harness.delivered, [1, 2, 3]);
  assert.ok(harness.metricEvents.includes("publish:coalesced"));
  harness.firstNotify.resolve();
  await waitFor(() => harness.notifications.length === 2);
  const second = JSON.parse(harness.notifications[1]!.payload) as { revision: number };
  assert.equal(second.revision, 3);
  await harness.bus.close();
});

test("event bus 严格处理入站消息并在 listener 故障后重连", async () => {
  const harness = createHarness();
  await harness.bus.start();
  assert.equal(harness.listeners.length, 1);
  harness.listeners[0]!.onNotification("bad-json");
  harness.listeners[0]!.onNotification(serializeAnnotationRevisionEventEnvelope("other", {
    annotationFileId: "file-a",
    revision: 4,
    operationCursor: "cursor-4",
  }));
  assert.deepEqual(harness.delivered, [4]);
  assert.ok(harness.metricEvents.includes("inbound:invalid"));

  harness.listeners[0]!.onError(new Error("connection lost"));
  await waitFor(() => harness.timers.length === 1);
  harness.timers[0]!();
  await waitFor(() => harness.listeners.length === 2);
  assert.ok(harness.metricEvents.includes("reconnect"));
  assert.deepEqual(harness.closedListeners, [0]);
  await harness.bus.close();
  assert.deepEqual(harness.closedListeners, [0, 1]);
});

test("event bus 初次 LISTEN 失败会阻止启动且可由调用方重新尝试", async () => {
  const harness = createHarness({ failFirstOpen: true });
  // 初始连接失败不能悄悄进入降级运行，否则部署会误以为跨实例通知已经可用。
  await assert.rejects(harness.bus.start(), /LISTEN unavailable/);
  assert.equal(harness.timers.length, 0);
  await harness.bus.start();
  assert.equal(harness.getOpenCalls(), 2);
  assert.equal(harness.listeners.length, 1);
  await harness.bus.close();
});

test("event bus 回收坏 listener 失败时仍会继续重连", async () => {
  const harness = createHarness({ rejectFirstClose: true });
  await harness.bus.start();
  // close rejection 只能被记录，不能吞掉 finally 中的重连调度。
  harness.listeners[0]!.onError(new Error("connection lost"));
  await waitFor(() => harness.timers.length === 1);
  harness.timers[0]!();
  await waitFor(() => harness.listeners.length === 2);
  await harness.bus.close();
  assert.deepEqual(harness.closedListeners, [0, 1]);
});

test("event bus 队列达到上限时丢弃旧文件提示而不阻断发布者", async () => {
  const harness = createHarness({ blockFirstNotify: true, maxPendingFiles: 1 });
  await harness.bus.start();
  harness.bus.publishRevisionAdvanced({
    annotationFileId: "file-a",
    revision: 1,
    operationCursor: "cursor-a",
  });
  harness.bus.publishRevisionAdvanced({
    annotationFileId: "file-b",
    revision: 1,
    operationCursor: "cursor-b",
  });
  harness.bus.publishRevisionAdvanced({
    annotationFileId: "file-c",
    revision: 1,
    operationCursor: "cursor-c",
  });
  assert.ok(harness.metricEvents.includes("publish:dropped"));
  harness.firstNotify.resolve();
  await waitFor(() => harness.notifications.length === 2);
  const second = JSON.parse(harness.notifications[1]!.payload) as { annotationFileId: string };
  assert.equal(second.annotationFileId, "file-c");
  await harness.bus.close();
});

test("event bus 的 PostgreSQL 发布失败只记录降级而不反向抛给保存调用方", async () => {
  const harness = createHarness({ failFirstNotify: true });
  await harness.bus.start();
  assert.doesNotThrow(() => harness.bus.publishRevisionAdvanced({
    annotationFileId: "file-a",
    revision: 1,
    operationCursor: "cursor-a",
  }));
  await waitFor(() => harness.metricEvents.includes("publish:failed"));
  assert.deepEqual(harness.delivered, [1]);
  await harness.bus.close();
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 event bus 测试条件超时。");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
