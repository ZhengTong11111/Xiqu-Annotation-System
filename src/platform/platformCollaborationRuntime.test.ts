import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlatformCollaborationRuntime,
  type PlatformCollaborationFacts,
  type PlatformCollaborationSocket,
  type PlatformCollaborationStatus,
} from "./platformCollaborationRuntime";

class FakeClock {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.now + delayMs, callback });
    return id;
  };

  clearTimer = (id: number) => {
    this.tasks.delete(id);
  };

  async advanceBy(durationMs: number) {
    const target = this.now + durationMs;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.now = next[1].dueAt;
      next[1].callback();
      await flushPromises();
    }
    this.now = target;
    await flushPromises();
  }
}

type FakeEventMap = {
  open: Event;
  message: { data: unknown };
  close: { code: number };
  error: Event;
};

class FakeSocket implements PlatformCollaborationSocket {
  readonly listeners = new Map<keyof FakeEventMap, Array<(event: never) => void>>();
  closed: { code?: number; reason?: string } | null = null;
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  addEventListener<TType extends keyof FakeEventMap>(
    type: TType,
    listener: (event: FakeEventMap[TType]) => void,
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event: never) => void);
    this.listeners.set(type, listeners);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  send(data: string) {
    this.sent.push(data);
  }

  emit<TType extends keyof FakeEventMap>(type: TType, event: FakeEventMap[TType]) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

const FACTS: PlatformCollaborationFacts = {
  enabled: true,
  online: true,
  sessionKey: "file-1",
};

