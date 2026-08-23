import {
  ATTACHED_POINT_TRACK_STRUCTURE_UPDATE_COMMAND,
  BUILTIN_TRACK_STRUCTURE_UPDATE_COMMAND,
  parseAttachedPointTrackStructureCommandEnvelope,
  parseBuiltinTrackStructureCommandEnvelope,
  parseTrackOrderCommandEnvelope,
  TRACK_ORDER_UPDATE_COMMAND,
  type AttachedPointTrackStructureSnapshot,
  type BuiltinTrackStructureSnapshot,
  type TrackConfigurationCommandEnvelope,
} from "@xiqu/shared";
import type { AttachedPointTrack, BuiltinTrack, CustomTrack, ProjectData } from "./projectData.js";
import {
  resolveAttachedPointTrackStructureSnapshot,
  resolveBuiltinTrackStructureSnapshot,
} from "./trackConfigurationCommand.js";
import { areProjectValuesEqual } from "./projectValueEquality.js";

export type TrackConfigurationApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked" }
  | { status: "applied"; project: ProjectData; envelope: TrackConfigurationCommandEnvelope };

// 三类配置 leaf 共用一个分派入口；每个 adapter 都先验证全部 before，再执行不可变写入。
export function applyTrackConfigurationCommandToProject(
  project: ProjectData,
  value: unknown,
): TrackConfigurationApplyResult {
  if (!value || typeof value !== "object" || !("command" in value) ||
    !value.command || typeof value.command !== "object" || !("type" in value.command)) {
    return { status: "invalid_command" };
  }
  if (value.command.type === TRACK_ORDER_UPDATE_COMMAND) return applyTrackOrder(project, value);
  if (value.command.type === BUILTIN_TRACK_STRUCTURE_UPDATE_COMMAND) return applyBuiltinStructure(project, value);
  if (value.command.type === ATTACHED_POINT_TRACK_STRUCTURE_UPDATE_COMMAND) {
    return applyAttachedPointStructure(project, value);
  }
  return { status: "invalid_command" };
}

function applyTrackOrder(project: ProjectData, value: unknown): TrackConfigurationApplyResult {
  const envelope = parseTrackOrderCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const knownTrackIds = [...project.builtinTracks, ...project.customTracks].map((track) => track.id);
  if (!areProjectValuesEqual(project.activeTrackOrder, envelope.command.before) ||
    !haveSameIdSet(knownTrackIds, envelope.command.before)) return { status: "blocked" };
  return { status: "applied", project: { ...project, activeTrackOrder: [...envelope.command.after] }, envelope };
}

function applyBuiltinStructure(project: ProjectData, value: unknown): TrackConfigurationApplyResult {
  const envelope = parseBuiltinTrackStructureCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  for (const item of envelope.command.items) {
    const current = resolveBuiltinTrackStructureSnapshot(project, item.trackId);
    if (!current || !areProjectValuesEqual(current, item.before)) return { status: "blocked" };
  }
  const updates = new Map(envelope.command.items.map((item) => [item.trackId, item.after]));
  const builtinTracks = project.builtinTracks.map((track) => {
    const snapshot = updates.get(track.id);
    return snapshot ? restoreBuiltinTrackStructureSnapshot(track, snapshot) : track;
  });
  return { status: "applied", project: { ...project, builtinTracks }, envelope };
}

function applyAttachedPointStructure(project: ProjectData, value: unknown): TrackConfigurationApplyResult {
  const envelope = parseAttachedPointTrackStructureCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  // point track id 在项目内全局唯一；先拒绝歧义，再核对命令声明的父作用域和完整 before。
  for (const item of envelope.command.items) {
    if (countPointTrackOccurrences(project, item.pointTrackId) !== 1) return { status: "blocked" };
    const current = resolveAttachedPointTrackStructureSnapshot(project, item);
    if (!current || !areProjectValuesEqual(current, item.before)) return { status: "blocked" };
  }
  const updates = new Map(envelope.command.items.map((item) => [item.pointTrackId, item.after]));
  const updatePointTracks = (tracks: AttachedPointTrack[]) => tracks.map((track) => {
    const snapshot = updates.get(track.id);
    return snapshot ? restoreAttachedPointTrackStructureSnapshot(track, snapshot) : track;
  });
  return {
    status: "applied",
    project: {
      ...project,
      builtinTracks: project.builtinTracks.map((track) => ({
        ...track,
        attachedPointTracks: updatePointTracks(track.attachedPointTracks),
      })),
      customTracks: project.customTracks.map((track) => ({
        ...track,
        attachedPointTracks: updatePointTracks(track.attachedPointTracks),
      })) as CustomTrack[],
    },
    envelope,
  };
}

function restoreBuiltinTrackStructureSnapshot(
  track: BuiltinTrack,
  snapshot: BuiltinTrackStructureSnapshot,
): BuiltinTrack {
  const {
    attachedPointTracksExpanded: _expanded,
    snapToWaveformKeypoints: _snap,
    autoSetLoopRangeOnSelect: _autoLoop,
    ...stable
  } = track;
  return {
    ...stable,
    name: snapshot.name,
    ...(snapshot.attachedPointTracksExpanded === null
      ? {}
      : { attachedPointTracksExpanded: snapshot.attachedPointTracksExpanded }),
    ...(snapshot.snapToWaveformKeypoints === null
      ? {}
      : { snapToWaveformKeypoints: snapshot.snapToWaveformKeypoints }),
    ...(snapshot.autoSetLoopRangeOnSelect === null
      ? {}
      : { autoSetLoopRangeOnSelect: snapshot.autoSetLoopRangeOnSelect }),
  };
}

function restoreAttachedPointTrackStructureSnapshot(
  track: AttachedPointTrack,
  snapshot: AttachedPointTrackStructureSnapshot,
): AttachedPointTrack {
  const {
    snapToWaveformKeypoints: _waveformSnap,
    snapToParentBoundaries: _parentSnap,
    autoSetLoopRangeOnSelect: _autoLoop,
    ...stable
  } = track;
  return {
    ...stable,
    name: snapshot.name,
    typeOptions: [...snapshot.typeOptions],
    ...(snapshot.snapToWaveformKeypoints === null
      ? {}
      : { snapToWaveformKeypoints: snapshot.snapToWaveformKeypoints }),
    ...(snapshot.snapToParentBoundaries === null
      ? {}
      : { snapToParentBoundaries: snapshot.snapToParentBoundaries }),
    ...(snapshot.autoSetLoopRangeOnSelect === null
      ? {}
      : { autoSetLoopRangeOnSelect: snapshot.autoSetLoopRangeOnSelect }),
  };
}

function countPointTrackOccurrences(project: ProjectData, pointTrackId: string) {
  return [...project.builtinTracks, ...project.customTracks]
    .reduce((count, track) => count + track.attachedPointTracks.filter((pointTrack) =>
      pointTrack.id === pointTrackId).length, 0);
}

function haveSameIdSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}
