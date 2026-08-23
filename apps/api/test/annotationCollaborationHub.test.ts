import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationCollaborationHub } from "../src/annotationCollaborationHub.js";

test("协作 hub 按文件隔离并拒绝倒退或重复 revision", () => {
  const hub = new AnnotationCollaborationHub();
  const left: number[] = [];
  const right: number[] = [];
  const unsubscribe = hub.subscribe("file-left", {
    send: (message) => {
      if (message.type === "annotation.revision.advanced") left.push(message.revision);
    },
    close: () => undefined,
  });
  hub.subscribe("file-right", {
    send: (message) => {
      if (message.type === "annotation.revision.advanced") right.push(message.revision);
    },
    close: () => undefined,
  });
  assert.equal(hub.deliverRevisionAdvanced({
    annotationFileId: "file-left",
    revision: 2,
    operationCursor: "cursor-left-2",
  }), "accepted");
  assert.equal(hub.deliverRevisionAdvanced({
    annotationFileId: "file-left",
    revision: 2,
    operationCursor: "duplicate",
  }), "duplicate");
  assert.equal(hub.deliverRevisionAdvanced({
    annotationFileId: "file-right",
    revision: 4,
    operationCursor: "cursor-right-4",
  }), "accepted");
  assert.deepEqual(left, [2]);
  assert.deepEqual(right, [4]);
  unsubscribe();
  hub.deliverRevisionAdvanced({
    annotationFileId: "file-left",
    revision: 3,
    operationCursor: "cursor-left-3",
  });
  assert.deepEqual(left, [2]);
});

test("协作 hub 按成员结构去重 presence 快照", () => {
  const hub = new AnnotationCollaborationHub();
  const snapshots: number[] = [];
  hub.subscribe("file-1", {
    send: (message) => {
      if (message.type === "presence.snapshot") snapshots.push(message.members.length);
    },
    close: () => undefined,
  });
  const members = [{
    userId: "user-1",
    accountName: "student",
    displayName: "学生账号",
    connectionCount: 1,
    lastSeenAt: "2026-08-04T00:00:00.000Z",
  }];
  assert.equal(hub.deliverPresenceSnapshot("file-1", members), "accepted");
  assert.equal(hub.deliverPresenceSnapshot("file-1", [{
    ...members[0]!,
    lastSeenAt: "2026-08-04T00:00:20.000Z",
  }]), "duplicate");
  assert.deepEqual(snapshots, [1]);
});

test("协作 hub 按事件标识投递审核失效提示且不携带正文", () => {
  const hub = new AnnotationCollaborationHub();
  const messages: unknown[] = [];
  hub.subscribe("file-1", {
    send: (message) => {
      if (message.type === "annotation.review.changed") messages.push(message);
    },
    close: () => undefined,
  });
  const event = {
    annotationFileId: "file-1",
    eventId: "event-1",
    occurredAt: "2026-08-22T00:00:00.000Z",
  };
  assert.equal(hub.deliverReviewChanged(event), "accepted");
  assert.equal(hub.deliverReviewChanged(event), "duplicate");
  assert.equal(hub.deliverReviewChanged({ ...event, eventId: "event-2" }), "accepted");
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => !JSON.stringify(message).includes("body")));
});

test("最后一个订阅者离开后，相同成员结构仍会发送给新会话", () => {
  const hub = new AnnotationCollaborationHub();
  const members = [{
    userId: "user-1",
    accountName: "student",
    displayName: "学生账号",
    connectionCount: 1,
    lastSeenAt: "2026-08-04T00:00:00.000Z",
  }];
  const first: string[] = [];
  const unsubscribe = hub.subscribe("file-1", {
    send: (message) => first.push(message.type),
    close: () => undefined,
  });
  assert.equal(hub.deliverPresenceSnapshot("file-1", members), "accepted");
  unsubscribe();

  const second: string[] = [];
  hub.subscribe("file-1", {
    send: (message) => second.push(message.type),
    close: () => undefined,
  });
  assert.equal(hub.deliverPresenceSnapshot("file-1", members), "accepted");
  assert.deepEqual(first, ["presence.snapshot"]);
  assert.deepEqual(second, ["presence.snapshot"]);
});

test("远端活动排除来源连接，并按 session sequence 拒绝乱序复活", () => {
  const hub = new AnnotationCollaborationHub();
  const source: string[] = [];
  const peer: Array<number | null> = [];
  hub.subscribe("file-1", {
    activitySessionId: "session-source",
    send: (message) => source.push(message.type),
    close: () => undefined,
  });
  hub.subscribe("file-1", {
    activitySessionId: "session-peer",
    send: (message) => {
      if (message.type === "presence.timeline_activity.changed") {
        peer.push(message.activity?.playhead?.time ?? null);
      }
    },
    close: () => undefined,
  });
  const base = {
    annotationFileId: "file-1",
    activitySessionId: "session-source",
    userId: "user-1",
    observedAt: "2026-08-04T00:00:00.000Z",
  };
  const activity = (time: number) => ({
    playhead: { time, playing: true },
    pointer: { time: time + 1 },
    selection: null,
  });
  assert.equal(hub.deliverRemoteActivity({ ...base, sequence: 1, activity: activity(3) }), "accepted");
  assert.equal(hub.deliverRemoteActivity({ ...base, sequence: 1, activity: activity(4) }), "duplicate");
  assert.equal(hub.deliverRemoteActivity({ ...base, sequence: 2, activity: null }), "accepted");
  assert.equal(hub.deliverRemoteActivity({ ...base, sequence: 1, activity: activity(5) }), "duplicate");
  assert.deepEqual(source, []);
  assert.deepEqual(peer, [3, null]);
});

test("协作 hub 关闭时清理全部订阅者", () => {
  const hub = new AnnotationCollaborationHub();
  const closes: Array<[number, string]> = [];
  hub.subscribe("file-1", {
    send: () => undefined,
    close: (code, reason) => closes.push([code, reason]),
  });
  hub.closeAll();
  assert.deepEqual(closes, [[1001, "server_shutdown"]]);
});
