import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceBreadcrumb, ResourceEntry } from "@xiqu/shared";
import {
  buildResourceColumnPath,
  createRootResourceColumn,
  getColumnLocationParentId,
  getColumnPathSelection,
  getValidResourceColumnPathLength,
  truncateResourceColumnPath,
  updateResourceColumnPath,
} from "./resourceColumnModel.js";

const project = resource("project-a", "project");
const folder = resource("folder-a", "folder");
const annotation = resource("annotation-a", "annotation_file");

test("分栏从当前虚拟入口建立唯一根列", () => {
  assert.deepEqual(createRootResourceColumn("favorites"), {
    key: "root:favorites",
    parentId: null,
    view: "favorites",
    openedByResourceId: null,
  });
});

test("容器选择追加 children 列，文件选择截断旧路径", () => {
  const root = [createRootResourceColumn("all_projects")];
  const projectPath = updateResourceColumnPath(root, 0, project);
  const folderPath = updateResourceColumnPath(projectPath, 1, folder);
  assert.deepEqual(folderPath.map(({ key }) => key), [
    "root:all_projects",
    "children:project-a",
    "children:folder-a",
  ]);
  assert.deepEqual(
    updateResourceColumnPath(folderPath, 1, annotation).map(({ key }) => key),
    ["root:all_projects", "children:project-a"],
  );
});

test("上游容器换选会丢弃右侧失效路径", () => {
  const original = buildResourceColumnPath("all_projects", [
    breadcrumb("project-a", null, "project"),
    breadcrumb("folder-a", "project-a", "folder"),
  ]);
  const replacement = resource("project-b", "project");
  const next = updateResourceColumnPath(original, 0, replacement);
  assert.deepEqual(next.map(({ key }) => key), [
    "root:all_projects",
    "children:project-b",
  ]);
});

test("面包屑恢复多级路径并保留虚拟根 view", () => {
  const columns = buildResourceColumnPath("recent", [
    breadcrumb("project-a", null, "project"),
    breadcrumb("folder-a", "project-a", "folder"),
  ]);
  assert.equal(columns[0]?.view, "recent");
  assert.equal(getColumnPathSelection(columns, 0), "project-a");
  assert.equal(getColumnPathSelection(columns, 1), "folder-a");
  assert.equal(getColumnLocationParentId(columns), "folder-a");
});

test("截断与当前位置解析不会产生幽灵列", () => {
  const columns = buildResourceColumnPath("all_projects", [
    breadcrumb("project-a", null, "project"),
    breadcrumb("folder-a", "project-a", "folder"),
  ]);
  const truncated = truncateResourceColumnPath(columns, 0);
  assert.deepEqual(truncated, [createRootResourceColumn("all_projects")]);
  assert.equal(getColumnLocationParentId(truncated), null);
});

test("刷新后只在上游容器确实消失时截断路径", () => {
  const columns = buildResourceColumnPath("all_projects", [
    breadcrumb("project-a", null, "project"),
    breadcrumb("folder-a", "project-a", "folder"),
  ]);
  assert.equal(getValidResourceColumnPathLength(columns, {
    "root:all_projects": [project],
    "children:project-a": [],
  }, new Set()), 2);
});

test("上游列临时读取失败时保留已有路径", () => {
  const columns = buildResourceColumnPath("all_projects", [
    breadcrumb("project-a", null, "project"),
    breadcrumb("folder-a", "project-a", "folder"),
  ]);
  assert.equal(getValidResourceColumnPathLength(columns, {
    "root:all_projects": [project],
    "children:project-a": [],
  }, new Set(["children:project-a"])), columns.length);
});

// 分页列尚未穷尽时，当前首批找不到路径容器并不能证明容器已经不存在。
test("上游列仍有后续页时保留尚未加载的路径", () => {
  const columns = buildResourceColumnPath("all_projects", [
    breadcrumb("project-a", null, "project"),
    breadcrumb("folder-a", "project-a", "folder"),
  ]);
  assert.equal(getValidResourceColumnPathLength(columns, {
    "root:all_projects": [project],
    "children:project-a": [],
  }, new Set(), new Set(["children:project-a"])), columns.length);
});

function resource(
  id: string,
  type: ResourceEntry["type"],
): ResourceEntry {
  return {
    id,
    parentId: null,
    type,
    name: id,
    owner: { id: "owner", accountName: "owner", displayName: "Owner" },
    breakPermissionInheritance: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    childCount: 0,
    favorite: false,
    permission: {
      source: "owner",
      capabilities: [],
      inheritedFrom: [],
      isOwner: true,
      canManagePermissions: true,
    },
  };
}

function breadcrumb(
  id: string,
  parentId: string | null,
  type: ResourceBreadcrumb["type"],
): ResourceBreadcrumb {
  return { id, parentId, type, name: id };
}
