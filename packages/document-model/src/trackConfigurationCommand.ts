import {
  buildAttachedPointTrackStructureUpdateEnvelope,
  buildBuiltinTrackStructureUpdateEnvelope,
  buildTrackOrderUpdateEnvelope,
  type AttachedPointTrackStructureCommandEnvelope,
  type AttachedPointTrackStructureSnapshot,
  type AttachedPointTrackStructureUpdateItem,
  type BuiltinTrackStructureCommandEnvelope,
  type BuiltinTrackStructureSnapshot,
  type BuiltinTrackStructureUpdateItem,
  type TrackOrderCommandEnvelope,
} from "@xiqu/shared";
import type { AttachedPointTrack, BuiltinTrack, ProjectData } from "./projectData.js";

export type AttachedPointTrackStructureTarget = {
  pointTrackId: string;
  parentTrackId: string;
  parentTrackType: "builtin" | "custom";
};

// 顺序 leaf 始终读取完整 activeTrackOrder；调用点不能手工拼接可能漏轨的 before/after。
export function buildProjectTrackOrderEnvelope(
  baseProject: ProjectData,
  nextProject: ProjectData,
): TrackOrderCommandEnvelope | null {
  return buildTrackOrderUpdateEnvelope(baseProject.activeTrackOrder, nextProject.activeTrackOrder);
}

export function buildProjectBuiltinTrackStructureEnvelope(
  baseProject: ProjectData,
  nextProject: ProjectData,
  trackIds: readonly string[],
): BuiltinTrackStructureCommandEnvelope | null {
  const items: BuiltinTrackStructureUpdateItem[] = [];
  for (const trackId of new Set(trackIds)) {
    const before = resolveBuiltinTrackStructureSnapshot(baseProject, trackId);
    const after = resolveBuiltinTrackStructureSnapshot(nextProject, trackId);
    if (!before || !after) return null;
    items.push({ trackId, before, after });
  }
  return buildBuiltinTrackStructureUpdateEnvelope(items);
}

export function buildProjectAttachedPointTrackStructureEnvelope(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly AttachedPointTrackStructureTarget[],
): AttachedPointTrackStructureCommandEnvelope | null {
  const uniqueTargets = new Map(targets.map((target) => [
    `${target.parentTrackType}:${target.parentTrackId}:${target.pointTrackId}`,
    target,
  ]));
  const items: AttachedPointTrackStructureUpdateItem[] = [];
  for (const target of uniqueTargets.values()) {
    const before = resolveAttachedPointTrackStructureSnapshot(baseProject, target);
    const after = resolveAttachedPointTrackStructureSnapshot(nextProject, target);
    if (!before || !after) return null;
    items.push({ ...target, before, after });
  }
  return buildAttachedPointTrackStructureUpdateEnvelope(items);
}

export function resolveBuiltinTrackStructureSnapshot(
  project: ProjectData,
  trackId: string,
): BuiltinTrackStructureSnapshot | null {
  const matches = project.builtinTracks.filter((track) => track.id === trackId);
  return matches.length === 1 ? createBuiltinTrackStructureSnapshot(matches[0]) : null;
}

export function resolveAttachedPointTrackStructureSnapshot(
  project: ProjectData,
  target: AttachedPointTrackStructureTarget,
): AttachedPointTrackStructureSnapshot | null {
  const parentTracks = target.parentTrackType === "builtin" ? project.builtinTracks : project.customTracks;
  const parentMatches = parentTracks.filter((track) => track.id === target.parentTrackId);
  if (parentMatches.length !== 1) return null;
  const pointMatches = parentMatches[0].attachedPointTracks.filter((track) => track.id === target.pointTrackId);
  return pointMatches.length === 1 ? createAttachedPointTrackStructureSnapshot(pointMatches[0]) : null;
}

// 配置快照刻意排除逐字与 attached points；实体内容由 content child 独立声明并接受前置检查。
export function createBuiltinTrackStructureSnapshot(track: BuiltinTrack): BuiltinTrackStructureSnapshot {
  return {
    id: track.id,
    trackType: track.type,
    name: track.name,
    options: track.options ? [...track.options] : null,
    attachedPointTracksExpanded: track.attachedPointTracksExpanded ?? null,
    snapToWaveformKeypoints: track.snapToWaveformKeypoints ?? null,
    autoSetLoopRangeOnSelect: track.autoSetLoopRangeOnSelect ?? null,
  };
}

export function createAttachedPointTrackStructureSnapshot(
  track: AttachedPointTrack,
): AttachedPointTrackStructureSnapshot {
  return {
    id: track.id,
    name: track.name,
    typeOptions: [...track.typeOptions],
    snapToWaveformKeypoints: track.snapToWaveformKeypoints ?? null,
    snapToParentBoundaries: track.snapToParentBoundaries ?? null,
    autoSetLoopRangeOnSelect: track.autoSetLoopRangeOnSelect ?? null,
  };
}
