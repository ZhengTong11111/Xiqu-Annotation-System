import {
  ANNOTATION_TRANSACTION_APPLY_COMMAND,
  parseAnnotationCommandEnvelope,
  TIMELINE_TIMING_UPDATE_COMMAND,
  TRACK_STRUCTURE_TRANSACTION_APPLY_COMMAND,
  type TimelineTimingUpdateItem,
} from "@xiqu/shared";
import { escapeCsvCell } from "./auditLogQuery.js";

export type AnnotationCorrectionOrigin = "manual_timing_edit" | "sentence_even_reset";

export type AnnotationCorrectionOperationFact = {
  id: string;
  annotationFileId: string;
  actorUserId: string;
  sequence: number;
  baseRevision: number;
  committedRevision: number | null;
  committedAt: Date | null;
  payload: unknown;
  toolAttempt: {
    id: string;
    eventName: string;
    sentenceId: string;
    entryPoint: string;
    invokedAt: Date;
    confirmedAt: Date | null;
    suppressPrompt: boolean;
    outcome: string | null;
  } | null;
};

export type AnnotationCorrectionDatasetRow = {
  annotationFileId: string;
  operationId: string;
  actorUserId: string;
  sequence: number;
  baseRevision: number;
  committedRevision: number;
  committedAt: Date;
  origin: AnnotationCorrectionOrigin;
  characterId: string;
  trackId: string | null;
  beforeStartMicros: number;
  beforeEndMicros: number;
  afterStartMicros: number;
  afterEndMicros: number;
  startDeltaMicros: number;
  endDeltaMicros: number;
  toolAttemptId: string | null;
  sentenceId: string | null;
  entryPoint: string | null;
  toolInvokedAt: Date | null;
  toolConfirmedAt: Date | null;
  suppressPrompt: boolean | null;
};

export const ANNOTATION_CORRECTION_DATASET_HEADER = [
  "标注文件 ID",
  "操作 ID",
  "账号 ID",
  "操作序号",
  "基础版本",
  "提交版本",
  "提交时间",
  "修正来源",
  "逐字 ID",
  "轨道 ID",
  "修改前开始微秒",
  "修改前结束微秒",
  "修改后开始微秒",
  "修改后结束微秒",
  "开始边界变化微秒",
  "结束边界变化微秒",
  "工具尝试 ID",
  "句子 ID",
  "工具入口",
  "工具调用时间",
  "工具确认时间",
  "本次打开不再提示",
] as const;

/**
 * 从一个已提交 operation 中提取逐字 timing 修正。
 * 解析入口复用 shared 严格命令合同，坏 payload、旧快照和其他实体不会被猜测为训练事实。
 */
export function extractAnnotationCorrectionRows(
  operation: AnnotationCorrectionOperationFact,
): AnnotationCorrectionDatasetRow[] {
  if (operation.committedRevision === null || operation.committedAt === null) return [];
  const timingItems = extractTimingItems(operation.payload)
    .filter((item) => item.entityType === "character");
  if (!timingItems.length) return [];

  const evenResetAttempt = operation.toolAttempt?.eventName === "sentence_character_even_timing_reset" &&
    operation.toolAttempt.outcome === "committed"
    ? operation.toolAttempt
    : null;
  return timingItems.map((item) => {
    const beforeStartMicros = secondsToMicros(item.before.startTime);
    const beforeEndMicros = secondsToMicros(item.before.endTime);
    const afterStartMicros = secondsToMicros(item.after.startTime);
    const afterEndMicros = secondsToMicros(item.after.endTime);
    return {
      annotationFileId: operation.annotationFileId,
      operationId: operation.id,
      actorUserId: operation.actorUserId,
      sequence: operation.sequence,
      baseRevision: operation.baseRevision,
      committedRevision: operation.committedRevision!,
      committedAt: operation.committedAt!,
      origin: evenResetAttempt ? "sentence_even_reset" : "manual_timing_edit",
      characterId: item.entityId,
      trackId: item.trackId ?? null,
      beforeStartMicros,
      beforeEndMicros,
      afterStartMicros,
      afterEndMicros,
      startDeltaMicros: afterStartMicros - beforeStartMicros,
      endDeltaMicros: afterEndMicros - beforeEndMicros,
      toolAttemptId: evenResetAttempt?.id ?? null,
      sentenceId: evenResetAttempt?.sentenceId ?? null,
      entryPoint: evenResetAttempt?.entryPoint ?? null,
      toolInvokedAt: evenResetAttempt?.invokedAt ?? null,
      toolConfirmedAt: evenResetAttempt?.confirmedAt ?? null,
      suppressPrompt: evenResetAttempt?.suppressPrompt ?? null,
    };
  });
}

/** CSV 仅投影固定数值和稳定 ID；不包含 ProjectData、文字正文、媒体 URL 或任意 details。 */
export function buildAnnotationCorrectionDatasetCsv(
  rows: readonly AnnotationCorrectionDatasetRow[],
) {
  const lines = rows.map((row) => [
    row.annotationFileId,
    row.operationId,
    row.actorUserId,
    row.sequence,
    row.baseRevision,
    row.committedRevision,
    row.committedAt.toISOString(),
    row.origin,
    row.characterId,
    row.trackId ?? "",
    row.beforeStartMicros,
    row.beforeEndMicros,
    row.afterStartMicros,
    row.afterEndMicros,
    row.startDeltaMicros,
    row.endDeltaMicros,
    row.toolAttemptId ?? "",
    row.sentenceId ?? "",
    row.entryPoint ?? "",
    row.toolInvokedAt?.toISOString() ?? "",
    row.toolConfirmedAt?.toISOString() ?? "",
    row.suppressPrompt === null ? "" : String(row.suppressPrompt),
  ]);
  return `\uFEFF${[ANNOTATION_CORRECTION_DATASET_HEADER, ...lines]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n")}\r\n`;
}

function extractTimingItems(payload: unknown): TimelineTimingUpdateItem[] {
  const envelope = parseAnnotationCommandEnvelope(payload);
  if (!envelope) return [];
  if (envelope.command.type === TIMELINE_TIMING_UPDATE_COMMAND) {
    return envelope.command.items;
  }
  if (envelope.command.type !== ANNOTATION_TRANSACTION_APPLY_COMMAND &&
    envelope.command.type !== TRACK_STRUCTURE_TRANSACTION_APPLY_COMMAND) {
    return [];
  }
  // 两种事务都只允许一层严格叶命令，因此无需递归或宽松遍历任意 JSON。
  return envelope.command.commands.flatMap((command) =>
    command.type === TIMELINE_TIMING_UPDATE_COMMAND ? command.items : []);
}

function secondsToMicros(seconds: number) {
  const micros = Math.round(seconds * 1_000_000);
  if (!Number.isSafeInteger(micros)) {
    throw new Error("逐字时间超出可导出的微秒范围。");
  }
  return micros;
}
