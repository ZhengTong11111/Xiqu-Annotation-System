import {
  type Prisma,
  type PrismaClient,
  type ProjectMemberRole as DbProjectMemberRole,
} from "@prisma/client";
import { collectPersistedPermissionTrackIds } from "@xiqu/document-model";
import type {
  AddProjectMemberRequest,
  PermissionTrackOption,
  PlatformUser,
  ProjectCapability,
  ProjectMember,
  ProjectMemberRole,
  UpdateProjectMemberRequest,
} from "@xiqu/shared";
import { DEFAULT_PROJECT_ROLE_CAPABILITIES } from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import {
  ALL_PROJECT_CAPABILITIES,
  ProjectAccessService,
  toDbCapabilities,
} from "./projectAccess.js";
import { toJsonPayload, toPublicUser } from "./repositoryMappers.js";

const PROJECT_MEMBER_ROLES = new Set<ProjectMemberRole>([
  "manager",
  "reviewer",
  "annotator",
  "viewer",
]);

const memberInclude = {
  user: { include: { roles: true } },
} satisfies Prisma.ProjectMemberInclude;

type MemberWithUser = Prisma.ProjectMemberGetPayload<{
  include: typeof memberInclude;
}>;

export class ProjectMemberService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ProjectAccessService,
  ) {}

  async listDirectoryUsers(
    user: ApiUser,
    options: { projectId?: string; query?: string; limit: number },
  ): Promise<PlatformUser[]> {
    if (!this.access.isGlobalAdmin(user)) {
      if (!options.projectId) {
        throw forbidden("非管理员查询账号目录时必须指定可管理的项目。");
      }
      await this.access.assertCapability(user, options.projectId, "manage_members");
    }
    const query = options.query?.trim();
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        ...(query
          ? {
              OR: [
                { accountName: { contains: query, mode: "insensitive" } },
                { displayName: { contains: query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { roles: true },
      orderBy: [{ displayName: "asc" }, { accountName: "asc" }],
      take: options.limit,
    });
    return users.map(toPublicUser);
  }

  async listProjectMembers(
    user: ApiUser,
    projectId: string,
  ): Promise<ProjectMember[]> {
    await this.access.assertCapability(user, projectId, "manage_members");
    const project = await this.prisma.annotationProject.findUnique({
      where: { id: projectId },
      include: {
        owner: { include: { roles: true } },
        members: {
          include: memberInclude,
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!project) throw notFound("项目不存在。");

    const owner: ProjectMember = {
      id: `owner:${project.id}`,
      projectId: project.id,
      userId: project.owner.id,
      accountName: project.owner.accountName,
      displayName: project.owner.displayName,
      platformRoles: toPublicUser(project.owner).roles,
      role: "owner",
      capabilities: [...ALL_PROJECT_CAPABILITIES],
      timeRange: null,
      trackIds: [],
      expiresAt: null,
      isOwner: true,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
    return [owner, ...project.members.map(toProjectMember)];
  }

  async addProjectMember(
    user: ApiUser,
    projectId: string,
    input: AddProjectMemberRequest,
  ): Promise<ProjectMember> {
    await this.access.assertCapability(user, projectId, "manage_members");
    const project = await this.access.getProjectOrThrow(projectId);
    if (project.ownerUserId === input.userId) {
      throw conflict("项目所有者已经拥有完整权限。");
    }
    const targetUser = await this.prisma.user.findUnique({
      where: { id: input.userId },
      include: { roles: true },
    });
    if (!targetUser?.isActive) throw notFound("目标账号不存在或已停用。");
    if (await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: input.userId } },
    })) {
      throw conflict("该账号已经是项目成员，请直接修改现有权限。");
    }
    const normalized = await this.normalizeMember(projectId, input);
    const member = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.projectMember.create({
        data: {
          projectId,
          userId: input.userId,
          role: normalized.role as DbProjectMemberRole,
          capabilities: toDbCapabilities(normalized.capabilities),
          allowedStartTime: normalized.timeRange?.startTime ?? null,
          allowedEndTime: normalized.timeRange?.endTime ?? null,
          allowedTrackIds: normalized.trackIds,
          expiresAt: normalized.expiresAt,
        },
        include: memberInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "project_member_add",
          actorUserId: user.id,
          projectId,
          targetType: "project_member",
          targetId: created.id,
          detail: toJsonPayload({
            targetUserId: input.userId,
            role: normalized.role,
            capabilities: normalized.capabilities,
            timeRange: normalized.timeRange,
            trackIds: normalized.trackIds,
          }),
        },
      });
      return created;
    });
    return toProjectMember(member);
  }

  async updateProjectMember(
    user: ApiUser,
    projectId: string,
    memberId: string,
    input: UpdateProjectMemberRequest,
  ): Promise<ProjectMember> {
    await this.access.assertCapability(user, projectId, "manage_members");
    const existing = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });
    if (!existing) throw notFound("项目成员不存在。");
    const normalized = await this.normalizeMember(projectId, {
      userId: existing.userId,
      role: input.role ?? existing.role as ProjectMemberRole,
      capabilities: input.capabilities ??
        existing.capabilities as ProjectCapability[],
      scope: {
        timeRange: input.scope?.timeRange === undefined
          ? existing.allowedStartTime !== null &&
              existing.allowedEndTime !== null
            ? {
                startTime: existing.allowedStartTime,
                endTime: existing.allowedEndTime,
              }
            : null
          : input.scope.timeRange,
        trackScope: input.scope?.trackScope === undefined
          ? existing.allowedTrackIds.length
            ? { trackIds: existing.allowedTrackIds }
            : null
          : input.scope.trackScope,
      },
      expiresAt: input.expiresAt === undefined
        ? existing.expiresAt?.toISOString() ?? null
        : input.expiresAt,
    });

    const member = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.projectMember.update({
        where: { id: existing.id },
        data: {
          role: normalized.role as DbProjectMemberRole,
          capabilities: toDbCapabilities(normalized.capabilities),
          allowedStartTime: normalized.timeRange?.startTime ?? null,
          allowedEndTime: normalized.timeRange?.endTime ?? null,
          allowedTrackIds: normalized.trackIds,
          expiresAt: normalized.expiresAt,
        },
        include: memberInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "project_member_update",
          actorUserId: user.id,
          projectId,
          targetType: "project_member",
          targetId: updated.id,
          detail: toJsonPayload({
            targetUserId: updated.userId,
            role: normalized.role,
            capabilities: normalized.capabilities,
            timeRange: normalized.timeRange,
            trackIds: normalized.trackIds,
          }),
        },
      });
      return updated;
    });
    return toProjectMember(member);
  }

  async removeProjectMember(
    user: ApiUser,
    projectId: string,
    memberId: string,
  ) {
    await this.access.assertCapability(user, projectId, "manage_members");
    const existing = await this.prisma.projectMember.findFirst({
      where: { id: memberId, projectId },
    });
    if (!existing) throw notFound("项目成员不存在。");
    await this.prisma.$transaction(async (transaction) => {
      // 历史版本必须保留；只冻结该成员仍在编辑的工作区，阻止离开项目后继续写入。
      await transaction.annotationWorkspace.updateMany({
        where: {
          projectId,
          ownerUserId: existing.userId,
          status: "active",
        },
        data: {
          status: "archived",
          archivedAt: new Date(),
        },
      });
      await transaction.projectMember.delete({ where: { id: existing.id } });
      await transaction.auditLog.create({
        data: {
          action: "project_member_remove",
          actorUserId: user.id,
          projectId,
          targetType: "project_member",
          targetId: existing.id,
          detail: toJsonPayload({ targetUserId: existing.userId }),
        },
      });
    });
  }

  async listPermissionTracks(
    user: ApiUser,
    projectId: string,
  ): Promise<PermissionTrackOption[]> {
    await this.access.assertCapability(user, projectId, "manage_members");
    const workspaces = await this.prisma.annotationWorkspace.findMany({
      where: { projectId },
      include: { latestSnapshot: true },
    });
    const ids = new Set<string>();
    const labels = new Map<string, string>([
      ["character-track", "逐字文字轨"],
      ["banyan", "板眼轨"],
    ]);
    for (const workspace of workspaces) {
      const payload = workspace.latestSnapshot?.payload;
      for (const id of collectPersistedPermissionTrackIds(payload)) ids.add(id);
      collectTrackLabels(payload, labels);
    }
    return [...ids].sort().map((id) => ({
      id,
      label: labels.get(id) ?? id,
      kind: id.includes("#branch:")
        ? "branch"
        : id.includes("#point:")
          ? "attached-point"
          : id === "character-track"
            ? "builtin"
            : id === "banyan"
              ? "derived"
              : "custom",
    }));
  }

  private async normalizeMember(
    projectId: string,
    input: AddProjectMemberRequest,
  ) {
    if (!PROJECT_MEMBER_ROLES.has(input.role)) {
      throw badRequest("项目角色无效。");
    }
    const capabilities = [...new Set(
      input.capabilities ?? DEFAULT_PROJECT_ROLE_CAPABILITIES[input.role],
    )];
    if (!capabilities.includes("view_project")) {
      throw badRequest("项目成员至少需要 view_project 能力。");
    }
    if (
      capabilities.some((capability) =>
        !ALL_PROJECT_CAPABILITIES.includes(capability))
    ) {
      throw badRequest("项目能力列表包含未知值。");
    }
    const timeRange = input.scope?.timeRange ?? undefined;
    if (
      timeRange &&
      (!Number.isFinite(timeRange.startTime) ||
        !Number.isFinite(timeRange.endTime) ||
        timeRange.startTime < 0 ||
        timeRange.endTime <= timeRange.startTime)
    ) {
      throw badRequest("项目成员时间范围无效。");
    }
    const trackIds = [...new Set(input.scope?.trackScope?.trackIds ?? [])];
    if (
      capabilities.includes("manage_members") &&
      (timeRange || trackIds.length)
    ) {
      throw badRequest("管理项目成员的账号不能设置局部时间或轨道范围。");
    }
    if (trackIds.length) {
      const knownTrackIds = new Set(
        (await this.listPermissionTracksForValidation(projectId)).map(
          (track) => track.id,
        ),
      );
      if (trackIds.some((trackId) => !knownTrackIds.has(trackId))) {
        throw badRequest("项目成员轨道范围包含项目中不存在的轨道。");
      }
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && !Number.isFinite(expiresAt.getTime())) {
      throw badRequest("权限有效期不是合法日期。");
    }
    return {
      role: input.role,
      capabilities,
      timeRange,
      trackIds,
      expiresAt,
    };
  }

  private async listPermissionTracksForValidation(projectId: string) {
    const workspaces = await this.prisma.annotationWorkspace.findMany({
      where: { projectId },
      include: { latestSnapshot: true },
    });
    const ids = new Set<string>();
    for (const workspace of workspaces) {
      for (const id of collectPersistedPermissionTrackIds(
        workspace.latestSnapshot?.payload,
      )) {
        ids.add(id);
      }
    }
    return [...ids].map((id) => ({ id }));
  }
}

function toProjectMember(member: MemberWithUser): ProjectMember {
  return {
    id: member.id,
    projectId: member.projectId,
    userId: member.userId,
    accountName: member.user.accountName,
    displayName: member.user.displayName,
    platformRoles: member.user.roles.map((entry) =>
      entry.role) as ProjectMember["platformRoles"],
    role: member.role as ProjectMemberRole,
    capabilities: member.capabilities as ProjectCapability[],
    timeRange: member.allowedStartTime !== null &&
        member.allowedEndTime !== null
      ? {
          startTime: member.allowedStartTime,
          endTime: member.allowedEndTime,
        }
      : null,
    trackIds: member.allowedTrackIds,
    expiresAt: member.expiresAt?.toISOString() ?? null,
    isOwner: false,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
}

function collectTrackLabels(
  payload: unknown,
  labels: Map<string, string>,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const customTracks = (payload as Record<string, unknown>).customTracks;
  if (!Array.isArray(customTracks)) return;
  for (const track of customTracks) {
    if (!track || typeof track !== "object" || Array.isArray(track)) continue;
    const record = track as Record<string, unknown>;
    if (typeof record.id === "string") {
      labels.set(
        record.id,
        typeof record.name === "string" ? record.name : record.id,
      );
    }
  }
}
