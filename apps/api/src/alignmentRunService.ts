import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  buildAlignmentTextProjection,
  type AlignmentTextProjectionResult,
} from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import {
  FORCE_ALIGNMENT_MODEL_PRESET_LABELS,
  type AlignmentRunDetail,
  type AlignmentRunPage,
  type AlignmentRunSummary,
  type CreateAlignmentRunRequest,
  type ForceAlignmentModelPreset,
  type ListAlignmentRunsOptions,
} from "@xiqu/shared";
import { resolveAnalysisAudioContext } from "./analysisAudioSourceResolver.js";
import { createAlignmentRunIdentity } from "./alignmentRunIdentity.js";
import { lockActiveAnnotationFileForWrite } from "./annotationFileWriteLock.js";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";
import type { ApiUser } from "./domain.js";
import {
  analysisAudioForbidden,
  analysisSourceMissing,
  analysisToolUnavailable,
  badRequest,
  conflict,
  notFound,
} from "./errors.js";
import {
  assertProcessingJobRequestMatch,
  createForceAlignmentRequestFingerprint,
} from "./processingJobIdentity.js";
import { ensureProcessingJobRequest } from "./processingJobRequestService.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const ACTIVE_JOB_STATUSES = ["queued", "running", "cancelling"] as const;

const MODEL_PRESETS: Record<ForceAlignmentModelPreset, {
  modelName: string;
  modelVersion: string;
  dictionaryVersion: string;
  codeVersion: string;
  config: Record<string, unknown>;
}> = {
  kunqu_character_v1: {
    modelName: "xiqu-kunqu-character-aligner",
    modelVersion: "1",
    dictionaryVersion: "yinxue-lizhu-v1",
    codeVersion: "force-alignment-contract-v1",
    config: { sampleRate: 16_000, channelCount: 1, outputUnit: "character" },
  },
};

type AlignmentRunRow = Prisma.AlignmentRunGetPayload<{
  include: { artifacts: { select: { id: true } } };
}>;

/**
 * 强制对齐创建只保存稳定输入身份和账号需求。模型执行、预测对象发布与应用命令分别属于 D2c/D2d，不能在这里近似实现。
 */
