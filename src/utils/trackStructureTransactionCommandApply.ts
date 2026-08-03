import {
  ANNOTATION_CONTENT_UPDATE_COMMAND,
  ANNOTATION_LIFECYCLE_UPDATE_COMMAND,
  ANNOTATION_STATE_UPDATE_COMMAND,
  ATTACHED_POINT_TRACK_LIFECYCLE_UPDATE_COMMAND,
  CUSTOM_TRACK_LIFECYCLE_UPDATE_COMMAND,
  CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND,
  parseTrackStructureTransactionCommandEnvelope,
  TIMELINE_TIMING_UPDATE_COMMAND,
  type TrackStructureTransactionCommandEnvelope,
} from "@xiqu/shared";
import type { ProjectData } from "../types";
import { applyAnnotationContentCommandToProject } from "./annotationContentCommandApply";
import { applyAnnotationLifecycleCommandToProject } from "./annotationLifecycleCommandApply";
import { validateProjectAnnotationReferences } from "./annotationLifecycleCommand";
import { applyAnnotationStateCommandToProject } from "./annotationStateCommandApply";
import { applyCustomTrackStructureCommandToProject } from "./customTrackStructureCommandApply";
import { applyTimelineTimingCommandToProject } from "./timelineTimingCommandApply";
import {
  applyTrackStructureLifecycleCommandToProject,
  validateTrackContainerIntegrity,
} from "./trackStructureLifecycleCommandApply";

export type TrackStructureTransactionApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked"; childIndex: number }
  | { status: "applied"; project: ProjectData; envelope: TrackStructureTransactionCommandEnvelope };

// 所有子命令只作用于局部变量；最终引用图通过前，调用者看不到任何部分结构结果。
export function applyTrackStructureTransactionCommandToProject(
  project: ProjectData,
  value: unknown,
): TrackStructureTransactionApplyResult {
  const envelope = parseTrackStructureTransactionCommandEnvelope(value);
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
            : command.type === CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND
              ? applyCustomTrackStructureCommandToProject(currentProject, childEnvelope)
              : command.type === CUSTOM_TRACK_LIFECYCLE_UPDATE_COMMAND ||
                  command.type === ATTACHED_POINT_TRACK_LIFECYCLE_UPDATE_COMMAND
                ? applyTrackStructureLifecycleCommandToProject(currentProject, childEnvelope)
                : assertNever(command);
    if (result.status !== "applied") return { status: "blocked", childIndex };
    currentProject = result.project;
  }
  return validateProjectAnnotationReferences(currentProject) && validateTrackContainerIntegrity(currentProject)
    ? { status: "applied", project: currentProject, envelope }
    : { status: "blocked", childIndex: envelope.command.commands.length - 1 };
}

function assertNever(value: never): never {
  throw new Error(`结构事务包含未处理的子命令：${JSON.stringify(value)}`);
}
