import assert from "node:assert/strict";
import test from "node:test";
import {
  canDelegateResourcePermissionPreset,
  canDelegateResourceReviewChange,
  classifyResourceSimplePermission,
  getResourcePermissionPresetCapabilities,
  getResourceSimplePermissionCapabilities,
  supportsResourceReviewAddon,
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

// 审核和权限管理保持正交，不能借“可编辑”基础预设自动发放。
test("编辑基础预设永远排除 review 和 manage_permissions", () => {
  for (const resourceType of ["folder", "project", "annotation_file", "media_file"] as const) {
    const capabilities = getResourcePermissionPresetCapabilities("edit", resourceType);
    assert.equal(capabilities.includes("review"), false);
    assert.equal(capabilities.includes("manage_permissions"), false);
  }
});

// 六种标准组合共用同一个稳定组合器，审核只增加 review 且不改变基础预设。
test("基础权限与审核附加项按权威顺序组合", () => {
  assert.deepEqual(
    getResourceSimplePermissionCapabilities({ basePreset: "none", canReview: false }, "project"),
    [],
  );
  assert.deepEqual(
    getResourceSimplePermissionCapabilities({ basePreset: "none", canReview: true }, "project"),
    ["review"],
  );
  assert.deepEqual(
    getResourceSimplePermissionCapabilities({ basePreset: "view", canReview: true }, "project"),
    ["read", "review", "download"],
  );
  assert.deepEqual(
    getResourceSimplePermissionCapabilities({ basePreset: "edit", canReview: true }, "project"),
    ["read", "write", "review", "create_child", "copy", "move", "delete", "download"],
  );
});

// 识别时只把 review 视为可表达附加项；其余额外、缺失或重复能力继续保留为 custom。
test("直接授权可无损识别基础权限与审核附加项", () => {
  assert.deepEqual(classifyResourceSimplePermission(null, "project"), {
    basePreset: "none",
    canReview: false,
  });
  assert.deepEqual(classifyResourceSimplePermission(["review"], "project"), {
    basePreset: "none",
    canReview: true,
  });
  assert.deepEqual(
    classifyResourceSimplePermission(["download", "review", "read"], "project"),
    { basePreset: "view", canReview: true },
  );
  assert.deepEqual(
    classifyResourceSimplePermission([
      "read", "write", "review", "create_child", "copy", "move", "delete", "download",
    ], "project"),
    { basePreset: "edit", canReview: true },
  );
  assert.equal(classifyResourceSimplePermission(["read"], "project").basePreset, "custom");
  assert.equal(
    classifyResourceSimplePermission(["read", "download", "manage_permissions"], "project").basePreset,
    "custom",
  );
  assert.equal(
    classifyResourceSimplePermission(["read", "read", "download"], "project").basePreset,
    "custom",
  );
  assert.equal(classifyResourceSimplePermission([], "project").basePreset, "custom");
});

// 媒体没有标注确认操作，异常 review ACL 必须进入详细模式而不是被极简模式重新保存。
test("媒体文件不开放审核附加项", () => {
  assert.equal(supportsResourceReviewAddon("media_file"), false);
  assert.equal(supportsResourceReviewAddon("annotation_file"), true);
  assert.equal(
    classifyResourceSimplePermission(["read", "review", "download"], "media_file").basePreset,
    "custom",
  );
  assert.throws(
    () => getResourceSimplePermissionCapabilities(
      { basePreset: "view", canReview: true },
      "media_file",
    ),
    /不支持/,
  );
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

// 权限管理员可以移除别人已有的 review，但新增 review 必须自己具备该能力。
test("审核附加项只在新增时要求 review 委派能力", () => {
  assert.equal(canDelegateResourceReviewChange([], false, true), false);
  assert.equal(canDelegateResourceReviewChange(["review"], false, true), true);
  assert.equal(canDelegateResourceReviewChange([], true, false), true);
  assert.equal(canDelegateResourceReviewChange([], true, true), true);
});
