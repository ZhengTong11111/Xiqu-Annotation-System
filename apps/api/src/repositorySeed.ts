import {
  PlatformRole as DbPlatformRole,
  ProjectCapability as DbProjectCapability,
  ProjectMemberRole as DbProjectMemberRole,
  type PrismaClient,
} from "@prisma/client";
import { DEFAULT_PROJECT_ROLE_CAPABILITIES } from "@xiqu/shared";
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
          create: seedUser.roles.map((role) => ({
            role: role as DbPlatformRole,
          })),
        },
      },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { accountName: seedUser.accountName },
      include: { roles: true },
    });
    const existingRoles = new Set(user.roles.map((entry) => entry.role));
    for (const role of seedUser.roles) {
      if (!existingRoles.has(role as DbPlatformRole)) {
        await prisma.userRole.create({
          data: { userId: user.id, role: role as DbPlatformRole },
        });
      }
    }
  }

  if (await prisma.annotationProject.findUnique({
    where: { id: "project-xunmeng-demo" },
  })) {
    return;
  }

  const annotatorCapabilities = [
    ...DEFAULT_PROJECT_ROLE_CAPABILITIES.annotator,
  ] as DbProjectCapability[];
  const reviewerCapabilities = [
    ...DEFAULT_PROJECT_ROLE_CAPABILITIES.reviewer,
  ] as DbProjectCapability[];

  await prisma.$transaction(async (transaction) => {
    const mediaAsset = await transaction.mediaAsset.create({
      data: {
        id: "media-xunmeng-demo",
        title: "示例视频：顾卫英《寻梦》",
        description: "开发环境内置示例媒体，用于验证工作区和版本流程。",
        ownerUserId: "user-admin",
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
    const workspace = await transaction.annotationWorkspace.create({
      data: {
        id: "workspace-xunmeng-main",
        projectId: project.id,
        name: "项目主工作区",
        workspaceType: "main",
        status: "active",
        ownerUserId: "user-admin",
        createdBy: "user-admin",
      },
    });
    const snapshot = await transaction.annotationSnapshot.create({
      data: {
        id: "snapshot-xunmeng-main-1",
        workspaceId: workspace.id,
        revision: 1,
        payload: {},
        createdBy: "user-admin",
      },
    });
    await transaction.annotationWorkspace.update({
      where: { id: workspace.id },
      data: { latestSnapshotId: snapshot.id },
    });
    await transaction.annotationProject.update({
      where: { id: project.id },
      data: { primaryWorkspaceId: workspace.id },
    });
    await transaction.projectMember.createMany({
      data: [
        {
          projectId: project.id,
          userId: "user-ta",
          role: DbProjectMemberRole.reviewer,
          capabilities: reviewerCapabilities,
        },
        {
          projectId: project.id,
          userId: "user-student",
          role: DbProjectMemberRole.annotator,
          capabilities: annotatorCapabilities,
        },
      ],
    });
  });
}
