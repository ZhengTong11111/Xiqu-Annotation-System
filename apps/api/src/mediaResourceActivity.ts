import type { Prisma, PrismaClient } from "@prisma/client";
import { notFound } from "./errors.js";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const activeMediaSelect = {
  type: true,
  parentId: true,
  trashedAt: true,
  archivedAt: true,
  mediaFile: {
    select: {
      resourceId: true,
      sourceType: true,
      mediaKind: true,
      mimeType: true,
      duration: true,
      aliyunVodVideoId: true,
      aliyunVodRegion: true,
      file: {
        select: {
          id: true,
          mimeType: true,
        },
      },
    },
  },
} satisfies Prisma.ResourceEntrySelect;

/** 资源本身可见但位于回收站祖先下时同样不能成为播放或音轨关联来源。 */
export async function assertActiveResourceAncestors(
  database: DatabaseClient,
  parentId: string | null,
) {
  let currentId = parentId;
  while (currentId) {
    const parent = await database.resourceEntry.findUnique({
      where: { id: currentId },
      select: { parentId: true, trashedAt: true },
    });
    if (!parent || parent.trashedAt) throw notFound("活动媒体不存在。");
    currentId = parent.parentId;
  }
}

/** 集中媒体活动性判断，避免音轨管理与播放会话对回收站/归档状态产生不同解释。 */
export async function requireActiveMediaResource(
  database: DatabaseClient,
  resourceId: string,
) {
  const resource = await database.resourceEntry.findUnique({
    where: { id: resourceId },
    select: activeMediaSelect,
  });
  if (
    !resource ||
    resource.type !== "media_file" ||
    !resource.mediaFile ||
    resource.trashedAt ||
    resource.archivedAt
  ) {
    throw notFound("活动媒体不存在。");
  }
  await assertActiveResourceAncestors(database, resource.parentId);
  return resource.mediaFile;
}
