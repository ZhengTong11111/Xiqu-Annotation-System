import { Prisma, type PrismaClient } from "@prisma/client";
import {
  PROCESSING_JOB_STATUSES,
  type ListProcessingJobsOptions,
  type ProcessingJobDetail,
  type ProcessingJobPage,
  type ProcessingJobRequestListItem,
  type ProcessingJobScope,
  type ProcessingJobStatus,
  type ProcessingJobSummary,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, forbidden, notFound } from "./errors.js";
import {
  decodeProcessingJobCursor,
  encodeProcessingJobCursor,
  normalizeProcessingJobQuery,
  ProcessingJobQueryError,
  type NormalizedProcessingJobQuery,
  type ProcessingJobCursor,
} from "./processingJobQuery.js";
import { ResourceAccessService } from "./resourceAccess.js";

const RELATED_SCAN_BATCH = 200;
const MAX_RELATED_SCAN_ROWS = 1_000;
const MAX_DETAIL_REQUESTS = 200;
const MAX_RELATED_SUMMARY_ROWS = 5_000;

const requestRowSelect = {
  id: true,
  requestedAt: true,
  cancelledAt: true,
  requester: { select: { id: true, accountName: true, displayName: true } },
  contextResource: { select: { id: true, name: true, type: true } },
  job: {
    select: {
      id: true,
      type: true,
      status: true,
      progress: true,
      errorCode: true,
      createdAt: true,
      updatedAt: true,
      finishedAt: true,
      cancelRequestedAt: true,
      cancellationMode: true,
    },
  },
} satisfies Prisma.ProcessingJobRequestSelect;

type ProcessingJobRequestRow = Prisma.ProcessingJobRequestGetPayload<{
  select: typeof requestRowSelect;
}>;

