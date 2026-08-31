import {
  Prisma,
  type PrismaClient,
  type ResourceCapability as DbResourceCapability,
} from "@prisma/client";
import {
  getAutomaticResourceCapabilities,
  getProjectWorkflowGroupCapabilities,
  hasFullPlatformResourceAccess,
  RESOURCE_CAPABILITIES,
  type EffectiveResourcePermission,
  type ProjectWorkflowGroup,
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
    const effectiveUser = await this.resolveTransactionActor(user, database);
    if (this.hasFullResourceAccess(effectiveUser)) return true;
    let currentId: string | null = resourceId;
    while (currentId) {
      const resource: { ownerUserId: string; parentId: string | null } | null =
        await database.resourceEntry.findUnique({
          where: { id: currentId },
          select: { ownerUserId: true, parentId: true },
        });
      if (!resource) return false;
      if (resource.ownerUserId === effectiveUser.id) return true;
      currentId = resource.parentId;
    }
    return false;
  }

  async getEffectivePermission(
    user: ApiUser,
    resourceId: string,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ): Promise<EffectiveResourcePermission> {
    const permission = (await this.getEffectivePermissions(user, [resourceId], database)).get(resourceId);
    if (!permission) throw notFound("资源不存在。");
    return permission;
  }

  /**
   * 批量权限解析只执行一次祖先链查询和一次授权查询，供任务、搜索等有界列表复用。
   * 单资源入口也委托这里，确保 owner、角色、断继承和过期规则只有一份实现。
   */
  async getEffectivePermissions(
    user: ApiUser,
    resourceIds: readonly string[],
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, EffectiveResourcePermission>> {
    const uniqueIds = [...new Set(resourceIds)];
    if (!uniqueIds.length) return new Map();
    // 事务权限复核不能信任请求开始时的角色快照；资源树锁后必须读取当前活动状态与角色。
    const effectiveUser = await this.resolveTransactionActor(user, database);
    const chains = await database.$queryRaw<Array<{
      targetId: string;
      resourceId: string;
      depth: number;
    }>>(Prisma.sql`
      WITH RECURSIVE resource_chain AS (
        SELECT
          resource."id" AS "targetId",
          resource."id" AS "resourceId",
          resource."parent_id" AS "parentId",
          resource."break_permission_inheritance" AS "stopsInheritance",
          0 AS "depth",
          ARRAY[resource."id"]::text[] AS "path"
        FROM "resource_entries" AS resource
        WHERE resource."id" IN (${Prisma.join(uniqueIds)})
        UNION ALL
        SELECT
          chain."targetId",
          parent."id" AS "resourceId",
          parent."parent_id" AS "parentId",
          parent."break_permission_inheritance" AS "stopsInheritance",
          chain."depth" + 1,
          chain."path" || parent."id"
        FROM resource_chain AS chain
        INNER JOIN "resource_entries" AS parent ON parent."id" = chain."parentId"
        WHERE NOT chain."stopsInheritance"
          AND NOT parent."id" = ANY(chain."path")
          AND chain."depth" < 255
      )
      SELECT "targetId", "resourceId", "depth"
      FROM resource_chain
      ORDER BY "targetId" ASC, "depth" ASC
    `);
    const chainResourceIds = [...new Set(chains.map(({ resourceId }) => resourceId))];
    const now = new Date();
    const resources = await database.resourceEntry.findMany({
      where: { id: { in: chainResourceIds } },
      select: {
        id: true,
        name: true,
        ownerUserId: true,
      },
    });
    // adapter-pg 的事务客户端只有一个连接；ACL 关系必须作为第二条顺序查询读取，
    // 不能用 relation select 让 Prisma 在一个 transaction client 上并行展开。
    const permissionRows = await database.resourcePermission.findMany({
      where: {
        resourceId: { in: chainResourceIds },
        userId: effectiveUser.id,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        resourceId: true,
        capabilities: true,
        inheritToChildren: true,
      },
    });
    // 职责组本身就是独立授权来源；这里只读取当前账号在祖先项目中的成员关系，不改写手工 ACL。
    const workflowRows = await database.projectWorkflowMember.findMany({
      where: {
        projectResourceId: { in: chainResourceIds },
        userId: effectiveUser.id,
      },
      select: {
        projectResourceId: true,
        group: true,
      },
    });
    const permissionsByResourceId = new Map<string, typeof permissionRows>();
    for (const permission of permissionRows) {
      const rows = permissionsByResourceId.get(permission.resourceId) ?? [];
      rows.push(permission);
      permissionsByResourceId.set(permission.resourceId, rows);
    }
    const workflowGroupsByProjectId = new Map<string, ProjectWorkflowGroup[]>();
    for (const membership of workflowRows) {
      const groups = workflowGroupsByProjectId.get(membership.projectResourceId) ?? [];
      groups.push(membership.group as ProjectWorkflowGroup);
      workflowGroupsByProjectId.set(membership.projectResourceId, groups);
    }
    const resourceById = new Map(resources.map((resource) => [
      resource.id,
      {
        ...resource,
        permissions: permissionsByResourceId.get(resource.id) ?? [],
      },
    ]));
    const chainByTarget = new Map<string, typeof chains>();
    for (const row of chains) {
      const rows = chainByTarget.get(row.targetId) ?? [];
      rows.push(row);
      chainByTarget.set(row.targetId, rows);
    }

    const result = new Map<string, EffectiveResourcePermission>();
    for (const targetId of uniqueIds) {
      const targetChain = chainByTarget.get(targetId);
      const target = resourceById.get(targetId);
      if (!targetChain || !target) continue;
      if (this.hasFullResourceAccess(effectiveUser)) {
        result.set(targetId, this.fullPermission("admin", false));
        continue;
      }
      if (target.ownerUserId === effectiveUser.id) {
        result.set(targetId, this.fullPermission("owner", true));
        continue;
      }

      const roleCapabilities = getAutomaticResourceCapabilities(effectiveUser.roles);
      const capabilities = new Set<ResourceCapability>(roleCapabilities);
      const direct = target.permissions[0] ?? null;
      direct?.capabilities.forEach((capability) => capabilities.add(capability as ResourceCapability));
      const inheritedFrom: EffectiveResourcePermission["inheritedFrom"] = [];
      // 当前项目和未被断继承的祖先项目都可贡献职责权限；每个来源单独保留，便于 UI 解释撤销边界。
      for (const { resourceId } of targetChain) {
        const sourceProject = resourceById.get(resourceId);
        if (!sourceProject) continue;
        for (const group of workflowGroupsByProjectId.get(resourceId) ?? []) {
          const groupCapabilities = getProjectWorkflowGroupCapabilities(group);
          groupCapabilities.forEach((capability) => capabilities.add(capability));
          inheritedFrom.push({
            resourceId,
            resourceName: sourceProject.name,
            capabilities: groupCapabilities,
            responsibilityGroup: group,
          });
        }
      }
      for (const { resourceId, depth } of targetChain) {
        if (depth === 0) continue;
        const ancestor = resourceById.get(resourceId);
        if (!ancestor) continue;
        const inheritedCapabilities = ancestor.ownerUserId === effectiveUser.id
          ? ALL_CAPABILITIES
          : ancestor.permissions
              .filter(({ inheritToChildren }) => inheritToChildren)
              .flatMap(({ capabilities: values }) => values as ResourceCapability[]);
        if (!inheritedCapabilities.length) continue;
        inheritedCapabilities.forEach((capability) => capabilities.add(capability));
        inheritedFrom.push({
          resourceId: ancestor.id,
          resourceName: ancestor.name,
          capabilities: [...new Set(inheritedCapabilities)],
        });
      }
      const values = ALL_CAPABILITIES.filter((capability) => capabilities.has(capability));
      result.set(targetId, {
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
      });
    }
    return result;
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

  /** 在事务边界内使用当前角色复核平台级资源管理能力。 */
  async assertFullResourceAccess(
    user: ApiUser,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ) {
    const effectiveUser = await this.resolveTransactionActor(user, database);
    if (!this.hasFullResourceAccess(effectiveUser)) {
      throw forbidden("只有管理员可以执行该操作。");
    }
    return effectiveUser;
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

  /** 普通读取沿用认证快照；事务写入则重读当前账号状态与角色。 */
  private async resolveTransactionActor(
    user: ApiUser,
    database: PrismaClient | Prisma.TransactionClient,
  ): Promise<ApiUser> {
    if (database === this.prisma) return user;
    // 交互事务保持单连接顺序查询；账号停用或角色撤销一旦先提交，排队写事务必须立即失去权限。
    const account = await database.user.findUnique({
      where: { id: user.id },
      select: { isActive: true },
    });
    const roleRows = account?.isActive
      ? await database.userRole.findMany({
          where: { userId: user.id },
          select: { role: true },
        })
      : [];
    if (!account?.isActive) throw forbidden("当前账号已停用。");
    return {
      ...user,
      roles: roleRows.map(({ role }) => role as ApiUser["roles"][number]),
    };
  }
}
