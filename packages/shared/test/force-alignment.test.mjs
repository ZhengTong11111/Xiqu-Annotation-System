import assert from "node:assert/strict";
import test from "node:test";
import { parseCreateAlignmentRunRequest } from "../dist/index.js";

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
