import type {
  ResourceCapability,
  ResourcePermissionMatrixRow,
} from "@xiqu/shared";
import {
  classifyResourcePermissionPreset,
  getResourcePermissionPresetCapabilities,
  type ResourcePermissionPreset,
  type ResourcePermissionPresetMatch,
} from "./resourcePermissionPresets";

export type ProjectPermissionSavePlan =
  | { kind: "noop"; requiresDetailedOverwrite: false }
  | { kind: "remove"; requiresDetailedOverwrite: boolean }
  | {
      kind: "upsert";
      capabilities: ResourceCapability[];
      inheritToChildren: true;
      requiresDetailedOverwrite: boolean;
    };

// 集中面板只读取项目直接 ACL 的三档匹配；最终有效权限仍完全来自服务端矩阵。
export function getProjectPermissionPresetMatch(
  row: ResourcePermissionMatrixRow,
): ResourcePermissionPresetMatch {
  return classifyResourcePermissionPreset(
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
    sources.push(`仍继承自：${row.effectivePermission.inheritedFrom
      .map((item) => item.resourceName)
      .join("、")}`);
  }
  return sources.length > 0 ? sources.join("；") : null;
}

// 项目快速授权固定向子资源传递；custom 或旧的非传递设置必须经用户确认后才能被三档预设覆盖。
export function createProjectPermissionSavePlan(
  row: ResourcePermissionMatrixRow,
  preset: ResourcePermissionPreset,
): ProjectPermissionSavePlan {
  const directPermission = row.directPermission ?? null;
  const currentMatch = getProjectPermissionPresetMatch(row);
  const requiresDetailedOverwrite = Boolean(
    directPermission && (
      currentMatch === "custom" || !directPermission.inheritToChildren
    ),
  );
  if (preset === "none") {
    return directPermission
      ? { kind: "remove", requiresDetailedOverwrite }
      : { kind: "noop", requiresDetailedOverwrite: false };
  }
  const capabilities = getResourcePermissionPresetCapabilities(preset, "project");
  if (
    currentMatch === preset &&
    directPermission?.inheritToChildren === true
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
