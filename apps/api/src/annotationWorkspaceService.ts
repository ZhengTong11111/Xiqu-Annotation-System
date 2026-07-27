import type { PrismaClient, WorkspaceStatus } from "@prisma/client";
import {
  authorizeProjectMutations,
  collectProjectMutations,
} from "@xiqu/document-model";
import type {
  AnnotationWorkspace,
  AnnotationWorkspaceSummary,
  CreateWorkspaceRequest,
  SaveWorkspaceRequest,
  UpdateWorkspaceStatusRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  permissionScopeViolation,
} from "./errors.js";
import {
  isMemberActive,
  ProjectAccessService,
} from "./projectAccess.js";
import {
  toJsonPayload,
  toWorkspace,
  toWorkspaceSummary,
  workspaceSummaryInclude,
} from "./repositoryMappers.js";
import { runSerializableTransaction } from "./serializableTransaction.js";

const projectCountSelect = {
  workspaces: true,
  annotationVersions: true,
  projectVersions: true,
  members: true,
} as const;

export class AnnotationWorkspaceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ProjectAccessService,
  ) {}

  async listProjectWorkspaces(
    user: ApiUser,
    projectId: string,
    ownerUserId?: string,
  ): Promise<AnnotationWorkspaceSummary[]> {
    await this.access.assertProjectVisible(user, projectId);
    const workspaces = await this.prisma.annotationWorkspace.findMany({
      where: { projectId, ownerUserId },
      include: workspaceSummaryInclude,
      orderBy: { updatedAt: "desc" },
    });
    return Promise.all(workspaces.map(async (workspace) =>
      toWorkspaceSummary(
        workspace,
        await this.access.resolveWorkspacePermission(user, workspace),
      )));
  }

  async createWorkspace<TPayload>(
    user: ApiUser,
    projectId: string,
    input: CreateWorkspaceRequest<TPayload>,
  ): Promise<AnnotationWorkspace<TPayload>> {
    const projectPermission = await this.access.assertCapability(
      user,
      projectId,
      "create_workspace",
    );
    const ownerUserId = input.ownerUserId ?? user.id;
    if (
      ownerUserId !== user.id &&
      !projectPermission.capabilities.includes("manage_all_versions")
    ) {
      throw forbidden("只有版本管理员可以为其他账号创建工作区。");
    }
    if (input.workspaceType === "main") {
      await this.access.assertCapability(
        user,
        projectId,
        "manage_all_versions",
      );
    }
    await this.assertWorkspaceOwnerIsProjectMember(projectId, ownerUserId);

    const workspaceId = await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        const workspace = await transaction.annotationWorkspace.create({
          data: {
            projectId,
            name: input.name.trim(),
            workspaceType: input.workspaceType ?? "personal",
            ownerUserId,
            createdBy: user.id,
          },
        });
        const snapshot = await transaction.annotationSnapshot.create({
          data: {
            workspaceId: workspace.id,
            revision: 1,
            payload: toJsonPayload(input.initialPayload),
            createdBy: user.id,
          },
        });
        await transaction.annotationWorkspace.update({
          where: { id: workspace.id },
          data: { latestSnapshotId: snapshot.id },
        });
        if (workspace.workspaceType === "main") {
          // 条件更新是主工作区唯一性的最终闸门。即使两个请求同时通过前置检查，
          // 也只有一个能把仍为空的项目指针写入；失败事务会整体回滚新工作区。
          const claimed = await transaction.annotationProject.updateMany({
            where: { id: projectId, primaryWorkspaceId: null },
            data: { primaryWorkspaceId: workspace.id },
          });
          if (claimed.count !== 1) {
            throw conflict("项目已经存在主工作区。");
          }
        }
        await transaction.auditLog.create({
          data: {
            action: "workspace_create",
            actorUserId: user.id,
            projectId,
            workspaceId: workspace.id,
            targetType: "annotation_workspace",
            targetId: workspace.id,
            detail: toJsonPayload({
              name: workspace.name,
              workspaceType: workspace.workspaceType,
              ownerUserId,
            }),
          },
        });
        return workspace.id;
      },
    );
    return this.getWorkspace<TPayload>(user, workspaceId);
  }

  async getWorkspace<TPayload>(
    user: ApiUser,
    workspaceId: string,
  ): Promise<AnnotationWorkspace<TPayload>> {
    const workspace = await this.loadWorkspace(workspaceId);
    const permission = await this.access.assertWorkspaceVisible(user, workspace);
    const projectPermission = await this.access.getEffectiveProjectPermission(
      user,
      workspace.projectId,
    );
    return toWorkspace<TPayload>(
      workspace,
      permission,
      projectPermission.capabilities,
    );
  }

  async saveWorkspace<TPayload>(
    user: ApiUser,
    workspaceId: string,
    input: SaveWorkspaceRequest<TPayload>,
  ): Promise<AnnotationWorkspace<TPayload>> {
    const workspace = await this.loadWorkspace(workspaceId);
    const permission = await this.access.resolveWorkspacePermission(user, workspace);
    if (!permission.canEdit) {
      throw forbidden("当前工作区不可编辑。");
    }
    const beforePayload = workspace.latestSnapshot?.payload ?? {};
    const authorization = authorizeProjectMutations(
      collectProjectMutations(beforePayload, input.payload),
      permission,
    );
    if (!authorization.allowed) {
      throw permissionScopeViolation(
        "保存内容超出了当前账号的时间或轨道授权范围。",
        {
          violations: authorization.violations.slice(0, 20),
          totalViolationCount: authorization.totalViolationCount,
        },
      );
    }

    await runSerializableTransaction(this.prisma, async (transaction) => {
      const current = await transaction.annotationWorkspace.findUnique({
        where: { id: workspaceId },
        include: { latestSnapshot: true },
      });
      if (!current) throw notFound("标注工作区不存在。");
      if (current.status !== "active") {
        throw conflict("工作区状态已改变，不能继续保存。");
      }
      const currentRevision = current.latestSnapshot?.revision ?? 0;
      if (currentRevision !== input.baseRevision) {
        throw conflict("服务器工作区已有更新，请刷新后再保存。", {
          expectedRevision: currentRevision,
          receivedRevision: input.baseRevision,
        });
      }
      const snapshot = await transaction.annotationSnapshot.create({
        data: {
          workspaceId,
          revision: currentRevision + 1,
          payload: toJsonPayload(input.payload),
          createdBy: user.id,
        },
      });
      await transaction.annotationWorkspace.update({
        where: { id: workspaceId },
        data: { latestSnapshotId: snapshot.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "workspace_save",
          actorUserId: user.id,
          projectId: current.projectId,
          workspaceId,
          targetType: "annotation_snapshot",
          targetId: snapshot.id,
          detail: toJsonPayload({ revision: snapshot.revision }),
        },
      });
    });
    return this.getWorkspace<TPayload>(user, workspaceId);
  }

  async updateWorkspaceStatus(
    user: ApiUser,
    workspaceId: string,
    input: UpdateWorkspaceStatusRequest,
  ): Promise<AnnotationWorkspaceSummary> {
    const workspace = await this.loadWorkspace(workspaceId);
    const permission = await this.access.resolveWorkspacePermission(user, workspace);
    assertStatusTransition(
      workspace.status,
      input.status,
      permission.isWorkspaceOwner,
      permission.canManage,
      permission.capabilities.includes("submit_version"),
    );
    const updated = await this.prisma.$transaction(async (transaction) => {
      const next = await transaction.annotationWorkspace.update({
        where: { id: workspaceId },
        data: {
          status: input.status as WorkspaceStatus,
          submittedAt: input.status === "submitted" ? new Date() : null,
          archivedAt: input.status === "archived" ? new Date() : null,
        },
        include: workspaceSummaryInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "workspace_status_update",
          actorUserId: user.id,
          projectId: workspace.projectId,
          workspaceId,
          targetType: "annotation_workspace",
          targetId: workspaceId,
          detail: toJsonPayload({
            previousStatus: workspace.status,
            nextStatus: input.status,
          }),
        },
      });
      return next;
    });
    return toWorkspaceSummary(
      updated,
      await this.access.resolveWorkspacePermission(user, updated),
    );
  }

  private async loadWorkspace(workspaceId: string) {
    const workspace = await this.prisma.annotationWorkspace.findUnique({
      where: { id: workspaceId },
      include: {
        ...workspaceSummaryInclude,
        project: {
          include: {
            mediaAsset: true,
            _count: { select: projectCountSelect },
          },
        },
      },
    });
    if (!workspace) throw notFound("标注工作区不存在。");
    if (!workspace.latestSnapshot) {
      throw conflict("标注工作区尚未建立初始快照。");
    }
    return workspace;
  }

  private async assertWorkspaceOwnerIsProjectMember(
    projectId: string,
    ownerUserId: string,
  ) {
    const project = await this.access.getProjectOrThrow(projectId);
    if (project.ownerUserId === ownerUserId) return;
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: ownerUserId } },
    });
    // 过期成员虽然仍保留在项目成员表中以便审计，但不能再成为新工作区 owner。
    if (!member || !isMemberActive(member)) {
      throw badRequest("工作区 owner 必须是当前有效项目成员。");
    }
  }
}

function assertStatusTransition(
  current: string,
  next: string,
  isWorkspaceOwner: boolean,
  canManage: boolean,
  canSubmit: boolean,
) {
  if (current === next) return;
  if (next === "submitted" && isWorkspaceOwner && canSubmit && current === "active") {
    return;
  }
  if (next === "archived" && (isWorkspaceOwner || canManage)) {
    return;
  }
  if (next === "active" && canManage && current !== "active") {
    return;
  }
  throw forbidden("当前账号不能执行该工作区状态转换。");
}
