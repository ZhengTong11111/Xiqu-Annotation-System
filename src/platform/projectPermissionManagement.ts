import type {
  ResourceCapability,
  ResourcePermissionMatrixRow,
} from "@xiqu/shared";
import {
  classifyResourceSimplePermission,
  getResourceSimplePermissionCapabilities,
  haveSameResourceCapabilities,
  type ResourceSimplePermissionMatch,
  type ResourceSimplePermissionSelection,
} from "./resourcePermissionPresets";
import { describeSupplementalPermissionSources } from "./resourcePermissionSources";

export type ProjectPermissionSavePlan =
  | { kind: "noop"; requiresDetailedOverwrite: false }
  | { kind: "remove"; requiresDetailedOverwrite: boolean }
  | {
      kind: "upsert";
      capabilities: ResourceCapability[];
      inheritToChildren: true;
      requiresDetailedOverwrite: boolean;
    };

// 集中面板只拆解项目直接 ACL 的基础预设和审核附加项；最终有效权限仍完全来自服务端矩阵。
export function getProjectSimplePermissionMatch(
  row: ResourcePermissionMatrixRow,
): ResourceSimplePermissionMatch {
  return classifyResourceSimplePermission(
    row.directPermission?.capabilities,
    "project",
  );
}

// owner 与全局管理员不是普通直接 ACL，集中面板只能解释其完整权限，不能伪装成可降级选项。
export function getProjectPermissionLockReason(
  row: ResourcePermissionMatrixRow,
): string | null {
  if (row.effectivePermission.isOwner) return "项目所有者始终拥有完整权限。";
  if (row.effectivePermission.source === "admin") {
    return "全局管理员始终拥有完整资源权限，不能通过项目授权降低。";
  }
  return null;
}

// 删除直接 ACL 前解释仍会生效的角色和祖先来源，避免“不额外授权”被误读为显式拒绝。
export function getProjectPermissionResidualAccess(
  row: ResourcePermissionMatrixRow,
): string | null {
  const sources: string[] = [];
  if (row.user.roles.includes("teacher")) {
    sources.push("教师角色仍提供查看、播放与下载");
  }
  if (row.effectivePermission.inheritedFrom.length > 0) {
    const description = describeSupplementalPermissionSources(
      row.effectivePermission.inheritedFrom,
      true,
    );
    if (description) sources.push(description);
  }
  return sources.length > 0 ? sources.join("；") : null;
}

// 项目快速授权固定向子资源传递；custom 或旧的非传递设置必须经用户确认后才能被极简组合覆盖。
export function createProjectPermissionSavePlan(
  row: ResourcePermissionMatrixRow,
  selection: ResourceSimplePermissionSelection,
): ProjectPermissionSavePlan {
  const directPermission = row.directPermission ?? null;
  const currentMatch = getProjectSimplePermissionMatch(row);
  const requiresDetailedOverwrite = Boolean(
    directPermission && (
      currentMatch.basePreset === "custom" || !directPermission.inheritToChildren
    ),
  );
  const capabilities = getResourceSimplePermissionCapabilities(selection, "project");
  if (capabilities.length === 0) {
    return directPermission
      ? { kind: "remove", requiresDetailedOverwrite }
      : { kind: "noop", requiresDetailedOverwrite: false };
  }
  if (
    directPermission &&
    haveSameResourceCapabilities(directPermission.capabilities, capabilities) &&
    directPermission.inheritToChildren === true
  ) {
    return { kind: "noop", requiresDetailedOverwrite: false };
  }
  return {
    kind: "upsert",
    capabilities,
    inheritToChildren: true,
    requiresDetailedOverwrite,
  };
}
