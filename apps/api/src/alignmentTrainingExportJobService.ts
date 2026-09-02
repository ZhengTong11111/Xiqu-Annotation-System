import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AlignmentTrainingExportJobRequestSummary,
  CreateAlignmentTrainingExportJobRequest,
} from "@xiqu/shared";
import {
  createAlignmentTrainingExportJobDeduplicationKey,
  createAlignmentTrainingExportRequestFingerprint,
} from "./alignmentTrainingExportJobIdentity.js";
import {
  ALIGNMENT_TRAINING_EXPORT_READY_INCLUDE,
  requireReadyAlignmentTrainingExport,
} from "./alignmentTrainingExportReader.js";
import type { ApiUser } from "./domain.js";
import { conflict, notFound } from "./errors.js";
import {
  assertProcessingJobRequestMatch,
} from "./processingJobIdentity.js";
import { ensureProcessingJobRequest } from "./processingJobRequestService.js";
import type { ResourceAccessService } from "./resourceAccess.js";

/** 训练导出预约只建立共享 job/request 事实；二进制读取和对象发布留给后续 claim-fenced worker。 */
export class AlignmentTrainingExportJobService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async create(
    user: ApiUser,
    exportId: string,
    input: CreateAlignmentTrainingExportJobRequest,
  ): Promise<AlignmentTrainingExportJobRequestSummary> {
    return this.prisma.$transaction(async (transaction) => {
      // 锁序与现有任务一致：账号动作 -> canonical execution；同一动作模糊重试只能落到一个 key。
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(
          hashtext(${`xiqu:processing-request:${user.id}:${input.clientRequestId}`})
        )
      `;
      await this.access.assertFullResourceAccess(user, transaction);
      const initial = await loadReadyExport(transaction, exportId);
      const deduplicationKey = createAlignmentTrainingExportJobDeduplicationKey({
        exportId: initial.row.id,
        provenanceManifestChecksum: initial.provenanceManifest.checksum,
        inputManifestChecksum: initial.inputManifest.checksum,
      });
      const requestFingerprint = createAlignmentTrainingExportRequestFingerprint({
        exportId,
        deduplicationKey,
      });

      const replayed = await transaction.processingJobRequestKey.findUnique({
        where: {
          requesterUserId_clientRequestId: {
            requesterUserId: user.id,
            clientRequestId: input.clientRequestId,
          },
        },
        include: { request: { include: { job: true } } },
      });
      if (replayed) {
        assertProcessingJobRequestMatch(replayed.requestFingerprint, requestFingerprint);
        assertJobRelation(replayed.request.job, exportId, deduplicationKey);
        return mapRequest(exportId, replayed.request.id, replayed.request.job);
      }

      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-job:${deduplicationKey}`}))
      `;
      // canonical 锁后重读并重验不可变输入，避免在等待期间依赖旧关系快照。
      const ready = await loadReadyExport(transaction, exportId);
      const currentDeduplicationKey = createAlignmentTrainingExportJobDeduplicationKey({
        exportId: ready.row.id,
        provenanceManifestChecksum: ready.provenanceManifest.checksum,
        inputManifestChecksum: ready.inputManifest.checksum,
      });
      if (currentDeduplicationKey !== deduplicationKey) {
        throw conflict("训练冻结输入在预约期间发生变化。", {
          code: "alignment_training_export_changed",
        });
      }

      const activeJob = await transaction.processingJob.findFirst({
        where: {
          deduplicationKey,
          status: { in: ["queued", "running", "cancelling"] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (activeJob?.status === "cancelling") {
        throw conflict("训练导出任务正在取消并清理，请稍后重试。", {
          code: "processing_job_cancellation_in_progress",
        });
      }
      if (activeJob) {
        assertJobRelation(activeJob, exportId, deduplicationKey);
        const request = await ensureProcessingJobRequest(transaction, {
          jobId: activeJob.id,
          requesterUserId: user.id,
          contextResourceId: null,
          mediaAudioTrackId: null,
          clientRequestId: input.clientRequestId,
          requestFingerprint,
        });
        return mapRequest(exportId, request.request.id, activeJob);
      }

      const inputFileIds = ready.row.items.flatMap((item) =>
        item.input?.sourceFileId ? [item.input.sourceFileId] : []).sort();
      const job = await transaction.processingJob.create({
        data: {
          type: "alignment_training_export",
          status: "queued",
          resourceId: null,
          inputFileIds: [...new Set(inputFileIds)],
          createdBy: user.id,
          alignmentTrainingExportId: exportId,
          deduplicationKey,
        },
      });
      const request = await ensureProcessingJobRequest(transaction, {
        jobId: job.id,
        requesterUserId: user.id,
        contextResourceId: null,
        mediaAudioTrackId: null,
        clientRequestId: input.clientRequestId,
        requestFingerprint,
      });
      await transaction.auditLog.create({
        data: {
          action: "alignment_training_export_job_create",
          actorUserId: user.id,
          detail: {
            exportId,
            jobId: job.id,
            requestId: request.request.id,
            provenanceManifestChecksum: ready.provenanceManifest.checksum,
            inputManifestChecksum: ready.inputManifest.checksum,
            sampleCount: ready.inputManifest.itemCount,
            uploadedSourceFileCount: job.inputFileIds.length,
          },
        },
      });
      return mapRequest(exportId, request.request.id, job);
    });
  }
}

async function loadReadyExport(transaction: Prisma.TransactionClient, exportId: string) {
  const row = await transaction.alignmentTrainingExport.findUnique({
    where: { id: exportId },
    include: ALIGNMENT_TRAINING_EXPORT_READY_INCLUDE,
  });
  if (!row) throw notFound("训练冻结不存在。");
  return requireReadyAlignmentTrainingExport(row);
}

function assertJobRelation(
  job: {
    id: string;
    type: string;
    alignmentTrainingExportId: string | null;
    deduplicationKey: string;
    analysisRunId: string | null;
    alignmentRunId: string | null;
  },
  exportId: string,
  deduplicationKey: string,
) {
  if (
    job.type !== "alignment_training_export" ||
    job.alignmentTrainingExportId !== exportId ||
    job.deduplicationKey !== deduplicationKey ||
    job.analysisRunId !== null ||
    job.alignmentRunId !== null
  ) {
    throw conflict("训练导出任务关系不完整。", {
      code: "processing_job_run_missing",
    });
  }
}

function mapRequest(
  exportId: string,
  requestId: string,
  job: { id: string; status: AlignmentTrainingExportJobRequestSummary["status"] },
): AlignmentTrainingExportJobRequestSummary {
  return {
    exportId,
    requestId,
    jobId: job.id,
    status: job.status,
  };
}
