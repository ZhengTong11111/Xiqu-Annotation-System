import { randomBytes } from "node:crypto";
import {
  AnnotationMode as DbAnnotationMode,
  AuditAction as DbAuditAction,
  PrismaClient,
  ProcessingJobType as DbProcessingJobType,
} from "@prisma/client";
import {
  authorizeProjectMutations,
  collectPersistedPermissionTrackIds,
  collectProjectMutations,
  doesGrantAuthorizeAction,
  isGrantScopeAuthorized,
  isGrantActive,
  resolveEffectiveDocumentPermission,
} from "@xiqu/document-model";
import type {
  CreateGrantRequest,
  PermissionAction,
  PermissionGrant,
  PermissionScope,
  UpdateGrantRequest,
} from "@xiqu/shared";
import { hashToken, verifyPassword } from "./auth.js";
import type {
  ApiAnnotationMode,
  ApiAnnotationOperation,
  ApiAuditLogEntry,
  ApiPermissionGrant,
  ApiProcessingJob,
  ApiRole,
  ApiUser,
} from "./domain.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  permissionScopeViolation,
  unauthorized,
} from "./errors.js";
import {
  createGrantData,
  documentInclude,
  expandDocument,
  toAnnotationOperation,
  toAuditLogEntry,
  toDocumentSummary,
  toFileObject,
  toGrantCreateData,
  toGrant,
  toJsonPayload,
  toMediaAsset,
  toProcessingJob,
  toProjectSummary,
  toPublicUser,
  toVersion,
  type DocumentWithDetails,
} from "./repositoryMappers.js";
import { ensurePlatformSeedData } from "./repositorySeed.js";

const globalAdminRoles: ApiRole[] = ["super_admin", "admin"];
const contentCreatorRoles: ApiRole[] = [
  "super_admin",
  "admin",
  "teacher",
  "ta",
];

