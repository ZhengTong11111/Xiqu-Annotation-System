import {
  assessAnnotationLifecycleExecution,
  getAnnotationLifecycleTargetKey,
  parseAnnotationLifecycleCommandEnvelope,
  type AnnotationLifecycleActual,
  type AnnotationLifecycleCommandEnvelope,
  type AnnotationLifecyclePreconditionIssue,
} from "@xiqu/shared";
import type { ProjectData } from "./projectData.js";
import {
  applyAnnotationLifecycleItems,
  resolveProjectAnnotationLifecycleTarget,
} from "./annotationLifecycleCommand.js";

export type AnnotationLifecycleCommandApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked"; issues: AnnotationLifecyclePreconditionIssue[] }
  | { status: "applied"; project: ProjectData; envelope: AnnotationLifecycleCommandEnvelope };

// 生命周期 adapter 先解析所有父容器和目标状态；重复身份、缺父或任一冲突都阻断整批创建/删除。
export function applyAnnotationLifecycleCommandToProject(
  project: ProjectData,
  value: unknown,
): AnnotationLifecycleCommandApplyResult {
  const envelope = parseAnnotationLifecycleCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const actuals: AnnotationLifecycleActual[] = [];
  for (const item of envelope.command.items) {
    const resolved = resolveProjectAnnotationLifecycleTarget(project, item);
    if (resolved.ambiguous) {
      return {
        status: "blocked",
        issues: [{ code: "state_mismatch", targetKey: getAnnotationLifecycleTargetKey(item) }],
      };
    }
    actuals.push({
      entityType: item.entityType,
      entityId: item.entityId,
      trackId: item.trackId,
      parentExists: resolved.parentExists,
      current: adaptSentenceLifecycleActualForLegacyCommand(item, resolved.current),
    } as AnnotationLifecycleActual);
  }
  const assessment = assessAnnotationLifecycleExecution(envelope, actuals);
  if (assessment.status === "invalid_command") return assessment;
  if (assessment.status === "blocked") return { status: "blocked", issues: assessment.issues };
  const nextProject = applyAnnotationLifecycleItems(project, assessment.envelope.command.items);
  return nextProject
    ? { status: "applied", project: nextProject, envelope: assessment.envelope }
    : {
        status: "blocked",
        issues: assessment.envelope.command.items.map((item) => ({
          code: "state_mismatch" as const,
          targetKey: getAnnotationLifecycleTargetKey(item),
        })),
      };
}

// v6 删除命令的 before 使用单角色快照。只有当前句仍是零/单角色时才能无损投影并通过前置条件；
// 已变为多角色的句子必须保持不匹配，不能用 null 冒充旧状态后误删实体。
function adaptSentenceLifecycleActualForLegacyCommand(
  item: AnnotationLifecycleCommandEnvelope["command"]["items"][number],
  currentValue: unknown,
): AnnotationLifecycleActual["current"] {
  const current = currentValue as AnnotationLifecycleActual["current"];
  if (item.entityType !== "sentence" || !current) return current;
  const expected = item.before?.entity ?? item.after?.entity;
  if (!expected || !("roleType" in expected) || !("roleTypes" in current.entity)) return current;
  if (current.entity.roleTypes.length > 1) return current;
  const { roleTypes, ...common } = current.entity;
  return {
    ...current,
    entity: { ...common, roleType: roleTypes[0] ?? null },
  } as AnnotationLifecycleActual["current"];
}