/** 后台任务查询以 request 上下文为可见性边界，不把内部执行参数或其他不可见资源带入 DTO。 */
export class ProcessingJobQueryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async list(
    user: ApiUser,
    options: ListProcessingJobsOptions,
  ): Promise<ProcessingJobPage> {
    const query = this.normalize(options);
    this.assertScope(user, query.scope);
    const cursor = options.cursor ? this.decodeCursor(options.cursor, query) : null;
    if (query.scope === "related") {
      return this.listRelated(user, query, cursor);
    }

    const rows = await this.findRows(user, query, cursor, query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const visibleResourceIds = query.scope === "all"
      ? new Set(pageRows.flatMap(({ contextResource }) => contextResource ? [contextResource.id] : []))
      : await this.getReadableResourceIds(user, pageRows);
    return {
      items: pageRows.map((row) => mapRequestRow(row, visibleResourceIds)),
      nextCursor: rows.length > query.limit && pageRows.length
        ? encodeProcessingJobCursor(toCursor(pageRows.at(-1)!), query)
        : null,
    };
  }

  async summary(user: ApiUser, scope: ProcessingJobScope = "mine"): Promise<ProcessingJobSummary> {
    const query = this.normalize({ scope, limit: 1 });
    this.assertScope(user, query.scope);
    if (query.scope !== "related") {
      const rows = await this.prisma.$queryRaw<Array<{ status: ProcessingJobStatus; count: bigint }>>(
        query.scope === "mine"
          ? Prisma.sql`
              SELECT job."status"::text AS "status", count(*)::bigint AS "count"
              FROM "processing_job_requests" AS request
              INNER JOIN "processing_jobs" AS job ON job."id" = request."job_id"
              WHERE request."requester_user_id" = ${user.id}
              GROUP BY job."status"
            `
          : Prisma.sql`
              SELECT job."status"::text AS "status", count(*)::bigint AS "count"
              FROM "processing_job_requests" AS request
              INNER JOIN "processing_jobs" AS job ON job."id" = request."job_id"
              GROUP BY job."status"
            `,
      );
      return buildSummary(query.scope, rows, false);
    }

    // related 摘要按批次复用唯一 ACL 算法；达到上限时明确标为 partial，绝不把截断结果伪装成全局精确值。
    const counts = emptyStatusCounts();
    let visibleRequestCount = 0;
    let scanned = 0;
    let cursor: ProcessingJobCursor | null = null;
    let exhausted = false;
    while (scanned < MAX_RELATED_SUMMARY_ROWS && !exhausted) {
      const rows = await this.findRows(user, query, cursor, RELATED_SCAN_BATCH);
      if (!rows.length) {
        exhausted = true;
        break;
      }
      scanned += rows.length;
      cursor = toCursor(rows.at(-1)!);
      exhausted = rows.length < RELATED_SCAN_BATCH;
      const readable = await this.getReadableResourceIds(user, rows);
      for (const row of rows) {
        if (!row.contextResource || !readable.has(row.contextResource.id)) continue;
        counts[row.job.status] += 1;
        visibleRequestCount += 1;
      }
    }
    return {
      scope,
      visibleRequestCount,
      byStatus: counts,
      isPartial: !exhausted,
    };
  }

  async detail(user: ApiUser, jobId: string): Promise<ProcessingJobDetail> {
    const isAdministrator = this.access.hasFullResourceAccess(user);
    const rows = await this.prisma.processingJobRequest.findMany({
      where: { jobId },
      select: requestRowSelect,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: MAX_DETAIL_REQUESTS + 1,
    });
    if (!rows.length) throw notFound("后台任务不存在。");
    const readable = isAdministrator
      ? new Set(rows.flatMap(({ contextResource }) => contextResource ? [contextResource.id] : []))
      : await this.getReadableResourceIds(user, rows);
    const visible = isAdministrator
      ? rows
      : rows.filter((row) =>
          row.requester.id === user.id ||
          Boolean(row.contextResource && readable.has(row.contextResource.id)));
    if (!visible.length) throw notFound("后台任务不存在。");
    const pageRows = visible.slice(0, MAX_DETAIL_REQUESTS);
    return {
      job: mapJob(pageRows[0]!.job),
      visibleRequests: pageRows.map((row) => {
        const item = mapRequestRow(row, readable);
        return {
          requestId: item.requestId,
          requestedAt: item.requestedAt,
          cancelledAt: item.cancelledAt,
          requester: item.requester,
          contextResource: item.contextResource,
        };
      }),
      visibleRequestCount: pageRows.length,
      requestsTruncated: isAdministrator
        ? rows.length > MAX_DETAIL_REQUESTS
        : visible.length > MAX_DETAIL_REQUESTS,
    };
  }

  private async listRelated(
    user: ApiUser,
    query: NormalizedProcessingJobQuery,
    initialCursor: ProcessingJobCursor | null,
  ): Promise<ProcessingJobPage> {
    const visible: ProcessingJobRequestRow[] = [];
    let cursor = initialCursor;
    let scanned = 0;
    let exhausted = false;
    while (visible.length < query.limit + 1 && scanned < MAX_RELATED_SCAN_ROWS && !exhausted) {
      const take = Math.min(RELATED_SCAN_BATCH, MAX_RELATED_SCAN_ROWS - scanned);
      const rows = await this.findRows(user, query, cursor, take);
      if (!rows.length) {
        exhausted = true;
        break;
      }
      scanned += rows.length;
      cursor = toCursor(rows.at(-1)!);
      exhausted = rows.length < take;
      const readable = await this.getReadableResourceIds(user, rows);
      visible.push(...rows.filter((row) =>
        Boolean(row.contextResource && readable.has(row.contextResource.id))));
    }
    const pageRows = visible.slice(0, query.limit);
    const readable = await this.getReadableResourceIds(user, pageRows);
    const nextAnchor = visible.length > query.limit && pageRows.length
      ? toCursor(pageRows.at(-1)!)
      : !exhausted && cursor
        ? cursor
        : null;
    return {
      items: pageRows.map((row) => mapRequestRow(row, readable)),
      nextCursor: nextAnchor ? encodeProcessingJobCursor(nextAnchor, query) : null,
    };
  }

  private findRows(
    user: ApiUser,
    query: NormalizedProcessingJobQuery,
    cursor: ProcessingJobCursor | null,
    take: number,
  ) {
    const where: Prisma.ProcessingJobRequestWhereInput = {
      requesterUserId: query.scope === "mine" ? user.id : undefined,
      contextResourceId: query.scope === "related" ? { not: null } : undefined,
      job: {
        status: query.status ?? undefined,
        type: query.type ?? undefined,
      },
      ...(cursor
        ? {
            OR: [
              { requestedAt: { lt: cursor.requestedAt } },
              { requestedAt: cursor.requestedAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    return this.prisma.processingJobRequest.findMany({
      where,
      select: requestRowSelect,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take,
    });
  }

  private async getReadableResourceIds(
    user: ApiUser,
    rows: readonly ProcessingJobRequestRow[],
  ) {
    const ids = rows.flatMap(({ contextResource }) => contextResource ? [contextResource.id] : []);
    const permissions = await this.access.getEffectivePermissions(user, ids);
    return new Set([...permissions.entries()]
      .filter(([, permission]) => permission.capabilities.includes("read"))
      .map(([resourceId]) => resourceId));
  }

  private normalize(options: ListProcessingJobsOptions) {
    try {
      return normalizeProcessingJobQuery(options);
    } catch (error) {
      if (error instanceof ProcessingJobQueryError) throw badRequest(error.message);
      throw error;
    }
  }

  private decodeCursor(token: string, query: NormalizedProcessingJobQuery) {
    try {
      return decodeProcessingJobCursor(token, query);
    } catch (error) {
      if (error instanceof ProcessingJobQueryError) throw badRequest(error.message);
      throw error;
    }
  }

  private assertScope(user: ApiUser, scope: ProcessingJobScope) {
    if (scope === "all" && !this.access.hasFullResourceAccess(user)) {
      throw forbidden("只有管理员可以查看全部后台任务。");
    }
  }
}

function mapRequestRow(
  row: ProcessingJobRequestRow,
  visibleResourceIds: ReadonlySet<string>,
): ProcessingJobRequestListItem {
  return {
    requestId: row.id,
    requestedAt: row.requestedAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    requester: row.requester,
    contextResource: row.contextResource && visibleResourceIds.has(row.contextResource.id)
      ? row.contextResource
      : null,
    job: mapJob(row.job),
  };
}

function mapJob(job: ProcessingJobRequestRow["job"]): ProcessingJobRequestListItem["job"] {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    errorCode: job.errorCode,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    cancellationMode: job.cancellationMode,
  };
}

function toCursor(row: ProcessingJobRequestRow): ProcessingJobCursor {
  return { requestedAt: row.requestedAt, id: row.id };
}

function emptyStatusCounts(): Record<ProcessingJobStatus, number> {
  return Object.fromEntries(PROCESSING_JOB_STATUSES.map((status) => [status, 0])) as
    Record<ProcessingJobStatus, number>;
}

function buildSummary(
  scope: ProcessingJobScope,
  rows: readonly { status: ProcessingJobStatus; count: bigint }[],
  isPartial: boolean,
): ProcessingJobSummary {
  const byStatus = emptyStatusCounts();
  for (const row of rows) byStatus[row.status] = Number(row.count);
  return {
    scope,
    byStatus,
    visibleRequestCount: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    isPartial,
  };
}
