import {
  type Prisma,
  type PrismaClient,
  type ResourceType as DbResourceType,
} from "@prisma/client";
import type {
  AnnotationFile,
  AnnotationRecoverySnapshot,
  CopyResourceRequest,
  CreateAnnotationFileRequest,
  CreateResourceRequest,
  EffectiveResourcePermission,
  ImportMediaFileRequest,
  ListResourcesOptions,
  MoveResourceRequest,
  ResourceCapability,
  ResourceEntry,
  ResourceListPage,
  ResourcePermissionMatrixRow,
  ResourcePermissionRecord,
  SaveAnnotationFileRequest,
  UpdateResourceRequest,
  UpsertResourcePermissionRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { ResourceAccessService } from "./resourceAccess.js";
import { toPublicUser } from "./repositoryMappers.js";

const resourceInclude = {
  owner: { include: { roles: true } },
  _count: { select: { children: true } },
  annotationFile: true,
  mediaFile: true,
} satisfies Prisma.ResourceEntryInclude;

type ResourceRow = Prisma.ResourceEntryGetPayload<{
  include: typeof resourceInclude;
}>;

const NAME_COLLATOR = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export class ResourceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async listResources(
    user: ApiUser,
    options: ListResourcesOptions,
  ): Promise<ResourceListPage> {
    const rows = await this.prisma.resourceEntry.findMany({
      where: this.buildListWhere(user, options),
      include: resourceInclude,
    });
    const visible: Array<{ row: ResourceRow; permission: EffectiveResourcePermission }> = [];
    for (const row of rows) {
      // 软删除容器时不逐条改写整棵子树；所有普通视图因此必须排除拥有已删除祖先的后代。
      // 回收站只展示自身带 trashedAt 的入口，不在这里重复过滤。
      if (
        options.view !== "trash" &&
        await this.hasTrashedAncestor(row.parentId)
      ) continue;
      const permission = await this.access.getEffectivePermission(user, row.id);
      if (permission.capabilities.includes("read")) {
        visible.push({ row, permission });
      }
    }

    visible.sort((left, right) => this.compareResources(
      left.row,
      right.row,
      options.sortBy ?? "name",
      options.direction ?? "asc",
    ));
    const cursorIndex = options.cursor
      ? visible.findIndex(({ row }) => row.id === options.cursor) + 1
      : 0;
    const start = Math.max(cursorIndex, 0);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const page = visible.slice(start, start + limit);
    return {
      items: await Promise.all(page.map(({ row, permission }) =>
        this.mapResource(user, row, permission))),
      breadcrumbs: options.parentId
        ? await this.buildBreadcrumbs(user, options.parentId)
        : [],
      nextCursor: visible.length > start + limit
        ? page.at(-1)?.row.id ?? null
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
    await this.access.assertCapability(user, resourceId, "write");
    await this.prisma.$transaction(async (transaction) => {
      // 先锁住这一份标注文件。仅把 revision 放进 UPDATE 条件还不够：
      // 两个事务可能同时尝试创建同一 revision 的恢复快照，导致唯一键错误先于
      // 乐观锁冲突发生。行锁让后到的事务等待，并在锁释放后读到最新 revision。
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
      if (current.revision !== input.baseRevision) {
        throw conflict("标注文件已被其他人修改，请刷新后再保存。", {
          expectedRevision: current.revision,
          receivedRevision: input.baseRevision,
        });
      }

      // 保存前把旧内容写入隐藏恢复快照；资源管理器不将它展示为业务“版本”。
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
    });
    return this.getAnnotationFile<TPayload>(user, resourceId);
  }

  async listRecoverySnapshots<TPayload>(
    user: ApiUser,
    resourceId: string,
  ): Promise<AnnotationRecoverySnapshot<TPayload>[]> {
    await this.access.assertCapability(user, resourceId, "write");
    const rows = await this.prisma.annotationRecoverySnapshot.findMany({
      where: { annotationFileId: resourceId },
      include: { creator: { include: { roles: true } } },
      orderBy: { revision: "desc" },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
      payload: row.payload as TPayload,
      creator: toPublicUser(row.creator),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
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
      await this.lockResourceRow(transaction, resourceId);
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

  async moveResource(
    user: ApiUser,
    resourceId: string,
    input: MoveResourceRequest,
  ) {
    await this.access.assertCapability(user, resourceId, "move");
    if (input.parentId) {
      await this.assertContainer(input.parentId);
      await this.access.assertCapability(user, input.parentId, "create_child");
    } else if (!this.access.isGlobalAdmin(user)) {
      throw forbidden("只有管理员可以把资源移动到根目录。");
    }
    await this.prisma.$transaction(async (transaction) => {
      // 所有 move 共用一把树结构锁，避免 A->B 与 B->A 同时通过循环检查。
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext('xiqu:resource-tree:move'))
      `;
      await this.lockResourceRow(transaction, resourceId);
      const latest = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!latest) throw notFound("资源不存在。");
      if (input.parentId) {
        const target = await transaction.resourceEntry.findUnique({
          where: { id: input.parentId },
        });
        if (!target) throw notFound("目标目录不存在。");
        if (target.type !== "folder" && target.type !== "project") {
          throw badRequest("目标资源不能包含子文件。");
        }
        if (target.trashedAt) throw badRequest("不能移动到回收站资源中。");
      }
      await this.lockParentNamespaces(transaction, [
        latest.parentId,
        input.parentId,
      ]);
      if (
        input.parentId &&
        await this.isDescendant(transaction, input.parentId, resourceId)
      ) {
        throw badRequest("不能把文件夹移动到它自己的子目录中。");
      }
      await this.assertNameAvailable(
        transaction,
        input.parentId,
        latest.name,
        resourceId,
      );
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { parentId: input.parentId },
      });
    });
    return this.getMappedResource(user, resourceId);
  }

  async copyResource(
    user: ApiUser,
    resourceId: string,
    input: CopyResourceRequest,
  ) {
    await this.access.assertCapability(user, resourceId, "copy");
    await this.assertContainer(input.parentId);
    await this.access.assertCapability(user, input.parentId, "create_child");
    const source = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
      include: { annotationFile: true },
    });
    if (!source) throw notFound("资源不存在。");
    if (source.type !== "annotation_file" || !source.annotationFile) {
      throw badRequest("当前阶段仅支持复制标注文件。");
    }
    const sourceFile = source.annotationFile;
    const requestedName = input.name?.trim() || source.name;
    const created = await this.prisma.$transaction(async (transaction) => {
      await this.lockParentNamespaces(transaction, [input.parentId]);
      const name = await this.availableCopyName(
        transaction,
        input.parentId,
        requestedName,
      );
      return transaction.resourceEntry.create({
        data: {
          parentId: input.parentId,
          type: "annotation_file",
          name,
          ownerUserId: user.id,
          annotationFile: {
            create: {
              payload: sourceFile.payload as Prisma.InputJsonValue,
              revision: 1,
              mediaResourceId: sourceFile.mediaResourceId,
              lastEditedBy: user.id,
            },
          },
        },
      });
    });
    // 复制不携带源文件直接 ACL；新副本由复制者拥有，并继承目标目录权限。
    return this.getMappedResource(user, created.id);
  }

  async setTrashed(user: ApiUser, resourceId: string, trashed: boolean) {
    await this.access.assertCapability(user, resourceId, "delete");
    await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceRow(transaction, resourceId);
      const current = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!current) throw notFound("资源不存在。");
      await this.lockParentNamespaces(transaction, [current.parentId]);
      if (!trashed) {
        await this.assertNameAvailable(
          transaction,
          current.parentId,
          current.name,
          resourceId,
        );
      }
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { trashedAt: trashed ? new Date() : null },
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
    options: ListResourcesOptions,
  ): Prisma.ResourceEntryWhereInput {
    const query = options.query?.trim();
    const common: Prisma.ResourceEntryWhereInput = {
      ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
      ...(options.type ? { type: options.type as DbResourceType } : {}),
    };
    switch (options.view ?? "children") {
      case "all_projects":
        return { ...common, type: "project", trashedAt: null };
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

  private compareResources(
    left: ResourceRow,
    right: ResourceRow,
    field: NonNullable<ListResourcesOptions["sortBy"]>,
    direction: NonNullable<ListResourcesOptions["direction"]>,
  ) {
    const multiplier = direction === "asc" ? 1 : -1;
    if (field === "name") {
      return NAME_COLLATOR.compare(left.name, right.name) * multiplier;
    }
    const leftValue = field === "size"
      ? left.mediaFile?.size ?? 0
      : left[field].getTime();
    const rightValue = field === "size"
      ? right.mediaFile?.size ?? 0
      : right[field].getTime();
    return (leftValue - rightValue) * multiplier;
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

  private async isDescendant(
    database: Prisma.TransactionClient,
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

  private async lockResourceRow(
    transaction: Prisma.TransactionClient,
    resourceId: string,
  ) {
    // 资源改名、移动和回收都依赖当前父目录；先锁定资源行，避免读取后被并发请求换父级。
    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM resource_entries
      WHERE id = ${resourceId}
      FOR UPDATE
    `;
    if (!rows.length) throw notFound("资源不存在。");
  }

  private async hasTrashedAncestor(parentId: string | null) {
    let currentId = parentId;
    while (currentId) {
      const row: { parentId: string | null; trashedAt: Date | null } | null =
        await this.prisma.resourceEntry.findUnique({
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
