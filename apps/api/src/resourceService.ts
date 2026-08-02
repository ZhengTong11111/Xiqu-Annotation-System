import {
  AnnotationConfirmationDomain as DbAnnotationConfirmationDomain,
  Prisma,
  type PrismaClient,
  type ResourceType as DbResourceType,
} from "@prisma/client";
import type {
  AnnotationConfirmationDomain,
  AnnotationConfirmationDraft,
  AnnotationConfirmationList,
  AnnotationConfirmationRecord,
  AnnotationFile,
  AnnotationRecoverySnapshotDetail,
  AnnotationRecoverySnapshotSummary,
  BatchMoveResourcesRequest,
  BatchMoveResourcesResponse,
  BatchTrashResourcesRequest,
  BatchTrashResourcesResponse,
  CopyResourceRequest,
  CreateAnnotationFileRequest,
  CreateResourceRequest,
  EffectiveResourcePermission,
  ImportMediaFileRequest,
  ListResourcesOptions,
  ResourceCapability,
  ResourceEntry,
  ResourceListPage,
  ResourcePermissionMatrixRow,
  ResourcePermissionRecord,
  RestoreAnnotationRecoverySnapshotRequest,
  SaveAnnotationFileRequest,
  UpdateResourceRequest,
  UpsertResourcePermissionRequest,
} from "@xiqu/shared";
import {
  canCreateAnnotationConfirmation,
  canRevokeAnnotationConfirmation,
  extractPersistedAnnotationTrackIds,
  validateAnnotationConfirmationDraft,
  validateAnnotationConfirmationTracks,
} from "@xiqu/document-model";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { ResourceAccessService } from "./resourceAccess.js";
import {
  buildResourceCopyPlan,
  MAX_RECURSIVE_COPY_NODES,
  type CopySourceNode,
} from "./resourceCopy.js";
import {
  normalizeResourceSelection,
  type ResourceSelectionNode,
} from "./resourceSelection.js";
import {
  ResourceCursorError,
  buildResourceOrderBy,
  decodeResourceCursor,
  encodeResourceCursor,
  getResourceScanBatchSize,
  mapWithConcurrency,
  normalizeResourceQuery,
  type NormalizedResourceQuery,
} from "./resourcePagination.js";
import { toPublicUser } from "./repositoryMappers.js";

const resourceInclude = {
  owner: { include: { roles: true } },
  _count: { select: { children: true } },
  annotationFile: true,
  mediaFile: true,
} satisfies Prisma.ResourceEntryInclude;

const annotationConfirmationInclude = {
  creator: { include: { roles: true } },
  revoker: { include: { roles: true } },
} satisfies Prisma.AnnotationConfirmationInclude;

type ResourceRow = Prisma.ResourceEntryGetPayload<{
  include: typeof resourceInclude;
}>;
type AnnotationConfirmationRow = Prisma.AnnotationConfirmationGetPayload<{
  include: typeof annotationConfirmationInclude;
}>;

export type CopyResourceResult = {
  resource: ResourceEntry;
  summary: {
    copiedNodeCount: number;
    copiedAnnotationCount: number;
    reusedFileObjectCount: number;
  };
};

const MAX_CONFIRMATION_REVOKE_REASON_LENGTH = 1_000;

// Prisma 枚举与共享合同保持显式双向映射，避免数据库命名变化被隐式类型断言掩盖。
const DB_CONFIRMATION_DOMAINS: Record<
  AnnotationConfirmationDomain,
  DbAnnotationConfirmationDomain
> = {
  subtitle_lines: DbAnnotationConfirmationDomain.subtitle_lines,
  character_annotations: DbAnnotationConfirmationDomain.character_annotations,
  gongche_annotations: DbAnnotationConfirmationDomain.gongche_annotations,
  banyan_sections: DbAnnotationConfirmationDomain.banyan_sections,
  banyan_marks: DbAnnotationConfirmationDomain.banyan_marks,
  custom_tracks: DbAnnotationConfirmationDomain.custom_tracks,
  custom_blocks: DbAnnotationConfirmationDomain.custom_blocks,
  attached_points: DbAnnotationConfirmationDomain.attached_points,
};

// 出站映射与入站映射分开定义，让 TypeScript 在新增数据库领域时强制提示补齐 API 合同。
const SHARED_CONFIRMATION_DOMAINS: Record<
  DbAnnotationConfirmationDomain,
  AnnotationConfirmationDomain
> = {
  subtitle_lines: "subtitle_lines",
  character_annotations: "character_annotations",
  gongche_annotations: "gongche_annotations",
  banyan_sections: "banyan_sections",
  banyan_marks: "banyan_marks",
  custom_tracks: "custom_tracks",
  custom_blocks: "custom_blocks",
  attached_points: "attached_points",
};

