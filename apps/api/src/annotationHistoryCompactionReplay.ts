import {
  applyAnnotationCommandToProject,
  type ProjectData,
} from "@xiqu/document-model";
import {
  isReplayableAnnotationCommandEnvelope,
  parseAnnotationCommandEnvelope,
} from "@xiqu/shared";
import {
  ANNOTATION_HISTORY_CANONICAL_HASH_VERSION,
  measureAnnotationHistoryJsonBytes,
} from "./annotationHistoryCanonicalHash.js";
import type { AnnotationHistoryRevisionPolicyFact } from "./annotationHistoryCompactionPolicy.js";
import type {
  AnnotationHistoryBlockCode,
  AnnotationHistoryOperationFact,
  AnnotationHistoryRevisionValidation,
  AnnotationHistorySnapshotDecision,
  AnnotationHistorySnapshotFact,
} from "./annotationHistoryCompactionTypes.js";

// 先把数据库行压成 revision 级门禁，策略选择和真实重放共用同一份事实，避免两边判断漂移。
export function buildAnnotationHistoryRevisionValidations(
  annotationFileId: string,
  operations: readonly AnnotationHistoryOperationFact[],
  firstRevision: number,
  lastRevision: number,
) {
  const grouped = new Map<number, AnnotationHistoryOperationFact[]>();
  const sequenceCounts = new Map<number, number>();
  for (const operation of operations) {
    const group = grouped.get(operation.committedRevision) ?? [];
    group.push(operation);
    grouped.set(operation.committedRevision, group);
    sequenceCounts.set(operation.sequence, (sequenceCounts.get(operation.sequence) ?? 0) + 1);
  }
  const validations = new Map<number, AnnotationHistoryRevisionValidation>();
  for (let revision = firstRevision + 1; revision <= lastRevision; revision += 1) {
    const revisionOperations = [...(grouped.get(revision) ?? [])]
      .sort((left, right) => left.sequence - right.sequence);
    const blockCodes = new Set<AnnotationHistoryBlockCode>();
    const sequences = new Set<number>();
    let requiresSnapshot = false;
    if (revisionOperations.length === 0) blockCodes.add("operation_revision_missing");
    for (const operation of revisionOperations) {
      if (operation.annotationFileId !== annotationFileId) blockCodes.add("operation_file_mismatch");
      if (operation.baseRevision !== revision - 1) blockCodes.add("operation_base_revision_mismatch");
      if (operation.status !== "accepted") blockCodes.add("operation_status_invalid");
      if (!operation.committedAt) blockCodes.add("operation_commit_timestamp_missing");
      if (sequences.has(operation.sequence) || (sequenceCounts.get(operation.sequence) ?? 0) > 1) {
        blockCodes.add("operation_sequence_duplicate");
      }
      sequences.add(operation.sequence);
      const envelope = parseAnnotationCommandEnvelope(operation.payload);
      if (!envelope) {
        blockCodes.add("operation_command_invalid");
        requiresSnapshot = true;
      } else {
        if (envelope.command.type !== operation.action) {
          blockCodes.add("operation_action_mismatch");
          requiresSnapshot = true;
        }
        if (!isReplayableAnnotationCommandEnvelope(envelope)) {
          blockCodes.add("operation_requires_snapshot");
          requiresSnapshot = true;
        }
      }
    }
    validations.set(revision, {
      revision,
      operations: revisionOperations,
      operationCount: revisionOperations.length,
      requiresSnapshot,
      blockCodes: [...blockCodes].sort(),
    });
  }
  return validations;
}

// 从当前可信 payload 严格逐 revision apply；任一组不完整都立即停止，绝不跳过后继续拼接。
export function replayAnnotationHistoryToRevision(input: {
  project: ProjectData;
  fromRevision: number;
  toRevision: number;
  revisions: ReadonlyMap<number, AnnotationHistoryRevisionValidation>;
  operationScanTruncated: boolean;
}) {
  if (input.operationScanTruncated) {
    return { project: null, blockCodes: ["operation_scan_truncated" as const] };
  }
  let project = input.project;
  for (let revision = input.fromRevision + 1; revision <= input.toRevision; revision += 1) {
    const validation = input.revisions.get(revision);
    if (!validation) {
      return { project: null, blockCodes: ["operation_revision_missing" as const] };
    }
    if (validation.blockCodes.length > 0) {
      return { project: null, blockCodes: validation.blockCodes };
    }
    for (const operation of validation.operations) {
      const applied = applyAnnotationCommandToProject(project, operation.payload);
      if (applied.status !== "applied") {
        return { project: null, blockCodes: ["operation_apply_failed" as const] };
      }
      project = applied.project;
    }
  }
  return { project, blockCodes: [] as AnnotationHistoryBlockCode[] };
}

// recipe 只记录定位、范围和 hash，不复制 operation payload 或标注正文。
export function buildAnnotationHistoryRecipe(input: {
  checkpoint: AnnotationHistorySnapshotFact;
  target: AnnotationHistorySnapshotFact;
  targetPayloadHash: string;
  revisions: ReadonlyMap<number, AnnotationHistoryRevisionValidation>;
}): NonNullable<AnnotationHistorySnapshotDecision["recipe"]> {
  const operations: AnnotationHistoryOperationFact[] = [];
  for (let revision = input.checkpoint.revision + 1; revision <= input.target.revision; revision += 1) {
    operations.push(...(input.revisions.get(revision)?.operations ?? []));
  }
  const sequences = operations.map((operation) => operation.sequence);
  const recipeWithoutSize = {
    version: 1 as const,
    hashVersion: ANNOTATION_HISTORY_CANONICAL_HASH_VERSION,
    checkpointSnapshotId: input.checkpoint.id,
    checkpointRevision: input.checkpoint.revision,
    operationRevisionStart: input.checkpoint.revision + 1,
    operationRevisionEnd: input.target.revision,
    operationSequenceStart: Math.min(...sequences),
    operationSequenceEnd: Math.max(...sequences),
    operationCount: operations.length,
    targetPayloadHash: input.targetPayloadHash,
  };
  return {
    ...recipeWithoutSize,
    estimatedBytes: measureAnnotationHistoryJsonBytes(recipeWithoutSize),
  };
}

// 策略层只消费计数和 snapshot-boundary 事实，不接触命令内容。
export function toAnnotationHistoryPolicyRevisionFact(
  validation: AnnotationHistoryRevisionValidation,
): AnnotationHistoryRevisionPolicyFact {
  return {
    revision: validation.revision,
    operationCount: validation.operationCount,
    requiresSnapshot: validation.requiresSnapshot,
  };
}
