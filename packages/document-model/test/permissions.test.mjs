import assert from "node:assert/strict";
import test from "node:test";
import {
  canGrantCapabilities,
  isPermissionGrantActive,
  normalizeCapabilities,
  resolveResourcePermission,
} from "../dist/index.js";

const grant = (overrides = {}) => ({
  resourceId: "project-1",
  resourceName: "项目一",
  capabilities: ["read"],
  inheritToChildren: true,
  expiresAt: null,
  ...overrides,
});

test("管理员与所有者始终拥有完整资源权限", () => {
  const admin = resolveResourcePermission({ isAdmin: true });
  const owner = resolveResourcePermission({ isOwner: true });
  // 完整权限不再依赖易过期的固定数量；管理员、所有者必须拥有同一能力集并包含独立审核能力。
  assert.deepEqual(owner.capabilities, admin.capabilities);
  assert.ok(admin.capabilities.includes("review"));
  assert.equal(owner.isOwner, true);
  assert.equal(owner.canManagePermissions, true);
});

test("直接权限与祖先继承权限按稳定顺序合并", () => {
  const permission = resolveResourcePermission({
    directGrant: grant({ capabilities: ["write"] }),
    inheritedGrants: [
      grant({ capabilities: ["read", "copy"] }),
      grant({
        resourceId: "folder-2",
        resourceName: "子目录",
        capabilities: ["download"],
      }),
    ],
  });
  assert.deepEqual(permission.capabilities, [
    "read",
    "write",
    "copy",
    "download",
  ]);
  assert.equal(permission.source, "direct");
  assert.equal(permission.inheritedFrom.length, 2);
});

test("不向子级继承和已过期的授权不会进入有效权限", () => {
  const now = Date.now();
  const permission = resolveResourcePermission({
    inheritedGrants: [
      grant({ inheritToChildren: false, capabilities: ["write"] }),
      grant({
        expiresAt: new Date(now - 1000).toISOString(),
        capabilities: ["copy"],
      }),
      grant({
        expiresAt: new Date(now + 1000).toISOString(),
        capabilities: ["read"],
      }),
    ],
    now,
  });
  assert.deepEqual(permission.capabilities, ["read"]);
  assert.equal(isPermissionGrantActive({
    expiresAt: new Date(now - 1).toISOString(),
  }, now), false);
});

test("能力归一化去重并使用共享目录顺序", () => {
  assert.deepEqual(
    normalizeCapabilities(["copy", "read", "copy", "delete"]),
    ["read", "copy", "delete"],
  );
});

test("非管理员不能授予自己不具备的能力", () => {
  const actor = resolveResourcePermission({
    directGrant: grant({ capabilities: ["read", "write"] }),
  });
  assert.equal(canGrantCapabilities(actor, ["read"]), true);
  assert.equal(canGrantCapabilities(actor, ["delete"]), false);
  assert.equal(canGrantCapabilities(actor, ["delete"], true), true);
});
