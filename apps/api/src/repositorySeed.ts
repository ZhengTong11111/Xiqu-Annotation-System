import {
  PlatformRole as DbPlatformRole,
  type PrismaClient,
  ResourceCapability as DbResourceCapability,
} from "@prisma/client";
import { hashPassword } from "./auth.js";
import type { ApiRole } from "./domain.js";

const seedUsers: Array<{
  id: string;
  accountName: string;
  displayName: string;
  password: string;
  roles: ApiRole[];
}> = [
  {
    id: "user-admin",
    accountName: "admin",
    displayName: "系统管理员",
    password: "admin123",
    roles: ["super_admin"],
  },
  {
    id: "user-ta",
    accountName: "ta",
    displayName: "教师账号",
    password: "ta123",
    roles: ["teacher"],
  },
  {
    id: "user-student",
    accountName: "student",
    displayName: "学生账号",
    password: "student123",
    roles: ["annotator"],
  },
];

export async function ensurePlatformSeedData(prisma: PrismaClient) {
  for (const seedUser of seedUsers) {
    const passwordHash = await hashPassword(seedUser.password);
    await prisma.user.upsert({
      where: { accountName: seedUser.accountName },
      update: { displayName: seedUser.displayName, isActive: true },
      create: {
        id: seedUser.id,
        accountName: seedUser.accountName,
        displayName: seedUser.displayName,
        passwordHash,
      },
    });
    for (const role of seedUser.roles) {
      await prisma.userRole.upsert({
        where: {
          userId_role: {
            userId: seedUser.id,
            role: role as DbPlatformRole,
          },
        },
        update: {},
        create: { userId: seedUser.id, role: role as DbPlatformRole },
      });
    }
  }

  if (await prisma.resourceEntry.findUnique({
    where: { id: "project-xunmeng-demo" },
  })) return;

  await prisma.$transaction(async (transaction) => {
    await transaction.resourceEntry.create({
      data: {
        id: "project-xunmeng-demo",
        type: "project",
        name: "示例项目：昆曲《寻梦》",
        ownerUserId: "user-admin",
        projectMetadata: {
          create: { description: "资源树与逐文件权限的开发示例。" },
        },
      },
    });
    await transaction.resourceEntry.create({
      data: {
        id: "annotation-xunmeng-demo",
        parentId: "project-xunmeng-demo",
        type: "annotation_file",
        name: "《寻梦》示例标注.json",
        ownerUserId: "user-admin",
        annotationFile: {
          create: {
            payload: {},
            revision: 1,
            lastEditedBy: "user-admin",
          },
        },
      },
    });
    await transaction.resourcePermission.createMany({
      data: [
        {
          resourceId: "project-xunmeng-demo",
          userId: "user-ta",
          capabilities: [
            DbResourceCapability.read,
            DbResourceCapability.write,
            DbResourceCapability.create_child,
            DbResourceCapability.copy,
            DbResourceCapability.move,
            DbResourceCapability.download,
            DbResourceCapability.manage_permissions,
          ],
          inheritToChildren: true,
          createdBy: "user-admin",
        },
        {
          resourceId: "project-xunmeng-demo",
          userId: "user-student",
          capabilities: [
            DbResourceCapability.read,
            DbResourceCapability.create_child,
            DbResourceCapability.copy,
            DbResourceCapability.download,
          ],
          inheritToChildren: true,
          createdBy: "user-admin",
        },
      ],
    });
  });
}
