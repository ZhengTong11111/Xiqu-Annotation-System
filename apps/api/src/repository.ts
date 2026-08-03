import { randomBytes } from "node:crypto";
import {
  type AuditAction,
  type Prisma,
  type PrismaClient,
  type ProcessingJobType as DbProcessingJobType,
} from "@prisma/client";
import {
  parseAnnotationCommandEnvelope,
  type AnnotationCommittedOperationPage,
  type AnnotationOperationPage,
  type AnnotationOperationRecord,
  type CreateAnnotationOperationRequest,
  type CreateProcessingJobRequest,
  type ProcessingJob,
} from "@xiqu/shared";
import { hashToken, verifyPassword } from "./auth.js";
import type { ApiUser } from "./domain.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "./errors.js";
import { ResourceAccessService } from "./resourceAccess.js";
import { toFile, toPublicUser } from "./repositoryMappers.js";
import { ensurePlatformSeedData } from "./repositorySeed.js";
import { createAnnotationOperationRequestHash } from "./annotationOperationIdempotency.js";
import {
  AnnotationOperationCursorError,
  encodeAnnotationOperationCursor,
  normalizeAnnotationOperationPage,
} from "./annotationOperationPagination.js";
import {
  AnnotationCommittedOperationCursorError,
  encodeAnnotationCommittedOperationCursor,
  normalizeAnnotationCommittedOperationPage,
} from "./annotationCommittedOperationPagination.js";

