import type {
  AnnotationRecoverySnapshotPage,
  AnnotationRecoverySnapshotSummary,
} from "@xiqu/shared";

export type RecoverySnapshotPagingState = {
  summaries: AnnotationRecoverySnapshotSummary[];
  nextCursor: string | null;
};

/**
 * 刷新替换现有页面，续页则按 snapshot id 去重追加。服务端顺序是权威顺序，客户端不按时间重新排序。
 */
export function applyRecoverySnapshotPage(
  current: RecoverySnapshotPagingState,
  page: AnnotationRecoverySnapshotPage,
  mode: "replace" | "append",
): RecoverySnapshotPagingState {
  const source = mode === "replace"
    ? page.snapshots
    : [...current.summaries, ...page.snapshots];
  const seen = new Set<string>();
  return {
    summaries: source.filter((summary) => {
      if (seen.has(summary.id)) return false;
      seen.add(summary.id);
      return true;
    }),
    nextCursor: page.nextCursor,
  };
}
