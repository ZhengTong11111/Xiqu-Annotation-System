import assert from "node:assert/strict";
import test from "node:test";
import { createAnnotationRemoteActivityRateLimiter } from "../src/annotationRemoteActivityRateLimiter.js";
import {
  parseSerializedAnnotationRemoteActivityEventEnvelope,
  serializeAnnotationRemoteActivityEventEnvelope,
} from "../src/annotationRemoteActivityEventEnvelope.js";
import { PostgresAnnotationRemoteActivityEventBus } from "../src/postgresAnnotationRemoteActivityEventBus.js";
import type { PostgresEventTransport } from "../src/postgresCoalescedEventBus.js";

test("远端活动 envelope 严格往返且不接受额外身份字段", () => {
  const event = {
    annotationFileId: "file-1",
    activitySessionId: "session-1",
    userId: "user-1",
    sequence: 4,
    observedAt: "2026-08-04T00:00:00.000Z",
    playhead: { time: 12.5, playing: true },
  };
  assert.deepEqual(
    parseSerializedAnnotationRemoteActivityEventEnvelope(
      serializeAnnotationRemoteActivityEventEnvelope("instance-1", event),
    ),
    event,
  );
  const polluted = JSON.stringify({
    sourceInstanceId: "instance-1",
    message: {
      version: 1,
      type: "presence.playhead.changed",
      ...event,
      displayName: "不应传输",
    },
  });
  assert.equal(parseSerializedAnnotationRemoteActivityEventEnvelope(polluted), null);
  assert.equal(parseSerializedAnnotationRemoteActivityEventEnvelope("not-json"), null);
});

test("连接级令牌桶允许短 burst 并限制持续高频帧", () => {
  const limiter = createAnnotationRemoteActivityRateLimiter({ ratePerSecond: 8, burst: 2 });
  assert.equal(limiter.accept(0), true);
  assert.equal(limiter.accept(0), true);
  assert.equal(limiter.accept(0), false);
  assert.equal(limiter.accept(124), false);
  assert.equal(limiter.accept(125), true);
  assert.equal(limiter.accept(250), true);
});

test("活动总线本机先投递，并按文件与连接合并待发帧", async () => {
  let releaseFirstNotify!: () => void;
  const firstNotifyGate = new Promise<void>((resolve) => {
    releaseFirstNotify = resolve;
  });
  const notifications: string[] = [];
  let notifyCount = 0;
  const transport: PostgresEventTransport = {
    async openListener() {
      return { close: async () => undefined };
    },
    async notify(_channel, payload) {
      notifyCount += 1;
      notifications.push(payload);
      if (notifyCount === 1) await firstNotifyGate;
    },
  };
  const delivered: number[] = [];
  const noOp = () => undefined;
  const bus = new PostgresAnnotationRemoteActivityEventBus({
    transport,
    channel: "xiqu_annotation_activity_test",
    instanceId: "instance-test",
    deliver: (event) => {
      delivered.push(event.sequence);
      return "accepted";
    },
    observability: {
      setAnnotationRemoteActivityBusConnected: noOp,
      setAnnotationRemoteActivityBusPendingSessions: noOp,
      recordAnnotationRemoteActivityBusPublish: noOp,
      recordAnnotationRemoteActivityBusInbound: noOp,
      recordAnnotationRemoteActivityBusReconnect: noOp,
    },
    logger: { error: noOp },
  });
  await bus.start();
  const base = {
    annotationFileId: "file-1",
    activitySessionId: "session-1",
    userId: "user-1",
    observedAt: "2026-08-04T00:00:00.000Z",
    playhead: { time: 1, playing: true },
  };
  bus.publishRemoteActivity({ ...base, sequence: 1 });
  bus.publishRemoteActivity({ ...base, sequence: 2 });
  bus.publishRemoteActivity({ ...base, sequence: 3 });
  assert.deepEqual(delivered, [1, 2, 3]);
  releaseFirstNotify();
  await waitFor(() => notifications.length === 2);
  assert.equal(parseSerializedAnnotationRemoteActivityEventEnvelope(notifications[1])?.sequence, 3);
  await bus.close();
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待活动总线测试条件超时。");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
