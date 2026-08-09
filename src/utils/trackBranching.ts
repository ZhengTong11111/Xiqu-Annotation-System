import type {
  BranchLane,
  BranchScope,
  TrackBranchDisplayMode,
  TrackBranching,
} from "../types";
import { createRuntimeUuid } from "./runtimeUuid";

export function createDefaultTrackBranching(): TrackBranching {
  return {
    enabled: true,
    rootLabel: "全轨",
    displayMode: "merged",
    // 不预设“左右手”：分叉可能是手、扇、身段、步法或其他研究对象。
    lanes: [],
  };
}

export function createBranchLane(name: string, parentId: string | null = null, color?: string): BranchLane {
  return {
    id: `branch-lane-${createRuntimeUuid()}`,
    name,
    parentId,
    color,
    children: [],
  };
}

export function recolorBranchLane(lanes: BranchLane[], laneId: string, color: string): BranchLane[] {
  return lanes.map((lane) => {
    if (lane.id === laneId) {
      return {
        ...lane,
        color,
      };
    }
    return {
      ...lane,
      children: recolorBranchLane(lane.children ?? [], laneId, color),
    };
  });
}

export function getBranchLaneCount(lanes: BranchLane[]): number {
  return lanes.reduce((count, lane) => count + 1 + getBranchLaneCount(lane.children ?? []), 0);
}

export function getBranchLaneIds(lanes: BranchLane[]): string[] {
  return lanes.flatMap((lane) => [lane.id, ...getBranchLaneIds(lane.children ?? [])]);
}

export function getNextBranchLaneName(lanes: BranchLane[], parentId: string | null) {
  const siblingCount = parentId === null
    ? lanes.length
    : findBranchLane(lanes, parentId)?.children?.length ?? 0;
  return parentId === null ? `分支 ${siblingCount + 1}` : `子分支 ${siblingCount + 1}`;
}

export function findBranchLane(lanes: BranchLane[], laneId: string): BranchLane | null {
  for (const lane of lanes) {
    if (lane.id === laneId) {
      return lane;
    }
    const childMatch = findBranchLane(lane.children ?? [], laneId);
    if (childMatch) {
      return childMatch;
    }
  }
  return null;
}

export function addBranchLane(
  lanes: BranchLane[],
  parentId: string | null,
  lane: BranchLane,
): BranchLane[] {
  if (parentId === null) {
    return [...lanes, { ...lane, parentId: null }];
  }
  return lanes.map((currentLane) => {
    if (currentLane.id === parentId) {
      return {
        ...currentLane,
        children: [...(currentLane.children ?? []), { ...lane, parentId }],
      };
    }
    return {
      ...currentLane,
      children: addBranchLane(currentLane.children ?? [], parentId, lane),
    };
  });
}

export function renameBranchLane(lanes: BranchLane[], laneId: string, name: string): BranchLane[] {
  return lanes.map((lane) => {
    if (lane.id === laneId) {
      return {
        ...lane,
        name,
      };
    }
    return {
      ...lane,
      children: renameBranchLane(lane.children ?? [], laneId, name),
    };
  });
}

export function removeBranchLane(lanes: BranchLane[], laneId: string): BranchLane[] {
  return lanes
    .filter((lane) => lane.id !== laneId)
    .map((lane) => ({
      ...lane,
      children: removeBranchLane(lane.children ?? [], laneId),
    }));
}

export function normalizeTrackBranching(value: unknown): TrackBranching | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Partial<TrackBranching>;
  // lane id 必须在整棵树内唯一，否则块的 branchScope 会无法明确指向。
  const lanes = normalizeBranchLanes(source.lanes, null, new Set());
  return {
    enabled: Boolean(source.enabled),
    rootLabel: typeof source.rootLabel === "string" && source.rootLabel.trim()
      ? source.rootLabel.trim()
      : "全轨",
    displayMode: isTrackBranchDisplayMode(source.displayMode) ? source.displayMode : "merged",
    lanes,
  };
}

export function normalizeBranchScope(value: unknown, validLaneIds: Set<string>): BranchScope | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Partial<BranchScope> & { laneIds?: unknown };
  if (source.mode === "root") {
    return { mode: "root" };
  }
  if (source.mode !== "lanes" || !Array.isArray(source.laneIds)) {
    return undefined;
  }
  // 旧文件或手工编辑文件可能残留已删除分叉 id，导入时只保留仍存在的分支。
  const laneIds = source.laneIds.filter((laneId): laneId is string =>
    typeof laneId === "string" && validLaneIds.has(laneId),
  );
  return laneIds.length > 0 ? { mode: "lanes", laneIds } : undefined;
}

function normalizeBranchLanes(value: unknown, parentId: string | null, seenIds: Set<string>): BranchLane[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((lane) => {
    if (!lane || typeof lane !== "object") {
      return [];
    }
    const source = lane as Partial<BranchLane>;
    if (typeof source.id !== "string" || !source.id.trim() || seenIds.has(source.id)) {
      return [];
    }
    seenIds.add(source.id);
    const name = typeof source.name === "string" && source.name.trim()
      ? source.name.trim()
      : "分支";
    return [{
      id: source.id,
      name,
      parentId,
      color: normalizeBranchLaneColor(source.color),
      children: normalizeBranchLanes(source.children, source.id, seenIds),
    }] satisfies BranchLane[];
  });
}

function normalizeBranchLaneColor(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : undefined;
}

function isTrackBranchDisplayMode(value: unknown): value is TrackBranchDisplayMode {
  return value === "merged" || value === "expanded";
}
