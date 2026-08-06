import type { TimelineTimingCommandEnvelope } from "@xiqu/shared";
import type { ProjectData } from "./projectData.js";
import { areProjectValuesEqual } from "./projectValueEquality.js";
import {
  buildProjectTimelineTimingEnvelope,
  type TimelineTimingTarget,
} from "./timelineTimingCommand.js";
import { applyTimelineTimingCommandToProject } from "./timelineTimingCommandApply.js";

// 独立 timing 命令必须完整解释 next ProjectData；若调用点遗漏句同步、工尺符号等派生变化，
// builder 返回 null，让上层进入受控快照边界，而不是留下只能在保存时才发现的不完整命令。
export function buildProjectTimelineTimingCommand(
  baseProject: ProjectData,
  nextProject: ProjectData,
  targets: readonly TimelineTimingTarget[],
): TimelineTimingCommandEnvelope | null {
  const envelope = buildProjectTimelineTimingEnvelope(baseProject, nextProject, targets);
  if (!envelope) return null;
  const applied = applyTimelineTimingCommandToProject(baseProject, envelope);
  return applied.status === "applied" && areProjectValuesEqual(applied.project, nextProject)
    ? envelope
    : null;
}