export class PrismaPlatformRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async ensureSeedData() {
    await ensurePlatformSeedData(this.prisma);
  }

  async login(accountName: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { accountName },
      include: { roles: true },
    });
    if (
      !user ||
      !user.isActive ||
      !(await verifyPassword(password, user.passwordHash))
    ) {
      throw unauthorized("账号或密码错误。");
    }
    const token = `xiqu_${randomBytes(32).toString("base64url")}`;
    await this.prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      },
    });
    await this.writeAuditLog({
      action: "auth_login",
      actorUserId: user.id,
      detail: {},
    });
    return { user: toPublicUser(user), accessToken: token };
  }

  async getUserByToken(token: string | null) {
    if (!token) throw unauthorized();
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { include: { roles: true } } },
    });
    if (
      !session ||
      session.expiresAt.getTime() < Date.now() ||
      !session.user.isActive
    ) {
      throw unauthorized();
    }
    return toPublicUser(session.user);
  }

  async listDirectoryUsers(user: ApiUser, query?: string) {
    if (!this.access.isGlobalAdmin(user) && !user.roles.includes("ta")) {
      throw forbidden("只有管理员和助教可以浏览账号目录。");
    }
    const rows = await this.prisma.user.findMany({
      where: {
        isActive: true,
        ...(query?.trim()
          ? {
              OR: [
                { displayName: { contains: query.trim(), mode: "insensitive" } },
                { accountName: { contains: query.trim(), mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { roles: true },
      orderBy: { displayName: "asc" },
      take: 200,
    });
    return rows.map(toPublicUser);
  }

  async getFileForRead(user: ApiUser, fileId: string) {
    const file = await this.prisma.fileObject.findUnique({
      where: { id: fileId },
      include: { mediaFiles: true },
    });
    if (!file) throw notFound("文件不存在。");
    if (file.ownerUserId !== user.id && !this.access.isGlobalAdmin(user)) {
      let canDownload = false;
      // 一个不可变 FileObject 可以被多个媒体资源复用；只要账号能下载其中任一资源，就能读取
      // 同一物理对象。这里不能再依赖历史上的单数 mediaFile 关系。
      for (const mediaFile of file.mediaFiles) {
        const permission = await this.access.getEffectivePermission(
          user,
          mediaFile.resourceId,
        );
        if (permission.capabilities.includes("download")) {
          canDownload = true;
          break;
        }
      }
      if (!canDownload) throw forbidden("当前账号不能读取该文件。");
    }
    return toFile(file);
  }

  async createProcessingJob(
    user: ApiUser,
    input: CreateProcessingJobRequest,
  ): Promise<ProcessingJob> {
    if (input.resourceId) {
      await this.access.assertCapability(user, input.resourceId, "write");
    }
    for (const fileId of input.inputFileIds) {
      await this.getFileForRead(user, fileId);
    }
    const row = await this.prisma.processingJob.create({
      data: {
        type: input.type as DbProcessingJobType,
        resourceId: input.resourceId ?? null,
        inputFileIds: input.inputFileIds,
        createdBy: user.id,
      },
    });
    await this.writeAuditLog({
      action: "job_create",
      actorUserId: user.id,
      resourceId: input.resourceId ?? null,
      detail: { type: input.type, inputFileIds: input.inputFileIds },
    });
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      resourceId: row.resourceId,
      inputFileIds: row.inputFileIds,
      createdBy: row.createdBy,
      progress: row.progress,
      errorMessage: row.errorMessage,
      result: row.result,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listAnnotationOperations(
    user: ApiUser,
    annotationFileId: string,
    options: { cursor?: unknown; limit?: unknown } = {},
  ): Promise<AnnotationOperationPage> {
    await this.access.assertCapability(user, annotationFileId, "read");
    let page;
    try {
      page = normalizeAnnotationOperationPage({ annotationFileId, ...options });
    } catch (error) {
      if (error instanceof AnnotationOperationCursorError) throw badRequest(error.message);
      throw error;
    }
    const rows = await this.prisma.annotationOperation.findMany({
      where: { annotationFileId, sequence: { gt: page.afterSequence } },
      orderBy: { sequence: "asc" },
      take: page.limit + 1,
    });
    const hasMore = rows.length > page.limit;
    const visibleRows = rows.slice(0, page.limit);
    const lastSequence = visibleRows.length > 0
      ? visibleRows[visibleRows.length - 1]?.sequence
      : undefined;
    return {
      items: visibleRows.map(this.mapOperation),
      // 空页保留调用方已有 cursor，后续轮询不会倒退到文件开头。
      nextCursor: lastSequence === undefined
        ? page.sourceCursor
        : encodeAnnotationOperationCursor(annotationFileId, lastSequence),
      hasMore,
    };
  }

  // 已提交 feed 只暴露与完整 payload revision 原子绑定的 operation，并按保存顺序稳定续读。
  async listCommittedAnnotationOperations(
    user: ApiUser,
    annotationFileId: string,
    options: { cursor?: unknown; limit?: unknown } = {},
  ): Promise<AnnotationCommittedOperationPage> {
    await this.access.assertCapability(user, annotationFileId, "read");
    let page;
    try {
      page = normalizeAnnotationCommittedOperationPage({ annotationFileId, ...options });
    } catch (error) {
      if (error instanceof AnnotationCommittedOperationCursorError) throw badRequest(error.message);
      throw error;
    }

    // committedRevision 先决定快照顺序，sequence 只负责同一次保存内的稳定次序。
    const rows = await this.prisma.annotationOperation.findMany({
      where: {
        annotationFileId,
        committedRevision: { not: null },
        OR: [
          { committedRevision: { gt: page.afterCommittedRevision } },
          {
            committedRevision: page.afterCommittedRevision,
            sequence: { gt: page.afterSequence },
          },
        ],
      },
      orderBy: [
        { committedRevision: "asc" },
        { sequence: "asc" },
      ],
      take: page.limit + 1,
    });
    const hasMore = rows.length > page.limit;
    const visibleRows = rows.slice(0, page.limit);
    const lastRow = visibleRows.length > 0
      ? visibleRows[visibleRows.length - 1]
      : undefined;
    if (lastRow && lastRow.committedRevision === null) {
      throw new Error("已提交 operation 查询返回了空 committedRevision。");
    }

    // 文件 revision 在 operation 查询后读取，响应不会声称落后于本页已经返回的提交事实。
    const file = await this.prisma.annotationFile.findUnique({
      where: { resourceId: annotationFileId },
      select: { revision: true },
    });
    if (!file) throw notFound("标注文件不存在。");
    return {
      items: visibleRows.map(this.mapOperation),
      nextCursor: lastRow && lastRow.committedRevision !== null
        ? encodeAnnotationCommittedOperationCursor(
            annotationFileId,
            lastRow.committedRevision,
            lastRow.sequence,
          )
        : page.sourceCursor,
      hasMore,
      currentRevision: file.revision,
    };
  }

  async createAnnotationOperation(
    user: ApiUser,
    annotationFileId: string,
    input: CreateAnnotationOperationRequest,
  ) {
    await this.access.assertCapability(user, annotationFileId, "write");
    const requestHash = createAnnotationOperationRequestHash({
      baseRevision: input.baseRevision,
      localRevision: input.localRevision ?? null,
      action: input.action,
      payload: input.payload,
    });
    const row = await this.prisma.$transaction(async (transaction) => {
      const uniqueWhere = {
        annotationFileId_actorUserId_clientOperationId: {
          annotationFileId,
          actorUserId: user.id,
          clientOperationId: input.clientOperationId,
        },
      } as const;

      // 已接受请求的重放必须先于 revision 检查；完整保存推进 revision 后，旧响应的安全重试仍应返回原行。
      const existing = await transaction.annotationOperation.findUnique({
        where: uniqueWhere,
      });
      if (existing) {
        assertIdempotentOperationMatch(existing.requestHash, requestHash);
        return existing;
      }

      // 排他锁同时串行化同一文件的 sequence 分配；不同文件仍可独立并发。
      await transaction.$queryRaw`
        SELECT resource_id
        FROM annotation_files
        WHERE resource_id = ${annotationFileId}
        FOR UPDATE
      `;
      // 并发相同 key 可能都在加锁前读到空；取得锁后必须再次检查，避免浪费一个 sequence。
      const existingAfterLock = await transaction.annotationOperation.findUnique({
        where: uniqueWhere,
      });
      if (existingAfterLock) {
        assertIdempotentOperationMatch(existingAfterLock.requestHash, requestHash);
        return existingAfterLock;
      }
      const file = await transaction.annotationFile.findUnique({
        where: { resourceId: annotationFileId },
      });
      if (!file) throw notFound("标注文件不存在。");
      if (input.baseRevision !== file.revision) {
        // operation log 与完整 payload 保存共享同一个远端基线；记录过期操作会让客户端
        // 误以为该操作已被服务器接受，因此必须保留客户端 pending 队列。
        throw conflict("标注文件已被其他人修改，请刷新后再提交操作。", {
          expectedRevision: file.revision,
          receivedRevision: input.baseRevision,
        });
      }
      // 文件行计数器是唯一序号分配源，不能用 max(sequence)+1 产生并发重复。
      const sequenceState = await transaction.annotationFile.update({
        where: { resourceId: annotationFileId },
        data: { lastOperationSequence: { increment: 1 } },
        select: { lastOperationSequence: true },
      });
      // 文件锁内已完成幂等复查，此处只保留唯一创建路径，避免并行 upsert 语义掩盖序号来源。
      return transaction.annotationOperation.create({
        data: {
          annotationFileId,
          actorUserId: user.id,
          clientOperationId: input.clientOperationId,
          requestHash,
          sequence: sequenceState.lastOperationSequence,
          baseRevision: input.baseRevision,
          localRevision: input.localRevision ?? null,
          action: input.action,
          payload: input.payload as Prisma.InputJsonValue,
          status: "accepted",
        },
      });
    });
    return this.mapOperation(row);
  }

  async writeAuditLog(input: {
    action: AuditAction;
    actorUserId?: string | null;
    resourceId?: string | null;
    fileId?: string | null;
    targetUserId?: string | null;
    detail?: unknown;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: input.action,
          actorUserId: input.actorUserId ?? null,
          resourceId: input.resourceId ?? null,
          fileId: input.fileId ?? null,
          targetUserId: input.targetUserId ?? null,
          detail: (input.detail ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // 多数审计在主业务事务提交后写入。此时返回 500 会诱导客户端重试已完成的写操作，
      // 反而制造重复资源；记录最小上下文并保持主操作结果。
      console.error("写入平台审计日志失败", {
        action: input.action,
        actorUserId: input.actorUserId ?? null,
        resourceId: input.resourceId ?? null,
        error,
      });
    }
  }

  private mapOperation(row: {
    id: string;
    annotationFileId: string;
    actorUserId: string;
    clientOperationId: string;
    sequence: number;
    baseRevision: number;
    localRevision: number | null;
    action: string;
    payload: Prisma.JsonValue;
    status: "accepted" | "rejected" | "superseded";
    committedRevision: number | null;
    committedAt: Date | null;
    createdAt: Date;
  }): AnnotationOperationRecord {
    return {
      id: row.id,
      annotationFileId: row.annotationFileId,
      actorUserId: row.actorUserId,
      clientOperationId: row.clientOperationId,
      sequence: row.sequence,
      baseRevision: row.baseRevision,
      localRevision: row.localRevision,
      action: row.action,
      payload: row.payload,
      status: row.status,
      commitState: row.committedRevision === null ? "accepted" : "committed",
      committedRevision: row.committedRevision,
      committedAt: row.committedAt?.toISOString() ?? null,
      replayability: parseAnnotationCommandEnvelope(row.payload) &&
        row.action === "timeline.items.timing.update"
        ? "domain_command"
        : "requires_snapshot",
      createdAt: row.createdAt.toISOString(),
    };
  }
}

// 同一幂等 key 只能代表一个不可变请求；冲突响应不回显服务端 hash 或客户端 payload。
function assertIdempotentOperationMatch(
  storedRequestHash: string,
  receivedRequestHash: string,
) {
  if (storedRequestHash !== receivedRequestHash) {
    throw conflict("客户端操作编号已用于另一项请求。", {
      code: "idempotency_conflict",
    });
  }
}
