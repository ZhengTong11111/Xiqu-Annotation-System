import {
  ANNOTATION_CONTENT_UPDATE_COMMAND,
  ANNOTATION_LIFECYCLE_UPDATE_COMMAND,
  ANNOTATION_STATE_UPDATE_COMMAND,
  parseAnnotationTransactionCommandEnvelope,
  TIMELINE_TIMING_UPDATE_COMMAND,
  type AnnotationTransactionCommandEnvelope,
} from "@xiqu/shared";
import type { ProjectData } from "./projectData.js";
import { applyAnnotationContentCommandToProject } from "./annotationContentCommandApply.js";
import { applyAnnotationLifecycleCommandToProject } from "./annotationLifecycleCommandApply.js";
import { applyAnnotationStateCommandToProject } from "./annotationStateCommandApply.js";
import { applyTimelineTimingCommandToProject } from "./timelineTimingCommandApply.js";

export type AnnotationTransactionCommandApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked"; childIndex: number }
  | { status: "applied"; project: ProjectData; envelope: AnnotationTransactionCommandEnvelope };

// 事务只在局部 ProjectData 上顺序执行；任一子命令失败时丢弃局部变量，调用者永远看不到半成品。
export function applyAnnotationTransactionCommandToProject(
  project: ProjectData,
  value: unknown,
): AnnotationTransactionCommandApplyResult {
  const envelope = parseAnnotationTransactionCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  let currentProject = project;
  for (const [childIndex, command] of envelope.command.commands.entries()) {
    const childEnvelope = { version: envelope.version, command };
    const result = command.type === TIMELINE_TIMING_UPDATE_COMMAND
      ? applyTimelineTimingCommandToProject(currentProject, childEnvelope)
      : command.type === ANNOTATION_CONTENT_UPDATE_COMMAND
        ? applyAnnotationContentCommandToProject(currentProject, childEnvelope)
        : command.type === ANNOTATION_LIFECYCLE_UPDATE_COMMAND
          ? applyAnnotationLifecycleCommandToProject(currentProject, childEnvelope)
          : command.type === ANNOTATION_STATE_UPDATE_COMMAND
            ? applyAnnotationStateCommandToProject(currentProject, childEnvelope)
            : assertNever(command);
    if (result.status !== "applied") return { status: "blocked", childIndex };
    currentProject = result.project;
  }
  return { status: "applied", project: currentProject, envelope };
}

function assertNever(value: never): never {
  throw new Error(`事务包含未处理的子命令：${JSON.stringify(value)}`);
}
