import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceEntry } from "@xiqu/shared";
import { getComparableAnnotationFiles } from "./resourceComparison";

// 测试资源只保留比较资格所需字段，避免测试数据掩盖选择顺序与权限规则。
function resource(
  id: string,
  type: ResourceEntry["type"] = "annotation_file",
  capabilities: ResourceEntry["permission"]["capabilities"] = ["read"],
): ResourceEntry {
  return {
    id,
    parentId: null,
    type,
    name: `${id}.json`,
    owner: { id: "owner", accountName: "owner", displayName: "所有者" },
    breakPermissionInheritance: false,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    childCount: 0,
    favorite: false,
    permission: {
      source: "direct",
      capabilities,
      inheritedFrom: [],
      isOwner: false,
      canManagePermissions: false,
    },
  };
}

// 左右顺序必须跟随 selectedIds，而不是当前资源数组的排序。
test("比较文件保留用户选择顺序", () => {
  const first = resource("first");
  const second = resource("second");
  const result = getComparableAnnotationFiles(
    ["second", "first"],
    [first, second],
    { isTrashView: false, interactionDisabled: false },
  );
  assert.deepEqual(result?.map(({ id }) => id), ["second", "first"]);
});

// 数量、类型、读取权限和当前交互上下文任一不满足时都应 fail closed。
test("比较资格拒绝不完整或不可读选择", () => {
  const readable = resource("readable");
  const unreadable = resource("unreadable", "annotation_file", []);
  const folder = resource("folder", "folder");
  const options = { isTrashView: false, interactionDisabled: false };
  assert.equal(getComparableAnnotationFiles(["readable"], [readable], options), null);
  assert.equal(
    getComparableAnnotationFiles(
      ["readable", "folder"],
      [readable, folder],
      options,
    ),
    null,
  );
  assert.equal(
    getComparableAnnotationFiles(
      ["readable", "unreadable"],
      [readable, unreadable],
      options,
    ),
    null,
  );
  assert.equal(
    getComparableAnnotationFiles(
      ["readable", "unreadable"],
      [readable, unreadable],
      { isTrashView: true, interactionDisabled: false },
    ),
    null,
  );
});
