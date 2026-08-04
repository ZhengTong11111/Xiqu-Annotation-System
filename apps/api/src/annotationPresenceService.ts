import type { Prisma, PrismaClient } from "@prisma/client";
import type { AnnotationPresenceMember } from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { assertActiveAnnotationFile } from "./annotationFileActivity.js";
import { conflict } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";

export const ANNOTATION_PRESENCE_TTL_MS = 60_000;
const MAX_ACTIVE_SESSIONS_PER_FILE = 1_000;
const MAX_ACTIVE_SESSIONS_PER_USER_AND_FILE = 100;
const MAX_PRESENCE_MEMBERS = 200;
const EXPIRED_PRESENCE_CLEANUP_LIMIT = 200;

export type AnnotationPresenceHandle = {
  id: string;
  annotationFileId: string;
  userId: string;
};

/**
 * 数据库中的短生命周期 presence 是跨实例权威事实。
 * Service 不持有 socket 或 timer；WebSocket route 只保存返回的连接 handle。
 */
export class AnnotationPresenceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  // 新连接加入前在文件锁内复核权限、清理过期记录并执行全部容量门禁。
  async join(user: ApiUser, annotationFileId: string): Promise<AnnotationPresenceHandle> {
    return this.prisma.$transaction(async (transaction) => {
      // 同文件 join 串行化连接上限检查，避免并发 count 后同时越过边界。
      await lockAnnotationFile(transaction, annotationFileId);
      await this.access.assertCapability(user, annotationFileId, "read", transaction);
      await assertActiveAnnotationFile(transaction, annotationFileId);
      const now = new Date();
      await this.cleanupExpiredForFile(transaction, annotationFileId, now);

      // Prisma 的交互式事务只占用一个 pg 连接；这里必须串行查询，不能用 Promise.all
      // 在同一连接上并发发送命令，否则 pg 9 将不再支持该行为。
      const fileSessionCount = await transaction.annotationCollaborationPresence.count({
        where: { annotationFileId, expiresAt: { gt: now } },
      });
      const userSessionCount = await transaction.annotationCollaborationPresence.count({
        where: { annotationFileId, userId: user.id, expiresAt: { gt: now } },
      });
      if (fileSessionCount >= MAX_ACTIVE_SESSIONS_PER_FILE) {
        throw conflict("当前标注文件的在线协作连接已达到上限，请稍后重试。");
      }
      if (userSessionCount >= MAX_ACTIVE_SESSIONS_PER_USER_AND_FILE) {
        throw conflict("当前账号在此标注文件打开的在线窗口过多，请先关闭不再使用的窗口。");
      }
      if (userSessionCount === 0) {
        // 协议最多承载 200 个聚合账号；已有账号仍可增加窗口，新账号必须在写入前拒绝，
        // 避免数据库真实在线人数与浏览器静默截断后的名单不一致。
        const activeUsers = await transaction.annotationCollaborationPresence.groupBy({
          by: ["userId"],
          where: { annotationFileId, expiresAt: { gt: now } },
          orderBy: { userId: "asc" },
          take: MAX_PRESENCE_MEMBERS,
        });
        if (activeUsers.length >= MAX_PRESENCE_MEMBERS) {
          throw conflict("当前标注文件的在线账号已达到上限，请稍后重试。");
        }
      }

      const presence = await transaction.annotationCollaborationPresence.create({
        data: {
          annotationFileId,
          userId: user.id,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + ANNOTATION_PRESENCE_TTL_MS),
        },
        select: { id: true, annotationFileId: true, userId: true },
      });
      return presence;
    });
  }

  // 心跳只能延长仍然有效的当前连接，不能让已过期记录重新成为在线事实。
  async renew(handle: AnnotationPresenceHandle) {
    const now = new Date();
    const renewed = await this.prisma.annotationCollaborationPresence.updateMany({
      where: {
        id: handle.id,
        annotationFileId: handle.annotationFileId,
        userId: handle.userId,
        // 已经过期的 session 不能通过迟到 heartbeat 复活成在线状态。
        expiresAt: { gt: now },
      },
      data: {
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + ANNOTATION_PRESENCE_TTL_MS),
      },
    });
    return renewed.count === 1;
  }

  // 主动离开按连接 handle 精确删除，重复 finalize 保持幂等。
  async leave(handle: AnnotationPresenceHandle) {
    const deleted = await this.prisma.annotationCollaborationPresence.deleteMany({
      where: {
        id: handle.id,
        annotationFileId: handle.annotationFileId,
        userId: handle.userId,
      },
    });
    return deleted.count === 1;
  }

  // 成员列表从数据库活动 session 聚合，同账号多窗口只增加连接数量。
  async listActive(annotationFileId: string): Promise<AnnotationPresenceMember[]> {
    const now = new Date();
    const sessions = await this.prisma.annotationCollaborationPresence.findMany({
      where: { annotationFileId, expiresAt: { gt: now } },
      select: {
        userId: true,
        lastSeenAt: true,
        user: { select: { accountName: true, displayName: true } },
      },
      orderBy: [{ userId: "asc" }, { lastSeenAt: "desc" }, { id: "asc" }],
      take: MAX_ACTIVE_SESSIONS_PER_FILE,
    });

    // 浏览器按账号显示在线成员；多 tab 只增加 connectionCount，不伪装成多个不同用户。
    const members = new Map<string, AnnotationPresenceMember>();
    for (const session of sessions) {
      const existing = members.get(session.userId);
      if (existing) {
        existing.connectionCount += 1;
        if (session.lastSeenAt.toISOString() > existing.lastSeenAt) {
          existing.lastSeenAt = session.lastSeenAt.toISOString();
        }
        continue;
      }
      if (members.size >= MAX_PRESENCE_MEMBERS) break;
      members.set(session.userId, {
        userId: session.userId,
        accountName: session.user.accountName,
        displayName: session.user.displayName,
        connectionCount: 1,
        lastSeenAt: session.lastSeenAt.toISOString(),
      });
    }
    return [...members.values()];
  }

  // Join 顺带有界清理当前文件最早的过期记录，避免在线热文件无限积累残留。
  private async cleanupExpiredForFile(
    transaction: Prisma.TransactionClient,
    annotationFileId: string,
    now: Date,
  ) {
    const expired = await transaction.annotationCollaborationPresence.findMany({
      where: { annotationFileId, expiresAt: { lte: now } },
      select: { id: true },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: EXPIRED_PRESENCE_CLEANUP_LIMIT,
    });
    if (!expired.length) return;
    await transaction.annotationCollaborationPresence.deleteMany({
      where: { id: { in: expired.map(({ id }) => id) } },
    });
  }
}

async function lockAnnotationFile(
  transaction: Prisma.TransactionClient,
  annotationFileId: string,
) {
  // 参数仍通过 Prisma SQL template 绑定；FOR UPDATE 只串行同一标注文件的 join 边界。
  await transaction.$queryRaw`
    SELECT "resource_id"
    FROM "annotation_files"
    WHERE "resource_id" = ${annotationFileId}
    FOR UPDATE
  `;
}
