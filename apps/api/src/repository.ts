import { randomBytes } from "node:crypto";
import {
  AnnotationMode as DbAnnotationMode,
  AuditAction as DbAuditAction,
  PrismaClient,
  ProcessingJobType as DbProcessingJobType,
} from "@prisma/client";
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
import { conflict, forbidden, notFound, unauthorized } from "./errors.js";
import {
  createGrantData,
  documentInclude,
  expandDocument,
  toAnnotationOperation,
  toAuditLogEntry,
  toDocumentSummary,
  toFileObject,
  toGrantCreateData,
  toJsonPayload,
  toMediaAsset,
  toProcessingJob,
  toProjectSummary,
  toPublicUser,
  toVersion,
  type GrantRecord,
} from "./repositoryMappers.js";
import { ensurePlatformSeedData } from "./repositorySeed.js";

const privilegedRoles: ApiRole[] = ["super_admin", "admin", "teacher", "ta"];

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
    const where = this.hasAnyRole(user, privilegedRoles) ? {} : { ownerUserId: user.id };
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
    if (file.ownerUserId !== user.id && !this.hasAnyRole(user, privilegedRoles)) {
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
    if (file.ownerUserId !== user.id && !this.hasAnyRole(user, privilegedRoles)) {
      throw forbidden();
    }
    return toFileObject(file);
  }

  async listMediaAssets(user: ApiUser) {
    this.requireRole(user, privilegedRoles);
    const mediaAssets = await this.prisma.mediaAsset.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return mediaAssets.map((mediaAsset) => toMediaAsset(mediaAsset));
  }

  async createMediaAsset(user: ApiUser, input: { title: string; description?: string | null; primaryFileId?: string | null }) {
    this.requireRole(user, privilegedRoles);
    if (input.primaryFileId) {
      await this.assertFileVisible(user, input.primaryFileId);
    }
    const mediaAsset = await this.prisma.mediaAsset.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        primaryFileId: input.primaryFileId ?? null,
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
    if (this.hasAnyRole(user, privilegedRoles)) {
      const projects = await this.prisma.annotationProject.findMany({
        include: { _count: { select: { documents: true } } },
        orderBy: { updatedAt: "desc" },
      });
      return projects.map((project) => toProjectSummary(project));
    }
    const grants = await this.prisma.permissionGrant.findMany({
      where: {
        userId: user.id,
        actions: { has: "view" },
        projectId: { not: null },
      },
      select: { projectId: true },
    });
    const projectIds = Array.from(new Set(grants.map((grant) => grant.projectId).filter(Boolean))) as string[];
    const projects = await this.prisma.annotationProject.findMany({
      where: { id: { in: projectIds } },
      include: { _count: { select: { documents: true } } },
      orderBy: { updatedAt: "desc" },
    });
    return projects.map((project) => toProjectSummary(project));
  }

  async createProject(user: ApiUser, input: { title: string; mediaAssetId: string }) {
    this.requireRole(user, privilegedRoles);
    const mediaAsset = await this.prisma.mediaAsset.findUnique({ where: { id: input.mediaAssetId } });
    if (!mediaAsset) {
      throw notFound("媒体资产不存在。");
    }
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
    return documents.map((document) => toDocumentSummary(document));
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
    if (!this.canDocumentGrant(user.id, document.grants, "view") && !this.hasAnyRole(user, privilegedRoles)) {
      throw forbidden();
    }
    return expandDocument(document);
  }

  async saveDocument(user: ApiUser, documentId: string, input: { baseRevision: number; payload: unknown }) {
    const currentDocument = await this.getDocumentOrThrow(documentId);
    if (!this.canDocumentGrant(user.id, currentDocument.grants, "edit") && !this.hasAnyRole(user, privilegedRoles)) {
      throw forbidden();
    }
    if (!currentDocument.latestSnapshot || currentDocument.latestSnapshot.revision !== input.baseRevision) {
      throw conflict("文档版本已变化，请先刷新或进入冲突处理流程。", {
        expectedRevision: currentDocument.latestSnapshot?.revision ?? null,
        receivedRevision: input.baseRevision,
      });
    }
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
    return expandDocument(nextDocument);
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
    if (!this.canDocumentGrant(user.id, document.grants, "edit") && !this.hasAnyRole(user, privilegedRoles)) {
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
    if (!this.canDocumentGrant(user.id, version.document.grants, "edit") && !this.hasAnyRole(user, privilegedRoles)) {
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
    this.requireRole(user, [...privilegedRoles, "service"]);
    const job = await this.prisma.processingJob.create({
      data: {
        type: input.type as DbProcessingJobType,
        status: "queued",
        inputFileIds: input.inputFileIds,
        outputFileIds: [],
        documentId: input.documentId ?? null,
        createdBy: user.id,
      },
    });
    await this.writeAuditLog({
      action: "job_create",
      actorUserId: user.id,
      projectId: null,
      documentId: input.documentId ?? null,
      jobId: job.id,
      detail: { type: input.type, inputFileIds: input.inputFileIds, documentId: input.documentId ?? null },
    });
    return toProcessingJob(job);
  }

  // 查询审计日志。初版仅管理员/教师/助教可访问。
  // 支持按 project/document/actor/limit 筛选，按 createdAt 降序。
  async listAuditLogs(
    user: ApiUser,
    options: { projectId?: string; documentId?: string; actorUserId?: string; limit?: number },
  ): Promise<ApiAuditLogEntry[]> {
    this.requireRole(user, privilegedRoles);
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
    const document = await this.getDocumentOrThrow(documentId);
    if (!this.canDocumentGrant(user.id, document.grants, "view") && !this.hasAnyRole(user, privilegedRoles)) {
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
    if (!this.canDocumentGrant(user.id, document.grants, "edit") && !this.hasAnyRole(user, privilegedRoles)) {
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

  private async assertFileVisible(user: ApiUser, fileId: string) {
    const file = await this.prisma.fileObject.findUnique({ where: { id: fileId } });
    if (!file) {
      throw notFound("文件不存在。");
    }
    if (file.ownerUserId !== user.id && !this.hasAnyRole(user, privilegedRoles)) {
      throw forbidden();
    }
  }

  private async assertProjectVisible(user: ApiUser, projectId: string) {
    if (this.hasAnyRole(user, privilegedRoles)) {
      return;
    }
    const grant = await this.prisma.permissionGrant.findFirst({
      where: {
        userId: user.id,
        projectId,
        actions: { has: "view" },
      },
    });
    if (!grant) {
      throw forbidden();
    }
  }

  private async assertProjectManageable(user: ApiUser, projectId: string) {
    if (this.hasAnyRole(user, privilegedRoles)) {
      const project = await this.prisma.annotationProject.findUnique({ where: { id: projectId } });
      if (!project) {
        throw notFound("项目不存在。");
      }
      return;
    }
    const grant = await this.prisma.permissionGrant.findFirst({
      where: {
        userId: user.id,
        projectId,
        actions: { has: "manage" },
      },
    });
    if (!grant) {
      throw forbidden();
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

  private canDocumentGrant(userId: string, grants: GrantRecord[], action: ApiPermissionGrant["actions"][number]) {
    return grants.some((grant) => grant.userId === userId && grant.actions.includes(action));
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
