import {
  assessAnnotationContentExecution,
  parseAnnotationContentCommandEnvelope,
  type AnnotationContentCommandEnvelope,
  type AnnotationContentActual,
  type AnnotationContentPreconditionIssue,
} from "@xiqu/shared";
import type { ProjectData } from "../types";
import {
  applyAnnotationContentItems,
  resolveProjectAnnotationContent,
  type AnnotationContentTarget,
} from "./annotationContentCommand";

// adapter 只返回三态结果，调用者不能在 blocked 时取得或误用半成品 ProjectData。
export type AnnotationContentCommandApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked"; issues: AnnotationContentPreconditionIssue[] }
  | { status: "applied"; project: ProjectData; envelope: AnnotationContentCommandEnvelope };

// 内容 adapter 先收集全部实际值并完成 precondition，再统一 immutable 写入，禁止部分应用。
export function applyAnnotationContentCommandToProject(
  project: ProjectData,
  value: unknown,
): AnnotationContentCommandApplyResult {
  const envelope = parseAnnotationContentCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const parsedActuals: AnnotationContentActual[] = [];
  for (const item of envelope.command.items) {
    const target = item as AnnotationContentTarget;
    const current = resolveProjectAnnotationContent(project, target);
    if (current !== null) parsedActuals.push({ ...target, current } as AnnotationContentActual);
  }
  const assessment = assessAnnotationContentExecution(envelope, parsedActuals);
  if (assessment.status === "invalid_command") return assessment;
  if (assessment.status === "blocked") return { status: "blocked", issues: assessment.issues };

  const nextProject = applyAnnotationContentItems(project, assessment.envelope.command.items);
  return { status: "applied", project: nextProject, envelope: assessment.envelope };
}
