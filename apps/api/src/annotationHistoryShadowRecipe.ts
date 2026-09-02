import {
  reconstructAnnotationHistoryPayload,
  type AnnotationHistoryReconstructionCode,
  type AnnotationHistoryShadowRecipe,
} from "./annotationHistoryReconstruction.js";
import type {
  AnnotationHistoryOperationFact,
  AnnotationHistorySnapshotFact,
} from "./annotationHistoryCompactionTypes.js";

export {
  ANNOTATION_HISTORY_SHADOW_RECIPE_VERSION,
  areAnnotationHistoryShadowRecipesEqual,
} from "./annotationHistoryReconstruction.js";
export type { AnnotationHistoryShadowRecipe } from "./annotationHistoryReconstruction.js";

export type AnnotationHistoryShadowVerificationCode = AnnotationHistoryReconstructionCode;

/**
 * 在写入影子元数据前重新证明 checkpoint + operation 链能够无损得到仍在场的目标 payload。
 * 重放、hash 和 recipe 复核全部委托给统一重建内核，避免未来 resolver 复制逻辑。
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
  const reconstruction = reconstructAnnotationHistoryPayload({
    annotationFileId: input.annotationFileId,
    expectedTargetSnapshotId: input.expectedTargetSnapshotId,
    checkpoint: input.checkpoint,
    target: input.target,
    inlineTargetPayload: input.target.payload,
    operations: input.operations,
    expectedRecipe: input.expectedRecipe,
  });
  if (!reconstruction.ok) return reconstruction;
  return {
    ok: true,
    payloadHash: reconstruction.payloadHash,
    recipe: reconstruction.recipe,
  };
}
