import type { AnnotationOperation, AnnotationToolAttempt, PrismaClient } from "@prisma/client";
import {
  ANNOTATION_TRANSACTION_APPLY_COMMAND,
  TIMELINE_TIMING_UPDATE_COMMAND,
  TRACK_STRUCTURE_TRANSACTION_APPLY_COMMAND,
} from "@xiqu/shared";
import {
  buildAnnotationCorrectionDatasetCsv,
  extractAnnotationCorrectionRows,
  type AnnotationCorrectionDatasetRow,
  type AnnotationCorrectionOperationFact,
} from "./annotationCorrectionDataset.js";
import type { ApiUser } from "./domain.js";
import { badRequest } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_EXPORTED_ROWS = 10_000;
const MAX_SCANNED_OPERATIONS = 10_000;
const OPERATION_BATCH_SIZE = 500;

type OperationWithAttempt = Pick<
  AnnotationOperation,
  "id" | "annotationFileId" | "actorUserId" | "sequence" | "baseRevision" |
  "committedRevision" | "committedAt" | "payload"
> & {
  toolAttempt: Pick<
    AnnotationToolAttempt,
    "id" | "eventName" | "sentenceId" | "entryPoint" | "invokedAt" |
    "confirmedAt" | "suppressPrompt" | "outcome"
  > | null;
};

export type AnnotationCorrectionDatasetExport = {
  csv: string;
  exportedRowCount: number;
  scannedOperationCount: number;
  truncated: boolean;
};

/** 模型改进数据只读既有 operation/attempt；本服务不得创建任务、预测、训练包或复制标注正文。 */
export class AnnotationCorrectionDatasetService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async exportCorrections(
    user: ApiUser,
    input: { from: Date; to: Date },
  ): Promise<AnnotationCorrectionDatasetExport> {
    await this.access.assertFullResourceAccess(user);
    assertTimeWindow(input);
    const rows: AnnotationCorrectionDatasetRow[] = [];
    let cursor: { committedAt: Date; id: string } | null = null;
    let scannedOperationCount = 0;
    let operationOverflow = false;
    let rowOverflow = false;

    // 只扫描可能包含 timing 叶命令的三类 action；复合锚点避免 offset 在写入期间跳行。
    while (!operationOverflow && !rowOverflow) {
      const take = Math.min(
        OPERATION_BATCH_SIZE,
        MAX_SCANNED_OPERATIONS + 1 - scannedOperationCount,
      );
      if (take <= 0) break;
      const page: OperationWithAttempt[] = await this.prisma.annotationOperation.findMany({
        where: {
          status: "accepted",
          committedAt: { gte: input.from, lt: input.to },
          committedRevision: { not: null },
          action: { in: [
            TIMELINE_TIMING_UPDATE_COMMAND,
            ANNOTATION_TRANSACTION_APPLY_COMMAND,
            TRACK_STRUCTURE_TRANSACTION_APPLY_COMMAND,
          ] },
          ...(cursor ? {
            OR: [
              { committedAt: { gt: cursor.committedAt } },
              { committedAt: cursor.committedAt, id: { gt: cursor.id } },
            ],
          } : {}),
        },
        orderBy: [{ committedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          annotationFileId: true,
          actorUserId: true,
          sequence: true,
          baseRevision: true,
          committedRevision: true,
          committedAt: true,
          payload: true,
          toolAttempt: {
            select: {
              id: true,
              eventName: true,
              sentenceId: true,
              entryPoint: true,
              invokedAt: true,
              confirmedAt: true,
              suppressPrompt: true,
              outcome: true,
            },
          },
        },
      });
      if (!page.length) break;
      for (const operation of page) {
        // 第 10,001 个候选只用于确认 operation 扫描已截断，不进入解析和计数。
        if (scannedOperationCount >= MAX_SCANNED_OPERATIONS) {
          operationOverflow = true;
          break;
        }
        scannedOperationCount += 1;
        rows.push(...extractAnnotationCorrectionRows(operation as AnnotationCorrectionOperationFact));
        if (rows.length > MAX_EXPORTED_ROWS) {
          rowOverflow = true;
          break;
        }
      }
      const last = page.at(-1)!;
      if (last.committedAt === null) throw new Error("已提交 operation 缺少提交时间。");
      cursor = { committedAt: last.committedAt, id: last.id };
      if (page.length < take) break;
    }
    const exportedRows = rows.slice(0, MAX_EXPORTED_ROWS);
    return {
      csv: buildAnnotationCorrectionDatasetCsv(exportedRows),
      exportedRowCount: exportedRows.length,
      scannedOperationCount,
      truncated: rowOverflow || operationOverflow,
    };
  }
}

function assertTimeWindow(input: { from: Date; to: Date }) {
  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs ||
    toMs - fromMs > MAX_WINDOW_MS) {
    throw badRequest("人工修正数据时间范围不正确。");
  }
}
