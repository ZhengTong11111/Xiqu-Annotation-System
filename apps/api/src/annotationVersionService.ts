import type {
  AnnotationVersionKind,
  AnnotationVersionStatus,
  PrismaClient,
} from "@prisma/client";
import type {
  AnnotationVersion,
  AnnotationVersionSummary,
  AnnotationWorkspace,
  CompleteAnnotationVersionRequest,
  ForkAnnotationVersionRequest,
  UpdateAnnotationVersionStatusRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { conflict, forbidden, notFound } from "./errors.js";
import { ProjectAccessService } from "./projectAccess.js";
import {
  annotationVersionInclude,
  toAnnotationVersion,
  toAnnotationVersionSummary,
  toJsonPayload,
} from "./repositoryMappers.js";
import { AnnotationWorkspaceService } from "./annotationWorkspaceService.js";
import { runSerializableTransaction } from "./serializableTransaction.js";

export class AnnotationVersionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ProjectAccessService,
    private readonly workspaces: AnnotationWorkspaceService,
  ) {}

  async listProjectVersions(
    user: ApiUser,
    projectId: string,
    filters: { createdBy?: string; workspaceId?: string } = {},
  ): Promise<AnnotationVersionSummary[]> {
    await this.access.assertProjectVisible(user, projectId);
    const versions = await this.prisma.annotationVersion.findMany({
      where: {
        projectId,
        createdBy: filters.createdBy,
        workspaceId: filters.workspaceId,
      },
      include: {
        snapshot: true,
        creator: true,
      },
      orderBy: { completedAt: "desc" },
    });
    return versions.map(toAnnotationVersionSummary);
  }

  async listWorkspaceVersions(
    user: ApiUser,
    workspaceId: string,
  ): Promise<AnnotationVersionSummary[]> {
    await this.workspaces.getWorkspace(user, workspaceId);
    const versions = await this.prisma.annotationVersion.findMany({
      where: { workspaceId },
      include: { snapshot: true, creator: true },
      orderBy: { completedAt: "desc" },
    });
    return versions.map(toAnnotationVersionSummary);
  }

  async completeVersion<TPayload>(
    user: ApiUser,
    workspaceId: string,
    input: CompleteAnnotationVersionRequest,
  ): Promise<AnnotationVersion<TPayload>> {
    const workspace = await this.prisma.annotationWorkspace.findUnique({
      where: { id: workspaceId },
      include: { latestSnapshot: true },
    });
    if (!workspace) throw notFound("标注工作区不存在。");
    if (!workspace.latestSnapshot) throw conflict("工作区尚未保存任何快照。");
    const permission = await this.access.resolveWorkspacePermission(user, workspace);
    if (
      !permission.isWorkspaceOwner ||
      !permission.capabilities.includes("complete_version")
    ) {
      throw forbidden("只有工作区 owner 可以完成自己的标注版本。");
    }
    if (workspace.status === "archived") {
      throw conflict("已归档工作区不能创建新版本。");
    }
    const version = await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
      // 完成版本必须固定到事务开始时真正的 latest snapshot。若保存与完成并发，
      // 串行化重试会重新读取 revision，避免版本悄悄引用旧快照。
      const currentWorkspace = await transaction.annotationWorkspace.findUnique({
        where: { id: workspaceId },
        include: { latestSnapshot: true },
      });
      if (!currentWorkspace?.latestSnapshot) {
        throw conflict("工作区尚未保存任何快照。");
      }
      if (currentWorkspace.status === "archived") {
        throw conflict("已归档工作区不能创建新版本。");
      }
      const parent = await transaction.annotationVersion.findFirst({
        where: { workspaceId },
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      const created = await transaction.annotationVersion.create({
        data: {
          projectId: currentWorkspace.projectId,
          workspaceId,
          snapshotId: currentWorkspace.latestSnapshotId!,
          parentVersionId: parent?.id ??
            currentWorkspace.forkedFromVersionId,
          name: input.name.trim(),
          description: input.description ?? null,
          kind: (input.kind ?? "checkpoint") as AnnotationVersionKind,
          createdBy: user.id,
        },
        include: annotationVersionInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_version_create",
          actorUserId: user.id,
          projectId: currentWorkspace.projectId,
          workspaceId,
          annotationVersionId: created.id,
          targetType: "annotation_version",
          targetId: created.id,
          detail: toJsonPayload({
            name: created.name,
            kind: created.kind,
            revision: created.snapshot.revision,
          }),
        },
      });
      return created;
      },
    );
    return toAnnotationVersion<TPayload>(version);
  }

  async forkVersion<TPayload>(
    user: ApiUser,
    versionId: string,
    input: ForkAnnotationVersionRequest,
  ): Promise<AnnotationWorkspace<TPayload>> {
    const source = await this.prisma.annotationVersion.findUnique({
      where: { id: versionId },
      include: { snapshot: true },
    });
    if (!source) throw notFound("源标注版本不存在。");
    await this.access.assertCapability(user, source.projectId, "fork_version");

    const workspaceId = await this.prisma.$transaction(async (transaction) => {
      // Fork 必须复制固定 version 的 snapshot，而不是读取源工作区后续 latest snapshot。
      const workspace = await transaction.annotationWorkspace.create({
        data: {
          projectId: source.projectId,
          name: input.workspaceName.trim(),
          workspaceType: "personal",
          ownerUserId: user.id,
          createdBy: user.id,
          forkedFromVersionId: source.id,
        },
      });
      const snapshot = await transaction.annotationSnapshot.create({
        data: {
          workspaceId: workspace.id,
          revision: 1,
          payload: toJsonPayload(source.snapshot.payload),
          createdBy: user.id,
        },
      });
      await transaction.annotationWorkspace.update({
        where: { id: workspace.id },
        data: { latestSnapshotId: snapshot.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_version_fork",
          actorUserId: user.id,
          projectId: source.projectId,
          workspaceId: workspace.id,
          annotationVersionId: source.id,
          targetType: "annotation_workspace",
          targetId: workspace.id,
          detail: toJsonPayload({
            sourceVersionId: source.id,
            sourceSnapshotId: source.snapshotId,
          }),
        },
      });
      return workspace.id;
    });
    return this.workspaces.getWorkspace<TPayload>(user, workspaceId);
  }

  async updateVersionStatus(
    user: ApiUser,
    versionId: string,
    input: UpdateAnnotationVersionStatusRequest,
  ): Promise<AnnotationVersionSummary> {
    const version = await this.prisma.annotationVersion.findUnique({
      where: { id: versionId },
      include: { snapshot: true, creator: true },
    });
    if (!version) throw notFound("标注版本不存在。");
    const permission = await this.access.getEffectiveProjectPermission(
      user,
      version.projectId,
    );
    if (
      version.createdBy !== user.id &&
      !permission.capabilities.includes("manage_all_versions")
    ) {
      throw forbidden("当前账号不能归档该标注版本。");
    }
    if (input.status !== "archived") {
      throw conflict("已完成版本只能归档，不能重新激活或改写。");
    }
    const updated = await this.prisma.$transaction(async (transaction) => {
      const row = await transaction.annotationVersion.update({
        where: { id: versionId },
        data: {
          status: input.status as AnnotationVersionStatus,
          archivedAt: new Date(),
        },
        include: { snapshot: true, creator: true },
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_version_archive",
          actorUserId: user.id,
          projectId: version.projectId,
          workspaceId: version.workspaceId,
          annotationVersionId: version.id,
          targetType: "annotation_version",
          targetId: version.id,
        },
      });
      return row;
    });
    return toAnnotationVersionSummary(updated);
  }
}
