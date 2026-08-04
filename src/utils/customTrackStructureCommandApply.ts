import {
  getCustomTrackStructureTargetKey,
  parseCustomTrackStructureCommandEnvelope,
  type CustomTrackStructureCommandEnvelope,
} from "@xiqu/shared";
import type { ProjectData } from "@xiqu/document-model";
import { areProjectValuesEqual } from "./projectValueEquality";
import {
  applyCustomTrackStructureItems,
  resolveCustomTrackStructureSnapshot,
} from "./customTrackStructureCommand";

export type CustomTrackStructureCommandApplyResult =
  | { status: "invalid_command" }
  | { status: "blocked"; issues: Array<{ code: "target_missing" | "before_mismatch" | "result_invalid"; targetKey: string }> }
  | { status: "applied"; project: ProjectData; envelope: CustomTrackStructureCommandEnvelope };

// 所有 before 通过后才统一应用 after；任一轨道缺失或结构漂移都阻断整批命令。
export function applyCustomTrackStructureCommandToProject(
  project: ProjectData,
  value: unknown,
): CustomTrackStructureCommandApplyResult {
  const envelope = parseCustomTrackStructureCommandEnvelope(value);
  if (!envelope) return { status: "invalid_command" };
  const issues: Array<{ code: "target_missing" | "before_mismatch"; targetKey: string }> = [];
  for (const item of envelope.command.items) {
    const current = resolveCustomTrackStructureSnapshot(project, item.trackId);
    const targetKey = getCustomTrackStructureTargetKey(item);
    if (!current) issues.push({ code: "target_missing", targetKey });
    else if (!areProjectValuesEqual(current, item.before)) issues.push({ code: "before_mismatch", targetKey });
  }
  if (issues.length > 0) return { status: "blocked", issues };
  const nextProject = applyCustomTrackStructureItems(project, envelope.command.items);
  return nextProject
    ? { status: "applied", project: nextProject, envelope }
    : {
        status: "blocked",
        issues: envelope.command.items.map((item) => ({
          code: "result_invalid" as const,
          targetKey: getCustomTrackStructureTargetKey(item),
        })),
      };
}
