import assert from "node:assert/strict";
import test from "node:test";
import {
  parseApplyAlignmentRunRequest,
  parseCreateAlignmentRunRequest,
} from "../dist/index.js";

test("强制对齐创建请求只接受规范 UUID 与固定模型预设", () => {
  const input = {
    clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelPreset: "kunqu_character_v1",
  };
  assert.deepEqual(parseCreateAlignmentRunRequest(input), { success: true, data: input });
  assert.equal(parseCreateAlignmentRunRequest({ ...input, inputRevision: 7 }).success, false);
  assert.equal(parseCreateAlignmentRunRequest({ ...input, clientRequestId: "client-1" }).success, false);
  assert.equal(parseCreateAlignmentRunRequest({ ...input, modelPreset: "custom" }).success, false);
});

test("强制对齐应用请求只接受一次动作 UUID 与正 revision", () => {
  const input = {
    clientActionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    baseRevision: 7,
  };
  assert.deepEqual(parseApplyAlignmentRunRequest(input), { success: true, data: input });
  assert.equal(parseApplyAlignmentRunRequest({ ...input, runId: "server-owned" }).success, false);
  assert.equal(parseApplyAlignmentRunRequest({ ...input, clientActionId: "action-1" }).success, false);
  assert.equal(parseApplyAlignmentRunRequest({ ...input, baseRevision: 0 }).success, false);
  assert.equal(parseApplyAlignmentRunRequest({ ...input, baseRevision: 2_147_483_647 }).success, false);
});