function createHarness(options: { permanentTicketError?: boolean } = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const statuses: PlatformCollaborationStatus[] = [];
  const messages: string[] = [];
  const errors: unknown[] = [];
  let ticketRequests = 0;
  const runtime = createPlatformCollaborationRuntime({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
    now: () => clock.now,
    requestTicket: async () => {
      ticketRequests += 1;
      if (options.permanentTicketError) throw Object.assign(new Error("forbidden"), { permanent: true });
      return {
        ticket: `ticket-${ticketRequests}`,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        websocketPath: "/api/ws",
      };
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    isPermanentTicketError: (error) =>
      Boolean(error && typeof error === "object" && "permanent" in error),
    onStatusChange: (status) => statuses.push(status),
    onMessage: (message) => messages.push(message.type),
    onError: (error) => errors.push(error),
  });
  return {
    clock,
    runtime,
    sockets,
    statuses,
    messages,
    errors,
    getTicketRequests: () => ticketRequests,
  };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function readyMessage(fileId = "file-1", revision = 1) {
  return JSON.stringify({
    version: 1,
    type: "session.ready",
    annotationFileId: fileId,
    revision,
    operationCursor: `cursor-${revision}`,
    heartbeatIntervalMs: 20_000,
  });
}

function presenceMessage(fileId = "file-1") {
  return JSON.stringify({
    version: 1,
    type: "presence.snapshot",
    annotationFileId: fileId,
    generatedAt: "2026-08-04T00:00:00.000Z",
    members: [{
      userId: "user-1",
      accountName: "student",
      displayName: "学生账号",
      connectionCount: 1,
      lastSeenAt: "2026-08-04T00:00:00.000Z",
    }],
  });
}

test("取得一次性票据后等待 session.ready 才进入 connected", async () => {
  const harness = createHarness();
  harness.runtime.update(FACTS);
  await flushPromises();
  assert.equal(harness.getTicketRequests(), 1);
  assert.equal(harness.sockets.length, 1);
  harness.sockets[0].emit("open", new Event("open"));
  assert.equal(last(harness.statuses), "connecting");
  harness.sockets[0].emit("message", { data: readyMessage() });
  assert.equal(last(harness.statuses), "connected");
  assert.deepEqual(harness.messages, ["session.ready"]);
  harness.runtime.dispose();
});

test("session.ready 后接收 presence，提前到达则按协议失败", async () => {
  const accepted = createHarness();
  accepted.runtime.update(FACTS);
  await flushPromises();
  accepted.sockets[0].emit("open", new Event("open"));
  accepted.sockets[0].emit("message", { data: readyMessage() });
  accepted.sockets[0].emit("message", { data: presenceMessage() });
  assert.deepEqual(accepted.messages, ["session.ready", "presence.snapshot"]);

  const rejected = createHarness();
  rejected.runtime.update(FACTS);
  await flushPromises();
  rejected.sockets[0].emit("open", new Event("open"));
  rejected.sockets[0].emit("message", { data: presenceMessage() });
  assert.equal(rejected.sockets[0].closed?.code, 4400);
  assert.equal(last(rejected.statuses), "error");
  accepted.runtime.dispose();
  rejected.runtime.dispose();
});

test("播放头在 ready 后首发，并以 8Hz trailing 合并和 keepalive 续期", async () => {
  const harness = createHarness();
  harness.runtime.update(FACTS);
  harness.runtime.updatePlayhead({ time: 1, playing: false });
  await flushPromises();
  const socket = harness.sockets[0];
  assert.deepEqual(socket.sent, []);
  socket.emit("open", new Event("open"));
  socket.emit("message", { data: readyMessage() });
  assert.equal(JSON.parse(socket.sent[0]!).activity.playhead.time, 1);

  harness.runtime.updatePlayhead({ time: 2, playing: true });
  harness.runtime.updatePlayhead({ time: 3, playing: true });
  await harness.clock.advanceBy(124);
  assert.equal(socket.sent.length, 1);
  await harness.clock.advanceBy(1);
  assert.equal(JSON.parse(socket.sent[1]!).activity.playhead.time, 3);
  await harness.clock.advanceBy(2_000);
  assert.equal(JSON.parse(socket.sent[socket.sent.length - 1]!).activity.playhead.time, 3);
  harness.runtime.dispose();
});

test("发送缓冲过高时丢弃过期帧，恢复后发送最新候选", async () => {
  const harness = createHarness();
  harness.runtime.update(FACTS);
  await flushPromises();
  const socket = harness.sockets[0];
  socket.emit("open", new Event("open"));
  socket.emit("message", { data: readyMessage() });
  socket.bufferedAmount = 300 * 1_024;
  harness.runtime.updatePlayhead({ time: 4, playing: false });
  await harness.clock.advanceBy(0);
  assert.equal(socket.sent.length, 0);
  socket.bufferedAmount = 0;
  harness.runtime.updatePlayhead({ time: 5, playing: false });
  await harness.clock.advanceBy(0);
  assert.equal(JSON.parse(socket.sent[0]!).activity.playhead.time, 5);
  harness.runtime.dispose();
});

test("播放头、鼠标与选区在同一发送窗口合并为完整 activity 快照", async () => {
  const harness = createHarness();
  harness.runtime.update(FACTS);
  harness.runtime.updatePlayhead({ time: 1, playing: true });
  harness.runtime.updatePointer({ time: 2 });
  harness.runtime.updateSelection({
    start: 1,
    end: 3,
    itemCount: 2,
    laneCount: 1,
    kinds: ["character"],
  });
  await flushPromises();
  const socket = harness.sockets[0];
  socket.emit("open", new Event("open"));
  socket.emit("message", { data: readyMessage() });
  assert.deepEqual(JSON.parse(socket.sent[0]!).activity, {
    playhead: { time: 1, playing: true },
    pointer: { time: 2 },
    selection: { start: 1, end: 3, itemCount: 2, laneCount: 1, kinds: ["character"] },
  });
  harness.runtime.updatePointer(null);
  harness.runtime.updateSelection(null);
  await harness.clock.advanceBy(125);
  assert.deepEqual(JSON.parse(socket.sent[1]!).activity, {
    playhead: { time: 1, playing: true },
    pointer: null,
    selection: null,
  });
  harness.runtime.dispose();
});

test("异常关闭使用退避和新票据重连，永久票据错误停止重试", async () => {
  const harness = createHarness();
  harness.runtime.update(FACTS);
  await flushPromises();
  harness.sockets[0].emit("open", new Event("open"));
  harness.sockets[0].emit("message", { data: readyMessage() });
  harness.sockets[0].emit("close", { code: 1006 });
  assert.equal(last(harness.statuses), "reconnecting");
  await harness.clock.advanceBy(1_000);
  assert.equal(harness.getTicketRequests(), 2);

  const denied = createHarness({ permanentTicketError: true });
  denied.runtime.update(FACTS);
  await flushPromises();
  assert.equal(last(denied.statuses), "error");
  denied.runtime.update(FACTS);
  await flushPromises();
  await denied.clock.advanceBy(60_000);
  assert.equal(denied.getTicketRequests(), 1);
  harness.runtime.dispose();
  denied.runtime.dispose();
});

test("认证失效关闭当前会话后停止重连", async () => {
  const harness = createHarness();
  harness.runtime.update(FACTS);
  await flushPromises();
  harness.sockets[0].emit("open", new Event("open"));
  harness.sockets[0].emit("message", { data: readyMessage() });
  harness.sockets[0].emit("close", { code: 4401 });
  assert.equal(last(harness.statuses), "error");
  await harness.clock.advanceBy(60_000);
  assert.equal(harness.getTicketRequests(), 1);
  harness.runtime.dispose();
});

test("文件切换关闭旧 socket，旧文件迟到消息不能进入新会话", async () => {
  const harness = createHarness();
  harness.runtime.update(FACTS);
  await flushPromises();
  const oldSocket = harness.sockets[0];
  harness.runtime.updatePlayhead({ time: 11, playing: true });
  harness.runtime.updatePointer({ time: 12 });
  harness.runtime.updateSelection({
    start: 10,
    end: 13,
    itemCount: 2,
    laneCount: 1,
    kinds: ["action"],
  });
  harness.runtime.update({ ...FACTS, sessionKey: "file-2" });
  await flushPromises();
  assert.equal(oldSocket.closed?.reason, "session_replaced");
  oldSocket.emit("message", { data: readyMessage("file-1") });
  assert.deepEqual(harness.messages, []);
  const current = harness.sockets[1];
  current.emit("open", new Event("open"));
  current.emit("message", { data: readyMessage("file-2") });
  assert.equal(last(harness.statuses), "connected");
  // 新文件尚未上报自身状态时保持空白，不能把旧文件的瞬时活动发送出去。
  assert.deepEqual(current.sent, []);
  harness.runtime.dispose();
});

test("非法服务消息 fail closed，离线与 dispose 不保留重连", async () => {
  const harness = createHarness();
  harness.runtime.update(FACTS);
  await flushPromises();
  const socket = harness.sockets[0];
  socket.emit("open", new Event("open"));
  socket.emit("message", { data: "not-json" });
  assert.equal(socket.closed?.code, 4400);
  assert.equal(last(harness.statuses), "error");
  assert.equal(harness.errors.length, 1);
  harness.runtime.update({ ...FACTS, online: false });
  assert.equal(last(harness.statuses), "offline");
  harness.runtime.dispose();
  await harness.clock.advanceBy(60_000);
  assert.equal(harness.getTicketRequests(), 1);
});

function last<T>(values: T[]) {
  return values[values.length - 1];
}
