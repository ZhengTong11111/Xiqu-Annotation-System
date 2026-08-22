import type { PlatformRole } from "@xiqu/shared";

// 平台角色中文名称由账号治理和权限管理共同使用，避免同一角色在两个管理窗口出现不同文案。
export const PLATFORM_ROLE_OPTIONS: ReadonlyArray<{
  role: PlatformRole;
  label: string;
}> = [
  { role: "super_admin", label: "系统管理员" },
  { role: "admin", label: "管理员" },
  { role: "teacher", label: "教师" },
  { role: "annotator", label: "标注员" },
  { role: "reviewer", label: "审核员" },
  { role: "service", label: "服务账号" },
];

const PLATFORM_ROLE_LABELS = new Map(
  PLATFORM_ROLE_OPTIONS.map(({ role, label }) => [role, label]),
);

export function formatPlatformRoleLabels(roles: readonly PlatformRole[]): string {
  return roles.map((role) => PLATFORM_ROLE_LABELS.get(role) ?? role).join("、") || "无角色";
}
