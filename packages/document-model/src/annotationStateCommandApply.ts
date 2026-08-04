import {
  assessAnnotationStateExecution,
  getAnnotationStateTargetKey,
  parseAnnotationStateCommandEnvelope,
  type AnnotationStateActual,
  type AnnotationStateCommandEnvelope,
  type AnnotationStatePreconditionIssue,
} from "@xiqu/shared";
import type { ProjectData } from "./projectData.js";
import {
  applyAnnotationStateItems,
  resolveProjectAnnotationState,
  type AnnotationStateTarget,
} from "./annotationStateCommand.js";

export type AnnotationStateCommandApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked"; issues: AnnotationStatePreconditionIssue[] }
  | { status: "applied"; project: ProjectData; envelope: AnnotationStateCommandEnvelope };

// adapter 在写入前一次性核对全部完整 before，任一冲突都不会产生局部复合状态。
export function applyAnnotationStateCommandToProject(
  project: ProjectData,
  value: unknown,
): AnnotationStateCommandApplyResult {
  const envelope = parseAnnotationStateCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const actuals: AnnotationStateActual[] = [];
  for (const item of envelope.command.items) {
    const target = item as AnnotationStateTarget;
    const current = resolveProjectAnnotationState(project, target);
    if (current) actuals.push({ ...target, current } as AnnotationStateActual);
  }
  const assessment = assessAnnotationStateExecution(envelope, actuals);
  if (assessment.status === "invalid_command") return assessment;
  if (assessment.status === "blocked") return { status: "blocked", issues: assessment.issues };
  const nextProject = applyAnnotationStateItems(project, assessment.envelope.command.items);
  return nextProject
    ? { status: "applied", project: nextProject, envelope: assessment.envelope }
    : { status: "blocked", issues: assessment.envelope.command.items.map((item) => ({
        // before 已通过；此处失败表示 after 破坏跨实体引用或最终集合不变量，而不是目标缺失。
        code: "result_invalid" as const,
        targetKey: getAnnotationStateTargetKey(item),
      })) };
}
