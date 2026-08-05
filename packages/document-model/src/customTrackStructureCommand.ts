import {
  buildCustomTrackStructureUpdateEnvelope,
  type CustomTrackBlockStructureSnapshot,
  type CustomTrackStructureBranchLane,
  type CustomTrackStructureCommandEnvelope,
  type CustomTrackStructureSnapshot,
  type CustomTrackStructureUpdateItem,
} from "@xiqu/shared";
import type { BranchLane, CustomTrack, ProjectData } from "./projectData.js";
import { areProjectValuesEqual } from "./projectValueEquality.js";

// UI 只声明受影响轨道；before/after 一律从真实 ProjectData 提取，避免调用点手工拼不完整快照。
export function buildProjectCustomTrackStructureCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  trackIds: readonly string[],
): CustomTrackStructureCommandEnvelope | null {
  const uniqueTrackIds = [...new Set(trackIds)];
  const items: CustomTrackStructureUpdateItem[] = [];
  for (const trackId of uniqueTrackIds) {
    const before = resolveCustomTrackStructureSnapshot(baseProject, trackId);
    const after = resolveCustomTrackStructureSnapshot(nextProject, trackId);
    if (!before || !after) return null;
    items.push({ trackId, before, after });
  }
  const envelope = buildCustomTrackStructureUpdateEnvelope(items);
  if (!envelope) return null;
  const reconstructed = applyCustomTrackStructureItems(baseProject, envelope.command.items);
  return reconstructed && areProjectValuesEqual(reconstructed, nextProject) ? envelope : null;
}

// 结构事务复用同一提取逻辑，但完整项目覆盖证明由更高层事务统一完成。
export function buildProjectCustomTrackStructureEnvelope(
  baseProject: ProjectData,
  nextProject: ProjectData,
  trackIds: readonly string[],
): CustomTrackStructureCommandEnvelope | null {
  const uniqueTrackIds = [...new Set(trackIds)];
  const items: CustomTrackStructureUpdateItem[] = [];
  for (const trackId of uniqueTrackIds) {
    const before = resolveCustomTrackStructureSnapshot(baseProject, trackId);
    const after = resolveCustomTrackStructureSnapshot(nextProject, trackId);
    if (!before || !after) return null;
    items.push({ trackId, before, after });
  }
  return buildCustomTrackStructureUpdateEnvelope(items);
}

export function resolveCustomTrackStructureSnapshot(
  project: ProjectData,
  trackId: string,
): CustomTrackStructureSnapshot | null {
  const matches = project.customTracks.filter((track) => track.id === trackId);
  return matches.length === 1 ? createCustomTrackStructureSnapshot(matches[0]) : null;
}

// 规范快照保留可选字段的“缺失”语义，并按 block id 排序，确保跨客户端产生稳定命令。
export function createCustomTrackStructureSnapshot(track: CustomTrack): CustomTrackStructureSnapshot {
  return {
    id: track.id,
    trackType: track.trackType,
    name: track.name,
    color: track.color ?? null,
    typeOptions: [...track.typeOptions],
    attachedPointTracksExpanded: track.attachedPointTracksExpanded ?? null,
    snapToWaveformKeypoints: track.snapToWaveformKeypoints ?? null,
    autoSetLoopRangeOnSelect: track.autoSetLoopRangeOnSelect ?? null,
    branching: track.branching
      ? {
          enabled: track.branching.enabled,
          rootLabel: track.branching.rootLabel ?? null,
          displayMode: track.branching.displayMode,
          lanes: track.branching.lanes.map(createBranchLaneSnapshot),
        }
      : null,
    blocks: track.blocks
      .map((block): CustomTrackBlockStructureSnapshot => ({
        id: block.id,
        branchScope: block.branchScope?.mode === "lanes"
          ? { mode: "lanes", laneIds: [...block.branchScope.laneIds].sort(compareStableIds) }
          : block.branchScope ? { mode: "root" } : null,
        branchGroupId: block.branchGroupId ?? null,
        branchParentBlockId: block.branchParentBlockId ?? null,
      }))
      .sort((left, right) => left.id === right.id ? 0 : left.id < right.id ? -1 : 1),
  };
}

