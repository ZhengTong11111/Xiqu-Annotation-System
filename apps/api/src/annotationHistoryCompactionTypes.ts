import type { ProjectData } from "@xiqu/document-model";
import type { ANNOTATION_HISTORY_CANONICAL_HASH_VERSION } from "./annotationHistoryCanonicalHash.js";
import type {
  AnnotationHistoryCompactionPolicy,
  AnnotationHistoryKeepReason,
  AnnotationHistorySnapshotPolicyFact,
} from "./annotationHistoryCompactionPolicy.js";

export const ANNOTATION_HISTORY_COMPACTION_PLAN_VERSION = 1;
export const MAX_ANNOTATION_HISTORY_REVISIONS_PER_FILE = 10_000;
export const MAX_ANNOTATION_HISTORY_OPERATIONS_PER_FILE = 200_000;

export type AnnotationHistorySnapshotFact = AnnotationHistorySnapshotPolicyFact;

export type AnnotationHistoryOperationFact = {
  id: string;
  annotationFileId: string;
  sequence: number;
  baseRevision: number;
  action: string;
  payload: unknown;
  status: "accepted" | "rejected" | "superseded";
  committedRevision: number;
  committedAt: Date | null;
};

// repository 合同刻意没有任何 mutation 方法，使 planner 在类型层就无法写数据库。
export type AnnotationHistoryCompactionRepository = {
  listAnnotationFileIds(input: {
    afterId: string | null;
    take: number;
  }): Promise<string[]>;
  listSnapshots(input: {
    annotationFileId: string;
    maxRevisions: number;
  }): Promise<{ items: AnnotationHistorySnapshotFact[]; truncated: boolean }>;
  listCommittedOperations(input: {
    annotationFileId: string;
    fromRevisionExclusive: number;
    toRevisionInclusive: number;
    maxOperations: number;
  }): Promise<{ items: AnnotationHistoryOperationFact[]; truncated: boolean }>;
  listProtectedRevisions(input: {
    annotationFileId: string;
    maxRevisions: number;
  }): Promise<{ revisions: Set<number>; truncated: boolean }>;
  loadSnapshotPayload(input: {
    annotationFileId: string;
    snapshotId: string;
  }): Promise<unknown | null>;
};

export type AnnotationHistoryBlockCode =
  | "snapshot_payload_missing"
  | "snapshot_payload_invalid"
  | "snapshot_scan_truncated"
  | "protected_revision_scan_truncated"
  | "checkpoint_unavailable"
  | "operation_scan_truncated"
  | "operation_revision_missing"
  | "operation_file_mismatch"
  | "operation_base_revision_mismatch"
  | "operation_status_invalid"
  | "operation_commit_timestamp_missing"
  | "operation_sequence_duplicate"
  | "operation_action_mismatch"
  | "operation_command_invalid"
  | "operation_requires_snapshot"
  | "operation_apply_failed"
  | "canonical_hash_mismatch";

export type AnnotationHistorySnapshotDecision = {
  snapshotId: string;
  revision: number;
  decision: "keep_inline" | "reconstructible" | "blocked";
  keepReasons: AnnotationHistoryKeepReason[];
  blockCodes: AnnotationHistoryBlockCode[];
  payloadBytes: number;
  payloadHash: string | null;
  recipe: {
    version: 1;
    hashVersion: typeof ANNOTATION_HISTORY_CANONICAL_HASH_VERSION;
    checkpointSnapshotId: string;
    checkpointRevision: number;
    operationRevisionStart: number;
    operationRevisionEnd: number;
    operationSequenceStart: number;
    operationSequenceEnd: number;
    operationCount: number;
    targetPayloadHash: string;
    estimatedBytes: number;
  } | null;
};

export type AnnotationHistoryFilePlan = {
  annotationFileId: string;
  snapshotCount: number;
  operationCount: number;
  protectedRevisionCount: number;
  protectedRevisionScanTruncated: boolean;
  unmatchedProtectedRevisions: number[];
  snapshotScanTruncated: boolean;
  operationScanTruncated: boolean;
  payloadBytes: number;
  estimatedRecipeBytes: number;
  estimatedReclaimableBytes: number;
  maxReplayRevisionDistance: number;
  maxReplayOperationCount: number;
  blockCodeCounts: Partial<Record<AnnotationHistoryBlockCode, number>>;
  decisions: AnnotationHistorySnapshotDecision[];
  errorCode: "repository_read_failed" | null;
};

export type AnnotationHistoryCompactionPlan = {
  version: 1;
  mode: "dry-run";
  generatedAt: string;
  interrupted: boolean;
  policy: AnnotationHistoryCompactionPolicy;
  limits: {
    maxRevisionsPerFile: number;
    maxOperationsPerFile: number;
    limitFiles: number | null;
  };
  files: AnnotationHistoryFilePlan[];
  summary: {
    fileCount: number;
    snapshotCount: number;
    operationCount: number;
    keepInlineCount: number;
    reconstructibleCount: number;
    blockedCount: number;
    payloadBytes: number;
    estimatedRecipeBytes: number;
    estimatedReclaimableBytes: number;
    maxReplayRevisionDistance: number;
    maxReplayOperationCount: number;
    blockCodeCounts: Partial<Record<AnnotationHistoryBlockCode, number>>;
  };
};

export type AnnotationHistoryCompactionPlannerOptions = {
  annotationFileId?: string;
  limitFiles?: number;
  maxRevisionsPerFile: number;
  maxOperationsPerFile: number;
  policy?: AnnotationHistoryCompactionPolicy;
  now?: Date;
  signal?: AbortSignal;
  onFilePlanned?: (progress: {
    annotationFileId: string;
    completedFileCount: number;
    snapshotCount: number;
  }) => void;
};

export type AnnotationHistoryRevisionValidation = {
  revision: number;
  operations: AnnotationHistoryOperationFact[];
  operationCount: number;
  requiresSnapshot: boolean;
  blockCodes: AnnotationHistoryBlockCode[];
};

// 加载结果只在单次循环中存活；报告永远不会携带 payload 或 ProjectData。
export type AnnotationHistoryLoadedSnapshot = {
  payload: unknown | null;
  payloadBytes: number;
  payloadHash: string;
  project: ProjectData | null;
};
