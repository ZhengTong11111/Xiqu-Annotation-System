import { PlatformRole as DbPlatformRole, type PrismaClient } from "@prisma/client";
import {
  canManagePlatformAccounts,
  type CreateManagedAccountRequest,
  type ListManagedAccountsOptions,
  type ManagedAccount,
  type ManagedAccountPage,
  type PlatformRole,
  type UpdateManagedAccountRequest,
} from "@xiqu/shared";
import { hashPassword, verifyPassword } from "./auth.js";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";

const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const ALL_ROLES = new Set<PlatformRole>([
  "super_admin",
  "admin",
  "teacher",
  "annotator",
  "reviewer",
  "service",
]);
const ACCOUNT_MANAGEMENT_ROLES = new Set<PlatformRole>(["super_admin"]);

export class AccountAdminService {
  constructor(private readonly prisma: PrismaClient) {}

  async listAccounts(
    actor: ApiUser,
    options: ListManagedAccountsOptions,
  ): Promise<ManagedAccountPage> {
    this.assertAccountAdministrator(actor);
    const limit = normalizeLimit(options.limit);
    const query = options.query?.trim();
    if (options.cursor) {
      // 只把确实不存在的游标归类为输入错误；连接或数据库异常必须保留原始错误供监控定位。
      const cursorExists = await this.prisma.user.count({ where: { id: options.cursor } });
      if (cursorExists === 0) throw badRequest("账号分页位置已经失效，请刷新列表。");
    }
    const rows = await this.prisma.user.findMany({
      where: {
        ...(query
          ? {
              OR: [
                { accountName: { contains: query, mode: "insensitive" as const } },
                { displayName: { contains: query, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      include: { roles: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      take: limit + 1,
    });
    const visible = rows.slice(0, limit);
    return {
      items: visible.map(mapManagedAccount),
      nextCursor: rows.length > limit ? visible.at(-1)?.id ?? null : null,
    };
  }

  async createAccount(
    actor: ApiUser,
    input: CreateManagedAccountRequest,
  ): Promise<ManagedAccount> {
    this.assertAccountAdministrator(actor);
    const accountName = normalizeAccountName(input.accountName);
    const displayName = normalizeDisplayName(input.displayName);
    const roles = normalizeRoles(input.roles);
    assertPassword(input.password);
    const passwordHash = await hashPassword(input.password);
    try {
      const row = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.user.create({
          data: {
            accountName,
            displayName,
            passwordHash,
            roles: {
              create: roles.map((role) => ({ role: role as DbPlatformRole })),
            },
          },
          include: { roles: true },
        });
        await transaction.auditLog.create({
          data: {
            action: "account_create",
            actorUserId: actor.id,
            targetUserId: created.id,
            detail: { roles },
          },
        });
        return created;
      });
      return mapManagedAccount(row);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw conflict("账号名已经存在。");
      throw error;
    }
  }

  async updateAccount(
    actor: ApiUser,
    targetUserId: string,
    input: UpdateManagedAccountRequest,
  ): Promise<ManagedAccount> {
    this.assertAccountAdministrator(actor);
    if (Object.keys(input).length === 0) throw badRequest("至少需要修改一项账号信息。");
    const displayName = input.displayName === undefined
      ? undefined
      : normalizeDisplayName(input.displayName);
    const roles = input.roles === undefined ? undefined : normalizeRoles(input.roles);

    const row = await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.user.findUnique({
        where: { id: targetUserId },
        include: { roles: true },
      });
      if (!current) throw notFound("账号不存在。");
      const currentRoles = current.roles.map(({ role }) => role as PlatformRole);
      const nextRoles = roles ?? currentRoles;
      const nextActive = input.isActive ?? current.isActive;
      if (targetUserId === actor.id && (!nextActive || !hasGlobalAdminRole(nextRoles))) {
        throw conflict("不能停用当前账号或移除当前账号的系统管理员角色。");
      }
      if (
        current.isActive && hasGlobalAdminRole(currentRoles) &&
        (!nextActive || !hasGlobalAdminRole(nextRoles))
      ) {
        const otherActiveAdmins = await transaction.user.count({
          where: {
            id: { not: targetUserId },
            isActive: true,
            roles: { some: { role: DbPlatformRole.super_admin } },
          },
        });
        if (otherActiveAdmins === 0) throw conflict("平台必须至少保留一个活动系统管理员账号。");
      }

      if (roles) {
        await transaction.userRole.deleteMany({ where: { userId: targetUserId } });
        await transaction.userRole.createMany({
          data: roles.map((role) => ({ userId: targetUserId, role: role as DbPlatformRole })),
        });
      }
      const updated = await transaction.user.update({
        where: { id: targetUserId },
        data: {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
        include: { roles: true },
      });
      if (input.isActive === false) {
        // 停用必须立刻撤销既有登录，不等待 session 自然过期。
        await transaction.session.deleteMany({ where: { userId: targetUserId } });
      }
      await transaction.auditLog.create({
        data: {
          action: "account_update",
          actorUserId: actor.id,
          targetUserId,
          detail: {
            ...(roles ? { roles } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(displayName !== undefined ? { displayNameChanged: true } : {}),
          },
        },
      });
      return updated;
    });
    return mapManagedAccount(row);
  }

  async resetPassword(actor: ApiUser, targetUserId: string, password: string) {
    this.assertAccountAdministrator(actor);
    assertPassword(password);
    const passwordHash = await hashPassword(password);
    await this.prisma.$transaction(async (transaction) => {
      const target = await transaction.user.findUnique({ where: { id: targetUserId } });
      if (!target) throw notFound("账号不存在。");
      await transaction.user.update({ where: { id: targetUserId }, data: { passwordHash } });
      await transaction.session.deleteMany({ where: { userId: targetUserId } });
      await transaction.auditLog.create({
        data: {
          action: "account_password_reset",
          actorUserId: actor.id,
          targetUserId,
        },
      });
    });
  }

  async changeOwnPassword(actor: ApiUser, currentPassword: string, newPassword: string) {
    assertPassword(newPassword);
    const account = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!account || !await verifyPassword(currentPassword, account.passwordHash)) {
      throw forbidden("当前密码不正确。");
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.user.update({ where: { id: actor.id }, data: { passwordHash } });
      await transaction.session.deleteMany({ where: { userId: actor.id } });
      await transaction.auditLog.create({
        data: {
          action: "account_password_change",
          actorUserId: actor.id,
          targetUserId: actor.id,
        },
      });
    });
  }

  private assertAccountAdministrator(actor: ApiUser) {
    if (!canManagePlatformAccounts(actor.roles)) {
      throw forbidden("只有系统管理员可以管理账号。");
    }
  }
}

function mapManagedAccount(user: {
  id: string;
  accountName: string;
  displayName: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  roles: Array<{ role: string }>;
}): ManagedAccount {
  return {
    id: user.id,
    accountName: user.accountName,
    displayName: user.displayName,
    roles: user.roles.map(({ role }) => role as PlatformRole),
    isActive: user.isActive,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function normalizeAccountName(value: string) {
  const normalized = value.trim();
  if (!ACCOUNT_NAME_PATTERN.test(normalized)) {
    throw badRequest("账号名需为 3-64 位字母、数字、点、下划线或连字符，并以字母或数字开头。");
  }
  return normalized;
}

function normalizeDisplayName(value: string) {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80) throw badRequest("显示名称需为 1-80 个字符。");
  return normalized;
}

function normalizeRoles(value: PlatformRole[]) {
  if (!Array.isArray(value) || value.length === 0 || value.some((role) => !ALL_ROLES.has(role))) {
    throw badRequest("账号至少需要一个有效角色。");
  }
  return [...new Set(value)];
}

function assertPassword(password: string) {
  if (typeof password !== "string" || password.length < 10 || password.length > 200) {
    throw badRequest("密码长度需为 10-200 个字符。");
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw badRequest("密码必须同时包含字母和数字。");
  }
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) throw badRequest("账号分页数量需为 1-200。");
  return value;
}

function hasGlobalAdminRole(roles: PlatformRole[]) {
  return roles.some((role) => ACCOUNT_MANAGEMENT_ROLES.has(role));
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
