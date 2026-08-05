import type { PlatformRole, ResourceCapability } from "./platform.js";

// 平台角色策略集中在这一模块，避免账号治理、资源 ACL 和前端入口各自维护不同角色名单。
// 后续若加入 teacher/annotator 附属关系，应在服务端关系解析后复用这些能力边界，而不是散落角色判断。
const ACCOUNT_MANAGEMENT_ROLES = new Set<PlatformRole>(["super_admin"]);
const FULL_RESOURCE_ACCESS_ROLES = new Set<PlatformRole>([
  "super_admin",
  "admin",
]);
const GLOBAL_RESOURCE_BROWSE_ROLES = new Set<PlatformRole>(["teacher"]);

export const TEACHER_AUTOMATIC_RESOURCE_CAPABILITIES: readonly ResourceCapability[] = [
  "read",
  "download",
];

// 只有系统管理员可以创建、停用账号、调整平台角色或重置他人密码。
export function canManagePlatformAccounts(roles: readonly PlatformRole[]) {
  return roles.some((role) => ACCOUNT_MANAGEMENT_ROLES.has(role));
}

// 系统管理员和管理员都保留资源、运维、审计等全局管理能力。
export function hasFullPlatformResourceAccess(roles: readonly PlatformRole[]) {
  return roles.some((role) => FULL_RESOURCE_ACCESS_ROLES.has(role));
}

// 教师自动浏览全部资源，但自动能力不包含内容编辑、审核或权限管理。
export function getAutomaticResourceCapabilities(
  roles: readonly PlatformRole[],
): readonly ResourceCapability[] {
  return roles.some((role) => GLOBAL_RESOURCE_BROWSE_ROLES.has(role))
    ? TEACHER_AUTOMATIC_RESOURCE_CAPABILITIES
    : [];
}

// 账号目录属于只读平台信息；教师继承原助教的目录浏览能力，普通标注账号仍不可枚举用户。
export function canBrowseAccountDirectory(roles: readonly PlatformRole[]) {
  return hasFullPlatformResourceAccess(roles) ||
    roles.some((role) => GLOBAL_RESOURCE_BROWSE_ROLES.has(role));
}
