import {
  RESOURCE_CAPABILITIES,
  type ProjectWorkflowGroup,
  type ResourceCapability,
} from "./platform.js";

// 职责组贡献的是可撤销的有效权限来源，不写入或覆盖手工 ResourcePermission。
const PROJECT_WORKFLOW_CAPABILITIES: Record<
  ProjectWorkflowGroup,
  ReadonlySet<ResourceCapability>
> = {
  annotation: new Set([
    "read",
    "write",
    "create_child",
    "copy",
    "move",
    "delete",
    "download",
  ]),
  // 审核必须能读取正文和媒体；它不隐式获得编辑、文件操作或权限管理能力。
  review: new Set(["read", "review", "download"]),
};

/** 按 shared 权威顺序返回职责组贡献，前后端不得另写一份 capability 列表。 */
export function getProjectWorkflowGroupCapabilities(
  group: ProjectWorkflowGroup,
): ResourceCapability[] {
  const selected = PROJECT_WORKFLOW_CAPABILITIES[group];
  return RESOURCE_CAPABILITIES.filter((capability) => selected.has(capability));
}
