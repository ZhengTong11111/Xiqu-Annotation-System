import { MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES } from "./annotationHistoryShadowRecipeService.js";

export type AnnotationHistoryStoredRecipeVerificationCliOptions = {
  annotationFileId: string;
  limitCandidates: number;
  statementTimeoutMs: number;
  outputPath?: string;
};

const VALUE_FLAGS = new Set([
  "--annotation-file-id",
  "--limit-candidates",
  "--statement-timeout-ms",
  "--output",
]);

/** 只读复核参数使用独立白名单，避免误接受 planner 的全库或写入选项。 */
export function parseAnnotationHistoryStoredRecipeVerificationCliOptions(
  args: readonly string[],
): AnnotationHistoryStoredRecipeVerificationCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!VALUE_FLAGS.has(argument)) throw new Error(`未知参数：${argument}。`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 ${argument} 缺少值。`);
    if (values.has(argument)) throw new Error(`参数 ${argument} 不能重复。`);
    values.set(argument, value);
    index += 1;
  }

  const annotationFileId = values.get("--annotation-file-id")?.trim();
  if (!annotationFileId || !isUuid(annotationFileId)) {
    throw new Error("必须提供完整的 --annotation-file-id <UUID>。");
  }
  const limitCandidates = boundedPositiveInteger(
    values.get("--limit-candidates"),
    16,
    MAX_ANNOTATION_HISTORY_SHADOW_CANDIDATES,
    "--limit-candidates",
  );
  const statementTimeoutMs = boundedPositiveInteger(
    values.get("--statement-timeout-ms"),
    30_000,
    300_000,
    "--statement-timeout-ms",
  );
  const outputPath = values.get("--output")?.trim();
  if (values.has("--output") && !outputPath) throw new Error("--output 不能为空。");
  return {
    annotationFileId,
    limitCandidates,
    statementTimeoutMs,
    ...(outputPath ? { outputPath } : {}),
  };
}

function boundedPositiveInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
  key: string,
) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${key} 必须是 1 到 ${maximum} 的整数。`);
  }
  return value;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
