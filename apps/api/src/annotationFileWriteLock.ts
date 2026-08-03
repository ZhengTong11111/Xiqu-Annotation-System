import type { Prisma } from "@prisma/client";
import type { ApiUser } from "./domain.js";
import { notFound } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";

// 所有标注内容写入共用固定锁序：资源树共享锁 → 资源行 → 活动祖先 → ACL → 文件行。
// 这样权限撤销、移动/回收和 operation/save 不会在不同模块形成各自近似但不等价的并发边界。
export async function lockActiveAnnotationFileForWrite(
  transaction: Prisma.TransactionClient,
  access: ResourceAccessService,
  user: ApiUser,
  resourceId: string,
) {
  await transaction.$queryRaw`
    SELECT 1::integer AS locked
    FROM pg_advisory_xact_lock_shared(hashtext('xiqu:resource-tree:mutation'))
  `;
  const rows = await transaction.$queryRaw<Array<{
    id: string;
    type: string;
    parentId: string | null;
    trashedAt: Date | null;
  }>>`
    SELECT id, type::text AS type, parent_id AS "parentId", trashed_at AS "trashedAt"
    FROM resource_entries
    WHERE id = ${resourceId}
    FOR UPDATE
  `;
  const resource = rows[0];
  if (!resource || resource.type !== "annotation_file" || resource.trashedAt) {
    throw notFound("活动标注文件不存在。");
  }
  let parentId = resource.parentId;
  while (parentId) {
    const parent = await transaction.resourceEntry.findUnique({
      where: { id: parentId },
      select: { parentId: true, trashedAt: true },
    });
    if (!parent || parent.trashedAt) throw notFound("活动标注文件不存在。");
    parentId = parent.parentId;
  }
  await access.assertCapability(user, resourceId, "write", transaction);
  await transaction.$queryRaw`
    SELECT resource_id
    FROM annotation_files
    WHERE resource_id = ${resourceId}
    FOR UPDATE
  `;
  const file = await transaction.annotationFile.findUnique({ where: { resourceId } });
  if (!file) throw notFound("活动标注文件不存在。");
  return file;
}