export class AlignmentRunService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly requestsEnabled: boolean,
  ) {}

  async create(
    user: ApiUser,
    annotationFileId: string,
    input: CreateAlignmentRunRequest,
  ): Promise<AlignmentRunSummary> {
    if (!this.requestsEnabled) {
      throw analysisToolUnavailable("强制对齐执行器尚未启用，当前没有创建后台任务。", {
        code: "alignment_executor_unavailable",
      });
    }

    const created = await this.prisma.$transaction(async (transaction) => {
      // 锁序固定为账号请求 -> 文件/资源 -> 音轨来源 -> canonical 执行，避免与取消和媒体分析形成反向等待。
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-request:${user.id}:${input.clientRequestId}`}))
      `;
      const file = await lockActiveAnnotationFileForWrite(
        transaction,
        this.access,
        user,
        annotationFileId,
      );
      const resource = await transaction.resourceEntry.findUnique({
        where: { id: annotationFileId },
        select: { archivedAt: true },
      });
      if (!resource || resource.archivedAt) {
        throw badRequest("请先取消归档标注文件，再创建强制对齐任务。");
      }

      const parsed = parseCurrentProjectData(file.payload);
      if (!parsed.success) {
        throw conflict("当前标注文档格式不完整，需先通过完整保存或迁移修复。", {
          code: "annotation_payload_invalid",
        });
      }
      const projection = requireAlignmentProjection(buildAlignmentTextProjection(parsed.data));
      const inputTextFingerprint = sha256(stableJsonStringify(projection.projection));
      const audioTrackId = await resolveDefaultAudioTrackId(transaction, file.mediaResourceId, annotationFileId);
      const audioContext = await resolveAnalysisAudioContext(
        transaction,
        this.access,
        user,
        annotationFileId,
        audioTrackId,
      );
      const source = requireReadyAudioSource(audioContext);
      const preset = MODEL_PRESETS[input.modelPreset];
      const identity = createAlignmentRunIdentity({
        annotationFileId,
        inputRevision: file.revision,
        inputTextFingerprint,
        inputSentenceCount: projection.sentenceCount,
        inputCharacterCount: projection.characterCount,
        sourceMediaResourceId: source.media.resourceId,
        sourceFingerprint: source.mediaFingerprint,
        mediaAudioTrackId: audioTrackId,
        audioOffsetMicros: BigInt(Math.round(source.offsetSeconds * 1_000_000)),
        mediaAnalysisFingerprint: null,
        ...preset,
      });
      const requestFingerprint = createForceAlignmentRequestFingerprint({
        deduplicationKey: identity.deduplicationKey,
        contextResourceId: annotationFileId,
        audioTrackId,
      });

      // 模糊响应重放在 canonical 锁前返回原任务；changed facts 会得到稳定 409，不能把旧编号改绑。
      const replayed = await transaction.processingJobRequestKey.findUnique({
        where: {
          requesterUserId_clientRequestId: {
            requesterUserId: user.id,
            clientRequestId: input.clientRequestId,
          },
        },
        include: { request: { include: { job: { include: { alignmentRun: { include: { artifacts: { select: { id: true } } } } } } } } },
      });
      if (replayed) {
        assertProcessingJobRequestMatch(replayed.requestFingerprint, requestFingerprint);
        if (!replayed.request.job.alignmentRun || replayed.request.job.type !== "force_alignment") {
          throw conflict("后台任务缺少对应的强制对齐记录。", { code: "processing_job_run_missing" });
        }
        return replayed.request.job.alignmentRun;
      }

      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${`xiqu:processing-job:${identity.deduplicationKey}`}))
      `;
      const existing = await transaction.alignmentRun.findUnique({
        where: { identityHash: identity.identityHash },
        include: { artifacts: { select: { id: true } } },
      });
      if (existing?.status === "succeeded") {
        const completedJob = await transaction.processingJob.findFirst({
          where: {
            alignmentRunId: existing.id,
            deduplicationKey: identity.deduplicationKey,
            status: "succeeded",
          },
          orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        });
        if (!completedJob || existing.artifacts.length === 0) {
          throw conflict("强制对齐结果与任务记录不一致。", { code: "processing_job_completion_missing" });
        }
        await ensureProcessingJobRequest(transaction, {
          jobId: completedJob.id,
          requesterUserId: user.id,
          contextResourceId: annotationFileId,
          mediaAudioTrackId: audioTrackId,
          clientRequestId: input.clientRequestId,
          requestFingerprint,
        });
        return existing;
      }

      const activeJob = await transaction.processingJob.findFirst({
        where: { deduplicationKey: identity.deduplicationKey, status: { in: [...ACTIVE_JOB_STATUSES] } },
        include: { alignmentRun: { include: { artifacts: { select: { id: true } } } } },
      });
      if (activeJob) {
        if (activeJob.status === "cancelling") {
          throw conflict("强制对齐正在取消并清理，请稍后重试。", {
            code: "processing_job_cancellation_in_progress",
          });
        }
        if (!activeJob.alignmentRun || activeJob.type !== "force_alignment") {
          throw conflict("活动强制对齐任务缺少对齐记录。", { code: "processing_job_run_missing" });
        }
        await ensureProcessingJobRequest(transaction, {
          jobId: activeJob.id,
          requesterUserId: user.id,
          contextResourceId: annotationFileId,
          mediaAudioTrackId: audioTrackId,
          clientRequestId: input.clientRequestId,
          requestFingerprint,
        });
        return activeJob.alignmentRun;
      }
      if (existing) {
        throw conflict("该输入已有终态强制对齐记录，请通过任务中心重试。", {
          code: "alignment_retry_required",
        });
      }

      const run = await transaction.alignmentRun.create({
        data: {
          annotationFileId,
          annotationFileIdSnapshot: annotationFileId,
          inputRevision: file.revision,
          inputTextFingerprint,
          inputSentenceCount: projection.sentenceCount,
          inputCharacterCount: projection.characterCount,
          sourceMediaResourceId: source.media.resourceId,
          sourceMediaResourceIdSnapshot: source.media.resourceId,
          sourceFingerprint: source.mediaFingerprint,
          mediaAudioTrackId: audioTrackId,
          mediaAudioTrackIdSnapshot: audioTrackId,
          audioOffsetMicros: BigInt(Math.round(source.offsetSeconds * 1_000_000)),
          mediaAnalysisRunId: null,
          mediaAnalysisFingerprint: null,
          modelName: preset.modelName,
          modelVersion: preset.modelVersion,
          dictionaryVersion: preset.dictionaryVersion,
          codeVersion: preset.codeVersion,
          configHash: identity.configHash,
          config: identity.config as Prisma.InputJsonValue,
          identityHash: identity.identityHash,
          createdBy: user.id,
        },
        include: { artifacts: { select: { id: true } } },
      });
      const job = await transaction.processingJob.create({
        data: {
          type: "force_alignment",
          resourceId: annotationFileId,
          inputFileIds: source.media.file ? [source.media.file.id] : [],
          createdBy: user.id,
          alignmentRunId: run.id,
          deduplicationKey: identity.deduplicationKey,
        },
      });
      await ensureProcessingJobRequest(transaction, {
        jobId: job.id,
        requesterUserId: user.id,
        contextResourceId: annotationFileId,
        mediaAudioTrackId: audioTrackId,
        clientRequestId: input.clientRequestId,
        requestFingerprint,
      });
      return run;
    });
    return mapRun(created, input.modelPreset, true);
  }

  async list(
    user: ApiUser,
    annotationFileId: string,
    options: ListAlignmentRunsOptions,
  ): Promise<AlignmentRunPage> {
    await this.access.assertCapability(user, annotationFileId, "read");
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    const current = await this.readCurrentInput(user, annotationFileId);
    const rows = await this.prisma.alignmentRun.findMany({
      where: {
        annotationFileId,
        ...(cursor ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      include: { artifacts: { select: { id: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => mapRun(row, resolvePreset(row), matchesCurrent(row, current))),
      nextCursor: rows.length > limit && page.length ? encodeCursor(page.at(-1)!) : null,
    };
  }

  async detail(user: ApiUser, annotationFileId: string, runId: string): Promise<AlignmentRunDetail> {
    await this.access.assertCapability(user, annotationFileId, "read");
    const [run, current] = await Promise.all([
      this.prisma.alignmentRun.findFirst({
        where: { id: runId, annotationFileId },
        include: { artifacts: { select: { id: true } } },
      }),
      this.readCurrentInput(user, annotationFileId),
    ]);
    if (!run) throw notFound("强制对齐记录不存在。");
    const activeRequest = await this.prisma.processingJobRequest.findFirst({
      where: {
        requesterUserId: user.id,
        contextResourceId: annotationFileId,
        cancelledAt: null,
        job: { alignmentRunId: run.id, status: { in: [...ACTIVE_JOB_STATUSES] } },
      },
      select: { id: true },
    });
    return {
      ...mapRun(run, resolvePreset(run), matchesCurrent(run, current)),
      audioTrackId: run.mediaAudioTrackId,
      requestActive: Boolean(activeRequest),
    };
  }

  private async readCurrentInput(user: ApiUser, annotationFileId: string) {
    const resource = await this.prisma.resourceEntry.findUnique({
      where: { id: annotationFileId },
      select: { trashedAt: true, archivedAt: true, annotationFile: { select: { revision: true, payload: true, mediaResourceId: true } } },
    });
    if (!resource?.annotationFile || resource.trashedAt || resource.archivedAt) {
      throw notFound("活动标注文件不存在。");
    }
    const parsed = parseCurrentProjectData(resource.annotationFile.payload);
    if (!parsed.success) return null;
    const projection = buildAlignmentTextProjection(parsed.data);
    if (!projection.ok) return null;
    const audioTrackId = await resolveDefaultAudioTrackId(
      this.prisma,
      resource.annotationFile.mediaResourceId,
      annotationFileId,
    ).catch(() => null);
    if (!audioTrackId) return null;
    const context = await resolveAnalysisAudioContext(
      this.prisma, this.access, user, annotationFileId, audioTrackId,
    );
    if (context.source.status !== "ready") return null;
    return {
      revision: resource.annotationFile.revision,
      textFingerprint: sha256(stableJsonStringify(projection.projection)),
      audioTrackId,
      sourceFingerprint: context.source.value.mediaFingerprint,
      offsetMicros: BigInt(Math.round(context.source.value.offsetSeconds * 1_000_000)),
    };
  }
}

async function resolveDefaultAudioTrackId(
  database: PrismaClient | Prisma.TransactionClient,
  primaryMediaResourceId: string | null,
  annotationFileId: string,
) {
  if (!primaryMediaResourceId) throw analysisSourceMissing("当前标注文件没有关联媒体。");
  const preference = await database.annotationAudioPreference.findUnique({
    where: { annotationFileId },
    select: { defaultAudioTrackId: true },
  });
  if (preference?.defaultAudioTrackId) return preference.defaultAudioTrackId;
  const original = await database.mediaAudioTrack.findFirst({
    where: { primaryMediaResourceId, kind: "original", enabled: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!original) throw analysisSourceMissing("当前媒体没有可用原声音轨。");
  return original.id;
}

function requireReadyAudioSource(context: Awaited<ReturnType<typeof resolveAnalysisAudioContext>>) {
  if (context.source.status === "ready") return context.source.value;
  if (context.source.value.code === "analysis_audio_forbidden") {
    throw analysisAudioForbidden("当前账号不能读取或下载强制对齐音频。");
  }
  throw analysisSourceMissing(
    context.source.value.code === "analysis_source_invalid"
      ? "当前默认音轨已失效，请先修复音轨关系。"
      : "当前标注文件没有可用的强制对齐音频。",
  );
}

function requireAlignmentProjection(result: AlignmentTextProjectionResult) {
  if (result.ok) return result;
  const messages: Record<typeof result.code, string> = {
    alignment_input_empty: "当前标注文件没有可对齐的句级与逐字文字。",
    alignment_sentence_without_characters: "存在尚未拆分逐字的句子，无法创建强制对齐任务。",
    alignment_character_orphaned: "逐字文字存在无效的句级归属。",
    alignment_input_invalid: "句级或逐字文字包含无效内容或时间范围。",
    alignment_input_too_large: "当前标注文档超过单次强制对齐容量上限。",
  };
  throw badRequest(messages[result.code], { code: result.code, entityId: result.entityId });
}

function resolvePreset(row: Pick<AlignmentRunRow, "modelName" | "modelVersion" | "dictionaryVersion" | "codeVersion">): ForceAlignmentModelPreset | "unknown" {
  const preset = MODEL_PRESETS.kunqu_character_v1;
  if (
    row.modelName !== preset.modelName ||
    row.modelVersion !== preset.modelVersion ||
    row.dictionaryVersion !== preset.dictionaryVersion ||
    row.codeVersion !== preset.codeVersion
  ) return "unknown";
  return "kunqu_character_v1";
}

function mapRun(
  run: AlignmentRunRow,
  modelPreset: ForceAlignmentModelPreset | "unknown",
  matchesCurrentInput: boolean,
): AlignmentRunSummary {
  return {
    id: run.id,
    status: run.status,
    progress: run.progress,
    errorCode: run.errorCode,
    inputRevision: run.inputRevision,
    inputSentenceCount: run.inputSentenceCount,
    inputCharacterCount: run.inputCharacterCount,
    modelPreset,
    modelLabel: modelPreset === "unknown"
      ? "历史强制对齐模型"
      : FORCE_ALIGNMENT_MODEL_PRESET_LABELS[modelPreset],
    matchesCurrentInput,
    artifactAvailable: run.status === "succeeded" && run.artifacts.length > 0,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function matchesCurrent(run: AlignmentRunRow, current: Awaited<ReturnType<AlignmentRunService["readCurrentInput"]>>) {
  return Boolean(current &&
    run.inputRevision === current.revision &&
    run.inputTextFingerprint === current.textFingerprint &&
    run.mediaAudioTrackIdSnapshot === current.audioTrackId &&
    run.sourceFingerprint === current.sourceFingerprint &&
    run.audioOffsetMicros === current.offsetMicros);
}

function normalizeLimit(value: number | undefined) {
  const limit = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw badRequest(`强制对齐每页数量必须在 1 到 ${MAX_PAGE_LIMIT} 之间。`);
  }
  return limit;
}

function encodeCursor(run: Pick<AlignmentRunRow, "createdAt" | "id">) {
  return Buffer.from(JSON.stringify({ version: 1, createdAt: run.createdAt.toISOString(), id: run.id }), "utf8")
    .toString("base64url");
}

function decodeCursor(token: string) {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const cursor = value as { version?: unknown; createdAt?: unknown; id?: unknown };
    if (cursor.version !== 1 || typeof cursor.createdAt !== "string" ||
        typeof cursor.id !== "string" || !cursor.id || cursor.id.length > 200) throw new Error();
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== cursor.createdAt) throw new Error();
    return { createdAt, id: cursor.id };
  } catch {
    throw badRequest("强制对齐分页游标无效，请刷新第一页。");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