function compareStableIds(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

// shared parser 已验证轨道和 block 身份；这里仍按命令目标计数，防止异常项目中的重复 id 被局部覆盖。
export function applyCustomTrackStructureItems(
  project: ProjectData,
  items: readonly CustomTrackStructureUpdateItem[],
): ProjectData | null {
  const updates = new Map(items.map((item) => [item.trackId, item.after]));
  let appliedCount = 0;
  const customTracks = project.customTracks.map((track) => {
    const snapshot = updates.get(track.id);
    if (!snapshot) return track;
    appliedCount += 1;
    return restoreCustomTrackStructureSnapshot(track, snapshot);
  });
  return appliedCount === updates.size
    ? { ...project, customTracks: customTracks as CustomTrack[] }
    : null;
}

function createBranchLaneSnapshot(lane: BranchLane): CustomTrackStructureBranchLane {
  return {
    id: lane.id,
    name: lane.name,
    parentId: lane.parentId,
    color: lane.color ?? null,
    children: (lane.children ?? []).map(createBranchLaneSnapshot),
  };
}

function restoreCustomTrackStructureSnapshot(
  track: CustomTrack,
  snapshot: CustomTrackStructureSnapshot,
): CustomTrack {
  const blockUpdates = new Map(snapshot.blocks.map((block) => [block.id, block]));
  const blocks = track.blocks.map((block) => {
    const next = blockUpdates.get(block.id);
    if (!next) return block;
    // 先排除旧可选字段，再按规范快照恢复；null 表示字段缺失而不是显式写入 null。
    const { branchScope: _scope, branchGroupId: _group, branchParentBlockId: _parent, ...stableBlock } = block;
    return {
      ...stableBlock,
      ...(next.branchScope ? { branchScope: structuredClone(next.branchScope) } : {}),
      ...(next.branchGroupId ? { branchGroupId: next.branchGroupId } : {}),
      ...(next.branchParentBlockId ? { branchParentBlockId: next.branchParentBlockId } : {}),
    };
  }) as CustomTrack["blocks"];
  const {
    color: _color,
    branching: _branching,
    attachedPointTracksExpanded: _expanded,
    snapToWaveformKeypoints: _waveformSnap,
    autoSetLoopRangeOnSelect: _autoLoop,
    ...stableTrack
  } = track;
  return {
    ...stableTrack,
    name: snapshot.name,
    typeOptions: [...snapshot.typeOptions],
    blocks,
    ...(snapshot.color ? { color: snapshot.color } : {}),
    ...(snapshot.attachedPointTracksExpanded === null
      ? {}
      : { attachedPointTracksExpanded: snapshot.attachedPointTracksExpanded }),
    ...(snapshot.snapToWaveformKeypoints === null
      ? {}
      : { snapToWaveformKeypoints: snapshot.snapToWaveformKeypoints }),
    ...(snapshot.autoSetLoopRangeOnSelect === null
      ? {}
      : { autoSetLoopRangeOnSelect: snapshot.autoSetLoopRangeOnSelect }),
    ...(snapshot.branching
      ? {
          branching: {
            enabled: snapshot.branching.enabled,
            ...(snapshot.branching.rootLabel === null ? {} : { rootLabel: snapshot.branching.rootLabel }),
            displayMode: snapshot.branching.displayMode,
            lanes: snapshot.branching.lanes.map(restoreBranchLaneSnapshot),
          },
        }
      : {}),
  } as CustomTrack;
}

function restoreBranchLaneSnapshot(lane: CustomTrackStructureBranchLane): BranchLane {
  return {
    id: lane.id,
    name: lane.name,
    parentId: lane.parentId,
    ...(lane.color ? { color: lane.color } : {}),
    children: lane.children.map(restoreBranchLaneSnapshot),
  };
}
