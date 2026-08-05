import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AnnotationCollaborationTicket } from "@xiqu/shared";
import { hashToken } from "./auth.js";
import type { ApiUser } from "./domain.js";
import { forbidden, HttpError, unauthorized } from "./errors.js";
import { assertActiveAnnotationFile } from "./annotationFileActivity.js";
import { encodeAnnotationSnapshotOperationCursor } from "./annotationCommittedOperationPagination.js";
import type { ResourceAccessService } from "./resourceAccess.js";
import { toPublicUser } from "./repositoryMappers.js";

export const ANNOTATION_COLLABORATION_TICKET_TTL_MS = 30_000;
const EXPIRED_TICKET_CLEANUP_LIMIT = 100;

export class AnnotationCollaborationTicketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async issue(
    user: ApiUser,
    annotationFileId: string,
  ): Promise<AnnotationCollaborationTicket> {
    await this.assertReadable(user, annotationFileId);
    await this.cleanupExpiredTickets();

    // 明文只返回浏览器一次；数据库泄漏时摘要不能直接建立 WebSocket 会话。
    const ticket = `xiqu_ws_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ANNOTATION_COLLABORATION_TICKET_TTL_MS);
    await this.prisma.annotationCollaborationTicket.create({
      data: {
        tokenHash: hashToken(ticket),
        annotationFileId,
        userId: user.id,
        expiresAt,
      },
    });
    return {
      ticket,
      expiresAt: expiresAt.toISOString(),
      websocketPath: `/api/annotation-files/${encodeURIComponent(annotationFileId)}/collaboration`,
    };
  }

  async consume(ticket: string, annotationFileId: string) {
    if (!/^xiqu_ws_[A-Za-z0-9_-]{43}$/.test(ticket)) throw unauthorized("协作连接票据无效或已失效。");
    const result = await this.prisma.$transaction(async (transaction) => {
      const now = new Date();
      const row = await transaction.annotationCollaborationTicket.findUnique({
        where: { tokenHash: hashToken(ticket) },
        include: { user: { include: { roles: true } } },
      });
      if (
        !row ||
        row.annotationFileId !== annotationFileId ||
        row.consumedAt ||
        row.expiresAt <= now ||
        !row.user.isActive
      ) {
        throw unauthorized("协作连接票据无效或已失效。");
      }

      // 条件更新是一次性消费的并发边界；同一明文票据最多一个连接能把 count 改为 1。
      const consumed = await transaction.annotationCollaborationTicket.updateMany({
        where: {
          id: row.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw unauthorized("协作连接票据无效或已失效。");

      const user = toPublicUser(row.user);
      try {
        await this.access.assertCapability(user, annotationFileId, "read", transaction);
        const file = await assertActiveAnnotationFile(transaction, annotationFileId);
        return {
          allowed: true as const,
          user,
          annotationFileId,
          revision: file.revision,
          operationCursor: encodeAnnotationSnapshotOperationCursor(
            annotationFileId,
            file.revision,
          ),
        };
      } catch (error) {
        // 票据一经正确端点消费就必须烧毁；撤权/回收失败不能因事务回滚让同一明文稍后重试。
        if (error instanceof HttpError && (error.statusCode === 403 || error.statusCode === 404)) {
          return { allowed: false as const };
        }
        throw error;
      }
    });
    if (!result.allowed) throw forbidden("当前账号已不能读取该标注文件。");
    return result;
  }

  async assertReadable(user: ApiUser, annotationFileId: string) {
    const account = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: { roles: true },
    });
    if (!account?.isActive) throw forbidden("当前账号已停用。");
    // 长连接存活期间角色也可能被管理员调整；复核必须使用数据库当前角色，不能沿用票据签发快照。
    await this.access.assertCapability(toPublicUser(account), annotationFileId, "read");
    await assertActiveAnnotationFile(this.prisma, annotationFileId);
  }

  // WebSocket 订阅建立后必须重新读取一次权威同步头，不能继续使用票据消费时的旧 revision。
  // 该方法同时复核当前账号与文件状态，供建连窗口和后续需要一致性检查的入口复用。
  async readCurrentHead(user: ApiUser, annotationFileId: string) {
    await this.assertReadable(user, annotationFileId);
    const file = await assertActiveAnnotationFile(this.prisma, annotationFileId);
    return {
      revision: file.revision,
      operationCursor: encodeAnnotationSnapshotOperationCursor(
        annotationFileId,
        file.revision,
      ),
    };
  }

  private async cleanupExpiredTickets() {
    const expired = await this.prisma.annotationCollaborationTicket.findMany({
      where: {
        OR: [
          { expiresAt: { lte: new Date() } },
          { consumedAt: { not: null } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: EXPIRED_TICKET_CLEANUP_LIMIT,
    });
    if (!expired.length) return;
    await this.prisma.annotationCollaborationTicket.deleteMany({
      where: { id: { in: expired.map(({ id }) => id) } },
    });
  }
}
