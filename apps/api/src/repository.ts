import { randomBytes } from "node:crypto";
import {
  AnnotationMode as DbAnnotationMode,
  PrismaClient,
  ProcessingJobType as DbProcessingJobType,
} from "@prisma/client";
import { hashToken, verifyPassword } from "./auth.js";
import type {
  ApiAnnotationMode,
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
      return transaction.annotationDocument.update({
        where: { id: createdDocument.id },
        data: {
          latestSnapshotId: snapshot.id,
        },
        include: documentInclude,
      });
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
      return transaction.annotationDocument.update({
        where: { id: documentId },
        data: {
          latestSnapshotId: snapshot.id,
          updatedAt: new Date(),
        },
        include: documentInclude,
      });
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
    return this.saveDocument(user, version.documentId, {
      baseRevision: version.document.latestSnapshot?.revision ?? 0,
      payload: version.snapshot.payload,
    });
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
    return toProcessingJob(job);
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
}
