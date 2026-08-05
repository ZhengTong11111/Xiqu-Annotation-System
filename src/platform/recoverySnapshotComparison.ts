import type {
  AnnotationFile,
  AnnotationRecoverySnapshotDetail,
} from "@xiqu/shared";
import {
  buildAnnotationDiff,
  type AnnotationDiffBuildError,
  type AnnotationDiffResult,
} from "./annotationDiff";
import type { ProjectData } from "../types";

export type RecoverySnapshotComparisonResult =
  | {
      ok: true;
      snapshotRevision: number;
      currentRevision: number;
      diff: AnnotationDiffResult;
      snapshotProject: ProjectData;
      currentProject: ProjectData;
    }
  | {
      ok: false;
      errors: AnnotationDiffBuildError[];
    };

// 快照比较固定左侧为历史、右侧为当前文件，并复用普通文件比较的唯一迁移与稳定 id diff 入口。
export function buildRecoverySnapshotComparison(input: {
  snapshot: AnnotationRecoverySnapshotDetail<unknown>;
  currentFile: AnnotationFile<unknown>;
}): RecoverySnapshotComparisonResult {
  const comparison = buildAnnotationDiff(
    input.snapshot.payload,
    input.currentFile.payload,
  );
  if (!comparison.ok) return comparison;
  return {
    ok: true,
    snapshotRevision: input.snapshot.revision,
    currentRevision: input.currentFile.revision,
    diff: comparison.diff,
    snapshotProject: comparison.leftProject,
    currentProject: comparison.rightProject,
  };
}
