export const ANNOTATION_HISTORY_HOUR_MS = 60 * 60 * 1_000;

export type AnnotationHistoryCompactionPolicy = {
  hotWindowMs: number;
  recentSnapshotCount: number;
  checkpointRevisionInterval: number;
  checkpointOperationInterval: number;
  checkpointTimeIntervalMs: number;
};

export const DEFAULT_ANNOTATION_HISTORY_COMPACTION_POLICY = Object.freeze({
  hotWindowMs: 24 * ANNOTATION_HISTORY_HOUR_MS,
  recentSnapshotCount: 100,
  checkpointRevisionInterval: 100,
  checkpointOperationInterval: 500,
  checkpointTimeIntervalMs: 6 * ANNOTATION_HISTORY_HOUR_MS,
}) satisfies AnnotationHistoryCompactionPolicy;

export type AnnotationHistorySnapshotPolicyFact = {
  id: string;
  revision: number;
  reason: string | null;
  createdAt: Date;
};

export type AnnotationHistoryRevisionPolicyFact = {
  revision: number;
  operationCount: number;
  requiresSnapshot: boolean;
};

export type AnnotationHistoryKeepReason =
  | "first_snapshot"
  | "last_snapshot"
  | "scan_boundary"
  | "special_reason"
  | "hot_window"
  | "recent_revision"
  | "review_reference"
  | "before_non_replayable_boundary"
  | "after_non_replayable_boundary"
  | "periodic_revision_checkpoint"
  | "periodic_operation_checkpoint"
  | "periodic_time_checkpoint";

/**
 * 只根据轻量元数据选出必须保留完整 payload 的 revision。
 *
 * 规则取并集；任何强制检查点都会重置周期计数，避免在相邻位置制造没有恢复价值的重复检查点。
 */
export function selectRequiredInlineSnapshots(input: {
  snapshots: readonly AnnotationHistorySnapshotPolicyFact[];
  revisions: readonly AnnotationHistoryRevisionPolicyFact[];
  protectedRevisions: ReadonlySet<number>;
  now: Date;
  policy: AnnotationHistoryCompactionPolicy;
}) {
  validateAnnotationHistoryCompactionPolicy(input.policy);
  const snapshots = [...input.snapshots].sort((left, right) => left.revision - right.revision);
  const reasons = new Map<number, Set<AnnotationHistoryKeepReason>>();
  if (snapshots.length === 0) return reasons;

  const addReason = (revision: number, reason: AnnotationHistoryKeepReason) => {
    const current = reasons.get(revision) ?? new Set<AnnotationHistoryKeepReason>();
    current.add(reason);
    reasons.set(revision, current);
  };
  const snapshotRevisionSet = new Set(snapshots.map((snapshot) => snapshot.revision));
  addReason(snapshots[0]!.revision, "first_snapshot");
  addReason(snapshots.at(-1)!.revision, "last_snapshot");

  const hotWindowStart = input.now.getTime() - input.policy.hotWindowMs;
  const recentStartIndex = Math.max(0, snapshots.length - input.policy.recentSnapshotCount);
  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot.reason !== null && snapshot.reason !== "save") {
      addReason(snapshot.revision, "special_reason");
    }
    if (snapshot.createdAt.getTime() >= hotWindowStart) addReason(snapshot.revision, "hot_window");
    if (index >= recentStartIndex) addReason(snapshot.revision, "recent_revision");
    if (input.protectedRevisions.has(snapshot.revision)) {
      addReason(snapshot.revision, "review_reference");
    }
  }

  // 明确 requires-snapshot 的提交两侧都保留完整 payload，后续重放绝不能跨过该边界。
  for (const revision of input.revisions) {
    if (!revision.requiresSnapshot) continue;
    if (snapshotRevisionSet.has(revision.revision - 1)) {
      addReason(revision.revision - 1, "before_non_replayable_boundary");
    }
    if (snapshotRevisionSet.has(revision.revision)) {
      addReason(revision.revision, "after_non_replayable_boundary");
    }
  }

  const operationsByRevision = new Map(
    input.revisions.map((revision) => [revision.revision, revision.operationCount]),
  );
  let checkpoint = snapshots[0]!;
  let operationsSinceCheckpoint = 0;
  let previousSnapshotRevision = checkpoint.revision;
  for (const snapshot of snapshots.slice(1)) {
    for (let revision = previousSnapshotRevision + 1; revision <= snapshot.revision; revision += 1) {
      operationsSinceCheckpoint += operationsByRevision.get(revision) ?? 0;
    }
    previousSnapshotRevision = snapshot.revision;
    if (reasons.has(snapshot.revision)) {
      checkpoint = snapshot;
      operationsSinceCheckpoint = 0;
      continue;
    }

    const revisionDistance = snapshot.revision - checkpoint.revision;
    const timeDistance = snapshot.createdAt.getTime() - checkpoint.createdAt.getTime();
    if (revisionDistance >= input.policy.checkpointRevisionInterval) {
      addReason(snapshot.revision, "periodic_revision_checkpoint");
    }
    if (operationsSinceCheckpoint >= input.policy.checkpointOperationInterval) {
      addReason(snapshot.revision, "periodic_operation_checkpoint");
    }
    if (timeDistance >= input.policy.checkpointTimeIntervalMs) {
      addReason(snapshot.revision, "periodic_time_checkpoint");
    }
    if (reasons.has(snapshot.revision)) {
      checkpoint = snapshot;
      operationsSinceCheckpoint = 0;
    }
  }
  return reasons;
}

// CLI 覆盖值也必须经过同一门禁，防止零阈值把每个 revision 都误判成检查点。
export function validateAnnotationHistoryCompactionPolicy(
  policy: AnnotationHistoryCompactionPolicy,
) {
  const values = Object.values(policy);
  if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error("恢复快照规划策略必须全部使用正整数阈值。");
  }
}
