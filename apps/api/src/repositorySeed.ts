import {
  AnnotationMode as DbAnnotationMode,
  PlatformRole as DbPlatformRole,
  type PrismaClient,
} from "@prisma/client";
import { hashPassword } from "./auth.js";
import type { ApiRole } from "./domain.js";
import { createGrantData } from "./repositoryMappers.js";

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
    displayName: "助教账号",
    password: "ta123",
    roles: ["ta"],
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
      update: {
        displayName: seedUser.displayName,
        isActive: true,
      },
      create: {
        id: seedUser.id,
        accountName: seedUser.accountName,
        displayName: seedUser.displayName,
        passwordHash,
        roles: {
          create: seedUser.roles.map((role) => ({ role: role as DbPlatformRole })),
        },
      },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { accountName: seedUser.accountName },
      include: { roles: true },
    });
    const existingRoles = new Set(user.roles.map((role) => role.role));
    for (const role of seedUser.roles) {
      if (!existingRoles.has(role as DbPlatformRole)) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            role: role as DbPlatformRole,
          },
        });
      }
    }
  }

  const existingDemoProject = await prisma.annotationProject.findUnique({
    where: { id: "project-xunmeng-demo" },
  });
  if (existingDemoProject) {
    return;
  }

  const now = new Date();
  await prisma.$transaction(async (transaction) => {
    const mediaAsset = await transaction.mediaAsset.create({
      data: {
        id: "media-xunmeng-demo",
        title: "示例视频：顾卫英《寻梦》",
        description: "开发环境内置示例媒体资产，用于验证项目库和服务端保存接口。",
      },
    });
    const project = await transaction.annotationProject.create({
      data: {
        id: "project-xunmeng-demo",
        title: "示例项目：昆曲《寻梦》",
        mediaAssetId: mediaAsset.id,
        ownerUserId: "user-admin",
      },
    });
    const document = await transaction.annotationDocument.create({
      data: {
        id: "document-xunmeng-base",
        projectId: project.id,
        title: "基准标注文档",
        mode: DbAnnotationMode.collaborative,
        createdAt: now,
      },
    });
    const snapshot = await transaction.annotationSnapshot.create({
      data: {
        id: "snapshot-xunmeng-base-0",
        documentId: document.id,
        revision: 0,
        payload: {},
        createdBy: "user-admin",
        createdAt: now,
      },
    });
    await transaction.annotationDocument.update({
      where: { id: document.id },
      data: {
        latestSnapshotId: snapshot.id,
      },
    });
    await transaction.permissionGrant.createMany({
      data: [
        createGrantData("user-admin", project.id, document.id, ["view", "edit", "manage", "confirm", "merge"]),
        createGrantData("user-ta", project.id, document.id, ["view", "edit", "review", "merge"]),
        createGrantData("user-student", project.id, document.id, ["view"]),
      ],
    });
  });
}
