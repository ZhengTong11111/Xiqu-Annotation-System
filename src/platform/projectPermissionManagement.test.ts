import assert from "node:assert/strict";
import test from "node:test";
import type { ResourcePermissionMatrixRow } from "@xiqu/shared";
import {
  createProjectPermissionSavePlan,
  getProjectPermissionLockReason,
  getProjectPermissionPresetMatch,
  getProjectPermissionResidualAccess,
} from "./projectPermissionManagement";

function createRow(
  overrides: Partial<ResourcePermissionMatrixRow> = {},
): ResourcePermissionMatrixRow {
  return {
    user: {
      id: "user-1",
      accountName: "student",
      displayName: "学生",
      roles: ["annotator"],
    },
    directPermission: null,
    effectivePermission: {
      source: "none",
      capabilities: [],
      inheritedFrom: [],
      isOwner: false,
      canManagePermissions: false,
    },
    ...overrides,
  };
}

function createDirectPermission(
  capabilities: ResourcePermissionMatrixRow["effectivePermission"]["capabilities"],
  inheritToChildren = true,
) {
  return {
    id: "permission-1",
    resourceId: "project-1",
    user: createRow().user,
    capabilities,
    inheritToChildren,
    expiresAt: null,
    createdBy: {
      id: "admin-1",
      accountName: "admin",
      displayName: "管理员",
    },
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

test("无直接 ACL 的不额外授权是 no-op，不能生成空 capability PUT", () => {
  assert.deepEqual(createProjectPermissionSavePlan(createRow(), "none"), {
    kind: "noop",
    requiresDetailedOverwrite: false,
  });
});

test("项目查看和编辑预设固定向子资源传递", () => {
  assert.deepEqual(createProjectPermissionSavePlan(createRow(), "view"), {
    kind: "upsert",
    capabilities: ["read", "download"],
    inheritToChildren: true,
    requiresDetailedOverwrite: false,
  });
  const edit = createProjectPermissionSavePlan(createRow(), "edit");
  assert.equal(edit.kind, "upsert");
  if (edit.kind === "upsert") {
    assert.equal(edit.inheritToChildren, true);
    assert.equal(edit.capabilities.includes("create_child"), true);
    assert.equal(edit.capabilities.includes("review"), false);
    assert.equal(edit.capabilities.includes("manage_permissions"), false);
  }
});

test("custom 与不向下传递的详细设置必须确认后覆盖", () => {
  const custom = createRow({
    directPermission: createDirectPermission(["read", "download", "review"]),
  });
  assert.equal(getProjectPermissionPresetMatch(custom), "custom");
  assert.equal(
    createProjectPermissionSavePlan(custom, "view").requiresDetailedOverwrite,
    true,
  );
  const localOnly = createRow({
    directPermission: createDirectPermission(["read", "download"], false),
  });
  assert.equal(
    createProjectPermissionSavePlan(localOnly, "view").requiresDetailedOverwrite,
    true,
  );
});

test("owner 与全局管理员返回稳定锁定原因", () => {
  assert.match(getProjectPermissionLockReason(createRow({
    effectivePermission: {
      source: "owner",
      capabilities: [],
      inheritedFrom: [],
      isOwner: true,
      canManagePermissions: true,
    },
  })) ?? "", /所有者/);
  assert.match(getProjectPermissionLockReason(createRow({
    effectivePermission: {
      source: "admin",
      capabilities: [],
      inheritedFrom: [],
      isOwner: false,
      canManagePermissions: true,
    },
  })) ?? "", /全局管理员/);
});

test("教师与祖先继承在删除直接 ACL 后仍有准确提示", () => {
  const row = createRow({
    user: { ...createRow().user, roles: ["teacher"] },
    effectivePermission: {
      source: "inherited",
      capabilities: ["read", "download"],
      inheritedFrom: [{
        resourceId: "parent-1",
        resourceName: "课程总目录",
        capabilities: ["read"],
      }],
      isOwner: false,
      canManagePermissions: false,
    },
  });
  assert.equal(
    getProjectPermissionResidualAccess(row),
    "教师角色仍提供查看、播放与下载；仍继承自：课程总目录",
  );
});
