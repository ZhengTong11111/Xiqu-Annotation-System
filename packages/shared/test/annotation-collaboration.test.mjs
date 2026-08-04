import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
  parseAnnotationCollaborationClientMessage,
  parseAnnotationCollaborationServerMessage,
} from "../dist/annotationCollaboration.js";

const ready = {
  version: ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
  type: "session.ready",
  annotationFileId: "annotation-file-1",
  revision: 3,
  operationCursor: "cursor-3",
  heartbeatIntervalMs: 20_000,
};

test("解析严格的协作会话与 revision 通知", () => {
  assert.deepEqual(parseAnnotationCollaborationServerMessage(ready), ready);
  const advanced = {
    version: 1,
    type: "annotation.revision.advanced",
    annotationFileId: "annotation-file-1",
    revision: 4,
    operationCursor: "cursor-4",
  };
  assert.deepEqual(parseAnnotationCollaborationServerMessage(advanced), advanced);
  const presence = {
    version: 1,
    type: "presence.snapshot",
    annotationFileId: "annotation-file-1",
    generatedAt: "2026-08-04T00:00:00.000Z",
    members: [{
      userId: "user-1",
      accountName: "student",
      displayName: "学生账号",
      connectionCount: 2,
      lastSeenAt: "2026-08-04T00:00:00.000Z",
    }],
  };
  assert.deepEqual(parseAnnotationCollaborationServerMessage(presence), presence);
});

test("严格解析播放头、鼠标与选区的完整活动快照", () => {
  const update = {
    version: 1,
    type: "presence.timeline_activity.update",
    sequence: 3,
    activity: {
      playhead: { time: 12.345, playing: true },
      pointer: { time: 13 },
      selection: { start: 10, end: 14, itemCount: 3, laneCount: 2, kinds: ["character", "action"] },
    },
  };
  assert.deepEqual(parseAnnotationCollaborationClientMessage(update), update);
  const changed = {
    version: 1,
    type: "presence.timeline_activity.changed",
    annotationFileId: "annotation-file-1",
    activitySessionId: "activity-session-1",
    userId: "user-1",
    sequence: 3,
    observedAt: "2026-08-04T00:00:00.000Z",
    activity: update.activity,
  };
  assert.deepEqual(parseAnnotationCollaborationServerMessage(changed), changed);
  assert.deepEqual(parseAnnotationCollaborationServerMessage({ ...changed, activity: null }), {
    ...changed,
    activity: null,
  });
});

test("拒绝损坏、泄漏字段或越界的活动消息", () => {
  const update = {
    version: 1,
    type: "presence.timeline_activity.update",
    sequence: 1,
    activity: {
      playhead: { time: 1, playing: false },
      pointer: null,
      selection: null,
    },
  };
  for (const value of [
    { ...update, sequence: 0 },
    { ...update, sequence: 1.5 },
    { ...update, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...update, activity: { ...update.activity, playhead: { time: -1, playing: false } } },
    { ...update, activity: { playhead: null, pointer: null, selection: null } },
    { ...update, activity: { ...update.activity, pointer: { time: 1, x: 2 } } },
    { ...update, activity: { ...update.activity, selection: { start: 2, end: 1, itemCount: 1, laneCount: 1, kinds: ["character"] } } },
    { ...update, activity: { ...update.activity, selection: { start: 1, end: 2, itemCount: 1, laneCount: 1, kinds: ["action", "character"] } } },
    { ...update, activity: { ...update.activity, selection: { start: 1, end: 2, itemCount: 1, laneCount: 1, kinds: ["character", "character"] } } },
    { ...update, extra: true },
  ]) assert.equal(parseAnnotationCollaborationClientMessage(value), null);

  const changed = {
    version: 1,
    type: "presence.timeline_activity.changed",
    annotationFileId: "file-1",
    activitySessionId: "session-1",
    userId: "user-1",
    sequence: 1,
    observedAt: "2026-08-04T00:00:00.000Z",
    activity: update.activity,
  };
  for (const value of [
    { ...changed, activitySessionId: "" },
    { ...changed, sequence: 0 },
    { ...changed, observedAt: "bad" },
    { ...changed, activity: { ...update.activity, playhead: { time: -1, playing: false } } },
    { ...changed, activity: { ...update.activity, playhead: { time: 1, playing: false, extra: true } } },
  ]) assert.equal(parseAnnotationCollaborationServerMessage(value), null);
});

test("拒绝未知版本、额外字段和损坏的同步位置", () => {
  const validMember = {
    userId: "user-1",
    accountName: "student",
    displayName: "学生账号",
    connectionCount: 1,
    lastSeenAt: "2026-08-04T00:00:00.000Z",
  };
  const invalid = [
    null,
    [],
    { ...ready, version: 2 },
    { ...ready, type: "presence.changed" },
    { ...ready, unexpected: true },
    { ...ready, annotationFileId: "" },
    { ...ready, revision: 0 },
    { ...ready, operationCursor: "" },
    { ...ready, heartbeatIntervalMs: 100 },
    {
      version: 1,
      type: "annotation.revision.advanced",
      annotationFileId: "annotation-file-1",
      revision: -1,
      operationCursor: "cursor",
    },
    {
      version: 1,
      type: "presence.snapshot",
      annotationFileId: "annotation-file-1",
      generatedAt: "not-a-time",
      members: [],
    },
    {
      version: 1,
      type: "presence.snapshot",
      annotationFileId: "annotation-file-1",
      generatedAt: "2026-08-04T00:00:00.000Z",
      members: [
        validMember,
        validMember,
      ],
    },
    {
      version: 1,
      type: "presence.snapshot",
      annotationFileId: "annotation-file-1",
      generatedAt: "2026-08-04T00:00:00.000Z",
      members: [{ ...validMember, connectionCount: 0 }],
    },
    {
      version: 1,
      type: "presence.snapshot",
      annotationFileId: "annotation-file-1",
      generatedAt: "2026-08-04T00:00:00.000Z",
      members: [{ ...validMember, unexpected: true }],
    },
    {
      version: 1,
      type: "presence.snapshot",
      annotationFileId: "annotation-file-1",
      generatedAt: "2026-08-04T00:00:00.000Z",
      members: Array.from({ length: 201 }, (_, index) => ({
        ...validMember,
        userId: `user-${index}`,
      })),
    },
  ];
  for (const value of invalid) {
    assert.equal(parseAnnotationCollaborationServerMessage(value), null);
  }
});
