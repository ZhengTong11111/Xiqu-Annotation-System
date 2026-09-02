import type { Prisma } from "@prisma/client";

export type ProcessingJobRequestDraft = {
  jobId: string;
  requesterUserId: string;
  contextResourceId: string;
  mediaAudioTrackId: string;
  clientRequestId: string;
  requestFingerprint: string;
};

/**
 * 同一账号、资源与共享执行只保留一条业务需求；每个标签页的 clientRequestId 仍保存为独立幂等别名。
 * 媒体分析和强制对齐共用这里，取消命令因此可以继续只操作 ProcessingJobRequest，而不需要第二套需求表。
 */
export async function ensureProcessingJobRequest(
  transaction: Prisma.TransactionClient,
  draft: ProcessingJobRequestDraft,
) {
  const existing = await transaction.processingJobRequest.findUnique({
    where: {
      jobId_requesterUserId_contextResourceId: {
        jobId: draft.jobId,
        requesterUserId: draft.requesterUserId,
        contextResourceId: draft.contextResourceId,
      },
    },
  });
  const request = existing
    ? existing.mediaAudioTrackId
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
