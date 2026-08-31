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

// 自动收敛比普通“同 revision”更严格：保存基线必须确实漂移，而完整当前正文必须已由服务器满足。
// 这条规则只判断可持久化 ProjectData；pending、吸附设置和请求竞态由 document state 再次原子复核。
export function canReconcileSameRevisionAlreadySatisfied(input: {
  expectedRevision: number;
  latestRevision: number;
  expectedSavedProject: ProjectData;
  currentProject: ProjectData;
  latestServerProject: ProjectData;
}): boolean {
  return input.latestRevision === input.expectedRevision &&
    !arePlatformProjectPayloadsEqual(input.expectedSavedProject, input.latestServerProject) &&
    arePlatformProjectPayloadsEqual(input.currentProject, input.latestServerProject);
}
