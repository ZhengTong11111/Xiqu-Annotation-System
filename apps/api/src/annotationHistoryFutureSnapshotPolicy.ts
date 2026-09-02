import type { AnnotationHistoryShadowRecipe } from "./annotationHistoryReconstruction.js";
import { ANNOTATION_HISTORY_CANONICAL_HASH_VERSION } from "./annotationHistoryCanonicalHash.js";

/** 未来快照的 rollout 名称必须显式写入代码，不使用时间戳猜测历史边界。 */
export const ANNOTATION_HISTORY_FUTURE_ROLLOUT =
  "future-reconstructible-v1" as const;
export const ANNOTATION_HISTORY_FUTURE_RECIPE_VERSION = 1 as const;
export const MAX_ANNOTATION_HISTORY_FUTURE_REPLAY_OPERATIONS = 10_000;

export type AnnotationHistoryFutureSnapshotRollout =
  | "disabled"
  | typeof ANNOTATION_HISTORY_FUTURE_ROLLOUT;

export type AnnotationHistoryFutureSnapshotProof =
  | {
      ok: true;
      payloadHash: string;
      recipe: AnnotationHistoryShadowRecipe;
    }
  | {
      ok: false;
      // 证明错误由唯一重建内核产生；策略只把它归入安全回退，不复制错误枚举。
      code: string;
    };

export type AnnotationHistoryFutureSnapshotDecision =
  | {
      storageMode: "inline";
      payloadRequired: true;
      recipe: null;
      fallbackReason: AnnotationHistoryFutureInlineReason;
    }
  | {
      storageMode: "reconstructible";
      payloadRequired: false;
      recipe: AnnotationHistoryShadowRecipe;
      fallbackReason: null;
    };

export type AnnotationHistoryFutureInlineReason =
  | "rollout_disabled"
  | "non_save_reason"
  | "checkpoint_required"
  | "proof_missing"
  | "proof_failed"
  | "proof_shape_invalid"
  | "replay_budget_exceeded";

/**
 * 未来快照唯一决策入口。
 *
 * 这个函数只消费保存事务已经准备好的轻量事实和“精确重建成功”证明：
 * 不在这里解析命令、不在这里 apply、不在这里计算 hash。历史 rollout 未
 * 明确开启、遇到检查点或任何证明不完整时，返回要求完整 payload 的 inline。
 */
export function decideFutureSnapshotStorage(input: {
  rollout: AnnotationHistoryFutureSnapshotRollout;
  reason: string | null | undefined;
  isCheckpoint: boolean;
  targetRevision: number;
  checkpointRevision: number;
  proof: AnnotationHistoryFutureSnapshotProof | null;
}): AnnotationHistoryFutureSnapshotDecision {
  if (input.rollout !== ANNOTATION_HISTORY_FUTURE_ROLLOUT) {
    return inline("rollout_disabled");
  }
  // 保护快照、恢复前快照和未来新增的特殊 reason 不能走轻量路径。
  if (input.reason !== "save") return inline("non_save_reason");
  // 检查点必须携带完整内容，后续 recipe 才有稳定的恢复起点。
  if (input.isCheckpoint) return inline("checkpoint_required");
  if (!input.proof) return inline("proof_missing");
  if (!input.proof.ok) return inline("proof_failed");
  if (
    !isValidFutureRecipeShape({
      recipe: input.proof.recipe,
      payloadHash: input.proof.payloadHash,
      targetRevision: input.targetRevision,
      checkpointRevision: input.checkpointRevision,
    })
  ) {
    return inline("proof_shape_invalid");
  }
  if (
    input.proof.recipe.operationCount >
    MAX_ANNOTATION_HISTORY_FUTURE_REPLAY_OPERATIONS
  ) {
    return inline("replay_budget_exceeded");
  }
  return {
    storageMode: "reconstructible",
    payloadRequired: false,
    recipe: input.proof.recipe,
    fallbackReason: null,
  };
}

/**
 * 轻量 recipe 的形状检查只守住数据库写入契约；内容等价性已经由重建内核
 * 证明，不能在此处增加第二套 parser、apply 或 hash 逻辑。
 */
function isValidFutureRecipeShape(input: {
  recipe: AnnotationHistoryShadowRecipe;
  payloadHash: string;
  targetRevision: number;
  checkpointRevision: number;
}) {
  const { recipe } = input;
  const integers = [
    recipe.version,
    recipe.checkpointRevision,
    recipe.operationRevisionStart,
    recipe.operationRevisionEnd,
    recipe.operationSequenceStart,
    recipe.operationSequenceEnd,
    recipe.operationCount,
  ];
  return recipe.version === ANNOTATION_HISTORY_FUTURE_RECIPE_VERSION &&
    recipe.hashVersion === ANNOTATION_HISTORY_CANONICAL_HASH_VERSION &&
    recipe.checkpointSnapshotId.trim().length > 0 &&
    integers.every((value) => Number.isSafeInteger(value) && value > 0) &&
    recipe.checkpointRevision === input.checkpointRevision &&
    recipe.operationRevisionStart === input.checkpointRevision + 1 &&
    recipe.operationRevisionEnd === input.targetRevision &&
    recipe.operationSequenceStart <= recipe.operationSequenceEnd &&
    recipe.operationCount > 0 &&
    recipe.operationCount <=
      recipe.operationSequenceEnd - recipe.operationSequenceStart + 1 &&
    /^[0-9a-f]{64}$/u.test(input.payloadHash) &&
    recipe.targetPayloadHash === input.payloadHash;
}

/** inline 是所有未知、失败和未启用情况的唯一安全结果。 */
function inline(
  fallbackReason: AnnotationHistoryFutureInlineReason,
): AnnotationHistoryFutureSnapshotDecision {
  return {
    storageMode: "inline",
    payloadRequired: true,
    recipe: null,
    fallbackReason,
  };
}