export class ResourceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async listResources(
    user: ApiUser,
    options: ListResourcesOptions,
  ): Promise<ResourceListPage> {
    const query = normalizeResourceQuery(options);
    const where = this.buildListWhere(user, query);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const scanBatchSize = getResourceScanBatchSize(limit);
    let candidateCursorId: string | null = null;
    if (options.cursor) {
      try {
        candidateCursorId = decodeResourceCursor(options.cursor, query);
      } catch (error) {
        if (error instanceof ResourceCursorError) throw badRequest(error.message);
        throw error;
      }
      // cursor 行必须仍属于同一数据库候选集合；资源已移动/删除时要求调用方刷新第一页。
      const cursorStillMatches = await this.prisma.resourceEntry.findFirst({
        where: { AND: [where, { id: candidateCursorId }] },
        select: { id: true },
      });
      if (!cursorStillMatches) {
        throw badRequest("资源分页游标已经失效，请刷新当前目录。");
      }
    }

    const visible: Array<{ row: ResourceRow; permission: EffectiveResourcePermission }> = [];
    let exhausted = false;
    // ACL 在数据库候选之后判断，因此按有限批次持续扫描，直到得到 limit+1 个可见项或候选耗尽。
    while (visible.length <= limit && !exhausted) {
      const rows = await this.prisma.resourceEntry.findMany({
        where,
        include: resourceInclude,
        orderBy: buildResourceOrderBy(query),
        take: scanBatchSize,
        ...(candidateCursorId
          ? { cursor: { id: candidateCursorId }, skip: 1 }
          : {}),
      });
      if (rows.length === 0) break;
      exhausted = rows.length < scanBatchSize;
      candidateCursorId = rows.at(-1)!.id;

      // 每批以有界并发计算软删除祖先和有效 ACL，结果顺序仍与数据库稳定排序一致。
      const evaluated = await mapWithConcurrency(rows, 12, async (row) => {
        if (
          query.view !== "trash" &&
          await this.hasTrashedAncestor(this.prisma, row.parentId)
        ) {
          return null;
        }
        const permission = await this.access.getEffectivePermission(user, row.id);
        return permission.capabilities.includes("read")
          ? { row, permission }
          : null;
      });
      for (const item of evaluated) {
        if (item) visible.push(item);
      }
    }

    const page = visible.slice(0, limit);
    return {
      items: await Promise.all(page.map(({ row, permission }) =>
        this.mapResource(user, row, permission))),
      breadcrumbs: options.parentId
        ? await this.buildBreadcrumbs(user, options.parentId)
        : [],
      nextCursor: visible.length > limit && page.length > 0
        ? encodeResourceCursor(page.at(-1)!.row.id, query)
        : null,
    };
  }

  async getResource(user: ApiUser, resourceId: string) {
    await this.access.assertCapability(user, resourceId, "read");
    return this.getMappedResource(user, resourceId);
  }

  async createResource(user: ApiUser, input: CreateResourceRequest) {
    if (input.parentId) {
      await this.assertContainer(input.parentId);
      await this.access.assertCapability(user, input.parentId, "create_child");
    } else if (!this.access.isGlobalAdmin(user)) {
      throw forbidden("只有管理员可以在资源根目录创建项目或文件夹。");
    }
    const name = this.validateName(input.name);
    const parentId = input.parentId ?? null;
    const resource = await this.prisma.$transaction(async (transaction) => {
      await this.lockParentNamespaces(transaction, [parentId]);
      await this.assertNameAvailable(transaction, parentId, name);
      return transaction.resourceEntry.create({
        data: {
          parentId,
          type: input.type,
          name,
          ownerUserId: user.id,
          projectMetadata: input.type === "project"
            ? { create: { description: input.description ?? null } }
            : undefined,
        },
        include: resourceInclude,
      });
    });
    return this.mapResource(
      user,
      resource,
      await this.access.getEffectivePermission(user, resource.id),
    );
  }

  async createAnnotationFile<TPayload>(
    user: ApiUser,
    input: CreateAnnotationFileRequest<TPayload>,
  ): Promise<AnnotationFile<TPayload>> {
    await this.assertContainer(input.parentId);
    await this.access.assertCapability(user, input.parentId, "create_child");
    const name = this.validateName(input.name);
    const resource = await this.prisma.$transaction(async (transaction) => {
      await this.lockParentNamespaces(transaction, [input.parentId]);
      await this.assertNameAvailable(
        transaction,
        input.parentId,
        name,
      );
      return transaction.resourceEntry.create({
        data: {
          parentId: input.parentId,
          type: "annotation_file",
          name,
          ownerUserId: user.id,
          annotationFile: {
            create: {
              payload: input.payload as Prisma.InputJsonValue,
              mediaResourceId: input.mediaResourceId ?? null,
              lastEditedBy: user.id,
            },
          },
        },
        include: {
          ...resourceInclude,
          annotationFile: {
            include: { lastEditor: { include: { roles: true } } },
          },
        },
      });
    });
    return this.mapAnnotationFile<TPayload>(
      user,
      resource,
      resource.annotationFile!,
    );
  }

  async importMediaFile(
    user: ApiUser,
    input: ImportMediaFileRequest,
  ) {
    await this.assertContainer(input.parentId);
    await this.access.assertCapability(user, input.parentId, "create_child");
    const file = await this.prisma.fileObject.findUnique({
      where: { id: input.fileId },
    });
    if (!file) throw notFound("上传文件不存在。");
    if (file.ownerUserId !== user.id && !this.access.isGlobalAdmin(user)) {
      throw forbidden("只能把自己上传的文件加入资源树。");
    }
    const name = this.validateName(input.name ?? file.name);
    const resource = await this.prisma.$transaction(async (transaction) => {
      await this.lockParentNamespaces(transaction, [input.parentId]);
      await this.assertNameAvailable(
        transaction,
        input.parentId,
        name,
      );
      return transaction.resourceEntry.create({
        data: {
          parentId: input.parentId,
          type: "media_file",
          name,
          ownerUserId: user.id,
          mediaFile: {
            create: {
              fileId: file.id,
              mimeType: file.mimeType,
              size: file.size,
            },
          },
        },
        include: resourceInclude,
      });
    });
    return this.mapResource(
      user,
      resource,
      await this.access.getEffectivePermission(user, resource.id),
    );
  }

  async getAnnotationFile<TPayload>(
    user: ApiUser,
    resourceId: string,
  ): Promise<AnnotationFile<TPayload>> {
    await this.access.assertCapability(user, resourceId, "read");
    const resource = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
      include: {
        ...resourceInclude,
        annotationFile: {
          include: { lastEditor: { include: { roles: true } } },
        },
      },
    });
    if (!resource?.annotationFile) throw notFound("标注文件不存在。");
    await this.prisma.resourceUserState.upsert({
      where: { resourceId_userId: { resourceId, userId: user.id } },
      update: { lastOpenedAt: new Date() },
      create: { resourceId, userId: user.id, lastOpenedAt: new Date() },
    });
    return this.mapAnnotationFile<TPayload>(
      user,
      resource,
      resource.annotationFile,
    );
  }

  async saveAnnotationFile<TPayload>(
    user: ApiUser,
    resourceId: string,
    input: SaveAnnotationFileRequest<TPayload>,
  ): Promise<AnnotationFile<TPayload>> {
    // 锁外预检用于快速拒绝常见无权限请求；事务内仍会在树结构稳定后再次复核。
    await this.access.assertCapability(user, resourceId, "write");
    await this.prisma.$transaction(async (transaction) => {
      // 普通保存与快照恢复共用同一锁顺序，避免保存期间资源被移动或藏入回收站。
      const current = await this.lockAnnotationFileForContentMutation(
        transaction,
        user,
        resourceId,
      );
      if (current.revision !== input.baseRevision) {
        throw conflict("标注文件已被其他人修改，请刷新后再保存。", {
          expectedRevision: current.revision,
          receivedRevision: input.baseRevision,
        });
      }

      // 保存前把旧内容写入恢复快照；它只通过标注文件 Inspector 受控查看，不是业务“版本”。
      await transaction.annotationRecoverySnapshot.upsert({
        where: {
          annotationFileId_revision: {
            annotationFileId: resourceId,
            revision: current.revision,
          },
        },
        update: {},
        create: {
          annotationFileId: resourceId,
          revision: current.revision,
          payload: current.payload as Prisma.InputJsonValue,
          createdBy: user.id,
          reason: "save",
        },
      });

      // revision 必须参与 UPDATE 条件。即使两个请求同时读到同一 revision，
      // 也只能有一个请求真正取得写入权，另一个事务会整体回滚。
      const updated = await transaction.annotationFile.updateMany({
        where: { resourceId, revision: input.baseRevision },
        data: {
          payload: input.payload as Prisma.InputJsonValue,
          revision: { increment: 1 },
          lastEditedBy: user.id,
          lastSavedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        const latest = await transaction.annotationFile.findUnique({
          where: { resourceId },
          select: { revision: true },
        });
        throw conflict("标注文件已被其他人修改，请刷新后再保存。", {
          expectedRevision: latest?.revision ?? input.baseRevision,
          receivedRevision: input.baseRevision,
        });
      }
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { updatedAt: new Date() },
      });

      // 保存审计与 payload 写入同属一个事务，失败时不会出现“已保存但无审计”的半完成状态。
      await transaction.auditLog.create({
        data: {
          action: "annotation_file_save",
          actorUserId: user.id,
          resourceId,
          detail: { revision: current.revision + 1 },
        },
      });
    });
    return this.getAnnotationFile<TPayload>(user, resourceId);
  }

  // 历史列表只返回轻量元数据，避免一次读取最多 50 份完整 ProjectData。
  async listRecoverySnapshots(
    user: ApiUser,
    resourceId: string,
  ): Promise<AnnotationRecoverySnapshotSummary[]> {
    await this.access.assertCapability(user, resourceId, "write");
    await this.assertActiveAnnotationFile(resourceId);
    const rows = await this.prisma.annotationRecoverySnapshot.findMany({
      where: { annotationFileId: resourceId },
      select: {
        id: true,
        annotationFileId: true,
        revision: true,
        creator: { include: { roles: true } },
        reason: true,
        createdAt: true,
      },
      // revision 理论上已唯一；附加时间和 id 让异常迁移数据也保持稳定顺序。
      orderBy: [
        { revision: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
      creator: toPublicUser(row.creator),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // 详情查询同时绑定文件和快照 id，防止利用其他文件的 snapshot id 越权读取 payload。
  async getRecoverySnapshot<TPayload>(
    user: ApiUser,
    resourceId: string,
    snapshotId: string,
  ): Promise<AnnotationRecoverySnapshotDetail<TPayload>> {
    await this.access.assertCapability(user, resourceId, "write");
    await this.assertActiveAnnotationFile(resourceId);
    const row = await this.prisma.annotationRecoverySnapshot.findFirst({
      where: {
        id: snapshotId,
        annotationFileId: resourceId,
      },
      include: { creator: { include: { roles: true } } },
    });
    if (!row) throw notFound("恢复快照不存在。");
    return {
      id: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
      payload: row.payload as TPayload,
      creator: toPublicUser(row.creator),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // 恢复历史不是 revision 回退，而是把目标 payload 写成新的当前 revision，并保留恢复前内容。
  async restoreAnnotationRecoverySnapshot<TPayload>(
    user: ApiUser,
    resourceId: string,
    snapshotId: string,
    input: RestoreAnnotationRecoverySnapshotRequest,
  ): Promise<AnnotationFile<TPayload>> {
    // 锁外预检减少无权限请求占用事务；真正安全边界仍在锁内 helper 中。
    await this.access.assertCapability(user, resourceId, "write");
    await this.prisma.$transaction(async (transaction) => {
      const current = await this.lockAnnotationFileForContentMutation(
        transaction,
        user,
        resourceId,
      );
      if (current.revision !== input.baseRevision) {
        throw conflict("标注文件已被其他人修改，请刷新后再恢复。", {
          expectedRevision: current.revision,
          receivedRevision: input.baseRevision,
        });
      }

      // 快照 id 必须和路径中的文件 id 同时匹配，不能借其他文件的 id 读取或恢复 payload。
      const sourceSnapshot = await transaction.annotationRecoverySnapshot
        .findFirst({
          where: {
            id: snapshotId,
            annotationFileId: resourceId,
          },
        });
      if (!sourceSnapshot) throw notFound("恢复快照不存在。");

      // 覆盖前保存当前内容，使用户能够再次恢复到本次操作之前的状态。
      await transaction.annotationRecoverySnapshot.upsert({
        where: {
          annotationFileId_revision: {
            annotationFileId: resourceId,
            revision: current.revision,
          },
        },
        update: {},
        create: {
          annotationFileId: resourceId,
          revision: current.revision,
          payload: current.payload as Prisma.InputJsonValue,
          createdBy: user.id,
          reason: "before_snapshot_restore",
        },
      });

      // revision 仍参与条件更新；即使未来锁实现变化，乐观锁也不会静默覆盖并发写入。
      const updated = await transaction.annotationFile.updateMany({
        where: { resourceId, revision: input.baseRevision },
        data: {
          payload: sourceSnapshot.payload as Prisma.InputJsonValue,
          revision: { increment: 1 },
          lastEditedBy: user.id,
          lastSavedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        const latest = await transaction.annotationFile.findUnique({
          where: { resourceId },
          select: { revision: true },
        });
        throw conflict("标注文件已被其他人修改，请刷新后再恢复。", {
          expectedRevision: latest?.revision ?? input.baseRevision,
          receivedRevision: input.baseRevision,
        });
      }

      // 资源修改时间和恢复审计与内容替换同时提交，审计只记录定位信息而不复制 payload。
      const nextRevision = current.revision + 1;
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { updatedAt: new Date() },
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_snapshot_restore",
          actorUserId: user.id,
          resourceId,
          detail: {
            sourceSnapshotId: sourceSnapshot.id,
            sourceRevision: sourceSnapshot.revision,
            previousRevision: current.revision,
            revision: nextRevision,
          },
        },
      });
    });
    return this.getAnnotationFile<TPayload>(user, resourceId);
  }

  // 确认列表只返回治理元数据和当前 revision，不读取或复制 annotation payload。
  async listAnnotationConfirmations(
    user: ApiUser,
    resourceId: string,
  ): Promise<AnnotationConfirmationList> {
    await this.access.assertCapability(user, resourceId, "read");
    await this.assertActiveAnnotationFile(resourceId);
    const [file, rows] = await Promise.all([
      this.prisma.annotationFile.findUnique({
        where: { resourceId },
        select: { revision: true },
      }),
      this.prisma.annotationConfirmation.findMany({
        where: { annotationFileId: resourceId },
        include: annotationConfirmationInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 200,
      }),
    ]);
    if (!file) throw notFound("标注文件不存在。");
    return {
      currentRevision: file.revision,
      confirmations: rows.map((row) => this.mapAnnotationConfirmation(row)),
    };
  }

  // 创建确认在锁内重新校验 revision、活动资源、逐资源 review 和真实持久轨道。
  async createAnnotationConfirmation(
    user: ApiUser,
    resourceId: string,
    input: Omit<AnnotationConfirmationDraft, "annotationFileId">,
  ): Promise<AnnotationConfirmationRecord> {
    const validated = validateAnnotationConfirmationDraft({
      annotationFileId: resourceId,
      ...input,
    });
    if (!validated.ok) {
      throw badRequest("确认范围格式不正确。", { issues: validated.issues });
    }

    return this.prisma.$transaction(async (transaction) => {
      const current = await this.lockAnnotationFileForConfirmation(
        transaction,
        user,
        resourceId,
      );
      if (current.revision !== validated.value.confirmedRevision) {
        throw conflict("标注文件已产生新修订，请刷新后重新审核。", {
          expectedRevision: current.revision,
          receivedRevision: validated.value.confirmedRevision,
        });
      }

      // tracks 只能引用当前 payload 中真实保存的顶层轨道；无法识别旧结构时保守拒绝。
      if (validated.value.scope.targets.mode === "tracks") {
        const trackIds = extractPersistedAnnotationTrackIds(current.payload);
        if (!trackIds.ok) {
          throw badRequest("当前标注内容无法验证轨道作用域。", {
            issues: trackIds.issues,
          });
        }
        const trackScope = validateAnnotationConfirmationTracks(
          validated.value.scope,
          new Set(trackIds.value),
        );
        if (!trackScope.ok) {
          throw badRequest("确认范围包含无效轨道。", { issues: trackScope.issues });
        }
      }

      const created = await transaction.annotationConfirmation.create({
        data: this.toAnnotationConfirmationCreateData(user.id, validated.value),
        include: annotationConfirmationInclude,
      });
      // 审计与确认记录同事务提交，detail 只保留定位字段，不复制 note 或 payload。
      await transaction.auditLog.create({
        data: {
          action: "annotation_confirmation_create",
          actorUserId: user.id,
          resourceId,
          detail: {
            confirmationId: created.id,
            confirmedRevision: created.confirmedRevision,
            startTime: created.startTime,
            endTime: created.endTime,
            targetMode: created.targetMode,
          },
        },
      });
      return this.mapAnnotationConfirmation(created);
    });
  }

  // 撤销只补充撤销事实；重复请求幂等返回原记录，不产生第二条审计。
  async revokeAnnotationConfirmation(
    user: ApiUser,
    resourceId: string,
    confirmationId: string,
    reason?: string | null,
  ): Promise<AnnotationConfirmationRecord> {
    const revokeReason = reason?.trim() || null;
    if (revokeReason && revokeReason.length > MAX_CONFIRMATION_REVOKE_REASON_LENGTH) {
      throw badRequest(
        `撤销原因不能超过 ${MAX_CONFIRMATION_REVOKE_REASON_LENGTH} 个字符。`,
      );
    }

    return this.prisma.$transaction(async (transaction) => {
      await this.lockAnnotationFileForConfirmation(
        transaction,
        user,
        resourceId,
      );
      await transaction.$queryRaw`
        SELECT id
        FROM annotation_confirmations
        WHERE id = ${confirmationId} AND annotation_file_id = ${resourceId}
        FOR UPDATE
      `;
      const existing = await transaction.annotationConfirmation.findFirst({
        where: { id: confirmationId, annotationFileId: resourceId },
        include: annotationConfirmationInclude,
      });
      if (!existing) throw notFound("确认记录不存在。");
      if (existing.revokedAt) return this.mapAnnotationConfirmation(existing);

      const isAdminOrOwner = await this.access.hasOwnerAuthority(
        user,
        resourceId,
        transaction,
      );
      const permission = canRevokeAnnotationConfirmation({
        actorUserId: user.id,
        canRead: true,
        canReview: true,
        isAdminOrOwner,
      }, existing.createdBy);
      if (!permission.allowed) throw forbidden("只能撤销自己创建的确认记录。");

      const revokedAt = new Date();
      const updated = await transaction.annotationConfirmation.update({
        where: { id: existing.id },
        data: { revokedBy: user.id, revokedAt, revokeReason },
        include: annotationConfirmationInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_confirmation_revoke",
          actorUserId: user.id,
          resourceId,
          detail: {
            confirmationId: updated.id,
            confirmedRevision: updated.confirmedRevision,
          },
        },
      });
      return this.mapAnnotationConfirmation(updated);
    });
  }

  async updateResource(
    user: ApiUser,
    resourceId: string,
    input: UpdateResourceRequest,
  ) {
    if (input.name !== undefined) {
      await this.access.assertCapability(user, resourceId, "write");
    }
    const normalizedName = input.name === undefined
      ? undefined
      : this.validateName(input.name);
    if (input.archived !== undefined) {
      await this.access.assertCapability(user, resourceId, "delete");
    }
    await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceRows(transaction, [resourceId]);
      const latest = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!latest) throw notFound("资源不存在。");
      if (normalizedName !== undefined) {
        await this.lockParentNamespaces(transaction, [latest.parentId]);
        await this.assertNameAvailable(
          transaction,
          latest.parentId,
          normalizedName,
          resourceId,
        );
      }
      if (input.name !== undefined || input.archived !== undefined) {
        await transaction.resourceEntry.update({
          where: { id: resourceId },
          data: {
            name: normalizedName,
            archivedAt: input.archived ? new Date() : null,
          },
        });
      }
      if (input.favorite !== undefined) {
        await transaction.resourceUserState.upsert({
          where: { resourceId_userId: { resourceId, userId: user.id } },
          update: { favorite: input.favorite },
          create: {
            resourceId,
            userId: user.id,
            favorite: input.favorite,
          },
        });
      }
    });
    return this.getMappedResource(user, resourceId);
  }

  async moveResources(
    user: ApiUser,
    input: BatchMoveResourcesRequest,
  ): Promise<BatchMoveResourcesResponse> {
    const requestedIds = [...new Set(input.resourceIds)];
    const selectionSnapshot = await this.loadResourceSelectionNodes(
      this.prisma,
      requestedIds,
    );
    const requestedNodeIds = new Set(selectionSnapshot.map(({ id }) => id));
    if (requestedIds.some((id) => !requestedNodeIds.has(id))) {
      throw notFound("部分待移动资源不存在。");
    }
    const normalizedSnapshot = normalizeResourceSelection(
      requestedIds,
      selectionSnapshot,
    );
    for (const resourceId of normalizedSnapshot.rootIds) {
      // 选中父目录时，后代随父目录保持内部层级，不要求后代额外具备 move 权限。
      await this.access.assertCapability(user, resourceId, "move");
    }
    if (input.parentId) {
      await this.assertContainer(input.parentId);
      await this.access.assertCapability(user, input.parentId, "create_child");
    } else if (!this.access.isGlobalAdmin(user)) {
      throw forbidden("只有管理员可以把资源移动到根目录。");
    }
    const moved = await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeMutation(transaction);
      const latestSelection = await this.loadResourceSelectionNodes(
        transaction,
        requestedIds,
      );
      const normalizedLatest = normalizeResourceSelection(
        requestedIds,
        latestSelection,
      );
      if (!sameStringSets(
        normalizedSnapshot.rootIds,
        normalizedLatest.rootIds,
      )) {
        throw conflict("移动期间资源层级发生变化，请刷新后重试。");
      }

      await this.lockResourceRows(transaction, normalizedLatest.rootIds);
      const roots = await transaction.resourceEntry.findMany({
        where: { id: { in: normalizedLatest.rootIds } },
        select: {
          id: true,
          parentId: true,
          type: true,
          name: true,
          trashedAt: true,
        },
      });
      if (roots.length !== normalizedLatest.rootIds.length) {
        throw notFound("部分待移动资源不存在。");
      }
      for (const root of roots) {
        if (
          root.trashedAt ||
          await this.hasTrashedAncestor(transaction, root.parentId)
        ) {
          throw badRequest("不能移动回收站中的资源。");
        }
      }

      if (input.parentId) {
        const target = await transaction.resourceEntry.findUnique({
          where: { id: input.parentId },
        });
        if (!target) throw notFound("目标目录不存在。");
        if (target.type !== "folder" && target.type !== "project") {
          throw badRequest("目标资源不能包含子文件。");
        }
        if (
          target.trashedAt ||
          await this.hasTrashedAncestor(transaction, target.parentId)
        ) {
          throw badRequest("不能移动到回收站资源中。");
        }
      }
      await this.lockParentNamespaces(transaction, [
        ...roots.map(({ parentId }) => parentId),
        input.parentId,
      ]);

      const rootById = new Map(roots.map((root) => [root.id, root]));
      const movedIds: string[] = [];
      const unchangedIds: string[] = [];
      // 固定顺序执行名称检查和更新。第一项写入后，后续同名来源会被同一事务检测并整体回滚。
      for (const resourceId of [...normalizedLatest.rootIds].sort()) {
        const root = rootById.get(resourceId)!;
        if (root.parentId === input.parentId) {
          unchangedIds.push(resourceId);
          continue;
        }
        if (
          input.parentId &&
          (root.type === "folder" || root.type === "project") &&
          await this.isDescendant(transaction, input.parentId, resourceId)
        ) {
          throw badRequest("不能把文件夹移动到它自己的子目录中。");
        }
        await this.assertNameAvailable(
          transaction,
          input.parentId,
          root.name,
          resourceId,
        );
        await transaction.resourceEntry.update({
          where: { id: resourceId },
          data: { parentId: input.parentId },
        });
        movedIds.push(resourceId);
      }
      return {
        movedIds,
        unchangedIds,
        collapsedDescendantIds: normalizedLatest.collapsedDescendantIds,
      };
    });

    return {
      moved: await Promise.all(moved.movedIds.map((id) =>
        this.getMappedResource(user, id))),
      unchanged: await Promise.all(moved.unchangedIds.map((id) =>
        this.getMappedResource(user, id))),
      collapsedDescendantIds: moved.collapsedDescendantIds,
    };
  }

  async copyResource(
    user: ApiUser,
    resourceId: string,
    input: CopyResourceRequest,
  ): Promise<CopyResourceResult> {
    await this.access.assertCapability(user, resourceId, "read");
    await this.access.assertCapability(user, resourceId, "copy");
    await this.assertContainer(input.parentId);
    await this.access.assertCapability(user, input.parentId, "create_child");
    const source = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
    });
    if (!source) throw notFound("资源不存在。");
    if (
      source.trashedAt ||
      await this.hasTrashedAncestor(this.prisma, source.parentId)
    ) {
      throw badRequest("不能复制回收站中的资源。");
    }
    if (
      (source.type === "folder" || source.type === "project") &&
      await this.isDescendant(this.prisma, input.parentId, resourceId)
    ) {
      throw badRequest("不能把文件夹复制到它自己或它的子目录中。");
    }

    const authorizedSnapshot = await this.loadCopySourceNodes(
      this.prisma,
      resourceId,
    );
    if (authorizedSnapshot.length > MAX_RECURSIVE_COPY_NODES) {
      throw badRequest(
        `单次最多复制 ${MAX_RECURSIVE_COPY_NODES} 个资源，请缩小复制范围。`,
      );
    }
    for (const node of authorizedSnapshot) {
      // 容器复制必须对整棵活动子树都拥有 read + copy。任何一个受限后代都会让整个根复制失败，
      // 避免悄悄生成一棵缺文件且难以察觉的副本。
      await this.access.assertCapability(user, node.id, "read");
      await this.access.assertCapability(user, node.id, "copy");
    }
    const requestedName = input.name?.trim() || source.name;
    const authorizedIds = new Set(authorizedSnapshot.map((node) => node.id));
    const copied = await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeMutation(transaction);
      await this.lockResourceRows(transaction, [resourceId]);
      const sourceContainerIds = authorizedSnapshot
        .filter((node) => node.type === "folder" || node.type === "project")
        .map((node) => node.id);
      // 新建子项也会拿父命名空间锁。复制时锁住所有源容器，保证复制计划期间不会插入新后代。
      await this.lockParentNamespaces(transaction, [
        input.parentId,
        ...sourceContainerIds,
      ]);

      const latestSource = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!latestSource) throw notFound("资源不存在。");
      if (
        latestSource.trashedAt ||
        await this.hasTrashedAncestor(transaction, latestSource.parentId)
      ) {
        throw conflict("复制期间源资源位置发生变化，请刷新后重试。");
      }
      const target = await transaction.resourceEntry.findUnique({
        where: { id: input.parentId },
      });
      if (!target || (target.type !== "folder" && target.type !== "project")) {
        throw notFound("目标目录不存在。");
      }
      if (
        target.trashedAt ||
        await this.hasTrashedAncestor(transaction, target.parentId)
      ) {
        throw conflict("目标目录已在回收站中，请选择其他位置。");
      }
      if (
        (latestSource.type === "folder" || latestSource.type === "project") &&
        await this.isDescendant(transaction, input.parentId, resourceId)
      ) {
        throw badRequest("不能把文件夹复制到它自己或它的子目录中。");
      }

      const latestNodes = await this.loadCopySourceNodes(
        transaction,
        resourceId,
      );
      if (
        latestNodes.length !== authorizedIds.size ||
        latestNodes.some((node) => !authorizedIds.has(node.id))
      ) {
        throw conflict("复制期间源目录发生变化，请刷新后重试。");
      }
      const name = await this.availableCopyName(
        transaction,
        input.parentId,
        requestedName,
      );
      const plan = buildResourceCopyPlan({
        sourceRootId: resourceId,
        targetParentId: input.parentId,
        rootName: name,
        nodes: latestNodes,
      });
      for (const node of plan.nodes) {
        await transaction.resourceEntry.create({
          data: {
            id: node.id,
            parentId: node.parentId,
            type: node.type,
            name: node.name,
            ownerUserId: user.id,
            breakPermissionInheritance: false,
            archivedAt: node.archivedAt,
            projectMetadata: node.type === "project"
              ? { create: { description: node.projectDescription } }
              : undefined,
            annotationFile: node.type === "annotation_file"
              ? {
                  create: {
                    payload: node.annotationPayload as Prisma.InputJsonValue,
                    revision: 1,
                    mediaResourceId: node.annotationMediaResourceId,
                    lastEditedBy: user.id,
                  },
                }
              : undefined,
            mediaFile: node.type === "media_file" && node.mediaFile
              ? {
                  create: {
                    fileId: node.mediaFile.fileId,
                    mimeType: node.mediaFile.mimeType,
                    size: node.mediaFile.size,
                    duration: node.mediaFile.duration,
                  },
                }
              : undefined,
          },
        });
      }
      return { rootId: plan.nodes[0]!.id, summary: plan };
    });
    // 副本不携带源 ACL、收藏、恢复历史或 operation；复制者拥有新节点，其余权限重新从目标继承。
    return {
      resource: await this.getMappedResource(user, copied.rootId),
      summary: {
        copiedNodeCount: copied.summary.copiedNodeCount,
        copiedAnnotationCount: copied.summary.copiedAnnotationCount,
        reusedFileObjectCount: copied.summary.reusedFileObjectCount,
      },
    };
  }

  async trashResources(
    user: ApiUser,
    input: BatchTrashResourcesRequest,
  ): Promise<BatchTrashResourcesResponse> {
    const requestedIds = [...new Set(input.resourceIds)];
    const selectionSnapshot = await this.loadResourceSelectionNodes(
      this.prisma,
      requestedIds,
    );
    const requestedNodeIds = new Set(selectionSnapshot.map(({ id }) => id));
    if (requestedIds.some((id) => !requestedNodeIds.has(id))) {
      throw notFound("部分待删除资源不存在。");
    }
    const normalizedSnapshot = normalizeResourceSelection(
      requestedIds,
      selectionSnapshot,
    );

    const trashed = await this.prisma.$transaction(async (transaction) => {
      // 所有资源树 mutation 共用同一把 advisory lock。锁后重新读取层级，避免删除期间父子关系变化。
      await this.lockResourceTreeMutation(transaction);
      const latestSelection = await this.loadResourceSelectionNodes(
        transaction,
        requestedIds,
      );
      const latestNodeIds = new Set(latestSelection.map(({ id }) => id));
      if (requestedIds.some((id) => !latestNodeIds.has(id))) {
        throw notFound("部分待删除资源不存在。");
      }
      const normalizedLatest = normalizeResourceSelection(
        requestedIds,
        latestSelection,
      );
      if (!sameStringSets(
        normalizedSnapshot.rootIds,
        normalizedLatest.rootIds,
      )) {
        throw conflict("删除期间资源层级发生变化，请刷新后重试。");
      }

      await this.lockResourceRows(transaction, normalizedLatest.rootIds);
      const roots = await transaction.resourceEntry.findMany({
        where: { id: { in: normalizedLatest.rootIds } },
        select: {
          id: true,
          parentId: true,
          trashedAt: true,
        },
      });
      if (roots.length !== normalizedLatest.rootIds.length) {
        throw notFound("部分待删除资源不存在。");
      }
      for (const root of roots) {
        if (
          root.trashedAt ||
          await this.hasTrashedAncestor(transaction, root.parentId)
        ) {
          throw badRequest("不能重复删除回收站中的资源。");
        }
        // 权限必须在资源树锁内通过 transaction client 重新解析，不能只依赖锁前的 UI 或预检查。
        await this.access.assertCapability(
          user,
          root.id,
          "delete",
          transaction,
        );
      }
      await this.lockParentNamespaces(
        transaction,
        roots.map(({ parentId }) => parentId),
      );

      const trashedAt = new Date();
      const sortedRootIds = [...normalizedLatest.rootIds].sort();
      await transaction.resourceEntry.updateMany({
        where: { id: { in: sortedRootIds } },
        data: { trashedAt },
      });
      // 审计与软删除处于同一事务；任一审计写入失败时整批状态也回滚。
      for (const resourceId of sortedRootIds) {
        await transaction.auditLog.create({
          data: {
            action: "resource_trash",
            actorUserId: user.id,
            resourceId,
            detail: {
              batchSize: requestedIds.length,
              logicalRootCount: sortedRootIds.length,
              collapsedSelectionCount:
                normalizedLatest.collapsedDescendantIds.length,
            },
          },
        });
      }
      return {
        rootIds: sortedRootIds,
        collapsedDescendantIds: normalizedLatest.collapsedDescendantIds,
      };
    });

    return {
      trashed: await Promise.all(trashed.rootIds.map((id) =>
        this.getMappedResource(user, id))),
      collapsedDescendantIds: trashed.collapsedDescendantIds,
    };
  }

  async restoreResource(user: ApiUser, resourceId: string) {
    await this.access.assertCapability(user, resourceId, "delete");
    await this.prisma.$transaction(async (transaction) => {
      // 移动、删除和恢复都会改变活动资源树；共用锁可防止恢复校验后父目录又被并发移动或删除。
      await this.lockResourceTreeMutation(transaction);
      await this.lockResourceRows(transaction, [resourceId]);
      const current = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!current) throw notFound("资源不存在。");
      if (!current.trashedAt) throw badRequest("资源不在回收站中。");
      await this.lockParentNamespaces(transaction, [current.parentId]);
      if (current.parentId) {
        const parent = await transaction.resourceEntry.findUnique({
          where: { id: current.parentId },
          select: {
            type: true,
            parentId: true,
            trashedAt: true,
          },
        });
        if (!parent || (parent.type !== "folder" && parent.type !== "project")) {
          throw conflict("原上级目录已经不存在，无法恢复到原位置。");
        }
        if (
          parent.trashedAt ||
          await this.hasTrashedAncestor(transaction, parent.parentId)
        ) {
          throw conflict("请先恢复上级目录。");
        }
      }
      await this.assertNameAvailable(
        transaction,
        current.parentId,
        current.name,
        resourceId,
      );
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { trashedAt: null },
      });
    });
    return this.getMappedResource(user, resourceId);
  }

  async listPermissionMatrix(
    actor: ApiUser,
    resourceId: string,
  ): Promise<ResourcePermissionMatrixRow[]> {
    await this.access.assertCapability(actor, resourceId, "manage_permissions");
    const [users, directRows] = await Promise.all([
      this.prisma.user.findMany({
        where: { isActive: true },
        include: { roles: true },
        orderBy: { displayName: "asc" },
      }),
      this.prisma.resourcePermission.findMany({
        where: { resourceId },
        include: {
          user: { include: { roles: true } },
          grantor: { include: { roles: true } },
        },
      }),
    ]);
    const directByUser = new Map(directRows.map((row) => [row.userId, row]));
    return Promise.all(users.map(async (user) => ({
      user: toPublicUser(user),
      directPermission: directByUser.has(user.id)
        ? this.mapPermission(directByUser.get(user.id)!)
        : null,
      effectivePermission: await this.access.getEffectivePermission(
        toPublicUser(user),
        resourceId,
      ),
    })));
  }

  async upsertPermission(
    actor: ApiUser,
    resourceId: string,
    userId: string,
    input: UpsertResourcePermissionRequest,
  ) {
    const actorPermission = await this.access.assertCapability(
      actor,
      resourceId,
      "manage_permissions",
    );
    const resource = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
    });
    if (!resource) throw notFound("资源不存在。");
    if (resource.ownerUserId === userId) {
      throw badRequest("资源所有者始终拥有完整权限，无需另行授权。");
    }
    const capabilities = [...new Set(input.capabilities)];
    if (
      !this.access.isGlobalAdmin(actor) &&
      capabilities.some((capability) =>
        !actorPermission.capabilities.includes(capability))
    ) {
      throw forbidden("不能授予自己并不拥有的资源能力。");
    }
    const subject = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!subject?.isActive) throw notFound("目标账号不存在或已停用。");
    const row = await this.prisma.resourcePermission.upsert({
      where: { resourceId_userId: { resourceId, userId } },
      update: {
        capabilities: this.access.toDatabaseCapabilities(capabilities),
        inheritToChildren: input.inheritToChildren ?? true,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: actor.id,
      },
      create: {
        resourceId,
        userId,
        capabilities: this.access.toDatabaseCapabilities(capabilities),
        inheritToChildren: input.inheritToChildren ?? true,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: actor.id,
      },
      include: {
        user: { include: { roles: true } },
        grantor: { include: { roles: true } },
      },
    });
    return this.mapPermission(row);
  }

  async removePermission(
    actor: ApiUser,
    resourceId: string,
    userId: string,
  ) {
    await this.access.assertCapability(actor, resourceId, "manage_permissions");
    const resource = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
    });
    if (!resource) throw notFound("资源不存在。");
    if (resource.ownerUserId === userId) {
      throw badRequest("不能移除资源所有者权限。");
    }
    await this.prisma.resourcePermission.deleteMany({
      where: { resourceId, userId },
    });
  }

  async updateInheritance(
    actor: ApiUser,
    resourceId: string,
    breakPermissionInheritance: boolean,
  ) {
    await this.access.assertCapability(actor, resourceId, "manage_permissions");
    await this.prisma.resourceEntry.update({
      where: { id: resourceId },
      data: { breakPermissionInheritance },
    });
    return this.getMappedResource(actor, resourceId);
  }

  private buildListWhere(
    user: ApiUser,
    options: NormalizedResourceQuery,
  ): Prisma.ResourceEntryWhereInput {
    const query = options.query?.trim();
    const common: Prisma.ResourceEntryWhereInput = {
      ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
      ...(options.type ? { type: options.type as DbResourceType } : {}),
    };
    switch (options.view ?? "children") {
      case "all_projects":
        // “所有项目”同时承担资源管理器根目录的职责。若把嵌套项目也平铺到这里，
        // 项目移动进另一个项目后会在根视图和目标项目中同时出现，视觉上像是复制。
        // 最近、收藏和共享仍是跨目录聚合视图；只有根项目视图遵循直接子项语义。
        return {
          ...common,
          parentId: null,
          type: "project",
          trashedAt: null,
        };
      case "recent":
        return {
          ...common,
          trashedAt: null,
          userStates: {
            some: { userId: user.id, lastOpenedAt: { not: null } },
          },
        };
      case "favorites":
        return {
          ...common,
          trashedAt: null,
          userStates: { some: { userId: user.id, favorite: true } },
        };
      case "shared":
        return {
          ...common,
          trashedAt: null,
          ownerUserId: { not: user.id },
        };
      case "archived":
        return { ...common, archivedAt: { not: null }, trashedAt: null };
      case "trash":
        return { ...common, trashedAt: { not: null } };
      default:
        return {
          ...common,
          parentId: options.parentId ?? null,
          trashedAt: null,
          archivedAt: null,
        };
    }
  }

  private async getMappedResource(user: ApiUser, resourceId: string) {
    const row = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
      include: resourceInclude,
    });
    if (!row) throw notFound("资源不存在。");
    return this.mapResource(
      user,
      row,
      await this.access.getEffectivePermission(user, resourceId),
    );
  }

  private async mapResource(
    user: ApiUser,
    row: ResourceRow,
    permission: EffectiveResourcePermission,
  ): Promise<ResourceEntry> {
    const state = await this.prisma.resourceUserState.findUnique({
      where: { resourceId_userId: { resourceId: row.id, userId: user.id } },
    });
    return {
      id: row.id,
      parentId: row.parentId,
      type: row.type,
      name: row.name,
      owner: toPublicUser(row.owner),
      breakPermissionInheritance: row.breakPermissionInheritance,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      trashedAt: row.trashedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      childCount: row._count.children,
      size: row.mediaFile?.size ?? null,
      mimeType: row.mediaFile?.mimeType ?? null,
      revision: row.annotationFile?.revision ?? null,
      favorite: state?.favorite ?? false,
      permission,
    };
  }

  private async mapAnnotationFile<TPayload = unknown>(
    user: ApiUser,
    resource: ResourceRow,
    file: {
      payload: Prisma.JsonValue;
      revision: number;
      mediaResourceId: string | null;
      lastSavedAt: Date;
      lastEditor: {
        id: string;
        accountName: string;
        displayName: string;
        roles: Array<{ role: string }>;
      };
    },
  ): Promise<AnnotationFile<TPayload>> {
    return {
      resource: await this.mapResource(
        user,
        resource,
        await this.access.getEffectivePermission(user, resource.id),
      ),
      payload: file.payload as TPayload,
      revision: file.revision,
      mediaResourceId: file.mediaResourceId,
      lastEditor: toPublicUser(file.lastEditor),
      lastSavedAt: file.lastSavedAt.toISOString(),
    };
  }

  // 确认创建输入映射集中处理互斥目标字段，数据库 CHECK 继续作为第二层保护。
  private toAnnotationConfirmationCreateData(
    createdBy: string,
    draft: AnnotationConfirmationDraft,
  ): Prisma.AnnotationConfirmationUncheckedCreateInput {
    const targets = draft.scope.targets;
    return {
      annotationFileId: draft.annotationFileId,
      confirmedRevision: draft.confirmedRevision,
      startTime: draft.scope.startTime,
      endTime: draft.scope.endTime,
      targetMode: targets.mode,
      domains: targets.mode === "domains"
        ? targets.domains.map((domain) => DB_CONFIRMATION_DOMAINS[domain])
        : [],
      trackIds: targets.mode === "tracks" ? targets.trackIds : [],
      note: draft.note ?? null,
      createdBy,
    };
  }

  // Prisma 行统一映射共享 DTO；freshness 由列表 currentRevision 在客户端/领域层派生。
  private mapAnnotationConfirmation(
    row: AnnotationConfirmationRow,
  ): AnnotationConfirmationRecord {
    const targets = row.targetMode === "domains"
      ? {
          mode: "domains" as const,
          domains: row.domains.map((domain) => SHARED_CONFIRMATION_DOMAINS[domain]),
        }
      : row.targetMode === "tracks"
        ? { mode: "tracks" as const, trackIds: [...row.trackIds] }
        : { mode: "all" as const };
    const base = {
      id: row.id,
      annotationFileId: row.annotationFileId,
      confirmedRevision: row.confirmedRevision,
      scope: {
        startTime: row.startTime,
        endTime: row.endTime,
        targets,
      },
      note: row.note,
      createdBy: toPublicUser(row.creator),
      createdAt: row.createdAt.toISOString(),
    };
    if (row.revokedAt && row.revoker) {
      return {
        ...base,
        revokedAt: row.revokedAt.toISOString(),
        revokedBy: toPublicUser(row.revoker),
        revokeReason: row.revokeReason,
      };
    }
    return {
      ...base,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    };
  }

  private mapPermission(row: {
    id: string;
    resourceId: string;
    capabilities: string[];
    inheritToChildren: boolean;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    user: {
      id: string;
      accountName: string;
      displayName: string;
      roles: Array<{ role: string }>;
    };
    grantor: {
      id: string;
      accountName: string;
      displayName: string;
      roles: Array<{ role: string }>;
    };
  }): ResourcePermissionRecord {
    return {
      id: row.id,
      resourceId: row.resourceId,
      user: toPublicUser(row.user),
      capabilities: row.capabilities as ResourceCapability[],
      inheritToChildren: row.inheritToChildren,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdBy: toPublicUser(row.grantor),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async buildBreadcrumbs(user: ApiUser, resourceId: string) {
    const items: ResourceListPage["breadcrumbs"] = [];
    let currentId: string | null = resourceId;
    while (currentId) {
      const row: {
        id: string;
        parentId: string | null;
        type: "folder" | "project" | "annotation_file" | "media_file";
        name: string;
      } | null = await this.prisma.resourceEntry.findUnique({
        where: { id: currentId },
        select: { id: true, parentId: true, type: true, name: true },
      });
      if (!row) break;
      await this.access.assertCapability(user, row.id, "read");
      items.unshift(row);
      currentId = row.parentId;
    }
    return items;
  }

  private async assertContainer(resourceId: string) {
    const row = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
    });
    if (!row) throw notFound("目标目录不存在。");
    if (row.type !== "folder" && row.type !== "project") {
      throw badRequest("目标资源不能包含子文件。");
    }
    if (row.trashedAt) throw badRequest("不能在回收站资源中创建文件。");
  }

  private validateName(value: string) {
    const name = value.trim();
    if (!name || name.length > 180 || /[\/\\\0]/.test(name)) {
      throw badRequest("资源名称不能为空、不能超过 180 字，且不能含路径分隔符。");
    }
    return name;
  }

  private async assertNameAvailable(
    database: Prisma.TransactionClient,
    parentId: string | null,
    name: string,
    excludeId?: string,
  ) {
    const duplicate = await database.resourceEntry.findFirst({
      where: {
        parentId,
        name: { equals: name, mode: "insensitive" },
        trashedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (duplicate) throw conflict("同一目录中已存在同名资源。");
  }

  private async availableCopyName(
    database: Prisma.TransactionClient,
    parentId: string,
    originalName: string,
  ) {
    const dot = originalName.lastIndexOf(".");
    const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
    const extension = dot > 0 ? originalName.slice(dot) : "";
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = index === 1
        ? `${stem} 副本${extension}`
        : `${stem} 副本 ${index}${extension}`;
      const exists = await database.resourceEntry.findFirst({
        where: {
          parentId,
          name: { equals: candidate, mode: "insensitive" },
          trashedAt: null,
        },
      });
      if (!exists) return candidate;
    }
    throw conflict("无法生成可用的副本名称。");
  }

  private async loadCopySourceNodes(
    database: PrismaClient | Prisma.TransactionClient,
    resourceId: string,
  ): Promise<CopySourceNode[]> {
    const ids = await database.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE resource_subtree AS (
        SELECT id
        FROM resource_entries
        WHERE id = ${resourceId}
          AND trashed_at IS NULL

        UNION ALL

        SELECT child.id
        FROM resource_entries AS child
        INNER JOIN resource_subtree AS parent ON child.parent_id = parent.id
        WHERE child.trashed_at IS NULL
      )
      SELECT id
      FROM resource_subtree
      LIMIT ${MAX_RECURSIVE_COPY_NODES + 1}
    `;
    if (!ids.length) return [];
    return database.resourceEntry.findMany({
      where: { id: { in: ids.map(({ id }) => id) } },
      select: {
        id: true,
        parentId: true,
        type: true,
        name: true,
        archivedAt: true,
        projectMetadata: { select: { description: true } },
        annotationFile: {
          select: { payload: true, mediaResourceId: true },
        },
        mediaFile: {
          select: {
            fileId: true,
            mimeType: true,
            size: true,
            duration: true,
          },
        },
      },
    });
  }

  private async loadResourceSelectionNodes(
    database: PrismaClient | Prisma.TransactionClient,
    resourceIds: string[],
  ): Promise<ResourceSelectionNode[]> {
    if (!resourceIds.length) return [];
    // 只读取所选节点到根目录的祖先链，足以判断“父与后代同时被选中”，无需加载整棵资源树。
    return database.$queryRaw<ResourceSelectionNode[]>`
      WITH RECURSIVE selected_ancestors AS (
        SELECT id, parent_id AS "parentId"
        FROM resource_entries
        WHERE id IN (${Prisma.join(resourceIds)})

        UNION

        SELECT parent.id, parent.parent_id AS "parentId"
        FROM resource_entries AS parent
        INNER JOIN selected_ancestors AS child ON child."parentId" = parent.id
      )
      SELECT DISTINCT id, "parentId"
      FROM selected_ancestors
    `;
  }

  // 恢复历史和内容写入只能作用于活动标注文件；transaction 参数保证检查使用同一事务快照。
  private async assertActiveAnnotationFile(
    resourceId: string,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ) {
    const resource = await database.resourceEntry.findUnique({
      where: { id: resourceId },
      select: {
        type: true,
        parentId: true,
        trashedAt: true,
        annotationFile: { select: { resourceId: true } },
      },
    });
    if (
      !resource ||
      resource.type !== "annotation_file" ||
      !resource.annotationFile ||
      resource.trashedAt ||
      await this.hasTrashedAncestor(database, resource.parentId)
    ) {
      throw notFound("活动标注文件不存在。");
    }
  }

  // 所有 annotation payload mutation 统一在资源树共享锁后复核权限，并锁住当前文件行。
  private async lockAnnotationFileForContentMutation(
    transaction: Prisma.TransactionClient,
    user: ApiUser,
    resourceId: string,
  ) {
    await this.lockResourceTreeForContentWrite(transaction);
    await this.lockResourceRows(transaction, [resourceId]);
    await this.assertActiveAnnotationFile(resourceId, transaction);
    await this.access.assertCapability(
      user,
      resourceId,
      "write",
      transaction,
    );

    // 仅依赖 revision 条件不够：两个事务可能先争抢同一 revision 的快照唯一键，行锁需先串行同一文件。
    await transaction.$queryRaw`
      SELECT resource_id
      FROM annotation_files
      WHERE resource_id = ${resourceId}
      FOR UPDATE
    `;
    const current = await transaction.annotationFile.findUnique({
      where: { resourceId },
    });
    if (!current) throw notFound("标注文件不存在。");
    return current;
  }

  // 审核事务沿用内容写入的锁顺序，但只共享锁 annotation 行，保证 revision 核对期间不能被保存推进。
  private async lockAnnotationFileForConfirmation(
    transaction: Prisma.TransactionClient,
    user: ApiUser,
    resourceId: string,
  ) {
    await this.lockResourceTreeForContentWrite(transaction);
    await this.lockResourceRows(transaction, [resourceId]);
    await this.assertActiveAnnotationFile(resourceId, transaction);
    const permission = await this.access.getEffectivePermission(
      user,
      resourceId,
      transaction,
    );
    const decision = canCreateAnnotationConfirmation({
      actorUserId: user.id,
      canRead: permission.capabilities.includes("read"),
      canReview: permission.capabilities.includes("review"),
      isAdminOrOwner: permission.source === "admin" || permission.isOwner,
    });
    if (!decision.allowed) throw forbidden("当前账号缺少该标注文件的审核权限。");

    await transaction.$queryRaw`
      SELECT resource_id
      FROM annotation_files
      WHERE resource_id = ${resourceId}
      FOR SHARE
    `;
    const current = await transaction.annotationFile.findUnique({
      where: { resourceId },
    });
    if (!current) throw notFound("标注文件不存在。");
    return current;
  }

  private async isDescendant(
    database: PrismaClient | Prisma.TransactionClient,
    candidateId: string,
    ancestorId: string,
  ) {
    let currentId: string | null = candidateId;
    while (currentId) {
      if (currentId === ancestorId) return true;
      const row: { parentId: string | null } | null =
        await database.resourceEntry.findUnique({
        where: { id: currentId },
        select: { parentId: true },
      });
      currentId = row?.parentId ?? null;
    }
    return false;
  }

  private async lockParentNamespaces(
    transaction: Prisma.TransactionClient,
    parentIds: Array<string | null>,
  ) {
    // 同一事务可能同时涉及源、目标目录；固定排序可避免两个 move 以相反顺序拿锁而死锁。
    const lockKeys = [...new Set(parentIds.map((id) =>
      `xiqu:resource-parent:${id ?? "<root>"}`))].sort();
    for (const lockKey of lockKeys) {
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${lockKey}))
      `;
    }
  }

  private async lockResourceTreeMutation(
    transaction: Prisma.TransactionClient,
  ) {
    // 结构写操作必须先拿同一把事务锁；固定顺序可防止 move 与 restore 交错后产生隐藏资源。
    await transaction.$queryRaw`
      SELECT 1::integer AS locked
      FROM pg_advisory_xact_lock(hashtext('xiqu:resource-tree:mutation'))
    `;
  }

  private async lockResourceTreeForContentWrite(
    transaction: Prisma.TransactionClient,
  ) {
    // 内容写入取得同一 advisory key 的共享锁：不同文件可并发，树移动/回收则等待所有写入结束。
    await transaction.$queryRaw`
      SELECT 1::integer AS locked
      FROM pg_advisory_xact_lock_shared(
        hashtext('xiqu:resource-tree:mutation')
      )
    `;
  }

  private async lockResourceRows(
    transaction: Prisma.TransactionClient,
    resourceIds: string[],
  ) {
    const orderedIds = [...new Set(resourceIds)].sort();
    if (!orderedIds.length) return;
    // 批量移动会同时锁多行；所有调用统一按 id 排序，避免两个事务以相反顺序等待而死锁。
    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM resource_entries
      WHERE id IN (${Prisma.join(orderedIds)})
      ORDER BY id
      FOR UPDATE
    `;
    if (rows.length !== orderedIds.length) throw notFound("部分资源不存在。");
  }

  private async hasTrashedAncestor(
    database: PrismaClient | Prisma.TransactionClient,
    parentId: string | null,
  ) {
    let currentId = parentId;
    while (currentId) {
      const row: { parentId: string | null; trashedAt: Date | null } | null =
        await database.resourceEntry.findUnique({
          where: { id: currentId },
          select: { parentId: true, trashedAt: true },
        });
      if (!row) return true;
      if (row.trashedAt) return true;
      currentId = row.parentId;
    }
    return false;
  }
}

function sameStringSets(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
