import type { PrismaClient, ProjectVersionStatus } from "@prisma/client";
import type {
  CreateProjectVersionRequest,
  ProjectVersion,
  UpdateProjectVersionStatusRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { conflict, forbidden, notFound } from "./errors.js";
import { ProjectAccessService } from "./projectAccess.js";
import {
  projectVersionInclude,
  toJsonPayload,
  toProjectVersion,
} from "./repositoryMappers.js";
import { runSerializableTransaction } from "./serializableTransaction.js";

export class ProjectVersionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ProjectAccessService,
  ) {}

  async listProjectVersions(
    user: ApiUser,
    projectId: string,
  ): Promise<ProjectVersion[]> {
    await this.access.assertProjectVisible(user, projectId);
    const versions = await this.prisma.projectVersion.findMany({
      where: { projectId },
      include: projectVersionInclude,
      orderBy: { sequence: "desc" },
    });
    return versions.map(toProjectVersion);
  }

  async createProjectVersion(
    user: ApiUser,
    projectId: string,
    input: CreateProjectVersionRequest,
  ): Promise<ProjectVersion> {
    await this.access.assertCapability(
      user,
      projectId,
      "create_project_version",
    );
    const created = await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
        // 来源版本的状态检查必须和候选版本创建处于同一串行事务。
        // 否则“归档来源版本”和“建立候选”并发时可能建立出来源已失效的候选版本。
        const source = await transaction.annotationVersion.findUnique({
          where: { id: input.sourceVersionId },
        });
        if (!source || source.projectId !== projectId) {
          throw notFound("来源标注版本不存在或不属于当前项目。");
        }
        if (source.status !== "active") {
          throw conflict("已归档标注版本不能建立项目候选版本。");
        }
        const latest = await transaction.projectVersion.findFirst({
          where: { projectId },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });
        const version = await transaction.projectVersion.create({
          data: {
            projectId,
            sourceVersionId: source.id,
            sequence: (latest?.sequence ?? 0) + 1,
            name: input.name.trim(),
            description: input.description ?? null,
            createdBy: user.id,
          },
          include: projectVersionInclude,
        });
        await transaction.auditLog.create({
          data: {
            action: "project_version_create",
            actorUserId: user.id,
            projectId,
            annotationVersionId: source.id,
            projectVersionId: version.id,
            targetType: "project_version",
            targetId: version.id,
            detail: toJsonPayload({
              sequence: version.sequence,
              sourceVersionId: source.id,
            }),
          },
        });
        return version;
      },
    );
    return toProjectVersion(created);
  }

  async publishProjectVersion(
    user: ApiUser,
    projectVersionId: string,
  ): Promise<ProjectVersion> {
    const target = await this.prisma.projectVersion.findUnique({
      where: { id: projectVersionId },
    });
    if (!target) throw notFound("项目版本不存在。");
    await this.access.assertCapability(
      user,
      target.projectId,
      "publish_project_version",
    );
    if (target.status !== "candidate") {
      throw conflict("只有候选项目版本可以发布。");
    }
    const published = await runSerializableTransaction(
      this.prisma,
      async (transaction) => {
      const currentTarget = await transaction.projectVersion.findUnique({
        where: { id: target.id },
      });
      if (!currentTarget || currentTarget.status !== "candidate") {
        throw conflict("该候选版本已被其他操作处理，请刷新后重试。");
      }
      const now = new Date();
      // 串行事务内先让旧发布版本退出 current，再更新项目指针。并发发布会
      // 发生串行化重试，因此数据库提交态始终只有一个 published 版本。
      await transaction.projectVersion.updateMany({
        where: {
          projectId: target.projectId,
          status: "published",
          id: { not: target.id },
        },
        data: { status: "superseded" },
      });
      const version = await transaction.projectVersion.update({
        where: { id: target.id },
        data: {
          status: "published",
          publishedBy: user.id,
          publishedAt: now,
        },
        include: projectVersionInclude,
      });
      await transaction.annotationProject.update({
        where: { id: target.projectId },
        data: { currentProjectVersionId: target.id },
      });
      await transaction.auditLog.create({
        data: {
          action: "project_version_publish",
          actorUserId: user.id,
          projectId: target.projectId,
          annotationVersionId: target.sourceVersionId,
          projectVersionId: target.id,
          targetType: "project_version",
          targetId: target.id,
          detail: toJsonPayload({ sequence: target.sequence }),
        },
      });
      return version;
      },
    );
    return toProjectVersion(published);
  }

  async updateProjectVersionStatus(
    user: ApiUser,
    projectVersionId: string,
    input: UpdateProjectVersionStatusRequest,
  ): Promise<ProjectVersion> {
    const target = await this.prisma.projectVersion.findUnique({
      where: { id: projectVersionId },
    });
    if (!target) throw notFound("项目版本不存在。");
    await this.access.assertCapability(
      user,
      target.projectId,
      "manage_all_versions",
    );
    if (target.status === "published") {
      throw forbidden("当前发布版本必须先由新版本取代，不能直接归档。");
    }
    if (input.status !== "archived") {
      throw conflict("项目版本只能归档；发布必须使用独立发布操作。");
    }
    const updated = await this.prisma.$transaction(async (transaction) => {
      const version = await transaction.projectVersion.update({
        where: { id: target.id },
        data: {
          status: input.status as ProjectVersionStatus,
          archivedAt: new Date(),
        },
        include: projectVersionInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "project_version_archive",
          actorUserId: user.id,
          projectId: target.projectId,
          annotationVersionId: target.sourceVersionId,
          projectVersionId: target.id,
          targetType: "project_version",
          targetId: target.id,
        },
      });
      return version;
    });
    return toProjectVersion(updated);
  }
}
