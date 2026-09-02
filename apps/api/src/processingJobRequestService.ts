import type { Prisma } from "@prisma/client";

export type ProcessingJobRequestDraft = {
  jobId: string;
  requesterUserId: string;
  contextResourceId: string | null;
  mediaAudioTrackId: string | null;
  clientRequestId: string;
  requestFingerprint: string;
};

/**
 * 同一账号、资源与共享执行只保留一条业务需求；每个标签页的 clientRequestId 仍保存为独立幂等别名。
 * 媒体分析、强制对齐和跨项目训练导出共用这里，取消命令因此继续只操作 ProcessingJobRequest。
 * 无资源上下文时不能使用 PostgreSQL 含 NULL 的复合 unique 查找，调用方必须已持有 canonical job lock。
 */
export async function ensureProcessingJobRequest(
  transaction: Prisma.TransactionClient,
  draft: ProcessingJobRequestDraft,
) {
  const existing = draft.contextResourceId === null
    ? await transaction.processingJobRequest.findFirst({
        where: {
          jobId: draft.jobId,
          requesterUserId: draft.requesterUserId,
          contextResourceId: null,
        },
        orderBy: { id: "asc" },
      })
    : await transaction.processingJobRequest.findUnique({
        where: {
          jobId_requesterUserId_contextResourceId: {
            jobId: draft.jobId,
            requesterUserId: draft.requesterUserId,
            contextResourceId: draft.contextResourceId,
          },
        },
      });
  if (existing?.mediaAudioTrackId && existing.mediaAudioTrackId !== draft.mediaAudioTrackId) {
    throw new Error("同一后台任务需求不能改绑到另一条音轨。");
  }
  const request = existing
    ? existing.mediaAudioTrackId || draft.mediaAudioTrackId === null
      ? existing
      : await transaction.processingJobRequest.update({
          where: { id: existing.id },
          // 历史需求没有可证明的音轨；只有再次经过完整来源校验时才能补稳定外键。
          data: { mediaAudioTrackId: draft.mediaAudioTrackId },
        })
    : await transaction.processingJobRequest.create({
        data: {
          jobId: draft.jobId,
          requesterUserId: draft.requesterUserId,
          contextResourceId: draft.contextResourceId,
          mediaAudioTrackId: draft.mediaAudioTrackId,
        },
      });
  await transaction.processingJobRequestKey.create({
    data: {
      requestId: request.id,
      requesterUserId: draft.requesterUserId,
      clientRequestId: draft.clientRequestId,
      requestFingerprint: draft.requestFingerprint,
    },
  });
  return { request, created: !existing };
}
