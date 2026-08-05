import assert from "node:assert/strict";
import test from "node:test";
import {
  canBrowseAccountDirectory,
  canManagePlatformAccounts,
  getAutomaticResourceCapabilities,
  hasFullPlatformResourceAccess,
} from "@xiqu/shared";

// 角色策略回归锁定三条独立边界，防止以后再次把账号治理和资源管理合并成一个管理员判断。
test("系统管理员独占账号治理，管理员保留资源全权", () => {
  assert.equal(canManagePlatformAccounts(["super_admin"]), true);
  assert.equal(canManagePlatformAccounts(["admin"]), false);
  assert.equal(hasFullPlatformResourceAccess(["super_admin"]), true);
  assert.equal(hasFullPlatformResourceAccess(["admin"]), true);
});

test("教师只自动获得全局浏览能力并可浏览账号目录", () => {
  assert.deepEqual(getAutomaticResourceCapabilities(["teacher"]), [
    "read",
    "download",
  ]);
  assert.equal(canBrowseAccountDirectory(["teacher"]), true);
  assert.equal(canManagePlatformAccounts(["teacher"]), false);
  assert.equal(hasFullPlatformResourceAccess(["teacher"]), false);
});

test("普通业务角色不会凭角色名称自动取得资源能力", () => {
  assert.deepEqual(
    getAutomaticResourceCapabilities(["annotator", "reviewer", "service"]),
    [],
  );
  assert.equal(canBrowseAccountDirectory(["annotator"]), false);
});
