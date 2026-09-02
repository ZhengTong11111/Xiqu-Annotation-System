import type { PrismaClient } from "@prisma/client";
import type {
  AnnotationHistoryCompactionRepository,
  AnnotationHistoryOperationFact,
} from "./annotationHistoryCompactionTypes.js";
import { MAX_ANNOTATION_HISTORY_PAYLOAD_BATCH_SIZE } from "./annotationHistoryCompactionTypes.js";

const OPERATION_PAGE_SIZE = 500;

/**
 * HC1 的 Prisma repository 只暴露有界 SELECT；planner 不接触 Prisma，也不能借接口写入数据库。
 * payload 以固定小批次读取，减少大文件逐条往返，同时避免把单文件甚至全库 JSON 一次装入内存。
 */
export class PrismaAnnotationHistoryCompactionRepository
implements AnnotationHistoryCompactionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAnnotationFileIds(input: { afterId: string | null; take: number }) {
    const rows = await this.prisma.annotationFile.findMany({
      where: {
        ...(input.afterId ? { resourceId: { gt: input.afterId } } : {}),
        recoverySnapshots: { some: {} },
      },
      select: { resourceId: true },
      orderBy: { resourceId: "asc" },
      take: input.take,
    });
    return rows.map((row) => row.resourceId);
  }

  async listSnapshots(input: { annotationFileId: string; maxRevisions: number }) {
    // 额外读取一行只用于报告 truncated；返回给 planner 的条数仍严格受 maxRevisions 限制。
    const take = input.maxRevisions + 1;
    const rows = await this.prisma.annotationRecoverySnapshot.findMany({
      where: { annotationFileId: input.annotationFileId },
      select: {
        id: true,
        revision: true,
        reason: true,
        createdAt: true,
      },
      orderBy: [
        { revision: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take,
    });
    const truncated = rows.length > input.maxRevisions;
    return {
      items: rows.slice(0, input.maxRevisions),
      truncated,
    };
  }

  async listCommittedOperations(input: {
    annotationFileId: string;
    fromRevisionExclusive: number;
    toRevisionInclusive: number;
    maxOperations: number;
  }) {
    const items: AnnotationHistoryOperationFact[] = [];
    let afterSequence = -1;
    let truncated = false;
    while (items.length <= input.maxOperations) {
      const remainingWithSentinel = input.maxOperations + 1 - items.length;
      const rows = await this.prisma.annotationOperation.findMany({
        where: {
          annotationFileId: input.annotationFileId,
          sequence: { gt: afterSequence },
          committedRevision: {
            gt: input.fromRevisionExclusive,
            lte: input.toRevisionInclusive,
          },
        },
        select: {
          id: true,
          annotationFileId: true,
          sequence: true,
          baseRevision: true,
          action: true,
          payload: true,
          status: true,
          committedRevision: true,
          committedAt: true,
        },
        orderBy: { sequence: "asc" },
        take: Math.min(OPERATION_PAGE_SIZE, remainingWithSentinel),
      });
      for (const row of rows) {
        // WHERE 已排除 null；显式门禁防止未来查询改动把未提交 operation 混入重放链。
        if (row.committedRevision === null) continue;
        items.push({ ...row, committedRevision: row.committedRevision });
      }
      if (items.length > input.maxOperations) {
        truncated = true;
        break;
      }
      if (rows.length < Math.min(OPERATION_PAGE_SIZE, remainingWithSentinel)) break;
      afterSequence = rows.at(-1)?.sequence ?? afterSequence;
    }
    return { items: items.slice(0, input.maxOperations), truncated };
  }

  async listProtectedRevisions(input: { annotationFileId: string; maxRevisions: number }) {
    // 先按 revision 聚合再读取，评论很多时也不会把每条正文事实拉进 planner；撤回事实仍属于历史引用。
    const confirmations = await this.prisma.annotationConfirmation.groupBy({
      by: ["confirmedRevision"],
      where: { annotationFileId: input.annotationFileId },
      orderBy: { confirmedRevision: "asc" },
      take: input.maxRevisions + 1,
    });
    const comments = await this.prisma.annotationRangeComment.groupBy({
      by: ["commentedRevision"],
      where: { annotationFileId: input.annotationFileId },
      orderBy: { commentedRevision: "asc" },
      take: input.maxRevisions + 1,
    });
    const reviewLinks = await this.prisma.annotationReviewLink.groupBy({
      by: ["sourceRevision"],
      where: { sourceAnnotationFileId: input.annotationFileId },
      orderBy: { sourceRevision: "asc" },
      take: input.maxRevisions + 1,
    });
    const revisions = new Set([
      ...confirmations.map((row) => row.confirmedRevision),
      ...comments.map((row) => row.commentedRevision),
      ...reviewLinks.map((row) => row.sourceRevision),
    ]);
    const truncated = confirmations.length > input.maxRevisions ||
      comments.length > input.maxRevisions ||
      reviewLinks.length > input.maxRevisions ||
      revisions.size > input.maxRevisions;
    return {
      revisions: new Set([...revisions].sort((left, right) => left - right).slice(0, input.maxRevisions)),
      truncated,
    };
  }

  async loadSnapshotPayloadBatch(input: { annotationFileId: string; snapshotIds: string[] }) {
    if (
      input.snapshotIds.length < 1 ||
      input.snapshotIds.length > MAX_ANNOTATION_HISTORY_PAYLOAD_BATCH_SIZE ||
      new Set(input.snapshotIds).size !== input.snapshotIds.length ||
      input.snapshotIds.some((id) => id.length < 1 || id.length > 200)
    ) {
      throw new Error("恢复快照 payload 批次输入无效。");
    }
    const rows = await this.prisma.annotationRecoverySnapshot.findMany({
      where: {
        id: { in: input.snapshotIds },
        annotationFileId: input.annotationFileId,
      },
      select: { id: true, payload: true },
    });
    return rows.map((row) => ({ snapshotId: row.id, payload: row.payload }));
  }
}
