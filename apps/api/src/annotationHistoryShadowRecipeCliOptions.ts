import {
  parseAnnotationHistoryCompactionCliOptions,
  type AnnotationHistoryCompactionCliOptions,
} from "./annotationHistoryCompactionCliOptions.js";
import { MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES } from "./annotationHistoryShadowRecipeService.js";

export type AnnotationHistoryShadowRecipeCliOptions = {
  apply: boolean;
  limitCandidates: number;
  planner: AnnotationHistoryCompactionCliOptions & { annotationFileId: string; scanAll: false };
};

/**
 * 影子写入 CLI 复用 HC1 的策略和扫描上限解析，只额外接受显式 apply 与候选批次。
 * 全库模式在这一阶段被禁止，防止一次误操作写满生产历史。
 */
export function parseAnnotationHistoryShadowRecipeCliOptions(
  args: readonly string[],
): AnnotationHistoryShadowRecipeCliOptions {
  const plannerArgs: string[] = [];
  let apply = false;
  let limitCandidates = 16;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--apply") {
      if (apply) throw new Error("--apply 不能重复。");
      apply = true;
      continue;
    }
    if (argument === "--limit-candidates") {
      const raw = args[index + 1];
      if (!raw || raw.startsWith("--")) throw new Error("--limit-candidates 缺少值。");
      const parsed = Number(raw);
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES
      ) {
        throw new Error(
          `--limit-candidates 必须是 1 到 ${MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES} 的整数。`,
        );
      }
      limitCandidates = parsed;
      index += 1;
      continue;
    }
    plannerArgs.push(argument);
  }

  const planner = parseAnnotationHistoryCompactionCliOptions(plannerArgs);
  if (planner.scanAll || !planner.annotationFileId) {
    throw new Error("影子 recipe 阶段只允许 --annotation-file-id <UUID> 单文件范围。");
  }
  return {
    apply,
    limitCandidates,
    planner: { ...planner, annotationFileId: planner.annotationFileId, scanAll: false },
  };
}
