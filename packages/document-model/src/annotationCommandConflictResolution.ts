import {
  ANNOTATION_CONTENT_UPDATE_COMMAND,
  ANNOTATION_TRANSACTION_APPLY_COMMAND,
  buildAnnotationContentUpdateEnvelope,
  buildAnnotationTransactionEnvelope,
  buildTimelineTimingUpdateEnvelope,
  parseAnnotationCommandEnvelope,
  TIMELINE_TIMING_UPDATE_COMMAND,
  type AnnotationCommandEnvelope,
  type AnnotationContentCommandEnvelope,
  type AnnotationContentUpdateItem,
  type AnnotationLifecycleCommandEnvelope,
  type AnnotationStateCommandEnvelope,
  type AnnotationTransactionCommandEnvelope,
  type TimelineTimingCommandEnvelope,
  type TimelineTimingUpdateItem,
} from "@xiqu/shared";
import type { ProjectData } from "./projectData.js";
import {
  resolveProjectAnnotationContent,
  type AnnotationContentTarget,
} from "./annotationContentCommand.js";
import { applyAnnotationCommandToProject } from "./annotationCommandApply.js";
import {
  resolveProjectTimelineTiming,
  type TimelineTimingTarget,
} from "./timelineTimingCommand.js";

export type ConcurrentAnnotationCommandResolution =
  | {
      status: "resolved";
      project: ProjectData;
      envelope: AnnotationCommandEnvelope;
    }
  | {
      status: "unresolved";
      reason:
        | "invalid_command"
        | "unsupported_command"
        | "target_missing"
        | "invalid_timing"
        | "no_effect"
        | "rebuilt_command_rejected";
    };

// 这一入口只供“服务器已明确拒绝旧 revision”后的实时冲突恢复使用。
// 普通重放仍坚持严格 before 校验，不能把本模块当成通用的宽松 apply。
export function resolveConcurrentAnnotationCommandConflict(
  latestProject: ProjectData,
  value: unknown,
): ConcurrentAnnotationCommandResolution {
  const envelope = parseAnnotationCommandEnvelope(value);
  if (!envelope) return { status: "unresolved", reason: "invalid_command" };

  if (envelope.command.type === TIMELINE_TIMING_UPDATE_COMMAND) {
    return resolveTimingConflict(latestProject, envelope.command.items);
  }
  if (envelope.command.type === ANNOTATION_CONTENT_UPDATE_COMMAND) {
    return resolveContentConflict(latestProject, envelope.command.items);
  }
  if (envelope.command.type === ANNOTATION_TRANSACTION_APPLY_COMMAND) {
    return resolveTransactionConflict(
      latestProject,
      envelope as AnnotationTransactionCommandEnvelope,
    );
  }
  return { status: "unresolved", reason: "unsupported_command" };
}

// 时间冲突按 start/end 两条边分别协调：本端没有修改的边保留服务器最新值，
// 本端修改过的边则采用本次手势的绝对目标值。这样同一边界由后完成恢复的一端胜出，
// 不同边界仍可组合，也不会把两个客户端基于同一旧位置的拖动距离错误相加。
function resolveTimingConflict(
  latestProject: ProjectData,
  items: readonly TimelineTimingUpdateItem[],
): ConcurrentAnnotationCommandResolution {
  const transformedItems: TimelineTimingUpdateItem[] = [];
  for (const item of items) {
    const target: TimelineTimingTarget = {
      entityType: item.entityType,
      entityId: item.entityId,
      ...(item.trackId === undefined ? {} : { trackId: item.trackId }),
    };
    const current = resolveProjectTimelineTiming(latestProject, target);
    if (!current) return { status: "unresolved", reason: "target_missing" };

    const changedStart = item.after.startTime !== item.before.startTime;
    const changedEnd = item.after.endTime !== item.before.endTime;
    const after = {
      startTime: changedStart ? item.after.startTime : current.startTime,
      endTime: changedEnd ? item.after.endTime : current.endTime,
    };
    if (!isValidTiming(after)) {
      return { status: "unresolved", reason: "invalid_timing" };
    }
    transformedItems.push({ ...item, before: current, after });
  }

  const transformedEnvelope = buildTimelineTimingUpdateEnvelope(transformedItems);
  if (!transformedEnvelope) return { status: "unresolved", reason: "no_effect" };
  return applyRebuiltEnvelope(latestProject, transformedEnvelope);
}

