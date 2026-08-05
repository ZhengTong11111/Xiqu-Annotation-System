#!/usr/bin/env node

import { createPrismaConnection } from "./database.js";
import {
  bootstrapInitialAdministrator,
  createPrismaBootstrapAdministratorStore,
} from "./bootstrapAdmin.js";
import {
  parseBootstrapAdminArguments,
  readBootstrapPasswordFromStdin,
} from "./bootstrapAdminArguments.js";

try {
  // bootstrap 强制显式数据库 URL，绝不使用开发默认库，避免把首管理员建到错误实例。
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("admin:bootstrap 必须显式设置 DATABASE_URL。");
  const options = parseBootstrapAdminArguments(process.argv.slice(2));
  const password = await readBootstrapPasswordFromStdin(process.stdin);
  const connection = createPrismaConnection(databaseUrl);
  try {
    const administrator = await bootstrapInitialAdministrator(
      createPrismaBootstrapAdministratorStore(connection.prisma),
      { ...options, password },
    );
    console.log(`首位系统管理员已创建：${administrator.accountName}（${administrator.displayName}）`);
  } finally {
    await connection.prisma.$disconnect();
    await connection.pool.end();
    await connection.maintenancePool.end();
    await connection.collaborationPool.end();
  }
} catch (error) {
  // 错误只报告稳定诊断，不回显数据库连接或 stdin 密码。
  const message = error instanceof Error ? error.message : String(error);
  console.error(`创建首位管理员失败：${message}`);
  process.exitCode = 1;
}
