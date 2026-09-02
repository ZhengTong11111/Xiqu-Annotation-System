import type { ProjectData } from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import { ANNOTATION_HISTORY_CANONICAL_HASH_VERSION, createAnnotationHistoryCanonicalHash } from "./annotationHistoryCanonicalHash.js";
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

export type AnnotationHistoryReconstructionCode =
  | AnnotationHistoryBlockCode
  | "checkpoint_identity_mismatch"
  | "checkpoint_payload_invalid"
  | "target_identity_mismatch"
  | "target_payload_invalid"
  | "target_payload_hash_changed"
  | "recipe_invalid"
  | "recipe_changed";

type AnnotationHistoryReconstructionSnapshot = AnnotationHistorySnapshotFact & {
  annotationFileId: string;
};

/**
 * 使用持久化 recipe 严格重建一个当前格式恢复快照。
 * 函数只消费调用方已经有界读取的事实，不查询数据库，也不在失败结果中返回正文或 operation 内容。
 */
export function reconstructAnnotationHistoryPayload(input: {
  annotationFileId: string;
  expectedTargetSnapshotId: string;
  checkpoint: AnnotationHistoryReconstructionSnapshot & { payload: unknown };
  target: AnnotationHistoryReconstructionSnapshot;
  inlineTargetPayload?: unknown;
  operations: readonly AnnotationHistoryOperationFact[];
  expectedRecipe: AnnotationHistoryShadowRecipe;
}):
  | {
      ok: true;
      payload: ProjectData;
      payloadHash: string;
      recipe: AnnotationHistoryShadowRecipe;
    }
  | { ok: false; code: AnnotationHistoryReconstructionCode } {
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
  if (!isValidReconstructionRecipe(checkpoint, target, expectedRecipe)) {
    return { ok: false, code: "recipe_invalid" };
  }

  const parsedCheckpoint = parseCurrentProjectData(checkpoint.payload);
  if (!parsedCheckpoint.success) return { ok: false, code: "checkpoint_payload_invalid" };

  // HC3a 仍有目标 inline payload 时同时复核其格式与 hash；未来真实重建不依赖这一份待回收正文。
  if (input.inlineTargetPayload !== undefined) {
    const parsedTarget = parseCurrentProjectData(input.inlineTargetPayload);
    if (!parsedTarget.success) return { ok: false, code: "target_payload_invalid" };
    if (createAnnotationHistoryCanonicalHash(input.inlineTargetPayload) !== expectedRecipe.targetPayloadHash) {
      return { ok: false, code: "target_payload_hash_changed" };
    }
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

  const payloadHash = createAnnotationHistoryCanonicalHash(replay.project);
  if (payloadHash !== expectedRecipe.targetPayloadHash) {
    return { ok: false, code: "canonical_hash_mismatch" };
  }
  const recipe = buildAnnotationHistoryRecipe({
    checkpoint,
    target,
    targetPayloadHash: payloadHash,
    revisions,
  });
  if (!areAnnotationHistoryShadowRecipesEqual(recipe, expectedRecipe)) {
    return { ok: false, code: "recipe_changed" };
  }
  return { ok: true, payload: replay.project, payloadHash, recipe };
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

function isValidReconstructionRecipe(
  checkpoint: AnnotationHistoryReconstructionSnapshot,
  target: AnnotationHistoryReconstructionSnapshot,
  recipe: AnnotationHistoryShadowRecipe,
) {
  // 持久化 recipe 必须自洽且严格连接 checkpoint 与目标；非法范围不能进入命令重放器。
  const integers = [
    checkpoint.revision,
    target.revision,
    recipe.version,
    recipe.checkpointRevision,
    recipe.operationRevisionStart,
    recipe.operationRevisionEnd,
    recipe.operationSequenceStart,
    recipe.operationSequenceEnd,
    recipe.operationCount,
  ];
  return checkpoint.id.trim().length > 0 && checkpoint.id !== target.id &&
    target.id.trim().length > 0 &&
    integers.every((value) => Number.isSafeInteger(value) && value > 0) &&
    recipe.version === ANNOTATION_HISTORY_SHADOW_RECIPE_VERSION &&
    recipe.hashVersion === ANNOTATION_HISTORY_CANONICAL_HASH_VERSION &&
    recipe.operationRevisionStart === checkpoint.revision + 1 &&
    recipe.operationRevisionEnd === target.revision &&
    recipe.operationRevisionStart <= recipe.operationRevisionEnd &&
    recipe.operationSequenceStart <= recipe.operationSequenceEnd &&
    recipe.operationCount <= recipe.operationSequenceEnd - recipe.operationSequenceStart + 1 &&
    /^[0-9a-f]{64}$/u.test(recipe.targetPayloadHash);
}
