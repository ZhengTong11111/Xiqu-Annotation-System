import type { Prisma, PrismaClient } from "@prisma/client";
import { notFound } from "./errors.js";

// 读会话和内容治理都必须拒绝位于回收站子树中的文件；这里只判断活动性，不判断账号权限。
export async function assertActiveAnnotationFile(
  database: PrismaClient | Prisma.TransactionClient,
  resourceId: string,
) {
  const resource = await database.resourceEntry.findUnique({
    where: { id: resourceId },
    select: {
      type: true,
      parentId: true,
      trashedAt: true,
      annotationFile: { select: { revision: true } },
    },
  });
  if (
    !resource ||
    resource.type !== "annotation_file" ||
    !resource.annotationFile ||
    resource.trashedAt
  ) {
    throw notFound("活动标注文件不存在。");
  }
  let parentId = resource.parentId;
  while (parentId) {
    const parent = await database.resourceEntry.findUnique({
      where: { id: parentId },
      select: { parentId: true, trashedAt: true },
    });
    if (!parent || parent.trashedAt) throw notFound("活动标注文件不存在。");
    parentId = parent.parentId;
  }
  return resource.annotationFile;
}
