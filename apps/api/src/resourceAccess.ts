import type {
  Prisma,
  PrismaClient,
  ResourceCapability as DbResourceCapability,
} from "@prisma/client";
import {
  getAutomaticResourceCapabilities,
  hasFullPlatformResourceAccess,
  RESOURCE_CAPABILITIES,
  type EffectiveResourcePermission,
  type ResourceCapability,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { forbidden, notFound } from "./errors.js";

const ALL_CAPABILITIES = [...RESOURCE_CAPABILITIES];

export class ResourceAccessService {
  constructor(private readonly prisma: PrismaClient) {}

  hasFullResourceAccess(user: ApiUser) {
    return hasFullPlatformResourceAccess(user.roles);
  }

  // 撤销他人审核记录需要真实管理权威；逐级 owner 与全局管理员都可管理其资源子树。
  async hasOwnerAuthority(
    user: ApiUser,
    resourceId: string,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ) {
    if (this.hasFullResourceAccess(user)) return true;
    let currentId: string | null = resourceId;
    while (currentId) {
      const resource: { ownerUserId: string; parentId: string | null } | null =
        await database.resourceEntry.findUnique({
          where: { id: currentId },
          select: { ownerUserId: true, parentId: true },
        });
      if (!resource) return false;
      if (resource.ownerUserId === user.id) return true;
      currentId = resource.parentId;
    }
    return false;
  }

  async getEffectivePermission(
    user: ApiUser,
    resourceId: string,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ): Promise<EffectiveResourcePermission> {
    const resource = await database.resourceEntry.findUnique({
      where: { id: resourceId },
      select: {
        id: true,
        name: true,
        ownerUserId: true,
        parentId: true,
        breakPermissionInheritance: true,
      },
    });
    if (!resource) throw notFound("资源不存在。");
    if (this.hasFullResourceAccess(user)) {
      return this.fullPermission("admin", false);
    }
    if (resource.ownerUserId === user.id) {
      return this.fullPermission("owner", true);
    }

    const now = new Date();
    // 角色自动能力只是 ACL 的只读基线；直接授权与继承授权仍可在此基础上显式增加能力。
    const roleCapabilities = getAutomaticResourceCapabilities(user.roles);
    const capabilities = new Set<ResourceCapability>(roleCapabilities);
    const inheritedFrom: EffectiveResourcePermission["inheritedFrom"] = [];
    const direct = await database.resourcePermission.findUnique({
      where: { resourceId_userId: { resourceId, userId: user.id } },
    });
    if (direct && (!direct.expiresAt || direct.expiresAt > now)) {
      direct.capabilities.forEach((capability) =>
        capabilities.add(capability as ResourceCapability));
    }

    // 当前节点选择“断开继承”时，只保留当前节点的直接授权。
    if (!resource.breakPermissionInheritance) {
      let parentId = resource.parentId;
      while (parentId) {
        const parent = await database.resourceEntry.findUnique({
          where: { id: parentId },
          select: {
            id: true,
            name: true,
            parentId: true,
            ownerUserId: true,
            breakPermissionInheritance: true,
            permissions: {
              where: {
                userId: user.id,
                inheritToChildren: true,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
            },
          },
        });
        if (!parent) break;
        const inheritedCapabilities = parent.ownerUserId === user.id
          ? ALL_CAPABILITIES
          : parent.permissions.flatMap((permission) =>
              permission.capabilities as ResourceCapability[]);
        if (inheritedCapabilities.length) {
          inheritedCapabilities.forEach((capability) =>
            capabilities.add(capability));
          inheritedFrom.push({
            resourceId: parent.id,
            resourceName: parent.name,
            capabilities: [...new Set(inheritedCapabilities)],
          });
        }
        if (parent.breakPermissionInheritance) break;
        parentId = parent.parentId;
      }
    }

    const values = ALL_CAPABILITIES.filter((capability) =>
      capabilities.has(capability));
    return {
      source: direct
        ? "direct"
        : inheritedFrom.length
          ? "inherited"
          : roleCapabilities.length
            ? "role"
            : "none",
      capabilities: values,
      inheritedFrom,
      isOwner: false,
      canManagePermissions: values.includes("manage_permissions"),
    };
  }

  async assertCapability(
    user: ApiUser,
    resourceId: string,
    capability: ResourceCapability,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ) {
    const permission = await this.getEffectivePermission(
      user,
      resourceId,
      database,
    );
    if (!permission.capabilities.includes(capability)) {
      throw forbidden(`当前账号缺少“${capability}”权限。`);
    }
    return permission;
  }

  toDatabaseCapabilities(capabilities: ResourceCapability[]) {
    return capabilities as DbResourceCapability[];
  }

  private fullPermission(
    source: "admin" | "owner",
    isOwner: boolean,
  ): EffectiveResourcePermission {
    return {
      source,
      capabilities: ALL_CAPABILITIES,
      inheritedFrom: [],
      isOwner,
      canManagePermissions: true,
    };
  }
}
