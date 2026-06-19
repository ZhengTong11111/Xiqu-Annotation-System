import { defineConfig } from "prisma/config";

const defaultDevelopmentDatabaseUrl =
  "postgresql://xiqu:xiqu_dev_password@localhost:54329/xiqu_platform?schema=public";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // 本地默认值与 docker-compose.yml 保持一致；服务器部署时必须用 DATABASE_URL 覆盖。
    url: process.env.DATABASE_URL ?? defaultDevelopmentDatabaseUrl,
  },
  migrations: {
    path: "prisma/migrations",
  },
});
