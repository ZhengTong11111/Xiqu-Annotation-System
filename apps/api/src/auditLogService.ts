import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AuditLogEntry,
  AuditLogPage,
  ListAuditLogsOptions,
} from "@xiqu/shared";
import {
  AuditLogQueryError,
  buildAuditLogCsv,
  buildAuditLogWhere,
  decodeAuditLogCursor,
  encodeAuditLogCursor,
  normalizeAuditLogQuery,
  type AuditLogCursor,
  type NormalizedAuditLogQuery,
} from "./auditLogQuery.js";
import type { ApiUser } from "./domain.js";
import { badRequest, forbidden } from "./errors.js";
import { ResourceAccessService } from "./resourceAccess.js";

// 审计导出有明确的服务端上限和数据库批次，避免一个请求无限占用 API 内存与连接。
const AUDIT_EXPORT_MAX_ROWS = 10_000;
const AUDIT_EXPORT_BATCH_SIZE = 500;

// Prisma 行包含浏览所需的执行人和资源摘要；目标账号因当前 schema 没有关联，随后批量补齐。
type AuditLogRow = Prisma.AuditLogGetPayload<{
  include: {
    actor: { select: { id: true; accountName: true; displayName: true } };
    resource: { select: { id: true; name: true; type: true } };
  };
}>;

export type AuditLogCsvExport = {
  csv: string;
  exportedCount: number;
  truncated: boolean;
};

// 审计查询服务集中处理只读授权、稳定分页和导出，不继续扩大通用平台 Repository。
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  // 列表多取一条判断后续页面，响应 items 仍严格受调用方 limit 限制。
  async listAuditLogs(
    user: ApiUser,
    options: ListAuditLogsOptions,
  ): Promise<AuditLogPage> {
    const query = this.normalizeAuditQuery(options);
    await this.assertAuditLogAccess(user, query);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const cursor = options.cursor
      ? this.decodeAuditCursor(options.cursor, query)
      : null;
    if (cursor) await this.assertAuditCursorStillMatches(query, cursor);
    const rows = await this.findAuditLogRows(query, cursor, limit + 1);
    const pageRows = rows.slice(0, limit);
    return {
      items: await this.mapAuditLogRows(pageRows),
      nextCursor: rows.length > limit && pageRows.length
        ? encodeAuditLogCursor(
            {
              createdAt: pageRows.at(-1)!.createdAt,
              id: pageRows.at(-1)!.id,
            },
            query,
          )
        : null,
    };
  }

  // CSV 导出重新执行授权并分批读取；cursor 不属于导出合同，导出覆盖当前筛选的最新结果。
  async exportAuditLogs(
    user: ApiUser,
    options: Omit<ListAuditLogsOptions, "cursor" | "limit">,
  ): Promise<AuditLogCsvExport> {
    const query = this.normalizeAuditQuery(options);
    await this.assertAuditLogAccess(user, query);
    const entries: AuditLogEntry[] = [];
    let cursor: AuditLogCursor | null = null;
    const targetCount = AUDIT_EXPORT_MAX_ROWS + 1;

    // 每批完成映射后再继续读取，避免一次请求启动无界查询或 N+1 账号请求。
    while (entries.length < targetCount) {
      const take = Math.min(
        AUDIT_EXPORT_BATCH_SIZE,
        targetCount - entries.length,
      );
      const rows = await this.findAuditLogRows(query, cursor, take);
      if (!rows.length) break;
      entries.push(...await this.mapAuditLogRows(rows));
      const last = rows.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (rows.length < take) break;
    }

    const truncated = entries.length > AUDIT_EXPORT_MAX_ROWS;
    const exported = entries.slice(0, AUDIT_EXPORT_MAX_ROWS);
    return {
      csv: buildAuditLogCsv(exported),
      exportedCount: exported.length,
      truncated,
    };
  }

  // 查询规范化错误统一映射为平台 400，避免 Router 和 Service 分别解释 cursor/date。
  private normalizeAuditQuery(
    options: ListAuditLogsOptions,
  ): NormalizedAuditLogQuery {
    try {
      return normalizeAuditLogQuery(options);
    } catch (error) {
      if (error instanceof AuditLogQueryError) throw badRequest(error.message);
      throw error;
    }
  }

  // 全局查询只允许管理员；资源范围查询沿用唯一 ResourceAccessService 的有效权限结论。
  private async assertAuditLogAccess(
    user: ApiUser,
    query: NormalizedAuditLogQuery,
  ): Promise<void> {
    if (query.resourceId) {
      await this.access.assertCapability(
        user,
        query.resourceId,
        "manage_permissions",
      );
      return;
    }
    if (!this.access.isGlobalAdmin(user)) {
      throw forbidden("非管理员查询审计日志时必须指定资源。");
    }
  }

  // 游标解码集中在 service 错误边界，坏 token 明确要求调用方刷新第一页。
  private decodeAuditCursor(
    token: string,
    query: NormalizedAuditLogQuery,
  ): AuditLogCursor {
    try {
      return decodeAuditLogCursor(token, query);
    } catch (error) {
      if (error instanceof AuditLogQueryError) throw badRequest(error.message);
      throw error;
    }
  }

  // 锚点被删除或不再满足筛选时拒绝继续翻页，防止结果集静默跳段。
  private async assertAuditCursorStillMatches(
    query: NormalizedAuditLogQuery,
    cursor: AuditLogCursor,
  ): Promise<void> {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        AND: [
          buildAuditLogWhere(query),
          { id: cursor.id, createdAt: cursor.createdAt },
        ],
      },
      select: { id: true },
    });
    if (!row) throw badRequest("审计日志分页游标已经失效，请刷新第一页。");
  }

  // 所有分页和导出批次共享同一排序、where 与轻量 relation 选择。
  private findAuditLogRows(
    query: NormalizedAuditLogQuery,
    cursor: AuditLogCursor | null,
    take: number,
  ): Promise<AuditLogRow[]> {
    return this.prisma.auditLog.findMany({
      where: buildAuditLogWhere(query, cursor),
      include: {
        actor: {
          select: { id: true, accountName: true, displayName: true },
        },
        resource: { select: { id: true, name: true, type: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    });
  }

  // targetUserId 当前不是 Prisma relation；每批一次查询并建立 map，避免逐行账号查询。
  private async mapAuditLogRows(
    rows: readonly AuditLogRow[],
  ): Promise<AuditLogEntry[]> {
    const targetUserIds = [...new Set(
      rows.flatMap((row) => row.targetUserId ? [row.targetUserId] : []),
    )];
    const targetUsers = targetUserIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: targetUserIds } },
          select: { id: true, accountName: true, displayName: true },
        })
      : [];
    const targetUserById = new Map(targetUsers.map((entry) => [entry.id, entry]));
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorUserId: row.actorUserId,
      resourceId: row.resourceId,
      fileId: row.fileId,
      targetUserId: row.targetUserId,
      detail: row.detail,
      createdAt: row.createdAt.toISOString(),
      actor: row.actor,
      resource: row.resource,
      targetUser: row.targetUserId
        ? targetUserById.get(row.targetUserId) ?? null
        : null,
    }));
  }
}