// 同一文本字段不存在无损的自动拼接语义；实时冲突采用“后完成恢复的一端胜出”。
// before 始终改为最新服务器值，因此这仍是一次经过前置条件保护的新提交，而非静默跳过校验。
function resolveContentConflict(
  latestProject: ProjectData,
  items: readonly AnnotationContentUpdateItem[],
): ConcurrentAnnotationCommandResolution {
  const transformedItems: AnnotationContentUpdateItem[] = [];
  for (const item of items) {
    const current = resolveProjectAnnotationContent(latestProject, item as AnnotationContentTarget);
    if (current === undefined) return { status: "unresolved", reason: "target_missing" };
    transformedItems.push({ ...item, before: current } as AnnotationContentUpdateItem);
  }

  const transformedEnvelope = buildAnnotationContentUpdateEnvelope(transformedItems);
  if (!transformedEnvelope) return { status: "unresolved", reason: "no_effect" };
  return applyRebuiltEnvelope(latestProject, transformedEnvelope);
}

// 事务逐个处理子命令，但只允许 timing/content 在冲突时转换；生命周期和状态命令仍严格执行。
// 任一子命令无法证明安全时丢弃整个临时结果，保持事务的全有或全无语义。
function resolveTransactionConflict(
  latestProject: ProjectData,
  envelope: AnnotationTransactionCommandEnvelope,
): ConcurrentAnnotationCommandResolution {
  let currentProject = latestProject;
  const resolvedChildren: Array<
    TimelineTimingCommandEnvelope |
    AnnotationContentCommandEnvelope |
    AnnotationLifecycleCommandEnvelope |
    AnnotationStateCommandEnvelope
  > = [];
  for (const command of envelope.command.commands) {
    const childEnvelope = { version: envelope.version, command } as AnnotationCommandEnvelope;
    const strict = applyAnnotationCommandToProject(currentProject, childEnvelope);
    if (strict.status === "applied") {
      currentProject = strict.project;
      resolvedChildren.push(strict.envelope as typeof resolvedChildren[number]);
      continue;
    }

    if (command.type !== TIMELINE_TIMING_UPDATE_COMMAND &&
      command.type !== ANNOTATION_CONTENT_UPDATE_COMMAND) {
      return { status: "unresolved", reason: "unsupported_command" };
    }
    const resolved = resolveConcurrentAnnotationCommandConflict(currentProject, childEnvelope);
    if (resolved.status !== "resolved") return resolved;
    currentProject = resolved.project;
    resolvedChildren.push(resolved.envelope as typeof resolvedChildren[number]);
  }

  const rebuilt = buildAnnotationTransactionEnvelope(resolvedChildren);
  if (!rebuilt) return { status: "unresolved", reason: "rebuilt_command_rejected" };
  return {
    status: "resolved",
    project: currentProject,
    envelope: rebuilt,
  };
}

function applyRebuiltEnvelope(
  latestProject: ProjectData,
  envelope: AnnotationCommandEnvelope,
): ConcurrentAnnotationCommandResolution {
  const applied = applyAnnotationCommandToProject(latestProject, envelope);
  return applied.status === "applied"
    ? { status: "resolved", project: applied.project, envelope: applied.envelope }
    : { status: "unresolved", reason: "rebuilt_command_rejected" };
}

function isValidTiming(value: { startTime: number; endTime: number }) {
  return Number.isFinite(value.startTime) &&
    Number.isFinite(value.endTime) &&
    value.startTime >= 0 &&
    value.endTime >= value.startTime;
}
