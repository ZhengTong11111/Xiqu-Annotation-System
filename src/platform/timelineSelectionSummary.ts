import type { AnnotationTimelineActivity, AnnotationSelectionSummaryKind } from "@xiqu/shared";
import type { ProjectData, TimelineSelectionItem } from "../types";

type ResolvedSelection = {
  start: number;
  end: number;
  laneId: string;
  kind: AnnotationSelectionSummaryKind;
};

const KIND_ORDER: AnnotationSelectionSummaryKind[] = [
  "character",
  "action",
  "custom_block",
  "attached_point",
  "banyan_mark",
];

// 只汇总时间、数量和研究域大类；实体 id 与标注正文绝不进入协作消息。
export function buildTimelineSelectionSummary(
  project: ProjectData,
  items: TimelineSelectionItem[],
): AnnotationTimelineActivity["selection"] {
  const resolved = items
    .map((item) => resolveTimelineSelection(project, item))
    .filter((item): item is ResolvedSelection => Boolean(item));
  if (!resolved.length) return null;
  const kinds = [...new Set(resolved.map((item) => item.kind))]
    .sort((left, right) => KIND_ORDER.indexOf(left) - KIND_ORDER.indexOf(right));
  return {
    start: Math.min(...resolved.map((item) => item.start)),
    end: Math.max(...resolved.map((item) => item.end)),
    itemCount: resolved.length,
    laneCount: new Set(resolved.map((item) => item.laneId)).size,
    kinds,
  };
}

function resolveTimelineSelection(
  project: ProjectData,
  item: TimelineSelectionItem,
): ResolvedSelection | null {
  if (item.type === "character") {
    const annotation = project.characterAnnotations.find((entry) => entry.id === item.id);
    return annotation ? createResolved(annotation.startTime, annotation.endTime, "character-track", "character") : null;
  }
  if (item.type === "action") {
    const annotation = project.actionAnnotations.find((entry) => entry.id === item.id);
    return annotation ? createResolved(annotation.startTime, annotation.endTime, annotation.trackId, "action") : null;
  }
  if (item.type === "custom-block") {
    const block = project.customTracks.find((track) => track.id === item.trackId)?.blocks
      .find((entry) => entry.id === item.id);
    const laneId = item.branchLaneId ? `${item.trackId}:${item.branchLaneId}` : item.trackId;
    return block ? createResolved(block.startTime, block.endTime, laneId, "custom_block") : null;
  }
  if (item.type === "attached-point") {
    const parentTrack = item.parentTrackId === "character-track"
      ? project.builtinTracks.find((track) => track.id === "character-track")
      : project.customTracks.find((track) => track.id === item.parentTrackId);
    const point = parentTrack?.attachedPointTracks.find((track) => track.id === item.trackId)?.points
      .find((entry) => entry.id === item.id);
    return point ? createResolved(point.time, point.time, item.trackId, "attached_point") : null;
  }
  const mark = project.banyanMarks.find((entry) => entry.id === item.id);
  return mark ? createResolved(mark.time, mark.time, "banyan-track", "banyan_mark") : null;
}

function createResolved(
  start: number,
  end: number,
  laneId: string,
  kind: AnnotationSelectionSummaryKind,
): ResolvedSelection | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
  return { start, end, laneId, kind };
}
