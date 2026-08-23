import {
  RESOURCE_CAPABILITIES,
  type ResourceCapability,
  type ResourceType,
} from "@xiqu/shared";

// 极简权限只是一组前端预设，不进入 API、数据库或服务端有效权限计算。
export type ResourcePermissionPreset = "none" | "view" | "edit";
export type ResourcePermissionPresetMatch = ResourcePermissionPreset | "custom";

// 极简权限把普通访问级别与审核能力分开建模，避免把“可审核”误做成第四档互斥预设。
export type ResourceSimplePermissionSelection = {
  basePreset: ResourcePermissionPreset;
  canReview: boolean;
};

export type ResourceSimplePermissionMatch = {
  basePreset: ResourcePermissionPresetMatch;
  canReview: boolean;
};

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

// 编辑基础预设只覆盖内容与文件操作；审核由独立附加项控制，权限管理仍只留在详细模式。
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

// 媒体资源没有标注确认操作；其异常 review 授权仍留给详细模式处理，极简模式不制造无效能力。
export function supportsResourceReviewAddon(resourceType: ResourceType): boolean {
  return resourceType !== "media_file";
}

// 审核是正交附加项：先剥离 review，再精确识别基础预设；其他能力仍保持 custom，不能被静默裁剪。
export function classifyResourceSimplePermission(
  directCapabilities: readonly ResourceCapability[] | null | undefined,
  resourceType: ResourceType,
): ResourceSimplePermissionMatch {
  if (directCapabilities == null) {
    return { basePreset: "none", canReview: false };
  }
  const directCapabilitySet = new Set(directCapabilities);
  const canReview = directCapabilitySet.has("review");
  if (
    directCapabilitySet.size !== directCapabilities.length ||
    (canReview && !supportsResourceReviewAddon(resourceType))
  ) {
    return { basePreset: "custom", canReview };
  }
  const baseCapabilities = directCapabilities.filter((capability) => capability !== "review");
  if (baseCapabilities.length === 0) {
    return {
      basePreset: canReview ? "none" : "custom",
      canReview,
    };
  }
  if (haveSameResourceCapabilities(
    baseCapabilities,
    getResourcePermissionPresetCapabilities("view", resourceType),
  )) {
    return { basePreset: "view", canReview };
  }
  if (haveSameResourceCapabilities(
    baseCapabilities,
    getResourcePermissionPresetCapabilities("edit", resourceType),
  )) {
    return { basePreset: "edit", canReview };
  }
  return { basePreset: "custom", canReview };
}

// 保存前只在这一处组合基础权限与审核附加项，并按 shared 权威顺序输出稳定 capability 数组。
export function getResourceSimplePermissionCapabilities(
  selection: ResourceSimplePermissionSelection,
  resourceType: ResourceType,
): ResourceCapability[] {
  if (selection.canReview && !supportsResourceReviewAddon(resourceType)) {
    throw new Error("媒体资源不支持极简审核附加权限。");
  }
  const selected = new Set<ResourceCapability>(
    selection.basePreset === "none"
      ? []
      : getResourcePermissionPresetCapabilities(selection.basePreset, resourceType),
  );
  if (selection.canReview) selected.add("review");
  return RESOURCE_CAPABILITIES.filter((capability) => selected.has(capability));
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

// 移除已有审核能力不要求授权者自己拥有 review；只有新增审核能力时才需要通过委派门禁。
export function canDelegateResourceReviewChange(
  actorCapabilities: readonly ResourceCapability[],
  currentCanReview: boolean,
  nextCanReview: boolean,
): boolean {
  return !nextCanReview || currentCanReview || actorCapabilities.includes("review");
}

// capability 集合比较忽略顺序但拒绝重复或额外字段，确保 custom 授权不会误匹配标准预设。
export function haveSameResourceCapabilities(
  left: readonly ResourceCapability[],
  right: readonly ResourceCapability[],
): boolean {
  const leftSet = new Set(left);
  if (leftSet.size !== left.length || leftSet.size !== right.length) return false;
  return right.every((capability) => leftSet.has(capability));
}
