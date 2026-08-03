import {
  ANNOTATION_CONTENT_UPDATE_COMMAND,
  ANNOTATION_LIFECYCLE_UPDATE_COMMAND,
  ANNOTATION_TRANSACTION_APPLY_COMMAND,
  parseAnnotationCommandEnvelope,
  TIMELINE_TIMING_UPDATE_COMMAND,
} from "@xiqu/shared";
import type { ProjectData } from "../types";
import { applyAnnotationContentCommandToProject } from "./annotationContentCommandApply";
import { applyAnnotationLifecycleCommandToProject } from "./annotationLifecycleCommandApply";
import { applyAnnotationTransactionCommandToProject } from "./annotationTransactionCommandApply";
import { applyTimelineTimingCommandToProject } from "./timelineTimingCommandApply";

// 通用 ProjectData 命令入口只做判别分派；各领域继续拥有独立 parser、precondition 和写入 adapter。
export function applyAnnotationCommandToProject(project: ProjectData, value: unknown) {
  const envelope = parseAnnotationCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" as const };
  if (envelope.command.type === TIMELINE_TIMING_UPDATE_COMMAND) {
    return applyTimelineTimingCommandToProject(project, envelope);
  }
  if (envelope.command.type === ANNOTATION_CONTENT_UPDATE_COMMAND) {
    return applyAnnotationContentCommandToProject(project, envelope);
  }
  if (envelope.command.type === ANNOTATION_LIFECYCLE_UPDATE_COMMAND) {
    return applyAnnotationLifecycleCommandToProject(project, envelope);
  }
  if (envelope.command.type === ANNOTATION_TRANSACTION_APPLY_COMMAND) {
    return applyAnnotationTransactionCommandToProject(project, envelope);
  }
  return assertNever(envelope.command);
}

function assertNever(value: never): never {
  throw new Error(`未处理的标注命令：${JSON.stringify(value)}`);
}
