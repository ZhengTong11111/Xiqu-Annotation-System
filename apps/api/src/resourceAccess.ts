import type {
  Prisma,
  PrismaClient,
  ResourceCapability as DbResourceCapability,
} from "@prisma/client";
import {
  RESOURCE_CAPABILITIES,
  type EffectiveResourcePermission,
  type ResourceCapability,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { forbidden, notFound } from "./errors.js";

const ALL_CAPABILITIES = [...RESOURCE_CAPABILITIES];

export class ResourceAccessService {
  constructor(private readonly prisma: PrismaClient) {}

  isGlobalAdmin(user: ApiUser) {
    return user.roles.includes("super_admin") || user.roles.includes("admin");
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
    if (this.isGlobalAdmin(user)) {
      return this.fullPermission("admin", false);
    }
    if (resource.ownerUserId === user.id) {
      return this.fullPermission("owner", true);
    }

    const now = new Date();
    const capabilities = new Set<ResourceCapability>();
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
