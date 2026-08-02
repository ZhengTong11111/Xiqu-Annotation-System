import type { PrismaClient } from "@prisma/client";
import type { ApiUser } from "../domain.js";
import { toPublicUser } from "../repositoryMappers.js";
import type { ResourceAccessService } from "../resourceAccess.js";

// 运维 CLI 不依赖浏览器 session，而是要求数据库中存在且启用的全局管理员作为审计操作者。
export async function loadMaintenanceOperator(
  prisma: PrismaClient,
  access: ResourceAccessService,
  accountName: string,
): Promise<ApiUser> {
  const row = await prisma.user.findUnique({
    where: { accountName },
    include: { roles: true },
  });
  if (!row || !row.isActive) {
    throw new Error(`运维操作者“${accountName}”不存在或已停用。`);
  }
  const user = toPublicUser(row);
  if (!access.isGlobalAdmin(user)) {
    throw new Error(`运维操作者“${accountName}”不是全局管理员。`);
  }
  return user;
}
