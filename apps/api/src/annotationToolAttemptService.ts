import type { AnnotationToolAttempt, Prisma, PrismaClient } from "@prisma/client";
import {
  ANNOTATION_TOOL_ATTEMPT_ENTRY_POINTS,
  ANNOTATION_TOOL_ATTEMPT_OUTCOMES,
  ANNOTATION_TOOL_EVENT_NAMES,
  type AnnotationToolAttemptRecord,
  type AnnotationToolAttemptState,
  type AnnotationToolAttemptSummary,
  type SubmitAnnotationToolAttemptBatchRequest,
  type SubmitAnnotationToolAttemptBatchResponse,
} from "@xiqu/shared";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";
import { assertActiveAnnotationFile } from "./annotationFileActivity.js";
import {
  buildAnnotationToolAttemptCsv,
  type AnnotationToolAttemptExportRow,
} from "./annotationToolAttemptExport.js";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const MAX_SUMMARY_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const ANNOTATION_TOOL_ATTEMPT_EXPORT_MAX_ROWS = 10_000;
const ANNOTATION_TOOL_ATTEMPT_EXPORT_BATCH_SIZE = 500;

export type AnnotationToolAttemptCsvExport = {
  csv: string;
  exportedCount: number;
  truncated: boolean;
};

/** 工具尝试的唯一事务 owner；前端队列、router 和未来 command commit 不得复制生命周期合并规则。 */
export class AnnotationToolAttemptService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async submitBatch(
    user: ApiUser,
    request: SubmitAnnotationToolAttemptBatchRequest,
  ): Promise<SubmitAnnotationToolAttemptBatchResponse> {
    const rows = await this.prisma.$transaction(async (transaction) => {
      const ids = request.attempts.map(({ id }) => id);
      // 多标签页首次送达同一 id 时，先按稳定顺序串行化，再判断 create/replay，避免唯一索引异常冒充业务冲突。
      for (const id of [...ids].sort()) {
        await transaction.$queryRaw`
          SELECT 1::integer AS locked
          FROM pg_advisory_xact_lock(hashtext(${`xiqu:annotation-tool-attempt:${id}`}))
        `;
      }
      const existingRows = await transaction.annotationToolAttempt.findMany({ where: { id: { in: ids } } });
      const existingById = new Map(existingRows.map((row) => [row.id, row]));

      // 只对首次创建复核活动文件与 write；本人已开始的离线事实即使随后撤权，也仍可补完终态。
      const newFileIds = [...new Set(request.attempts
        .filter(({ id }) => !existingById.has(id))
        .map(({ annotationFileId }) => annotationFileId))];
      for (const annotationFileId of newFileIds) {
        await assertActiveAnnotationFile(transaction, annotationFileId);
        await this.access.assertCapability(user, annotationFileId, "write", transaction);
      }

      const result: AnnotationToolAttempt[] = [];
      for (const attempt of request.attempts) {
        const existing = existingById.get(attempt.id);
        if (!existing) {
          result.push(await transaction.annotationToolAttempt.create({
            data: toCreateData(user.id, attempt),
          }));
          continue;
        }
        // 他人 attempt 与不存在统一为 404，避免 UUID 泄露账号或文件活动事实。
        if (existing.actorUserId !== user.id) throw notFound("工具尝试记录不存在。");
        const update = buildMonotonicUpdate(existing, attempt);
        result.push(Object.keys(update).length === 0
          ? existing
          : await transaction.annotationToolAttempt.update({ where: { id: existing.id }, data: update }));
      }
      return result;
    });
    return { attempts: rows.map(mapAttemptRecord) };
  }

  async summarize(
    user: ApiUser,
    input: { from: Date; to: Date },
  ): Promise<AnnotationToolAttemptSummary> {
    await this.access.assertFullResourceAccess(user);
    assertAttemptTimeWindow(input);
    const groups = await this.prisma.annotationToolAttempt.groupBy({
      by: ["eventName", "entryPoint", "outcome"],
      where: { invokedAt: { gte: input.from, lt: input.to } },
      _count: { _all: true },
    });
    const byEventName = Object.fromEntries(ANNOTATION_TOOL_EVENT_NAMES.map((value) => [value, 0])) as AnnotationToolAttemptSummary["byEventName"];
    const byEntryPoint = Object.fromEntries(ANNOTATION_TOOL_ATTEMPT_ENTRY_POINTS.map((value) => [value, 0])) as AnnotationToolAttemptSummary["byEntryPoint"];
    const byOutcome = Object.fromEntries(["pending", ...ANNOTATION_TOOL_ATTEMPT_OUTCOMES].map((value) => [value, 0])) as AnnotationToolAttemptSummary["byOutcome"];
    let total = 0;
    for (const group of groups) {
      const count = group._count._all;
      total += count;
      byEventName[group.eventName] += count;
      byEntryPoint[group.entryPoint] += count;
      byOutcome[group.outcome ?? "pending"] += count;
    }
    return {
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      total,
      byEventName,
      byEntryPoint,
      byOutcome,
    };
  }

  async exportAttempts(
    user: ApiUser,
    input: { from: Date; to: Date },
  ): Promise<AnnotationToolAttemptCsvExport> {
    await this.access.assertFullResourceAccess(user);
    assertAttemptTimeWindow(input);
    const rows: AnnotationToolAttemptExportRow[] = [];
    let cursor: Pick<AnnotationToolAttemptExportRow, "invokedAt" | "id"> | null = null;
    const targetCount = ANNOTATION_TOOL_ATTEMPT_EXPORT_MAX_ROWS + 1;

    // 使用 invokedAt + id 的复合锚点分批前进；额外读取一行只用于报告截断，不进入导出正文。
    while (rows.length < targetCount) {
      const take = Math.min(
        ANNOTATION_TOOL_ATTEMPT_EXPORT_BATCH_SIZE,
        targetCount - rows.length,
      );
      const page: AnnotationToolAttemptExportRow[] = await this.prisma.annotationToolAttempt.findMany({
        where: {
          AND: [
            { invokedAt: { gte: input.from, lt: input.to } },
            ...(cursor ? [{
              OR: [
                { invokedAt: { gt: cursor.invokedAt } },
                { invokedAt: cursor.invokedAt, id: { gt: cursor.id } },
              ],
            }] : []),
          ],
        },
        orderBy: [{ invokedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          eventName: true,
          actorUserId: true,
          annotationFileId: true,
          sentenceId: true,
          entryPoint: true,
          invokedAt: true,
          confirmedAt: true,
          finishedAt: true,
          outcome: true,
          suppressPrompt: true,
          characterCount: true,
          sentenceDurationMs: true,
          annotationOperationId: true,
          committedRevision: true,
          details: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!page.length) break;
      rows.push(...page);
      const last: AnnotationToolAttemptExportRow = page.at(-1)!;
      cursor = { invokedAt: last.invokedAt, id: last.id };
      if (page.length < take) break;
    }

    const truncated = rows.length > ANNOTATION_TOOL_ATTEMPT_EXPORT_MAX_ROWS;
    const exportedRows = rows.slice(0, ANNOTATION_TOOL_ATTEMPT_EXPORT_MAX_ROWS);
    return {
      csv: buildAnnotationToolAttemptCsv(exportedRows),
      exportedCount: exportedRows.length,
      truncated,
    };
  }
}

/** 聚合与导出共用同一半开时间窗，避免两个管理员入口逐渐产生不同的容量边界。 */
function assertAttemptTimeWindow(input: { from: Date; to: Date }) {
  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs ||
    toMs - fromMs > MAX_SUMMARY_WINDOW_MS) {
    throw badRequest("工具尝试统计时间范围不正确。");
  }
}

function toCreateData(actorUserId: string, attempt: AnnotationToolAttemptState): Prisma.AnnotationToolAttemptUncheckedCreateInput {
  return {
    id: attempt.id,
    eventName: attempt.eventName,
    actorUserId,
    annotationFileId: attempt.annotationFileId,
    sentenceId: attempt.sentenceId,
    entryPoint: attempt.entryPoint,
    invokedAt: new Date(attempt.invokedAt),
    confirmedAt: attempt.confirmedAt ? new Date(attempt.confirmedAt) : null,
    finishedAt: attempt.finishedAt ? new Date(attempt.finishedAt) : null,
    outcome: attempt.outcome ?? null,
    suppressPrompt: attempt.suppressPrompt,
    characterCount: attempt.characterCount,
    sentenceDurationMs: attempt.sentenceDurationMs,
    details: attempt.details ? attempt.details as Prisma.InputJsonValue : undefined,
  };
}

/** incoming 可以是旧状态前缀；已有非空事实只能保持同值，绝不能被迟到请求清空或改写。 */
function buildMonotonicUpdate(
  existing: AnnotationToolAttempt,
  incoming: AnnotationToolAttemptState,
): Prisma.AnnotationToolAttemptUpdateInput {
  if (
    existing.eventName !== incoming.eventName ||
    (existing.annotationFileId !== null && existing.annotationFileId !== incoming.annotationFileId) ||
    existing.sentenceId !== incoming.sentenceId ||
    existing.entryPoint !== incoming.entryPoint ||
    existing.invokedAt.toISOString() !== incoming.invokedAt ||
    existing.characterCount !== incoming.characterCount ||
    existing.sentenceDurationMs !== incoming.sentenceDurationMs
  ) {
    throw conflict("工具尝试编号已用于另一项调用。", { code: "tool_attempt_identity_conflict" });
  }
  if (existing.outcome !== null) {
    const expandsTerminal =
      (incoming.confirmedAt !== null && incoming.confirmedAt !== undefined && existing.confirmedAt === null) ||
      (incoming.suppressPrompt && !existing.suppressPrompt) ||
      (incoming.details !== null && incoming.details !== undefined && existing.details === null);
    if (expandsTerminal) {
      throw conflict("工具尝试终态不能继续补写。", { code: "tool_attempt_terminal_immutable" });
    }
  }
  const update: Prisma.AnnotationToolAttemptUpdateInput = {};
  mergeDate(existing.confirmedAt, incoming.confirmedAt, "confirmedAt", update);
  mergeTerminal(existing, incoming, update);
  if (!existing.suppressPrompt && incoming.suppressPrompt) update.suppressPrompt = true;
  mergeDetails(existing.details, incoming.details, update);
  const effectiveConfirmedAt = update.confirmedAt instanceof Date ? update.confirmedAt : existing.confirmedAt;
  const effectiveFinishedAt = update.finishedAt instanceof Date ? update.finishedAt : existing.finishedAt;
  if (effectiveConfirmedAt && effectiveFinishedAt && effectiveFinishedAt < effectiveConfirmedAt) {
    throw conflict("工具尝试生命周期时间与已保存状态冲突。", { code: "tool_attempt_time_conflict" });
  }
  return update;
}

function mergeDate(
  existing: Date | null,
  incoming: string | null | undefined,
  field: "confirmedAt",
  update: Prisma.AnnotationToolAttemptUpdateInput,
) {
  if (!incoming) return;
  const parsed = new Date(incoming);
  if (existing && existing.getTime() !== parsed.getTime()) {
    throw conflict("工具尝试生命周期已使用不同时间。", { code: "tool_attempt_lifecycle_conflict", field });
  }
  if (!existing) update[field] = parsed;
}

function mergeTerminal(
  existing: AnnotationToolAttempt,
  incoming: AnnotationToolAttemptState,
  update: Prisma.AnnotationToolAttemptUpdateInput,
) {
  if (!incoming.outcome || !incoming.finishedAt) return;
  const finishedAt = new Date(incoming.finishedAt);
  if (existing.outcome) {
    if (existing.outcome !== incoming.outcome || existing.finishedAt?.getTime() !== finishedAt.getTime()) {
      throw conflict("工具尝试已经以另一结果结束。", { code: "tool_attempt_terminal_conflict" });
    }
    return;
  }
  update.outcome = incoming.outcome;
  update.finishedAt = finishedAt;
}

function mergeDetails(
  existing: Prisma.JsonValue | null,
  incoming: AnnotationToolAttemptState["details"],
  update: Prisma.AnnotationToolAttemptUpdateInput,
) {
  if (!incoming) return;
  if (existing !== null && stableJsonStringify(existing) !== stableJsonStringify(incoming)) {
    throw conflict("工具尝试详情已经使用另一组值。", { code: "tool_attempt_details_conflict" });
  }
  if (existing === null) update.details = incoming as Prisma.InputJsonValue;
}

function mapAttemptRecord(row: AnnotationToolAttempt): AnnotationToolAttemptRecord {
  return {
    id: row.id,
    eventName: row.eventName,
    actorUserId: row.actorUserId,
    annotationFileId: row.annotationFileId,
    sentenceId: row.sentenceId,
    entryPoint: row.entryPoint,
    invokedAt: row.invokedAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    outcome: row.outcome,
    suppressPrompt: row.suppressPrompt,
    characterCount: row.characterCount,
    sentenceDurationMs: row.sentenceDurationMs,
    details: row.details as AnnotationToolAttemptRecord["details"],
    committedRevision: row.committedRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
