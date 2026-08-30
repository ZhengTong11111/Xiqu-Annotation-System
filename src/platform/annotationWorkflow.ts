import {
  getAnnotationWorkflowTransition,
  type AnnotationWorkflowStatus,
  type ResourceCapability,
  type ResourceEntry,
  type UserReference,
} from "@xiqu/shared";

export const ANNOTATION_WORKFLOW_STATUS_OPTIONS: ReadonlyArray<{
  value: AnnotationWorkflowStatus;
  label: string;
}> = [
  { value: "unannotated", label: "未标注" },
  { value: "annotated", label: "已标注" },
  { value: "reviewed", label: "已审核" },
];

export function annotationWorkflowStatusLabel(
  status: AnnotationWorkflowStatus | null | undefined,
): string {
  return ANNOTATION_WORKFLOW_STATUS_OPTIONS.find(({ value }) => value === status)
    ?.label ?? "未标注";
}

export function getAnnotationWorkflowCommandState(
  current: AnnotationWorkflowStatus,
  target: AnnotationWorkflowStatus,
  capabilities: ResourceCapability[],
): "current" | "allowed" | "forbidden" | "blocked_order" {
  const transition = getAnnotationWorkflowTransition(current, target);
  if (transition.kind === "unchanged") return "current";
  if (transition.kind === "invalid_order") return "blocked_order";
  return capabilities.includes(transition.requiredCapability)
    ? "allowed"
    : "forbidden";
}

export function resourceWorkflowStatus(
  resource: ResourceEntry,
): AnnotationWorkflowStatus | null {
  if (resource.type !== "annotation_file" && resource.type !== "project") return null;
  if (resource.workflowStatus === null) return null;
  return resource.workflowStatus ?? "unannotated";
}

/** 项目显示人工维护的标注负责人；其他资源的 owner 在资源浏览器中表达为创建人。 */
export function resourceResponsibleOrCreatorLabel(resource: ResourceEntry): string {
  if (resource.type !== "project") return resource.owner.displayName;
  return formatResponsibles(resource.annotationResponsibles ?? []);
}

/** 搜索、最近和收藏可能混合项目与文件，表头必须同时说明两种账号字段的语义。 */
export function resourceResponsibleOrCreatorColumnLabel(
  resources: ReadonlyArray<Pick<ResourceEntry, "type">>,
): "负责人" | "创建人" | "负责人 / 创建人" {
  const hasProject = resources.some(({ type }) => type === "project");
  const hasOtherResource = resources.some(({ type }) => type !== "project");
  if (hasProject && hasOtherResource) return "负责人 / 创建人";
  return hasProject ? "负责人" : "创建人";
}

export function formatResponsibles(users: UserReference[]): string {
  if (!users.length) return "—";
  const names = users.map(({ displayName }) => displayName);
  if (names.length <= 3) return names.join("、");
  return `${names.slice(0, 3).join("、")} 等 ${names.length} 人`;
}
