import assert from "node:assert/strict";
import test from "node:test";
import { getProjectWorkflowGroupCapabilities } from "../dist/index.js";

test("标注职责组贡献完整编辑预设但不包含审核和权限管理", () => {
  assert.deepEqual(getProjectWorkflowGroupCapabilities("annotation"), [
    "read",
    "write",
    "create_child",
    "copy",
    "move",
    "delete",
    "download",
  ]);
});

test("审核职责组只贡献可用的查看下载与审核能力", () => {
  assert.deepEqual(getProjectWorkflowGroupCapabilities("review"), [
    "read",
    "review",
    "download",
  ]);
});
