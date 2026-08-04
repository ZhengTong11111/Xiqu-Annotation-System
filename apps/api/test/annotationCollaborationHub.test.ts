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
