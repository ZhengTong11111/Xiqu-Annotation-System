import assert from "node:assert/strict";
import test from "node:test";
import {
  canDelegateResourcePermissionPreset,
  classifyResourcePermissionPreset,
  getResourcePermissionPresetCapabilities,
} from "./resourcePermissionPresets";

// 查看预设必须同时提供媒体播放所需的读取与下载能力。
test("查看预设固定为 read 和 download", () => {
  assert.deepEqual(
    getResourcePermissionPresetCapabilities("view", "annotation_file"),
    ["read", "download"],
  );
});

// 容器允许新建子项，叶文件不携带没有操作语义的 create_child。
test("编辑预设按资源类型决定是否包含 create_child", () => {
  assert.deepEqual(
    getResourcePermissionPresetCapabilities("edit", "project"),
    ["read", "write", "create_child", "copy", "move", "delete", "download"],
  );
  assert.deepEqual(
    getResourcePermissionPresetCapabilities("edit", "media_file"),
    ["read", "write", "copy", "move", "delete", "download"],
  );
});

// 审核和权限管理保持正交，不能借“可编辑”预设自动发放。
test("编辑预设永远排除 review 和 manage_permissions", () => {
  for (const resourceType of ["folder", "project", "annotation_file", "media_file"] as const) {
    const capabilities = getResourcePermissionPresetCapabilities("edit", resourceType);
    assert.equal(capabilities.includes("review"), false);
    assert.equal(capabilities.includes("manage_permissions"), false);
  }
});

// 预设识别忽略数组顺序，但任何额外、缺失或重复能力都保留为 custom。
test("直接授权只有精确匹配时才识别为标准预设", () => {
  assert.equal(classifyResourcePermissionPreset(null, "project"), "none");
  assert.equal(
    classifyResourcePermissionPreset(["download", "read"], "project"),
    "view",
  );
  assert.equal(classifyResourcePermissionPreset(["read"], "project"), "custom");
  assert.equal(
    classifyResourcePermissionPreset(["read", "download", "review"], "project"),
    "custom",
  );
  assert.equal(
    classifyResourcePermissionPreset(["read", "download", "manage_permissions"], "project"),
    "custom",
  );
  assert.equal(
    classifyResourcePermissionPreset(["read", "read", "download"], "project"),
    "custom",
  );
  assert.equal(classifyResourcePermissionPreset([], "project"), "custom");
});

// 普通权限管理员只能发放自己具备的完整预设，不能由前端悄悄裁剪能力。
test("预设委派要求操作账号拥有全部目标能力", () => {
  const fullEdit = getResourcePermissionPresetCapabilities("edit", "project");
  assert.equal(
    canDelegateResourcePermissionPreset(fullEdit, "edit", "project"),
    true,
  );
  assert.equal(
    canDelegateResourcePermissionPreset(
      fullEdit.filter((capability) => capability !== "delete"),
      "edit",
      "project",
    ),
    false,
  );
  assert.equal(
    canDelegateResourcePermissionPreset([], "none", "project"),
    true,
  );
});
