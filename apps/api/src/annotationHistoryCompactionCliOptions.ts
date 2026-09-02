import {
  ANNOTATION_HISTORY_HOUR_MS,
  type AnnotationHistoryCompactionPolicy,
} from "./annotationHistoryCompactionPolicy.js";
import {
  MAX_ANNOTATION_HISTORY_OPERATIONS_PER_FILE,
  MAX_ANNOTATION_HISTORY_REVISIONS_PER_FILE,
} from "./annotationHistoryCompactionTypes.js";

export type AnnotationHistoryCompactionCliOptions = {
  annotationFileId?: string;
  scanAll: boolean;
  limitFiles?: number;
  maxRevisionsPerFile: number;
  maxOperationsPerFile: number;
  statementTimeoutMs: number;
  outputPath?: string;
  policy: AnnotationHistoryCompactionPolicy;
};

const VALUE_FLAGS = new Set([
  "--annotation-file-id",
  "--limit-files",
  "--max-revisions",
  "--max-operations",
  "--statement-timeout-ms",
  "--output",
  "--recent-hours",
  "--recent-snapshots",
  "--checkpoint-revisions",
  "--checkpoint-operations",
  "--checkpoint-hours",
]);

/** CLI 参数严格白名单解析，避免拼写错误静默退化成一次范围更大的扫描。 */
export function parseAnnotationHistoryCompactionCliOptions(
  args: readonly string[],
): AnnotationHistoryCompactionCliOptions {
  const values = new Map<string, string>();
  let scanAll = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--all") {
      if (scanAll) throw new Error("--all 不能重复。");
      scanAll = true;
      continue;
    }
    if (!VALUE_FLAGS.has(argument)) throw new Error(`未知参数：${argument}。`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 ${argument} 缺少值。`);
    if (values.has(argument)) throw new Error(`参数 ${argument} 不能重复。`);
    values.set(argument, value);
    index += 1;
  }

  const annotationFileId = values.get("--annotation-file-id")?.trim();
  if (scanAll === Boolean(annotationFileId)) {
    throw new Error("必须且只能选择 --all 或 --annotation-file-id <UUID>。 ");
  }
  if (annotationFileId && !isUuid(annotationFileId)) {
    throw new Error("--annotation-file-id 必须是完整 UUID。");
  }
  const limitFiles = optionalPositiveInteger(values, "--limit-files");
  if (limitFiles !== undefined && !scanAll) {
    throw new Error("--limit-files 只能和 --all 一起使用。");
  }

  const policy = {
    hotWindowMs: positiveNumber(values, "--recent-hours", 24) * ANNOTATION_HISTORY_HOUR_MS,
    recentSnapshotCount: positiveInteger(values, "--recent-snapshots", 100),
    checkpointRevisionInterval: positiveInteger(values, "--checkpoint-revisions", 100),
    checkpointOperationInterval: positiveInteger(values, "--checkpoint-operations", 500),
    checkpointTimeIntervalMs:
      positiveNumber(values, "--checkpoint-hours", 6) * ANNOTATION_HISTORY_HOUR_MS,
  } satisfies AnnotationHistoryCompactionPolicy;
  return {
    ...(annotationFileId ? { annotationFileId } : {}),
    scanAll,
    ...(limitFiles === undefined ? {} : { limitFiles }),
    maxRevisionsPerFile: boundedPositiveInteger(
      values,
      "--max-revisions",
      10_000,
      MAX_ANNOTATION_HISTORY_REVISIONS_PER_FILE,
    ),
    maxOperationsPerFile: boundedPositiveInteger(
      values,
      "--max-operations",
      100_000,
      MAX_ANNOTATION_HISTORY_OPERATIONS_PER_FILE,
    ),
    statementTimeoutMs: positiveInteger(values, "--statement-timeout-ms", 30_000),
    ...(values.get("--output") ? { outputPath: values.get("--output")! } : {}),
    policy,
  };
}

// 数值参数共用严格 helper，避免不同阈值接受零、小数或超出安全整数范围。
function positiveInteger(values: ReadonlyMap<string, string>, key: string, fallback: number) {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} 必须是正整数。`);
  return value;
}

// 可选整数只有在显式出现时才进入最终选项，保留“未设置”和默认值的区别。
function optionalPositiveInteger(values: ReadonlyMap<string, string>, key: string) {
  return values.has(key) ? positiveInteger(values, key, 1) : undefined;
}

// payload/operation 扫描上限不可由操作者无限放大，防止一条命令吃满 API 主机内存。
function boundedPositiveInteger(
  values: ReadonlyMap<string, string>,
  key: string,
  fallback: number,
  maximum: number,
) {
  const value = positiveInteger(values, key, fallback);
  if (value > maximum) throw new Error(`${key} 不能超过 ${maximum}。`);
  return value;
}

// 小时阈值允许合理小数，但落到毫秒后必须仍是安全整数。
function positiveNumber(values: ReadonlyMap<string, string>, key: string, fallback: number) {
  const raw = values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} 必须是正数。`);
  const milliseconds = value * ANNOTATION_HISTORY_HOUR_MS;
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`${key} 超出支持范围。`);
  return value;
}

// 资源 id 采用标准 UUID；提前拒绝错误 id 可以避免一次无意义数据库扫描。
function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