export class PrismaPlatformRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureSeedData() {
    await ensurePlatformSeedData(this.prisma);
  }

  async login(accountName: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { accountName },
      include: { roles: true },
    });
    if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized("账号或密码错误。");
    }
    const token = `xiqu_${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + this.getAuthTokenTtlMs());
    await this.prisma.session.create({
      data: {
        tokenHash,
        userId: user.id,
        expiresAt,
      },
    });
    // 登录成功记审计，不在 transaction 内（登录没有业务一致性要求）。
    await this.writeAuditLog({
      action: "auth_login",
      actorUserId: user.id,
      detail: {},
    });
    return {
      user: toPublicUser(user),
      accessToken: token,
    };
  }

  async getUserByToken(token: string | null) {
    if (!token) {
      throw unauthorized();
    }
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: {
          include: { roles: true },
        },
      },
    });
    if (!session || session.expiresAt.getTime() < Date.now() || !session.user.isActive) {
      throw unauthorized();
    }
    return toPublicUser(session.user);
  }

  async listFiles(user: ApiUser) {
    const visibleProjectIds = this.hasAnyRole(user, globalAdminRoles)
      ? []
      : await this.listVisibleProjectIds(user);
    // 教师/助教不是全局管理员：只能看到自己的文件，以及已授权项目实际引用的媒体文件。
    const where = this.hasAnyRole(user, globalAdminRoles)
      ? {}
      : {
          OR: [
            { ownerUserId: user.id },
            {
              mediaAssets: {
                some: {
                  projects: { some: { id: { in: visibleProjectIds } } },
                },
              },
            },
          ],
        };
    const files = await this.prisma.fileObject.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    return files.map((file) => toFileObject(file));
  }

  // 预留给未来分片/断点续传上传：先建占位 file 行，再 finalize 补 checksum/size。
  // 当前路由直接用 createUploadedFile 一步完成，这两个方法暂无路由调用，先保留不删。
  async createPendingFile(user: ApiUser, input: { name: string; mimeType: string; size: number; storageKey: string }) {
    const file = await this.prisma.fileObject.create({
      data: {
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        storageKey: input.storageKey,
        checksum: null,
        ownerUserId: user.id,
      },
    });
    return toFileObject(file);
  }

  async createUploadedFile(
    user: ApiUser,
    input: { name: string; mimeType: string; size: number; storageKey: string; checksum: string },
  ) {
    const file = await this.prisma.fileObject.create({
      data: {
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        storageKey: input.storageKey,
        checksum: input.checksum,
        ownerUserId: user.id,
      },
    });
    // 文件上传审计：detail 记录文件名、类型、大小和校验和，不存完整文件内容。
    await this.writeAuditLog({
      action: "file_upload",
      actorUserId: user.id,
      fileId: file.id,
      detail: { name: input.name, mimeType: input.mimeType, size: input.size, checksum: input.checksum },
    });
    return toFileObject(file);
  }

  async finalizeFileUpload(user: ApiUser, fileId: string, input: { checksum: string; size: number }) {
    const file = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!file) {
      throw notFound("文件不存在。");
    }
    if (file.ownerUserId !== user.id && !this.hasAnyRole(user, globalAdminRoles)) {
      throw forbidden();
    }
    const updated = await this.prisma.fileObject.update({
      where: { id: fileId },
      data: {
        checksum: input.checksum,
        size: input.size,
      },
    });
    return toFileObject(updated);
  }

  async getFileForRead(user: ApiUser, fileId: string) {
    const file = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!file) {
      throw notFound("文件不存在。");
    }
    await this.assertFileVisible(user, fileId);
    return toFileObject(file);
  }

  async listMediaAssets(user: ApiUser) {
    const visibleProjectIds = this.hasAnyRole(user, globalAdminRoles)
      ? []
      : await this.listVisibleProjectIds(user);
    const mediaAssets = await this.prisma.mediaAsset.findMany({
      where: this.hasAnyRole(user, globalAdminRoles)
        ? {}
        : {
            OR: [
              { ownerUserId: user.id },
              { primaryFile: { ownerUserId: user.id } },
              { projects: { some: { id: { in: visibleProjectIds } } } },
            ],
          },
      orderBy: { updatedAt: "desc" },
    });
    return mediaAssets.map((mediaAsset) => toMediaAsset(mediaAsset));
  }

  async createMediaAsset(user: ApiUser, input: { title: string; description?: string | null; primaryFileId?: string | null }) {
    this.requireRole(user, contentCreatorRoles);
    if (input.primaryFileId) {
      await this.assertFileVisible(user, input.primaryFileId);
    }
    const mediaAsset = await this.prisma.mediaAsset.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        primaryFileId: input.primaryFileId ?? null,
        ownerUserId: user.id,
      },
    });
    await this.writeAuditLog({
      action: "media_create",
      actorUserId: user.id,
      detail: { title: input.title, primaryFileId: input.primaryFileId ?? null },
    });
    return toMediaAsset(mediaAsset);
  }

  async listProjects(user: ApiUser) {
    if (this.hasAnyRole(user, globalAdminRoles)) {
      const projects = await this.prisma.annotationProject.findMany({
        include: { _count: { select: { documents: true } } },
        orderBy: { updatedAt: "desc" },
      });
      return projects.map((project) => toProjectSummary(project));
    }
    const projectIds = await this.listVisibleProjectIds(user);
    const projects = await this.prisma.annotationProject.findMany({
      where: { id: { in: projectIds } },
      include: { _count: { select: { documents: true } } },
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(projects.map(async (project) => {
      const summary = toProjectSummary(project);
      if (project.ownerUserId === user.id) {
        return summary;
      }
      // 文档级 grant 只能暴露被授权的文档数量，不能通过项目摘要泄露同项目其他作业数量。
      return {
        ...summary,
        documentCount: await this.countVisibleProjectDocuments(
          user.id,
          project.id,
          summary.documentCount,
        ),
      };
    }));
  }

  async createProject(user: ApiUser, input: { title: string; mediaAssetId: string }) {
    this.requireRole(user, contentCreatorRoles);
    await this.assertMediaAssetVisible(user, input.mediaAssetId);
    const project = await this.prisma.annotationProject.create({
      data: {
        title: input.title,
        mediaAssetId: input.mediaAssetId,
        ownerUserId: user.id,
      },
      include: { _count: { select: { documents: true } } },
    });
    await this.writeAuditLog({
      action: "project_create",
      actorUserId: user.id,
      projectId: project.id,
      detail: { title: input.title, mediaAssetId: input.mediaAssetId },
    });
    return toProjectSummary(project);
  }

  async listProjectDocuments(user: ApiUser, projectId: string) {
    await this.assertProjectVisible(user, projectId);
    const documents = await this.prisma.annotationDocument.findMany({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
    });
    if (
      this.hasAnyRole(user, globalAdminRoles) ||
      await this.isProjectOwner(user.id, projectId)
    ) {
      return documents.map((document) => toDocumentSummary(document));
    }
    // 文档级授权不应让用户顺带看到同项目下未授权的课堂作业。
    const visibleDocuments = [];
    for (const document of documents) {
      const permission = await this.getEffectiveDocumentPermission(user, document.id);
      if (permission.canView) {
        visibleDocuments.push(toDocumentSummary(document));
      }
    }
    return visibleDocuments;
  }

  async createDocument(
    user: ApiUser,
    projectId: string,
    input: { title: string; mode: ApiAnnotationMode; initialPayload: unknown; grants?: ApiPermissionGrant[] },
  ) {
    await this.assertProjectManageable(user, projectId);
    const project = await this.prisma.annotationProject.findUnique({ where: { id: projectId } });
    if (!project) {
      throw notFound("项目不存在。");
    }

    const document = await this.prisma.$transaction(async (transaction) => {
      const createdDocument = await transaction.annotationDocument.create({
        data: {
          projectId,
          title: input.title,
          mode: input.mode as DbAnnotationMode,
        },
      });
      const snapshot = await transaction.annotationSnapshot.create({
        data: {
          documentId: createdDocument.id,
          revision: 1,
          payload: toJsonPayload(input.initialPayload),
          createdBy: user.id,
        },
      });
      await transaction.permissionGrant.createMany({
        data: input.grants?.length
          ? input.grants.map((grant) => toGrantCreateData(grant, projectId, createdDocument.id))
          : [createGrantData(user.id, projectId, createdDocument.id, ["view", "edit", "manage", "confirm", "merge"])],
      });
      const updatedDocument = await transaction.annotationDocument.update({
        where: { id: createdDocument.id },
        data: {
          latestSnapshotId: snapshot.id,
        },
        include: documentInclude,
      });
      // 文档创建审计在 transaction 内写入，与文档/快照/授权保持一致性。
      await transaction.auditLog.create({
        data: {
          action: "document_create",
          actorUserId: user.id,
          projectId,
          documentId: createdDocument.id,
          detail: toJsonPayload({ title: input.title, mode: input.mode, revision: 1 }),
        },
      });
      return updatedDocument;
    });
    await this.prisma.annotationProject.update({
      where: { id: projectId },
      data: { updatedAt: new Date() },
    });

    return expandDocument(document);
  }

  async getDocument(user: ApiUser, documentId: string) {
    const document = await this.getDocumentOrThrow(documentId);
    const permission = await this.getEffectiveDocumentPermission(user, documentId);
    if (!permission.canView) {
      throw forbidden();
    }
    // scoped manager 通过专用 grants 接口读取自己可管理的子范围；文档主体不附带整份授权清单。
    return this.expandDocumentForPermission(
      document,
      permission.isUnrestrictedManager,
    );
  }

  async saveDocument(user: ApiUser, documentId: string, input: { baseRevision: number; payload: unknown }) {
    const currentDocument = await this.getDocumentOrThrow(documentId);
    const permission = await this.getEffectiveDocumentPermission(user, documentId);
    if (!permission.canEdit) {
      throw forbidden();
    }
    if (!currentDocument.latestSnapshot || currentDocument.latestSnapshot.revision !== input.baseRevision) {
      throw conflict("文档版本已变化，请先刷新或进入冲突处理流程。", {
        expectedRevision: currentDocument.latestSnapshot?.revision ?? null,
        receivedRevision: input.baseRevision,
      });
    }
    // 权限范围校验：对比旧/新 payload，确保 scoped edit 不越权。
    // 管理员/owner 在 assertSavePermissionScope 内部直接通过（unrestricted editor）。
    await this.assertSavePermissionScope(
      user,
      documentId,
      currentDocument.latestSnapshot.payload,
      input.payload,
    );
    const nextDocument = await this.prisma.$transaction(async (transaction) => {
      const snapshot = await transaction.annotationSnapshot.create({
        data: {
          documentId,
          revision: input.baseRevision + 1,
          payload: toJsonPayload(input.payload),
          createdBy: user.id,
        },
      });
      const updated = await transaction.annotationDocument.update({
        where: { id: documentId },
        data: {
          latestSnapshotId: snapshot.id,
          updatedAt: new Date(),
        },
        include: documentInclude,
      });
      // 保存审计在 transaction 内写入，保证与快照创建一致。
      await transaction.auditLog.create({
        data: {
          action: "document_save",
          actorUserId: user.id,
          projectId: currentDocument.projectId,
          documentId,
          detail: toJsonPayload({ baseRevision: input.baseRevision, nextRevision: input.baseRevision + 1 }),
        },
      });
      return updated;
    });
    await this.prisma.annotationProject.update({
      where: { id: nextDocument.projectId },
      data: { updatedAt: new Date() },
    });
    return this.expandDocumentForPermission(
      nextDocument,
      permission.isUnrestrictedManager,
    );
  }

  async listVersions(user: ApiUser, documentId: string) {
    await this.getDocument(user, documentId);
    const versions = await this.prisma.annotationVersion.findMany({
      where: { documentId },
      include: { snapshot: true },
      orderBy: { createdAt: "desc" },
    });
    return versions.map((version) => toVersion(version));
  }

  async createVersion(user: ApiUser, documentId: string, input: { name: string; description?: string | null }) {
    const document = await this.getDocumentOrThrow(documentId);
    const permission = await this.getEffectiveDocumentPermission(user, documentId);
    if (!permission.canEdit) {
      throw forbidden();
    }
    const latestSnapshot = document.latestSnapshot;
    if (!latestSnapshot) {
      throw conflict("当前文档还没有可保存为版本的快照。");
    }
    const version = await this.prisma.$transaction(async (transaction) => {
      const createdVersion = await transaction.annotationVersion.create({
        data: {
          documentId,
          snapshotId: latestSnapshot.id,
          name: input.name,
          description: input.description ?? null,
          revision: latestSnapshot.revision,
          createdBy: user.id,
        },
        include: { snapshot: true },
      });
      await transaction.annotationDocument.update({
        where: { id: documentId },
        data: {
          currentVersionId: createdVersion.id,
        },
      });
      // 版本创建审计在 transaction 内，与版本记录保持一致。
      await transaction.auditLog.create({
        data: {
          action: "version_create",
          actorUserId: user.id,
          projectId: document.projectId,
          documentId,
          versionId: createdVersion.id,
          detail: toJsonPayload({ name: input.name, revision: latestSnapshot.revision }),
        },
      });
      return createdVersion;
    });
    return toVersion(version);
  }

  async restoreVersion(user: ApiUser, versionId: string) {
    const version = await this.prisma.annotationVersion.findUnique({
      where: { id: versionId },
      include: {
        snapshot: true,
        document: {
          include: documentInclude,
        },
      },
    });
    if (!version) {
      throw notFound("版本不存在。");
    }
    const permission = await this.getEffectiveDocumentPermission(user, version.documentId);
    if (!permission.canManage) {
      throw forbidden();
    }
    const restoredDocument = await this.saveDocument(user, version.documentId, {
      baseRevision: version.document.latestSnapshot?.revision ?? 0,
      payload: version.snapshot.payload,
    });
    // restoreVersion 内部调用了 saveDocument（已记 document_save），这里再记一条 version_restore。
    await this.writeAuditLog({
      action: "version_restore",
      actorUserId: user.id,
      projectId: version.document.projectId,
      documentId: version.documentId,
      versionId: version.id,
      detail: { restoredVersionId: version.id, restoredRevision: version.revision },
    });
    return restoredDocument;
  }

  async createProcessingJob(
    user: ApiUser,
    input: Omit<ApiProcessingJob, "id" | "status" | "outputFileIds" | "createdBy" | "createdAt" | "updatedAt" | "errorMessage">,
  ) {
    this.requireRole(user, [...contentCreatorRoles, "service"]);
    const isService = this.hasAnyRole(user, ["service"]);
    for (const fileId of input.inputFileIds) {
      if (isService) {
        await this.assertFileExists(fileId);
      } else {
        await this.assertFileVisible(user, fileId);
      }
    }
    if (!isService && input.documentId) {
      const permission = await this.getEffectiveDocumentPermission(
        user,
        input.documentId,
      );
      if (!permission.canEdit) {
        throw forbidden("创建文档分析任务需要该文档的编辑权限。");
      }
    }
    const document = input.documentId
      ? await this.getDocumentOrThrow(input.documentId)
      : null;
    const job = await this.prisma.processingJob.create({
      data: {
        type: input.type as DbProcessingJobType,
        status: "queued",
        inputFileIds: input.inputFileIds,
        outputFileIds: [],
        projectId: document?.projectId ?? null,
        documentId: input.documentId ?? null,
        createdBy: user.id,
      },
    });
    await this.writeAuditLog({
      action: "job_create",
      actorUserId: user.id,
      projectId: document?.projectId ?? null,
      documentId: input.documentId ?? null,
      jobId: job.id,
      detail: { type: input.type, inputFileIds: input.inputFileIds, documentId: input.documentId ?? null },
    });
    return toProcessingJob(job);
  }

  // 查询审计日志。管理员可全局查看；其他账号必须管理指定项目/文档。
  // 支持按 project/document/actor/limit 筛选，按 createdAt 降序。
  async listAuditLogs(
    user: ApiUser,
    options: { projectId?: string; documentId?: string; actorUserId?: string; limit?: number },
  ): Promise<ApiAuditLogEntry[]> {
    if (options.documentId && options.projectId) {
      const document = await this.getDocumentOrThrow(options.documentId);
      if (document.projectId !== options.projectId) {
        throw badRequest("documentId 不属于指定的 projectId。");
      }
    }
    if (!this.hasAnyRole(user, globalAdminRoles)) {
      if (options.documentId) {
        const permission = await this.getEffectiveDocumentPermission(
          user,
          options.documentId,
        );
        // 审计行并未逐条携带可计算的轨道/时间范围，因此受限 manager 不能读取整份文档审计。
        if (!permission.isUnrestrictedManager) {
          throw forbidden("查看文档审计日志需要整文档管理权限。");
        }
      } else if (options.projectId) {
        await this.assertProjectManageable(user, options.projectId);
      } else {
        throw forbidden("非管理员查询审计日志时必须指定可管理的项目或文档。");
      }
    }
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    // Prisma where 对 undefined 字段自动忽略，这里直接传可选值即可。
    const rows = await this.prisma.auditLog.findMany({
      where: {
        projectId: options.projectId,
        documentId: options.documentId,
        actorUserId: options.actorUserId,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => toAuditLogEntry(row));
  }

  // 列出文档的标注操作日志。需要文档 view 权限或特权角色。
  // 按时间降序，初版不带分页。
  async listOperations(
    user: ApiUser,
    documentId: string,
  ): Promise<ApiAnnotationOperation[]> {
    const permission = await this.getEffectiveDocumentPermission(user, documentId);
    if (!permission.canView) {
      throw forbidden();
    }
    const rows = await this.prisma.annotationOperation.findMany({
      where: { documentId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => toAnnotationOperation(row));
  }

  // 创建一条标注操作日志。
  // 需要文档 edit 权限或特权角色。baseRevision 与 server 最新 revision 不一致时返 409，
  // 保证操作日志与服务器快照版本对齐，避免后续同步时出现意外。
  // 初版只落日志，不改变文档 snapshot 或文档版本号。
  async createOperation(
    user: ApiUser,
    documentId: string,
    input: { baseRevision: number; localRevision?: number | null; action: string; payload: unknown },
  ): Promise<ApiAnnotationOperation> {
    const document = await this.getDocumentOrThrow(documentId);
    const permission = await this.getEffectiveDocumentPermission(user, documentId);
    if (!permission.canEdit) {
      throw forbidden();
    }
    const latestRevision = document.latestSnapshot?.revision ?? 0;
    // baseRevision 不一致时拒绝，保证操作日志与服务器快照版本对齐。
    if (input.baseRevision !== latestRevision) {
      throw conflict("操作提交的基础版本已过期，请先刷新文档。", {
        expectedRevision: latestRevision,
        receivedRevision: input.baseRevision,
      });
    }
    const row = await this.prisma.annotationOperation.create({
      data: {
        documentId,
        actorUserId: user.id,
        baseRevision: input.baseRevision,
        localRevision: input.localRevision ?? null,
        serverRevision: latestRevision,
        action: input.action,
        payload: toJsonPayload(input.payload),
        status: "accepted",
      },
    });
    return toAnnotationOperation(row);
  }

  // 列出文档的所有 grant。仅项目 owner、管理员或有效 manage 用户可查看。
  async listDocumentGrants(user: ApiUser, documentId: string) {
    await this.getDocumentOrThrow(documentId);
    const permission = await this.getEffectiveDocumentPermission(user, documentId);
    if (!permission.canManage) {
      throw forbidden();
    }
    const grants = await this.prisma.permissionGrant.findMany({
      where: { documentId },
      include: {
        user: {
          select: {
            displayName: true,
            accountName: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return grants
      .filter((grant) => {
        if (permission.isUnrestrictedManager) {
          return true;
        }
        const scope = toGrant(grant).scope;
        return isGrantScopeAuthorized(
          permission.manageScopes,
          scope.trackScope?.trackIds ?? [],
          scope.timeRange,
        );
      })
      .map((grant) => ({
        ...toGrant(grant),
        displayName: grant.user.displayName,
        accountName: grant.user.accountName,
      }));
  }

  // 给文档新增一条 grant。仅项目 owner、管理员或有效 manage 用户可操作。
  async createDocumentGrant(
    user: ApiUser,
    documentId: string,
    input: CreateGrantRequest,
  ) {
    const document = await this.getDocumentOrThrow(documentId);
    const scope = this.normalizeDocumentGrantScope(document, input.scope);
    await this.assertGrantScopeManageable(user, documentId, scope);
    await this.assertGrantTracksExist(document, scope);

    // 确保目标用户存在。
    const targetUser = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!targetUser || !targetUser.isActive) {
      throw notFound("被授权用户不存在或已停用。");
    }
    const grant = await this.prisma.permissionGrant.create({
      data: {
        userId: input.userId,
        projectId: document.projectId,
        documentId,
        actions: input.actions,
        startTime: scope.timeRange?.startTime ?? null,
        endTime: scope.timeRange?.endTime ?? null,
        trackIds: scope.trackScope?.trackIds ?? [],
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    await this.writeAuditLog({
      action: "permission_grant_create",
      actorUserId: user.id,
      projectId: document.projectId,
      documentId,
      detail: { grantId: grant.id, targetUserId: input.userId, actions: input.actions },
    });
    return toGrant(grant);
  }

  // 修改已有 grant。仅项目 owner、管理员或有效 manage 用户可操作。
  async updatePermissionGrant(
    user: ApiUser,
    grantId: string,
    input: UpdateGrantRequest,
  ) {
    const grant = await this.prisma.permissionGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw notFound("授权记录不存在。");
    const document = grant.documentId
      ? await this.getDocumentOrThrow(grant.documentId)
      : null;
    if (!document) throw notFound("授权关联的文档不存在。");
    const currentScope = toGrant(grant).scope;
    const nextScope = this.normalizeDocumentGrantScope(document, {
      timeRange:
        input.scope?.timeRange === undefined
          ? currentScope.timeRange
          : input.scope.timeRange ?? undefined,
      trackScope:
        input.scope?.trackScope === undefined
          ? currentScope.trackScope
          : input.scope.trackScope ?? undefined,
    });
    // 管理者必须同时覆盖授权修改前后的范围，避免先扩大后再接管越权授权。
    await this.assertGrantScopeManageable(user, document.id, currentScope);
    await this.assertGrantScopeManageable(user, document.id, nextScope);
    await this.assertGrantTracksExist(document, nextScope);

    const updated = await this.prisma.permissionGrant.update({
      where: { id: grantId },
      data: {
        actions: input.actions ?? undefined,
        startTime: input.scope ? nextScope.timeRange?.startTime ?? null : undefined,
        endTime: input.scope ? nextScope.timeRange?.endTime ?? null : undefined,
        trackIds: input.scope ? nextScope.trackScope?.trackIds ?? [] : undefined,
        expiresAt: input.expiresAt !== undefined ? (input.expiresAt ? new Date(input.expiresAt) : null) : undefined,
      },
    });
    await this.writeAuditLog({
      action: "permission_grant_update",
      actorUserId: user.id,
      projectId: document.projectId,
      documentId: grant.documentId ?? null,
      detail: { grantId: grant.id, updatedActions: input.actions, updatedExpiresAt: input.expiresAt },
    });
    return toGrant(updated);
  }

  // 撤销 grant。仅项目 owner、管理员或有效 manage 用户可操作。
  async revokePermissionGrant(user: ApiUser, grantId: string) {
    const grant = await this.prisma.permissionGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw notFound("授权记录不存在。");
    if (!grant.documentId) {
      throw badRequest("项目级授权暂不通过文档授权接口撤销。");
    }
    const document = await this.getDocumentOrThrow(grant.documentId);
    await this.assertGrantScopeManageable(user, document.id, toGrant(grant).scope);
    await this.prisma.permissionGrant.delete({ where: { id: grantId } });
    await this.writeAuditLog({
      action: "permission_grant_revoke",
      actorUserId: user.id,
      projectId: grant.projectId ?? null,
      documentId: grant.documentId ?? null,
      detail: { grantId: grant.id, targetUserId: grant.userId },
    });
  }

  // 获取当前用户对文档的有效权限摘要。
  async getEffectiveDocumentPermission(user: ApiUser, documentId: string) {
    const document = await this.getDocumentOrThrow(documentId);
    const isOwner = document.project.ownerUserId === user.id;
    const isAdmin = this.hasAnyRole(user, globalAdminRoles);
    // 项目级授权与文档级授权共同构成文档有效权限；过期过滤由权限核心统一完成。
    const grants = isAdmin || isOwner
      ? []
      : await this.listRelevantPermissionGrants(user.id, documentId, document.projectId);
    return resolveEffectiveDocumentPermission({
      userId: user.id,
      isOwner,
      isAdmin,
      grants,
      documentId,
      projectId: document.projectId,
    });
  }

  // 在保存 snapshot 时进行权限范围校验。旧/新 payload 均可能是 unknown，
  // 由 document-model 的 collectProjectMutations / authorizeProjectMutations 完成比较。
  // 管理员和 owner 不受范围约束（在 resolveEffectiveDocumentPermission 中 complete 返回）。
  // 普通用户若 scope 不足，返回 403，不创建 snapshot。
  async assertSavePermissionScope(user: ApiUser, documentId: string, beforePayload: unknown, afterPayload: unknown) {
    const effectivePermission = await this.getEffectiveDocumentPermission(user, documentId);
    // unrestricted editor 通过，不做 scope diff。
    if (effectivePermission.isUnrestrictedEditor) {
      return;
    }
    const document = await this.getDocumentOrThrow(documentId);
    const mutations = collectProjectMutations(beforePayload, afterPayload);
    const result = authorizeProjectMutations(mutations, effectivePermission);
    if (!result.allowed) {
      const violations = result.violations.slice(0, 20);
      const total = result.totalViolationCount;
      // 记录越权审计摘要，不保存完整 payload。
      await this.writeAuditLog({
        action: "permission_denied",
        actorUserId: user.id,
        projectId: document.projectId,
        documentId,
        detail: {
          mutationCount: mutations.length,
          violationCount: total,
          sampleViolations: violations.map((v) => ({ kind: v.kind, trackIds: v.trackIds, timeRange: v.timeRange })),
        },
      });
      throw permissionScopeViolation(
        "本次修改超出可编辑的轨道或时间范围。",
        {
        violations,
        totalViolationCount: total,
        },
      );
    }
  }

  private async assertFileVisible(user: ApiUser, fileId: string) {
    const file = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!file) {
      throw notFound("文件不存在。");
    }
    if (file.ownerUserId === user.id || this.hasAnyRole(user, globalAdminRoles)) {
      return;
    }
    const projects = await this.prisma.annotationProject.findMany({
      where: {
        mediaAsset: {
          primaryFileId: fileId,
        },
      },
      select: {
        id: true,
        ownerUserId: true,
      },
    });
    if (projects.some((project) => project.ownerUserId === user.id)) {
      return;
    }
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length) {
      const grants = await this.prisma.permissionGrant.findMany({
        where: {
          userId: user.id,
          projectId: { in: projectIds },
        },
      });
      if (grants.some((grant) =>
        isGrantActive(toGrant(grant)) &&
        doesGrantAuthorizeAction(
          grant.actions as PermissionAction[],
          "view",
        ),
      )) {
        return;
      }
    }
    throw forbidden();
  }

  private async assertFileExists(fileId: string) {
    const file = await this.prisma.fileObject.findUnique({
      where: { id: fileId },
      select: { id: true },
    });
    if (!file) {
      throw notFound("文件不存在。");
    }
  }

  private async assertProjectVisible(user: ApiUser, projectId: string) {
    const project = await this.prisma.annotationProject.findUnique({
      where: { id: projectId },
      select: { ownerUserId: true },
    });
    if (!project) {
      throw notFound("项目不存在。");
    }
    if (
      project.ownerUserId === user.id ||
      this.hasAnyRole(user, globalAdminRoles)
    ) {
      return;
    }
    const grants = await this.prisma.permissionGrant.findMany({
      where: {
        userId: user.id,
        projectId,
      },
    });
    if (!grants.some((grant) =>
      isGrantActive(toGrant(grant)) &&
      doesGrantAuthorizeAction(
        grant.actions as PermissionAction[],
        "view",
      ),
    )) {
      throw forbidden();
    }
  }

  private async assertProjectManageable(user: ApiUser, projectId: string) {
    const project = await this.prisma.annotationProject.findUnique({
      where: { id: projectId },
      select: { ownerUserId: true },
    });
    if (!project) {
      throw notFound("项目不存在。");
    }
    if (
      project.ownerUserId === user.id ||
      this.hasAnyRole(user, globalAdminRoles)
    ) {
      return;
    }
    const grants = await this.prisma.permissionGrant.findMany({
      where: {
        userId: user.id,
        projectId,
        documentId: null,
      },
    });
    if (!grants.some((grant) => {
      const mappedGrant = toGrant(grant);
      return isGrantActive(mappedGrant) &&
        doesGrantAuthorizeAction(mappedGrant.actions, "manage") &&
        !mappedGrant.scope.timeRange &&
        !mappedGrant.scope.trackScope?.trackIds.length;
    })) {
      throw forbidden();
    }
  }

  private async isProjectOwner(userId: string, projectId: string) {
    return Boolean(await this.prisma.annotationProject.findFirst({
      where: {
        id: projectId,
        ownerUserId: userId,
      },
      select: { id: true },
    }));
  }

  private async listVisibleProjectIds(user: ApiUser) {
    const [ownedProjects, grants] = await Promise.all([
      this.prisma.annotationProject.findMany({
        where: { ownerUserId: user.id },
        select: { id: true },
      }),
      this.prisma.permissionGrant.findMany({
        where: {
          userId: user.id,
          projectId: { not: null },
        },
      }),
    ]);
    const projectIds = new Set(ownedProjects.map((project) => project.id));
    for (const grant of grants) {
      const mappedGrant = toGrant(grant);
      if (
        grant.projectId &&
        isGrantActive(mappedGrant) &&
        doesGrantAuthorizeAction(mappedGrant.actions, "view")
      ) {
        projectIds.add(grant.projectId);
      }
    }
    return [...projectIds];
  }

  private async countVisibleProjectDocuments(
    userId: string,
    projectId: string,
    totalDocumentCount: number,
  ) {
    const grants = await this.prisma.permissionGrant.findMany({
      where: { userId, projectId },
    });
    const viewGrants = grants
      .map((grant) => toGrant(grant))
      .filter((grant) =>
        isGrantActive(grant) &&
        doesGrantAuthorizeAction(grant.actions, "view"),
      );
    if (viewGrants.some((grant) => !grant.scope.documentId)) {
      return totalDocumentCount;
    }
    const documentIds = [
      ...new Set(
        viewGrants
          .map((grant) => grant.scope.documentId)
          .filter((documentId): documentId is string => Boolean(documentId)),
      ),
    ];
    return this.prisma.annotationDocument.count({
      where: {
        projectId,
        id: { in: documentIds },
      },
    });
  }

  private async assertMediaAssetVisible(user: ApiUser, mediaAssetId: string) {
    const mediaAsset = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaAssetId },
      include: {
        primaryFile: { select: { ownerUserId: true } },
        projects: { select: { id: true } },
      },
    });
    if (!mediaAsset) {
      throw notFound("媒体资产不存在。");
    }
    if (
      this.hasAnyRole(user, globalAdminRoles) ||
      mediaAsset.ownerUserId === user.id ||
      mediaAsset.primaryFile?.ownerUserId === user.id
    ) {
      return;
    }
    const visibleProjectIds = new Set(await this.listVisibleProjectIds(user));
    if (!mediaAsset.projects.some((project) => visibleProjectIds.has(project.id))) {
      throw forbidden("当前账号无权使用该媒体资产。");
    }
  }

  private async listRelevantPermissionGrants(
    userId: string,
    documentId: string,
    projectId: string,
  ): Promise<PermissionGrant[]> {
    const grants = await this.prisma.permissionGrant.findMany({
      where: {
        userId,
        OR: [
          { documentId },
          { documentId: null, projectId },
        ],
      },
    });
    return grants.map((grant) => toGrant(grant));
  }

  private normalizeDocumentGrantScope(
    document: DocumentWithDetails,
    scope: PermissionScope | undefined,
  ): PermissionScope {
    if (
      (scope?.projectId && scope.projectId !== document.projectId) ||
      (scope?.documentId && scope.documentId !== document.id)
    ) {
      throw badRequest("授权 scope 不能指向当前文档之外的项目或文档。");
    }
    return {
      projectId: document.projectId,
      documentId: document.id,
      timeRange: scope?.timeRange,
      trackScope: scope?.trackScope?.trackIds.length
        ? { trackIds: [...new Set(scope.trackScope.trackIds)] }
        : undefined,
    };
  }

  private async assertGrantTracksExist(
    document: DocumentWithDetails,
    scope: PermissionScope,
  ) {
    const requestedTrackIds = scope.trackScope?.trackIds ?? [];
    if (!requestedTrackIds.length) {
      return;
    }
    const knownTrackIds = collectPersistedPermissionTrackIds(
      document.latestSnapshot?.payload,
    );
    const missingTrackIds = requestedTrackIds.filter(
      (trackId) => !knownTrackIds.has(trackId),
    );
    if (missingTrackIds.length) {
      throw badRequest("授权范围包含不存在的轨道。", { missingTrackIds });
    }
  }

  private async assertGrantScopeManageable(
    user: ApiUser,
    documentId: string,
    scope: PermissionScope,
  ) {
    const document = await this.getDocumentOrThrow(documentId);
    if (
      document.project.ownerUserId === user.id ||
      this.hasAnyRole(user, globalAdminRoles)
    ) {
      return;
    }
    const permission = await this.getEffectiveDocumentPermission(user, documentId);
    if (
      !permission.canManage ||
      !isGrantScopeAuthorized(
        permission.manageScopes,
        scope.trackScope?.trackIds ?? [],
        scope.timeRange,
      )
    ) {
      throw forbidden("不能创建、修改或撤销超出自身管理范围的授权。");
    }
  }

  private requireRole(user: ApiUser, allowedRoles: ApiRole[]) {
    if (!this.hasAnyRole(user, allowedRoles)) {
      throw forbidden();
    }
  }

  private hasAnyRole(user: ApiUser, allowedRoles: ApiRole[]) {
    return user.roles.some((role) => allowedRoles.includes(role));
  }

  private async getDocumentOrThrow(documentId: string) {
    const document = await this.prisma.annotationDocument.findUnique({
      where: { id: documentId },
      include: documentInclude,
    });
    if (!document) {
      throw notFound("标注文档不存在。");
    }
    return document;
  }

  private expandDocumentForPermission(
    document: DocumentWithDetails,
    includeAllGrants: boolean,
  ) {
    const expanded = expandDocument(document);
    // grant 包含其他账号的身份和授权范围；只有整文档 manager 才能通过文档主体读取完整清单。
    return includeAllGrants ? expanded : { ...expanded, grants: [] };
  }

  private getAuthTokenTtlMs() {
    const days = Number(process.env.XIQU_AUTH_TOKEN_DAYS ?? 14);
    return Math.max(1, days) * 24 * 60 * 60 * 1000;
  }

  // 审计日志写入 helper（用于 transaction 外的轻量审计）。
  // 初版不存完整 payload；detail 只放摘要字段（如 revision、文件名、checksum）。
  // 写入失败只记日志、不抛异常，避免阻断主业务流程——审计是辅助追溯，不是业务一致性前提。
  // 注意：在 transaction 内的审计（createDocument/saveDocument/createVersion）直接用
  // transaction.auditLog.create，不走本 helper，以保证审计与业务数据同生共死。
  private async writeAuditLog(input: {
    action: DbAuditAction;
    actorUserId: string;
    projectId?: string | null;
    documentId?: string | null;
    fileId?: string | null;
    versionId?: string | null;
    jobId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    detail?: unknown;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: input.action,
          actorUserId: input.actorUserId,
          projectId: input.projectId ?? null,
          documentId: input.documentId ?? null,
          fileId: input.fileId ?? null,
          versionId: input.versionId ?? null,
          jobId: input.jobId ?? null,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          detail: input.detail === undefined ? undefined : toJsonPayload(input.detail),
        },
      });
    } catch (error) {
      // 审计写入失败不抛异常，避免阻塞主业务流程。
      console.error("审计日志写入失败:", error instanceof Error ? error.message : String(error));
    }
  }
}
