import {
  ANNOTATION_TOOL_ATTEMPT_REASON_CODES,
  type AnnotationToolAttemptReasonCode,
} from "@xiqu/shared";
import { escapeCsvCell } from "./auditLogQuery.js";

/** 导出只依赖旁表中的固定轻量列，禁止把 Prisma 完整行或关联内容直接序列化进 CSV。 */
export type AnnotationToolAttemptExportRow = {
  id: string;
  eventName: string;
  actorUserId: string | null;
  annotationFileId: string | null;
  sentenceId: string;
  entryPoint: string;
  invokedAt: Date;
  confirmedAt: Date | null;
  finishedAt: Date | null;
  outcome: string | null;
  suppressPrompt: boolean;
  characterCount: number;
  sentenceDurationMs: number;
  annotationOperationId: string | null;
  committedRevision: number | null;
  details: unknown;
  createdAt: Date;
  updatedAt: Date;
};

const REASON_CODES = new Set<string>(ANNOTATION_TOOL_ATTEMPT_REASON_CODES);

export const ANNOTATION_TOOL_ATTEMPT_EXPORT_HEADER = [
  "尝试 ID",
  "事件",
  "入口",
  "调用时间",
  "确认时间",
  "结束时间",
  "结果",
  "本次打开不再提示",
  "字符数",
  "句长毫秒",
  "原因码",
  "账号 ID",
  "标注文件 ID",
  "句子 ID",
  "标注操作 ID",
  "提交版本",
  "记录创建时间",
  "记录更新时间",
] as const;

/**
 * CSV 仅投影训练溯源所需的固定字段。details 即使存在历史异常值，也只允许已知 reasonCode 离开服务端。
 */
export function buildAnnotationToolAttemptCsv(
  rows: readonly AnnotationToolAttemptExportRow[],
): string {
  const lines = rows.map((row) => [
    row.id,
    row.eventName,
    row.entryPoint,
    row.invokedAt.toISOString(),
    row.confirmedAt?.toISOString() ?? "",
    row.finishedAt?.toISOString() ?? "",
    row.outcome ?? "pending",
    row.suppressPrompt ? "true" : "false",
    row.characterCount,
    row.sentenceDurationMs,
    readReasonCode(row.details) ?? "",
    row.actorUserId ?? "",
    row.annotationFileId ?? "",
    row.sentenceId,
    row.annotationOperationId ?? "",
    row.committedRevision ?? "",
    row.createdAt.toISOString(),
    row.updatedAt.toISOString(),
  ]);
  return `\uFEFF${[ANNOTATION_TOOL_ATTEMPT_EXPORT_HEADER, ...lines]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n")}\r\n`;
}

function readReasonCode(value: unknown): AnnotationToolAttemptReasonCode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reasonCode = (value as Record<string, unknown>).reasonCode;
  return typeof reasonCode === "string" && REASON_CODES.has(reasonCode)
    ? reasonCode as AnnotationToolAttemptReasonCode
    : null;
}
