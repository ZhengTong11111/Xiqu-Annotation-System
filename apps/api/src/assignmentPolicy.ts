import type { Prisma, PrismaClient } from "@prisma/client";
import { isAssignmentRecipientWritable } from "@xiqu/document-model";
import type { ApiUser } from "./domain.js";
import { forbidden } from "./errors.js";

type AssignmentPolicyClient = PrismaClient | Prisma.TransactionClient;

/**
 * 学生提交后，即使还持有其他项目级 edit grant，也不能继续修改自己的作业副本。
 * 课程教师、助教和平台管理员不受“学生提交锁”影响，仍可审核或修复文档。
 */
export async function assertAssignmentDocumentWritable(
  prisma: AssignmentPolicyClient,
  user: ApiUser,
  documentId: string,
) {
  const recipient = await prisma.assignmentRecipient.findUnique({
    where: { documentId },
    include: {
      assignment: {
        include: {
          course: { include: { members: true } },
        },
      },
    },
  });
  if (!recipient || recipient.userId !== user.id) {
    return;
  }
  if (recipient.assignment.status !== "published") {
    throw forbidden("该作业当前不允许学生修改。");
  }
  if (
    recipient.assignment.startAt &&
    recipient.assignment.startAt.getTime() > Date.now()
  ) {
    throw forbidden("作业尚未到开始时间。");
  }
  if (!isAssignmentRecipientWritable(recipient.status)) {
    throw forbidden("该作业已经提交。如需继续修改，请联系教师或助教退回作业。");
  }
}

/**
 * 首次真实保存才视为“已经开始”。仅打开文档不会虚增课堂进度。
 * returned 状态保存后重新进入 in_progress，保留历史 returnedAt 供追溯。
 */
export async function recordAssignmentDocumentActivity(
  prisma: AssignmentPolicyClient,
  user: ApiUser,
  documentId: string,
  now = new Date(),
) {
  const recipient = await prisma.assignmentRecipient.findUnique({
    where: { documentId },
  });
  if (!recipient || recipient.userId !== user.id) {
    return;
  }
  if (recipient.status === "submitted" || recipient.status === "pending") {
    return;
  }
  await prisma.assignmentRecipient.update({
    where: { id: recipient.id },
    data: {
      status: "in_progress",
      firstEditedAt: recipient.firstEditedAt ?? now,
      lastActivityAt: now,
    },
  });
}
