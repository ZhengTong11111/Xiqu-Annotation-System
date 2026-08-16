import {
  RESOURCE_CAPABILITIES,
  type ResourceCapability,
  type ResourceType,
} from "@xiqu/shared";

// 极简权限只是一组前端预设，不进入 API、数据库或服务端有效权限计算。
export type ResourcePermissionPreset = "none" | "view" | "edit";
export type ResourcePermissionPresetMatch = ResourcePermissionPreset | "custom";

// 细粒度模式与只读摘要共用同一套中文能力名称，避免两个界面对同一 capability 使用不同文案。
export const RESOURCE_CAPABILITY_LABELS: Record<ResourceCapability, string> = {
  read: "查看",
  write: "编辑",
  review: "审核",
  create_child: "新建子项",
  copy: "复制",
  move: "移动",
  delete: "删除",
  download: "下载",
  manage_permissions: "管理权限",
};

// 查看预设必须同时允许读取和下载，保证上传媒体与 VOD 播放链路都能通过服务端门禁。
const VIEW_CAPABILITIES = new Set<ResourceCapability>([
  "read",
  "download",
]);

// 编辑预设覆盖内容与文件操作，但审核和权限管理始终留在详细模式中单独授予。
const EDIT_CAPABILITIES = new Set<ResourceCapability>([
  "read",
  "write",
  "copy",
  "move",
  "delete",
  "download",
]);

// 项目和文件夹可以容纳子资源，因此其编辑预设还需要创建子项能力。
function isContainerResourceType(resourceType: ResourceType): boolean {
  return resourceType === "folder" || resourceType === "project";
}

// 所有预设均按 shared capability 的权威顺序输出，避免请求、比较和界面各自维护数组顺序。
export function getResourcePermissionPresetCapabilities(
  preset: Exclude<ResourcePermissionPreset, "none">,
  resourceType: ResourceType,
): ResourceCapability[] {
  const selected = preset === "view"
    ? VIEW_CAPABILITIES
    : new Set<ResourceCapability>([
        ...EDIT_CAPABILITIES,
        ...(isContainerResourceType(resourceType) ? ["create_child" as const] : []),
      ]);
  return RESOURCE_CAPABILITIES.filter((capability) => selected.has(capability));
}

// 只有直接授权与预设完全相等时才归类；额外的审核或管理能力不能被极简界面静默吞掉。
export function classifyResourcePermissionPreset(
  directCapabilities: readonly ResourceCapability[] | null | undefined,
  resourceType: ResourceType,
): ResourcePermissionPresetMatch {
  if (directCapabilities == null) return "none";
  if (hasSameCapabilities(
    directCapabilities,
    getResourcePermissionPresetCapabilities("view", resourceType),
  )) {
    return "view";
  }
  if (hasSameCapabilities(
    directCapabilities,
    getResourcePermissionPresetCapabilities("edit", resourceType),
  )) {
    return "edit";
  }
  return "custom";
}

// 前端只提前禁用必然越权的预设；真正的委派范围仍由服务端在写入事务中重新验证。
export function canDelegateResourcePermissionPreset(
  actorCapabilities: readonly ResourceCapability[],
  preset: ResourcePermissionPreset,
  resourceType: ResourceType,
): boolean {
  if (preset === "none") return true;
  const actorCapabilitySet = new Set(actorCapabilities);
  return getResourcePermissionPresetCapabilities(preset, resourceType)
    .every((capability) => actorCapabilitySet.has(capability));
}

// capability 集合比较忽略顺序但拒绝重复或额外字段，确保 custom 授权不会误匹配标准预设。
function hasSameCapabilities(
  left: readonly ResourceCapability[],
  right: readonly ResourceCapability[],
): boolean {
  const leftSet = new Set(left);
  if (leftSet.size !== left.length || leftSet.size !== right.length) return false;
  return right.every((capability) => leftSet.has(capability));
}
