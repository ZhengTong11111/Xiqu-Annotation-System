import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveResourcePermission } from "@xiqu/shared";
import { describeSupplementalPermissionSources } from "./resourcePermissionSources";

test("权限来源摘要区分职责组和普通祖先 ACL", () => {
  const origins: EffectiveResourcePermission["inheritedFrom"] = [
    {
      resourceId: "project",
      resourceName: "寻梦项目",
      capabilities: ["read", "write"],
      responsibilityGroup: "annotation",
    },
    {
      resourceId: "folder",
      resourceName: "课程目录",
      capabilities: ["read"],
    },
  ];
  assert.equal(
    describeSupplementalPermissionSources(origins),
    "职责组：寻梦项目（标注组）；继承自：课程目录",
  );
  assert.equal(
    describeSupplementalPermissionSources(origins, true),
    "职责组仍提供：寻梦项目（标注组）；仍继承自：课程目录",
  );
});
