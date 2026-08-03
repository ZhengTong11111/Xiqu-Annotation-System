import {
  buildTrackStructureTransactionEnvelope,
  type TrackStructureTransactionCommandEnvelope,
} from "@xiqu/shared";
import type { ProjectData } from "../types";
import {
  buildProjectAnnotationContentEnvelope,
  resolveProjectAnnotationContent,
  type AnnotationContentTarget,
} from "./annotationContentCommand";
import {
  buildProjectAnnotationLifecycleEnvelope,
  resolveProjectAnnotationLifecycleTarget,
  type AnnotationLifecycleTarget,
} from "./annotationLifecycleCommand";
import {
  buildProjectAnnotationStateEnvelope,
  resolveProjectAnnotationState,
  type AnnotationStateTarget,
} from "./annotationStateCommand";
import { buildProjectCustomTrackStructureEnvelope } from "./customTrackStructureCommand";
import { areProjectValuesEqual } from "./projectValueEquality";
import {
  buildProjectAttachedPointTrackLifecycleEnvelope,
  buildProjectCustomTrackLifecycleEnvelope,
  resolveAttachedPointTrackLifecycleContext,
  resolveCustomTrackLifecycleState,
  type AttachedPointTrackLifecycleTarget,
  type CustomTrackLifecycleTarget,
} from "./trackStructureLifecycleCommand";
import { applyTrackStructureTransactionCommandToProject } from "./trackStructureTransactionCommandApply";

export type TrackStructureTransactionPlan = {
  customTrackLifecycleTargets?: readonly CustomTrackLifecycleTarget[];
  attachedPointTrackLifecycleTargets?: readonly AttachedPointTrackLifecycleTarget[];
  customTrackStructureIds?: readonly string[];
  contentTargets?: readonly AnnotationContentTarget[];
  lifecycleTargets?: readonly AnnotationLifecycleTarget[];
  stateTargets?: readonly AnnotationStateTarget[];
};

// 高层 builder 依照父子依赖排序叶命令，并以最终 ProjectData 深比较证明没有遗漏合同外变化。
export function buildProjectTrackStructureTransactionCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  plan: TrackStructureTransactionPlan,
): TrackStructureTransactionCommandEnvelope | null {
  const commands = [];
  const customLifecycle = classifyCustomTrackLifecycleTargets(baseProject, nextProject,
    plan.customTrackLifecycleTargets ?? []);
  const pointLifecycle = classifyPointTrackLifecycleTargets(baseProject, nextProject,
    plan.attachedPointTrackLifecycleTargets ?? []);
  if (!customLifecycle || !pointLifecycle) return null;

  // 创建父容器必须先于所有引用它的子实体；删除则相反，因此 lifecycle 被拆成前后两个阶段。
  if (customLifecycle.creations.length > 0) {
    const envelope = buildProjectCustomTrackLifecycleEnvelope(baseProject, nextProject, customLifecycle.creations);
    if (!envelope) return null;
    commands.push(envelope);
  }
  if (pointLifecycle.creations.length > 0) {
    const envelope = buildProjectAttachedPointTrackLifecycleEnvelope(baseProject, nextProject, pointLifecycle.creations);
    if (!envelope) return null;
    commands.push(envelope);
  }

  const stateTargets = selectChangedStateTargets(baseProject, nextProject, plan.stateTargets ?? []);
  if (!stateTargets) return null;
  if (stateTargets.length > 0) {
    const envelope = buildProjectAnnotationStateEnvelope(baseProject, nextProject, stateTargets);
    if (!envelope) return null;
    commands.push(envelope);
  }

  const lifecycleTargets = selectChangedLifecycleTargets(baseProject, nextProject, plan.lifecycleTargets ?? []);
  if (!lifecycleTargets) return null;
  if (lifecycleTargets.length > 0) {
    const envelope = buildProjectAnnotationLifecycleEnvelope(baseProject, nextProject, lifecycleTargets);
    if (!envelope) return null;
    commands.push(envelope);
  }

  const contentTargets = selectChangedContentTargets(baseProject, nextProject, plan.contentTargets ?? []);
  if (!contentTargets) return null;
  if (contentTargets.length > 0) {
    const envelope = buildProjectAnnotationContentEnvelope(baseProject, nextProject, contentTargets);
    if (!envelope) return null;
    commands.push(envelope);
  }

  if ((plan.customTrackStructureIds?.length ?? 0) > 0) {
    const envelope = buildProjectCustomTrackStructureEnvelope(
      baseProject,
      nextProject,
      plan.customTrackStructureIds ?? [],
    );
    if (!envelope) return null;
    commands.push(envelope);
  }

  if (pointLifecycle.deletions.length > 0) {
    const envelope = buildProjectAttachedPointTrackLifecycleEnvelope(baseProject, nextProject, pointLifecycle.deletions);
    if (!envelope) return null;
    commands.push(envelope);
  }
  if (customLifecycle.deletions.length > 0) {
    const envelope = buildProjectCustomTrackLifecycleEnvelope(baseProject, nextProject, customLifecycle.deletions);
    if (!envelope) return null;
    commands.push(envelope);
  }

  const envelope = buildTrackStructureTransactionEnvelope(commands);
  if (!envelope) return null;
  const applied = applyTrackStructureTransactionCommandToProject(baseProject, envelope);
  return applied.status === "applied" && areProjectValuesEqual(applied.project, nextProject) ? envelope : null;
}

