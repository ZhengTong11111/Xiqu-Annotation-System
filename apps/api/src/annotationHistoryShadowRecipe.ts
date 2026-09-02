import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import { createAnnotationHistoryCanonicalHash } from "./annotationHistoryCanonicalHash.js";
import {
  buildAnnotationHistoryRecipe,
  buildAnnotationHistoryRevisionValidations,
  replayAnnotationHistoryToRevision,
} from "./annotationHistoryCompactionReplay.js";
import type {
  AnnotationHistoryBlockCode,
  AnnotationHistoryOperationFact,
  AnnotationHistorySnapshotDecision,
  AnnotationHistorySnapshotFact,
} from "./annotationHistoryCompactionTypes.js";

export const ANNOTATION_HISTORY_SHADOW_RECIPE_VERSION = 1;

export type AnnotationHistoryShadowRecipe = NonNullable<
  AnnotationHistorySnapshotDecision["recipe"]
>;

export type AnnotationHistoryShadowVerificationCode =
  | AnnotationHistoryBlockCode
  | "checkpoint_identity_mismatch"
  | "checkpoint_payload_invalid"
  | "target_identity_mismatch"
  | "target_payload_invalid"
  | "target_payload_hash_changed"
  | "recipe_changed";

/**
 * 在写入影子元数据前重新证明 checkpoint + operation 链能够无损得到目标 payload。
 * 这里复用 HC1 的正式重放器和 canonical hash，不建立第二套近似验证逻辑。
 */
export function verifyAnnotationHistoryShadowRecipe(input: {
  annotationFileId: string;
  expectedTargetSnapshotId: string;
  checkpoint: AnnotationHistorySnapshotFact & { annotationFileId: string; payload: unknown };
  target: AnnotationHistorySnapshotFact & { annotationFileId: string; payload: unknown };
  operations: readonly AnnotationHistoryOperationFact[];
  expectedRecipe: AnnotationHistoryShadowRecipe;
}):
  | { ok: true; payloadHash: string; recipe: AnnotationHistoryShadowRecipe }
  | { ok: false; code: AnnotationHistoryShadowVerificationCode } {
  const { checkpoint, target, expectedRecipe } = input;
  if (
    checkpoint.annotationFileId !== input.annotationFileId ||
    checkpoint.id !== expectedRecipe.checkpointSnapshotId ||
    checkpoint.revision !== expectedRecipe.checkpointRevision
  ) {
    return { ok: false, code: "checkpoint_identity_mismatch" };
  }
  if (
    target.annotationFileId !== input.annotationFileId ||
    target.id !== input.expectedTargetSnapshotId ||
    target.revision !== expectedRecipe.operationRevisionEnd
  ) {
    return { ok: false, code: "target_identity_mismatch" };
  }

  const parsedCheckpoint = parseCurrentProjectData(checkpoint.payload);
  if (!parsedCheckpoint.success) return { ok: false, code: "checkpoint_payload_invalid" };
  const parsedTarget = parseCurrentProjectData(target.payload);
  if (!parsedTarget.success) return { ok: false, code: "target_payload_invalid" };

  const targetPayloadHash = createAnnotationHistoryCanonicalHash(target.payload);
  if (targetPayloadHash !== expectedRecipe.targetPayloadHash) {
    return { ok: false, code: "target_payload_hash_changed" };
  }
  const revisions = buildAnnotationHistoryRevisionValidations(
    input.annotationFileId,
    input.operations,
    checkpoint.revision,
    target.revision,
  );
  const replay = replayAnnotationHistoryToRevision({
    project: parsedCheckpoint.data,
    fromRevision: checkpoint.revision,
    toRevision: target.revision,
    revisions,
    operationScanTruncated: false,
  });
  if (!replay.project) return { ok: false, code: replay.blockCodes[0] ?? "operation_apply_failed" };
  if (createAnnotationHistoryCanonicalHash(replay.project) !== targetPayloadHash) {
    return { ok: false, code: "canonical_hash_mismatch" };
  }

  const recipe = buildAnnotationHistoryRecipe({
    checkpoint,
    target,
    targetPayloadHash,
    revisions,
  });
  if (!areAnnotationHistoryShadowRecipesEqual(recipe, expectedRecipe)) {
    return { ok: false, code: "recipe_changed" };
  }
  return { ok: true, payloadHash: targetPayloadHash, recipe };
}

/** estimatedBytes 只是 dry-run 报告值，不属于持久化 recipe 身份。 */
export function areAnnotationHistoryShadowRecipesEqual(
  left: AnnotationHistoryShadowRecipe,
  right: AnnotationHistoryShadowRecipe,
) {
  return left.version === right.version &&
    left.hashVersion === right.hashVersion &&
    left.checkpointSnapshotId === right.checkpointSnapshotId &&
    left.checkpointRevision === right.checkpointRevision &&
    left.operationRevisionStart === right.operationRevisionStart &&
    left.operationRevisionEnd === right.operationRevisionEnd &&
    left.operationSequenceStart === right.operationSequenceStart &&
    left.operationSequenceEnd === right.operationSequenceEnd &&
    left.operationCount === right.operationCount &&
    left.targetPayloadHash === right.targetPayloadHash;
}
