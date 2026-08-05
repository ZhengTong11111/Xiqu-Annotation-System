import { PlatformRole, Prisma, type PrismaClient } from "@prisma/client";
import { hashPassword } from "./auth.js";

export type BootstrapAdministratorInput = {
  accountName: string;
  displayName: string;
  password: string;
};

export type BootstrapAdministratorResult = {
  id: string;
  accountName: string;
  displayName: string;
};

type BootstrapAdministratorRepository = {
  hasActiveAdministrator(): Promise<boolean>;
  accountExists(accountName: string): Promise<boolean>;
  createAdministrator(input: {
    accountName: string;
    displayName: string;
    passwordHash: string;
  }): Promise<BootstrapAdministratorResult>;
};

export type BootstrapAdministratorStore = {
  runExclusive<T>(
    operation: (repository: BootstrapAdministratorRepository) => Promise<T>,
  ): Promise<T>;
};

/**
 * 只为全新数据库创建首位系统管理员。
 * 一旦存在活跃 super_admin，该入口永久拒绝继续增权，后续账号治理必须走平台正式管理能力。
 */
export async function bootstrapInitialAdministrator(
  store: BootstrapAdministratorStore,
  rawInput: BootstrapAdministratorInput,
  passwordHasher: (password: string) => Promise<string> = hashPassword,
) {
  const input = validateBootstrapAdministratorInput(rawInput);
  return store.runExclusive(async (repository) => {
    if (await repository.hasActiveAdministrator()) {
      throw new Error("数据库已存在活跃管理员，bootstrap 已关闭。");
    }
    if (await repository.accountExists(input.accountName)) {
      throw new Error("账号名已存在，不能通过 bootstrap 提升既有账号权限。");
    }
    const passwordHash = await passwordHasher(input.password);
    return repository.createAdministrator({
      accountName: input.accountName,
      displayName: input.displayName,
      passwordHash,
    });
  });
}

// 首位管理员输入采用保守边界，避免命令行空白和不可见字符形成无法登录或难以审计的账号。
export function validateBootstrapAdministratorInput(
  input: BootstrapAdministratorInput,
): BootstrapAdministratorInput {
  const accountName = input.accountName.trim();
  const displayName = input.displayName.trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(accountName)) {
    throw new Error("管理员账号名需为 3-64 位字母、数字、点、下划线或连字符。");
  }
  if (!displayName || displayName.length > 80) {
    throw new Error("管理员显示名称需为 1-80 个字符。");
  }
  if (input.password.length < 12 || input.password.length > 256) {
    throw new Error("管理员密码需为 12-256 个字符。");
  }
  if (/\r|\n|\0/.test(input.password)) {
    throw new Error("管理员密码不能包含换行或空字符。");
  }
  return { accountName, displayName, password: input.password };
}

/**
 * PostgreSQL 适配器使用事务级 advisory lock 串行化首次管理员检查与创建。
 * 这条锁只服务 bootstrap，不占用业务表行，也不会在事务结束后遗留。
 */
export function createPrismaBootstrapAdministratorStore(
  prisma: PrismaClient,
): BootstrapAdministratorStore {
  return {
    runExclusive: (operation) => prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('xiqu-platform-bootstrap-admin'))
      `;
      return operation({
        hasActiveAdministrator: async () => Boolean(await transaction.userRole.findFirst({
          where: {
            role: PlatformRole.super_admin,
            user: { isActive: true },
          },
          select: { id: true },
        })),
        accountExists: async (accountName) => Boolean(await transaction.user.findUnique({
          where: { accountName },
          select: { id: true },
        })),
        createAdministrator: async (input) => transaction.user.create({
          data: {
            accountName: input.accountName,
            displayName: input.displayName,
            passwordHash: input.passwordHash,
            roles: { create: { role: PlatformRole.super_admin } },
          },
          select: { id: true, accountName: true, displayName: true },
        }),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
  };
}