function classifyCustomTrackLifecycleTargets(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly CustomTrackLifecycleTarget[],
) {
  const creations: CustomTrackLifecycleTarget[] = [];
  const deletions: CustomTrackLifecycleTarget[] = [];
  for (const target of new Map(targets.map((item) => [item.trackId, item])).values()) {
    const before = resolveCustomTrackLifecycleState(baseProject, target.trackId);
    const after = resolveCustomTrackLifecycleState(nextProject, target.trackId);
    if ((before === null) === (after === null)) return null;
    (before ? deletions : creations).push(target);
  }
  return { creations, deletions };
}

function classifyPointTrackLifecycleTargets(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AttachedPointTrackLifecycleTarget[],
) {
  const creations: AttachedPointTrackLifecycleTarget[] = [];
  const deletions: AttachedPointTrackLifecycleTarget[] = [];
  const unique = new Map(targets.map((item) => [
    `${item.parentTrackType}:${item.parentTrackId}:${item.pointTrackId}`,
    item,
  ]));
  for (const target of unique.values()) {
    const before = resolveAttachedPointTrackLifecycleContext(baseProject, target);
    const after = resolveAttachedPointTrackLifecycleContext(nextProject, target);
    if (!before || !after || (before.entity === null) === (after.entity === null)) return null;
    (before.entity ? deletions : creations).push(target);
  }
  return { creations, deletions };
}

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

function selectChangedStateTargets(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AnnotationStateTarget[],
) {
  const changed: AnnotationStateTarget[] = [];
  for (const target of targets) {
    const before = resolveProjectAnnotationState(baseProject, target);
    const after = resolveProjectAnnotationState(nextProject, target);
    if (!before || !after) return null;
    if (!areProjectValuesEqual(before, after)) changed.push(target);
  }
  return changed;
}

function selectChangedLifecycleTargets(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AnnotationLifecycleTarget[],
) {
  const changed: AnnotationLifecycleTarget[] = [];
  for (const target of targets) {
    const before = resolveProjectAnnotationLifecycleTarget(baseProject, target);
    const after = resolveProjectAnnotationLifecycleTarget(nextProject, target);
    if (!before.parentExists || !after.parentExists || before.ambiguous || after.ambiguous) return null;
    if ((before.current === null) !== (after.current === null)) changed.push(target);
  }
  return changed;
}
