import type { ProjectData } from "../types";
import { arePlatformProjectPayloadsEqual } from "./platformProjectEquality";

export type PlatformAuthoritativeBaselineState =
  | "server_revision_behind"
  | "same_revision_match"
  | "same_revision_mismatch"
  | "server_revision_advanced";

// 409 后必须同时判断 revision 和正文；同 revision 不代表双方保存基线一定相同。
export function classifyPlatformAuthoritativeBaseline(input: {
  expectedRevision: number;
  latestRevision: number;
  expectedSavedProject: ProjectData;
  latestServerProject: ProjectData;
}): PlatformAuthoritativeBaselineState {
  if (input.latestRevision < input.expectedRevision) return "server_revision_behind";
  if (input.latestRevision > input.expectedRevision) return "server_revision_advanced";
  return arePlatformProjectPayloadsEqual(
    input.expectedSavedProject,
    input.latestServerProject,
  )
    ? "same_revision_match"
    : "same_revision_mismatch";
}
