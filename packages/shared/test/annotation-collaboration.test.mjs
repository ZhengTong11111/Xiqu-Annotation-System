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
});

test("拒绝未知版本、额外字段和损坏的同步位置", () => {
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
  ];
  for (const value of invalid) {
    assert.equal(parseAnnotationCollaborationServerMessage(value), null);
  }
});
