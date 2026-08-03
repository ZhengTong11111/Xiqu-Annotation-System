import {
  buildAnnotationTransactionEnvelope,
  type AnnotationTransactionCommandEnvelope,
} from "@xiqu/shared";
import type { ProjectData } from "../types";
import {
  buildProjectAnnotationContentEnvelope,
  resolveProjectAnnotationContent,
  type AnnotationContentTarget,
} from "./annotationContentCommand";
import {
  buildProjectAnnotationLifecycleEnvelope,
  type AnnotationLifecycleTarget,
} from "./annotationLifecycleCommand";
import { applyAnnotationTransactionCommandToProject } from "./annotationTransactionCommandApply";
import { areProjectValuesEqual } from "./projectValueEquality";
import {
  buildProjectTimelineTimingCommand,
  resolveProjectTimelineTiming,
  type TimelineTimingTarget,
} from "./timelineTimingCommand";

export type AnnotationTransactionPlan = {
  contentTargets?: readonly AnnotationContentTarget[];
  timingTargets?: readonly TimelineTimingTarget[];
  lifecycleTargets?: readonly AnnotationLifecycleTarget[];
};

// 高层 builder 从两份权威项目提取各单域命令，并以同一 replay adapter 反证事务完整覆盖 next。
export function buildProjectAnnotationTransactionCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  plan: AnnotationTransactionPlan,
): AnnotationTransactionCommandEnvelope | null {
  const children = [];
  const contentTargets = selectChangedContentTargets(baseProject, nextProject, plan.contentTargets ?? []);
  if (!contentTargets) return null;
  if (contentTargets.length > 0) {
    const envelope = buildProjectAnnotationContentEnvelope(baseProject, nextProject, contentTargets);
    if (!envelope) return null;
    children.push(envelope);
  }

  const timingTargets = selectChangedTimingTargets(baseProject, nextProject, plan.timingTargets ?? []);
  if (!timingTargets) return null;
  if (timingTargets.length > 0) {
    const envelope = buildProjectTimelineTimingCommand(baseProject, nextProject, timingTargets);
    if (!envelope) return null;
    children.push(envelope);
  }

  if ((plan.lifecycleTargets?.length ?? 0) > 0) {
    const envelope = buildProjectAnnotationLifecycleEnvelope(
      baseProject,
      nextProject,
      plan.lifecycleTargets ?? [],
    );
    if (!envelope) return null;
    children.push(envelope);
  }

  const envelope = buildAnnotationTransactionEnvelope(children);
  if (!envelope) return null;
  const applied = applyAnnotationTransactionCommandToProject(baseProject, envelope);
  return applied.status === "applied" && areProjectValuesEqual(applied.project, nextProject) ? envelope : null;
}

// no-op 目标不应制造空子命令；缺失任一声明目标则 fail closed，不能靠最终比较碰巧放行。
function selectChangedContentTargets(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AnnotationContentTarget[],
) {
  const changed: AnnotationContentTarget[] = [];
  for (const target of targets) {
    const before = resolveProjectAnnotationContent(baseProject, target);
    const after = resolveProjectAnnotationContent(nextProject, target);
    if (before === null || after === null) return null;
    if (before !== after) changed.push(target);
  }
  return changed;
}

function selectChangedTimingTargets(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly TimelineTimingTarget[],
) {
  const changed: TimelineTimingTarget[] = [];
  for (const target of targets) {
    const before = resolveProjectTimelineTiming(baseProject, target);
    const after = resolveProjectTimelineTiming(nextProject, target);
    if (!before || !after) return null;
    if (before.startTime !== after.startTime || before.endTime !== after.endTime) changed.push(target);
  }
  return changed;
}
