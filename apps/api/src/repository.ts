import { randomBytes } from "node:crypto";
import {
  type AuditAction,
  type Prisma,
  type PrismaClient,
  type ProcessingJobType as DbProcessingJobType,
} from "@prisma/client";
import type {
  AnnotationOperationRecord,
  AuditLogEntry,
  CreateProcessingJobRequest,
  ProcessingJob,
} from "@xiqu/shared";
import { hashToken, verifyPassword } from "./auth.js";
import type { ApiRole, ApiUser } from "./domain.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from "./errors.js";
import {
  ALL_PROJECT_CAPABILITIES,
  ProjectAccessService,
} from "./projectAccess.js";
import {
  toFile,
  toJsonPayload,
  toMediaAsset,
  toProjectSummary,
  toPublicUser,
} from "./repositoryMappers.js";
import { ensurePlatformSeedData } from "./repositorySeed.js";

const CONTENT_CREATOR_ROLES: ApiRole[] = [
  "super_admin",
  "admin",
  "teacher",
  "ta",
];

export class PrismaPlatformRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ProjectAccessService,
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
        expiresAt: new Date(Date.now() + this.getAuthTokenTtlMs()),
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

  async listFiles(user: ApiUser) {
    const visibleProjectIds = await this.listVisibleProjectIds(user);
    const files = await this.prisma.fileObject.findMany({
      where: this.access.isGlobalAdmin(user)
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
          },
      orderBy: { createdAt: "desc" },
    });
    return files.map(toFile);
  }

  async createUploadedFile(
    user: ApiUser,
    input: {
      name: string;
      mimeType: string;
      size: number;
      storageKey: string;
      checksum: string;
    },
  ) {
    const file = await this.prisma.fileObject.create({
      data: {
        ...input,
        ownerUserId: user.id,
      },
    });
    await this.writeAuditLog({
      action: "file_upload",
      actorUserId: user.id,
      fileId: file.id,
      detail: {
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        checksum: input.checksum,
      },
    });
    return toFile(file);
  }

  async getFileForRead(user: ApiUser, fileId: string) {
    const file = await this.prisma.fileObject.findUnique({
      where: { id: fileId },
    });
    if (!file) throw notFound("文件不存在。");
    if (
      file.ownerUserId !== user.id &&
      !this.access.isGlobalAdmin(user)
    ) {
      const project = await this.prisma.annotationProject.findFirst({
        where: {
          mediaAsset: { primaryFileId: fileId },
          OR: [
            { ownerUserId: user.id },
            {
              members: {
                some: {
                  userId: user.id,
                  capabilities: { has: "view_project" },
                  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                },
              },
            },
          ],
        },
      });
      if (!project) throw forbidden("当前账号不能读取该文件。");
    }
    return toFile(file);
  }

  async listMediaAssets(user: ApiUser) {
    const visibleProjectIds = await this.listVisibleProjectIds(user);
    const assets = await this.prisma.mediaAsset.findMany({
      where: this.access.isGlobalAdmin(user)
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
    return assets.map(toMediaAsset);
  }

  async createMediaAsset(
    user: ApiUser,
    input: {
      title: string;
      description?: string | null;
      primaryFileId?: string | null;
    },
  ) {
    this.requireRole(user, CONTENT_CREATOR_ROLES);
    if (input.primaryFileId) {
      const file = await this.prisma.fileObject.findUnique({
        where: { id: input.primaryFileId },
      });
      if (!file) throw notFound("主媒体文件不存在。");
      if (
        file.ownerUserId !== user.id &&
        !this.access.isGlobalAdmin(user)
      ) {
        throw forbidden("只能使用自己上传的媒体文件。");
      }
    }
    const asset = await this.prisma.mediaAsset.create({
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
      detail: {
        title: input.title,
        primaryFileId: input.primaryFileId ?? null,
      },
    });
    return toMediaAsset(asset);
  }

  async listProjects(user: ApiUser) {
    const projects = await this.prisma.annotationProject.findMany({
      where: this.access.isGlobalAdmin(user)
        ? {}
        : {
            OR: [
              { ownerUserId: user.id },
              {
                members: {
                  some: {
                    userId: user.id,
                    capabilities: { has: "view_project" },
                    OR: [
                      { expiresAt: null },
                      { expiresAt: { gt: new Date() } },
                    ],
                  },
                },
              },
            ],
          },
      include: {
        _count: {
          select: {
            workspaces: true,
            annotationVersions: true,
            projectVersions: true,
            members: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(projects.map(async (project) => {
      const permission = await this.access.getEffectiveProjectPermission(
        user,
        project.id,
      );
      return toProjectSummary(project, permission.capabilities);
    }));
  }

  async createProject(
    user: ApiUser,
    input: { title: string; mediaAssetId: string },
  ) {
    this.requireRole(user, CONTENT_CREATOR_ROLES);
    const media = await this.prisma.mediaAsset.findUnique({
      where: { id: input.mediaAssetId },
    });
    if (!media) throw notFound("媒体资产不存在。");
    if (
      media.ownerUserId !== user.id &&
      !this.access.isGlobalAdmin(user)
    ) {
      throw forbidden("当前账号不能使用该媒体资产创建项目。");
    }
    const project = await this.prisma.annotationProject.create({
      data: {
        title: input.title,
        mediaAssetId: input.mediaAssetId,
        ownerUserId: user.id,
      },
      include: {
        _count: {
          select: {
            workspaces: true,
            annotationVersions: true,
            projectVersions: true,
            members: true,
          },
        },
      },
    });
    await this.writeAuditLog({
      action: "project_create",
      actorUserId: user.id,
      projectId: project.id,
      detail: { title: input.title, mediaAssetId: input.mediaAssetId },
    });
    return toProjectSummary(project, ALL_PROJECT_CAPABILITIES);
  }

  async createProcessingJob(
    user: ApiUser,
    input: CreateProcessingJobRequest,
  ): Promise<ProcessingJob> {
    this.requireRole(user, [...CONTENT_CREATOR_ROLES, "service"]);
    for (const fileId of input.inputFileIds) {
      await this.getFileForRead(user, fileId);
    }
    let projectId: string | null = null;
    if (input.workspaceId) {
      const workspace = await this.prisma.annotationWorkspace.findUnique({
        where: { id: input.workspaceId },
      });
      if (!workspace) throw notFound("标注工作区不存在。");
      const permission = await this.access.resolveWorkspacePermission(
        user,
        workspace,
      );
      if (!permission.canEdit && !permission.canManage) {
        throw forbidden("创建分析任务需要该工作区的编辑或管理权限。");
      }
      projectId = workspace.projectId;
    }
    const job = await this.prisma.processingJob.create({
      data: {
        type: input.type as DbProcessingJobType,
        inputFileIds: input.inputFileIds,
        projectId,
        workspaceId: input.workspaceId ?? null,
        createdBy: user.id,
      },
    });
    await this.writeAuditLog({
      action: "job_create",
      actorUserId: user.id,
      projectId,
      workspaceId: input.workspaceId ?? null,
      jobId: job.id,
      detail: {
        type: input.type,
        inputFileIds: input.inputFileIds,
      },
    });
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      inputFileIds: job.inputFileIds,
      outputFileIds: job.outputFileIds,
      workspaceId: job.workspaceId,
      createdBy: job.createdBy,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      errorMessage: job.errorMessage,
    };
  }

  async listAuditLogs(
    user: ApiUser,
    options: {
      projectId?: string;
      workspaceId?: string;
      actorUserId?: string;
      limit?: number;
    },
  ): Promise<AuditLogEntry[]> {
    if (!this.access.isGlobalAdmin(user)) {
      if (!options.projectId) {
        throw forbidden("非管理员查询审计日志时必须指定项目。");
      }
      await this.access.assertCapability(
        user,
        options.projectId,
        "manage_all_versions",
      );
    }
    if (options.workspaceId && options.projectId) {
      const workspace = await this.prisma.annotationWorkspace.findUnique({
        where: { id: options.workspaceId },
      });
      if (!workspace || workspace.projectId !== options.projectId) {
        throw badRequest("workspaceId 不属于指定项目。");
      }
    }
    const rows = await this.prisma.auditLog.findMany({
      where: {
        projectId: options.projectId,
        workspaceId: options.workspaceId,
        actorUserId: options.actorUserId,
      },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(options.limit ?? 50, 200)),
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorUserId: row.actorUserId,
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      annotationVersionId: row.annotationVersionId,
      projectVersionId: row.projectVersionId,
      fileId: row.fileId,
      jobId: row.jobId,
      targetType: row.targetType,
      targetId: row.targetId,
      detail: row.detail,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async listOperations(
    user: ApiUser,
    workspaceId: string,
  ): Promise<AnnotationOperationRecord[]> {
    const workspace = await this.getWorkspaceOrThrow(workspaceId);
    await this.access.assertWorkspaceVisible(user, workspace);
    const rows = await this.prisma.annotationOperation.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toOperation);
  }

  async createOperation(
    user: ApiUser,
    workspaceId: string,
    input: {
      baseRevision: number;
      localRevision?: number | null;
      action: string;
      payload: unknown;
    },
  ): Promise<AnnotationOperationRecord> {
    const workspace = await this.prisma.annotationWorkspace.findUnique({
      where: { id: workspaceId },
      include: { latestSnapshot: true },
    });
    if (!workspace) throw notFound("标注工作区不存在。");
    const permission = await this.access.resolveWorkspacePermission(
      user,
      workspace,
    );
    if (!permission.canEdit) throw forbidden("当前工作区不可编辑。");
    const latestRevision = workspace.latestSnapshot?.revision ?? 0;
    if (input.baseRevision !== latestRevision) {
      throw conflict("操作的基础版本已过期，请先刷新工作区。", {
        expectedRevision: latestRevision,
        receivedRevision: input.baseRevision,
      });
    }
    const row = await this.prisma.annotationOperation.create({
      data: {
        workspaceId,
        actorUserId: user.id,
        baseRevision: input.baseRevision,
        localRevision: input.localRevision ?? null,
        serverRevision: latestRevision,
        action: input.action,
        payload: toJsonPayload(input.payload),
      },
    });
    return toOperation(row);
  }

  async writeAuditLog(input: {
    action: AuditAction;
    actorUserId?: string | null;
    projectId?: string | null;
    workspaceId?: string | null;
    annotationVersionId?: string | null;
    projectVersionId?: string | null;
    fileId?: string | null;
    jobId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    detail?: unknown;
  }) {
    await this.prisma.auditLog.create({
      data: {
        ...input,
        detail: input.detail === undefined
          ? undefined
          : toJsonPayload(input.detail),
      },
    });
  }

  private async getWorkspaceOrThrow(workspaceId: string) {
    const workspace = await this.prisma.annotationWorkspace.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) throw notFound("标注工作区不存在。");
    return workspace;
  }

  private async listVisibleProjectIds(user: ApiUser) {
    if (this.access.isGlobalAdmin(user)) {
      return (await this.prisma.annotationProject.findMany({
        select: { id: true },
      })).map((project) => project.id);
    }
    const projects = await this.prisma.annotationProject.findMany({
      where: {
        OR: [
          { ownerUserId: user.id },
          {
            members: {
              some: {
                userId: user.id,
                capabilities: { has: "view_project" },
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    return projects.map((project) => project.id);
  }

  private requireRole(user: ApiUser, allowedRoles: ApiRole[]) {
    if (!user.roles.some((role) => allowedRoles.includes(role))) {
      throw forbidden();
    }
  }

  private getAuthTokenTtlMs() {
    const configured = Number(process.env.AUTH_TOKEN_TTL_MS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : 1000 * 60 * 60 * 24 * 7;
  }
}

function toOperation(row: {
  id: string;
  workspaceId: string;
  actorUserId: string;
  baseRevision: number;
  localRevision: number | null;
  serverRevision: number | null;
  action: string;
  payload: Prisma.JsonValue;
  status: "accepted" | "rejected" | "superseded";
  createdAt: Date;
}): AnnotationOperationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    actorUserId: row.actorUserId,
    baseRevision: row.baseRevision,
    localRevision: row.localRevision,
    serverRevision: row.serverRevision,
    action: row.action,
    payload: row.payload,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
