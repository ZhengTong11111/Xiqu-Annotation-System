import type {
  PrismaClient,
  ProjectCapability as DbProjectCapability,
  ProjectMember,
} from "@prisma/client";
import type {
  EffectiveProjectPermission,
  EffectiveWorkspacePermission,
  ProjectCapability,
} from "@xiqu/shared";
import { PROJECT_CAPABILITIES } from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { forbidden, notFound } from "./errors.js";

const GLOBAL_ADMIN_ROLES = new Set(["super_admin", "admin"]);

export const ALL_PROJECT_CAPABILITIES: ProjectCapability[] = [
  ...PROJECT_CAPABILITIES,
];

export class ProjectAccessService {
  constructor(private readonly prisma: PrismaClient) {}

  isGlobalAdmin(user: ApiUser) {
    return user.roles.some((role) => GLOBAL_ADMIN_ROLES.has(role));
  }

  async getProjectOrThrow(projectId: string) {
    const project = await this.prisma.annotationProject.findUnique({
      where: { id: projectId },
    });
    if (!project) throw notFound("项目不存在。");
    return project;
  }

  async getEffectiveProjectPermission(
    user: ApiUser,
    projectId: string,
  ): Promise<EffectiveProjectPermission> {
    const project = await this.getProjectOrThrow(projectId);
    if (this.isGlobalAdmin(user) || project.ownerUserId === user.id) {
      return {
        source: this.isGlobalAdmin(user) ? "admin" : "owner",
        capabilities: ALL_PROJECT_CAPABILITIES,
        timeRange: null,
        trackIds: [],
        expiresAt: null,
      };
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (!member || !isMemberActive(member)) {
      return {
        source: "none",
        capabilities: [],
        timeRange: null,
        trackIds: [],
        expiresAt: member?.expiresAt?.toISOString() ?? null,
      };
    }
    return {
      source: "membership",
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
    };
  }

  async assertCapability(
    user: ApiUser,
    projectId: string,
    capability: ProjectCapability,
  ) {
    const permission = await this.getEffectiveProjectPermission(user, projectId);
    if (!permission.capabilities.includes(capability)) {
      throw forbidden("当前账号没有执行此项目操作的权限。");
    }
    return permission;
  }

  async assertProjectVisible(user: ApiUser, projectId: string) {
    return this.assertCapability(user, projectId, "view_project");
  }

  async resolveWorkspacePermission(
    user: ApiUser,
    workspace: {
      projectId: string;
      ownerUserId: string;
      status: string;
    },
  ): Promise<EffectiveWorkspacePermission> {
    const projectPermission = await this.getEffectiveProjectPermission(
      user,
      workspace.projectId,
    );
    const isWorkspaceOwner = workspace.ownerUserId === user.id;
    const canView = projectPermission.capabilities.includes("view_project");
    const canManage = projectPermission.capabilities.includes("manage_all_versions");
    // 个人工作区只允许 owner 编辑；管理者可审查和归档，但不能静默改写他人的成果。
    const canEdit = canView &&
      workspace.status === "active" &&
      isWorkspaceOwner &&
      projectPermission.capabilities.includes("create_workspace");
    return {
      ...projectPermission,
      canView,
      canEdit,
      canManage,
      isWorkspaceOwner,
    };
  }

  async assertWorkspaceVisible(
    user: ApiUser,
    workspace: {
      projectId: string;
      ownerUserId: string;
      status: string;
    },
  ) {
    const permission = await this.resolveWorkspacePermission(user, workspace);
    if (!permission.canView) {
      throw forbidden("当前账号不能查看该标注工作区。");
    }
    return permission;
  }
}

export function isMemberActive(
  member: Pick<ProjectMember, "expiresAt">,
  now = new Date(),
) {
  return member.expiresAt === null || member.expiresAt > now;
}

export function toDbCapabilities(
  capabilities: ProjectCapability[],
): DbProjectCapability[] {
  return capabilities as DbProjectCapability[];
}
