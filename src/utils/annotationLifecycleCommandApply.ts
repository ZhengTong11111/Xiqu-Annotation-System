import {
  assessAnnotationLifecycleExecution,
  parseAnnotationLifecycleCommandEnvelope,
  type AnnotationLifecycleActual,
  type AnnotationLifecycleCommandEnvelope,
  type AnnotationLifecyclePreconditionIssue,
} from "@xiqu/shared";
import type { ProjectData } from "../types";
import {
  applyAnnotationLifecycleItems,
  resolveProjectAnnotationLifecycleTarget,
} from "./annotationLifecycleCommand";

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
        issues: [{ code: "state_mismatch", targetKey: `${item.entityType}:${item.trackId}:${item.entityId}` }],
      };
    }
    actuals.push({
      entityType: item.entityType,
      entityId: item.entityId,
      trackId: item.trackId,
      parentExists: resolved.parentExists,
      current: resolved.current,
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
          targetKey: `${item.entityType}:${item.trackId}:${item.entityId}`,
        })),
      };
}
