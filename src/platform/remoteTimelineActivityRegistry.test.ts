import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationRemoteTimelineActivityMessage } from "@xiqu/shared";
import {
  applyRemoteTimelineActivityMessage,
  buildRemoteTimelineActivityView,
  pruneRemoteTimelineActivityRegistry,
} from "./remoteTimelineActivityRegistry";

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
): AnnotationRemoteTimelineActivityMessage {
  return {
    version: 1,
    type: "presence.timeline_activity.changed",
    annotationFileId: "file-1",
    activitySessionId,
    userId: "user-1",
    sequence,
    observedAt: "2026-08-04T00:00:00.000Z",
    activity: time === null ? null : {
      playhead: { time, playing: true },
      pointer: { time: time + 1 },
      selection: { start: time, end: time + 2, itemCount: 2, laneCount: 1, kinds: ["character"] },
    },
  };
}

test("activity registry 拒绝倒退 sequence，并由 clear 删除连接状态", () => {
  let registry = applyRemoteTimelineActivityMessage(new Map(), message("session-1", 2, 5), 100);
  registry = applyRemoteTimelineActivityMessage(registry, message("session-1", 1, 9), 200);
  assert.equal(registry.get("session-1")?.activity.playhead?.time, 5);
  registry = applyRemoteTimelineActivityMessage(registry, message("session-1", 3, null), 300);
  assert.equal(registry.size, 0);
});

test("同账号多窗口只展示最近完整快照，并过滤自己、离线成员与 stale 状态", () => {
  let registry = applyRemoteTimelineActivityMessage(new Map(), message("session-a", 1, 2), 100);
  registry = applyRemoteTimelineActivityMessage(registry, message("session-b", 1, 4), 200);
  assert.deepEqual(
    buildRemoteTimelineActivityView(registry, members, null, 300)
      .map((entry) => entry.activity.playhead?.time),
    [4],
  );
  assert.deepEqual(buildRemoteTimelineActivityView(registry, members, "user-1", 300), []);
  assert.deepEqual(buildRemoteTimelineActivityView(registry, [], null, 300), []);
  assert.equal(pruneRemoteTimelineActivityRegistry(registry, 7_000).size, 0);
});
