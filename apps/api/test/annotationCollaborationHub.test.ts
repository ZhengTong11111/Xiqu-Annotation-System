import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationCollaborationHub } from "../src/annotationCollaborationHub.js";

test("协作 hub 按文件隔离并拒绝倒退或重复 revision", () => {
  const hub = new AnnotationCollaborationHub();
  const left: number[] = [];
  const right: number[] = [];
  const unsubscribe = hub.subscribe("file-left", {
    send: (message) => left.push(message.revision),
    close: () => undefined,
  });
  hub.subscribe("file-right", {
    send: (message) => right.push(message.revision),
    close: () => undefined,
  });
  hub.publishRevisionAdvanced({
    annotationFileId: "file-left",
    revision: 2,
    operationCursor: "cursor-left-2",
  });
  hub.publishRevisionAdvanced({
    annotationFileId: "file-left",
    revision: 2,
    operationCursor: "duplicate",
  });
  hub.publishRevisionAdvanced({
    annotationFileId: "file-right",
    revision: 4,
    operationCursor: "cursor-right-4",
  });
  assert.deepEqual(left, [2]);
  assert.deepEqual(right, [4]);
  unsubscribe();
  hub.publishRevisionAdvanced({
    annotationFileId: "file-left",
    revision: 3,
    operationCursor: "cursor-left-3",
  });
  assert.deepEqual(left, [2]);
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
