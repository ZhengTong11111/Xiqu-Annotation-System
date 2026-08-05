import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResourceSelection } from "../src/resourceSelection.js";

const nodes = [
  { id: "root-a", parentId: null },
  { id: "child-a", parentId: "root-a" },
  { id: "grandchild-a", parentId: "child-a" },
  { id: "root-b", parentId: null },
];

test("资源选择去重并把已选祖先的后代折叠", () => {
  assert.deepEqual(
    normalizeResourceSelection(
      ["grandchild-a", "root-a", "child-a", "root-a"],
      nodes,
    ),
    {
      rootIds: ["root-a"],
      collapsedDescendantIds: ["grandchild-a", "child-a"],
    },
  );
});

test("无关子树保持多个逻辑根且不依赖输入顺序", () => {
  assert.deepEqual(
    normalizeResourceSelection(["root-b", "child-a"], nodes),
    {
      rootIds: ["root-b", "child-a"],
      collapsedDescendantIds: [],
    },
  );
});

test("缺少祖先记录时不会误折叠无关资源", () => {
  assert.deepEqual(
    normalizeResourceSelection(
      ["orphan", "root-b"],
      [{ id: "orphan", parentId: "missing" }, ...nodes],
    ),
    {
      rootIds: ["orphan", "root-b"],
      collapsedDescendantIds: [],
    },
  );
});
