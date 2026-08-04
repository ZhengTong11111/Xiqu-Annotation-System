import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_COLLABORATION_PROTOCOL_VERSION,
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
