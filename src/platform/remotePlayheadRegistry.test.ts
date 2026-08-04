import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationRemotePlayheadMessage } from "@xiqu/shared";
import {
  applyRemotePlayheadMessage,
  buildRemotePlayheadView,
  pruneRemotePlayheadRegistry,
} from "./remotePlayheadRegistry";

const members = [{
  userId: "user-1",
  accountName: "student",
  displayName: "学生账号",
  connectionCount: 2,
  lastSeenAt: "2026-08-04T00:00:00.000Z",
}];

function message(
  activitySessionId: string,
  sequence: number,
  time: number | null,
): AnnotationRemotePlayheadMessage {
  return {
    version: 1,
    type: "presence.playhead.changed",
    annotationFileId: "file-1",
    activitySessionId,
    userId: "user-1",
    sequence,
    observedAt: "2026-08-04T00:00:00.000Z",
    playhead: time === null ? null : { time, playing: true },
  };
}

test("registry 拒绝倒退 sequence，并由 clear 删除连接活动", () => {
  let registry = applyRemotePlayheadMessage(new Map(), message("session-1", 2, 5), 100);
  registry = applyRemotePlayheadMessage(registry, message("session-1", 1, 9), 200);
  assert.equal(registry.get("session-1")?.time, 5);
  registry = applyRemotePlayheadMessage(registry, message("session-1", 3, null), 300);
  assert.equal(registry.size, 0);
});

test("同账号多窗口只展示最近活动，且过滤自己、离线成员与 stale 状态", () => {
  let registry = applyRemotePlayheadMessage(new Map(), message("session-a", 1, 2), 100);
  registry = applyRemotePlayheadMessage(registry, message("session-b", 1, 4), 200);
  assert.deepEqual(buildRemotePlayheadView(registry, members, null, 300).map((entry) => entry.time), [4]);
  assert.deepEqual(buildRemotePlayheadView(registry, members, "user-1", 300), []);
  assert.deepEqual(buildRemotePlayheadView(registry, [], null, 300), []);
  assert.equal(pruneRemotePlayheadRegistry(registry, 7_000).size, 0);
});
