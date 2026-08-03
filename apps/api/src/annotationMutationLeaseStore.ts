import type { Prisma } from "@prisma/client";
import { conflict } from "./errors.js";
import {
  isAnnotationMutationLeaseExpired,
  matchesAnnotationMutationLeaseToken,
} from "./annotationMutationLease.js";

export type AnnotationMutationLeaseWriteGuard = {
  leaseWasUsed: boolean;
};

// operation 与完整保存共用这一守卫；检查必须发生在 annotation file 行锁之后的同一事务内。
export async function assertAnnotationMutationLeaseForWrite(
  transaction: Prisma.TransactionClient,
  annotationFileId: string,
  actorUserId: string,
  baseRevision: number,
  token: string | undefined,
  required = false,
  now = new Date(),
): Promise<AnnotationMutationLeaseWriteGuard> {
  const lease = await transaction.annotationMutationLease.findUnique({
    where: { annotationFileId },
  });
  if (!lease) {
    if (token) {
      throw conflict("结构变更租约已失效，请重新取得租约。", {
        code: "annotation_mutation_lease_expired",
      });
    }
    if (required) {
      throw conflict("该结构性变更必须先取得文件租约。", {
        code: "annotation_mutation_lease_required",
      });
    }
    return { leaseWasUsed: false };
  }
  if (isAnnotationMutationLeaseExpired(lease.expiresAt, now)) {
    await transaction.annotationMutationLease.delete({ where: { annotationFileId } });
    if (token) {
      throw conflict("结构变更租约已过期，请重新取得租约。", {
        code: "annotation_mutation_lease_expired",
      });
    }
    if (required) {
      throw conflict("该结构性变更必须重新取得文件租约。", {
        code: "annotation_mutation_lease_required",
      });
    }
    return { leaseWasUsed: false };
  }
  if (!token) {
    throw conflict("当前文件正在进行结构性变更，普通写入已暂时停止。", {
      code: "annotation_mutation_lease_required",
      holderUserId: lease.holderUserId,
      purpose: lease.purpose,
      expiresAt: lease.expiresAt.toISOString(),
    });
  }
  if (
    lease.holderUserId !== actorUserId ||
    lease.baseRevision !== baseRevision ||
    !matchesAnnotationMutationLeaseToken(token, lease.tokenHash)
  ) {
    throw conflict("结构变更租约与当前账号、版本或凭据不匹配。", {
      code: "annotation_mutation_lease_invalid",
    });
  }
  return { leaseWasUsed: true };
}
