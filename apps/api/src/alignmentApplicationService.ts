import { createHash } from "node:crypto";
import type { AlignmentApplication, Prisma, PrismaClient } from "@prisma/client";
import {
  buildAlignmentPredictionApplicationPlan,
  buildAlignmentTextProjection,
  type AlignmentPredictionArtifact,
  type ProjectData,
} from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import {
  FORCE_ALIGNMENT_MODEL_PRESET_LABELS,
  type AlignmentApplicationPage,
  type AlignmentApplicationSummary,
  type ApplyAlignmentRunRequest,
  type AtomicAnnotationCommandOperation,
  type CommitAnnotationCommandBatchRequest,
  type ListAlignmentApplicationsOptions,
} from "@xiqu/shared";
import { resolveAnalysisAudioContext } from "./analysisAudioSourceResolver.js";
import {
  isReadablePredictionArtifact,
  type PredictionArtifactMetadata,
} from "./alignmentArtifactMetadata.js";
import { readAlignmentPrediction, AlignmentPredictionReadError } from "./alignmentPredictionReader.js";
import {
  type AlignmentApplicationCommitBinding,
  AnnotationCommandCommitService,
} from "./annotationCommandCommitService.js";
import { encodeAnnotationSnapshotOperationCursor } from "./annotationCommittedOperationPagination.js";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";
import type { ApiUser } from "./domain.js";
import { analysisAudioForbidden, badRequest, conflict, notFound } from "./errors.js";
import type { ObjectStorage } from "./objectStorage.js";
import type { ResourceAccessService } from "./resourceAccess.js";
import { resolveAlignmentRunPreset } from "./alignmentRunService.js";

const DEFAULT_APPLICATION_PAGE_LIMIT = 20;
const MAX_APPLICATION_PAGE_LIMIT = 100;

type AlignmentRunForApplication = Prisma.AlignmentRunGetPayload<{
  include: { artifacts: true };
}>;

/**
 * 预测应用只负责验证 run/artifact/current facts 并规划普通 timing commands；
 * 真正的 snapshot/revision/operation 写入仍由 AnnotationCommandCommitService 唯一负责。
 */
export class AlignmentApplicationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly storage: Pick<ObjectStorage, "getObjectStream">,
    private readonly commandCommits: AnnotationCommandCommitService,
  ) {}

  async list(
    user: ApiUser,
    annotationFileId: string,
    options: ListAlignmentApplicationsOptions,
  ): Promise<AlignmentApplicationPage> {
    await this.access.assertCapability(user, annotationFileId, "read");
    const limit = normalizeApplicationLimit(options.limit);
    const cursor = options.cursor
      ? decodeApplicationCursor(annotationFileId, options.cursor)
      : null;
    const rows = await this.prisma.alignmentApplication.findMany({
      where: {
        annotationFileId,
        ...(cursor ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      include: {
        run: {
          select: {
            annotationFileIdSnapshot: true,
            modelName: true,
            modelVersion: true,
            dictionaryVersion: true,
            codeVersion: true,
          },
        },
        artifact: { select: { runId: true } },
        _count: {
          select: {
            operations: true,
            qualityAssessments: { where: { supersededAt: null } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    for (const row of page) {
      if (
        row.run.annotationFileIdSnapshot !== annotationFileId ||
        row.artifact.runId !== row.alignmentRunId ||
        row._count.operations !== row.operationCount
      ) {
        throw conflict("强制对齐应用历史关系不完整，不能显示。", {
          code: "alignment_application_history_incomplete",
        });
      }
    }
    return {
      items: page.map((row) => {
        const modelPreset = resolveAlignmentRunPreset(row.run);
        return {
          ...mapApplicationSummary(
            row,
            encodeAnnotationSnapshotOperationCursor(
              annotationFileId,
              row.committedRevision,
            ),
          ),
          actorUserId: row.actorUserId,
          modelPreset,
          modelLabel: modelPreset === "unknown"
            ? "历史强制对齐模型"
            : FORCE_ALIGNMENT_MODEL_PRESET_LABELS[modelPreset],
          currentAssessmentCount: row._count.qualityAssessments,
        };
      }),
      nextCursor: rows.length > limit && page.length
        ? encodeApplicationCursor(annotationFileId, page.at(-1)!)
        : null,
    };
  }

  async apply(
    user: ApiUser,
    annotationFileId: string,
    runId: string,
    request: ApplyAlignmentRunRequest,
  ): Promise<AlignmentApplicationSummary> {
    await this.access.assertCapability(user, annotationFileId, "write");
    const requestHash = createApplicationRequestHash(annotationFileId, runId, request);
    const existing = await this.findExistingApplication(
      user,
      annotationFileId,
      runId,
      request,
      requestHash,
    );
    if (existing) return existing;

    const run = await this.prisma.alignmentRun.findFirst({
      where: { id: runId, annotationFileId, status: "succeeded" },
      include: { artifacts: true },
    });
    const artifact = getSinglePredictionArtifact(run);
    if (!run || !artifact || !isReadablePredictionArtifact(artifact, run.manifest)) {
      throw notFound("可应用的强制对齐结果不存在。");
    }

    let prediction: AlignmentPredictionArtifact;
    try {
      prediction = await readAlignmentPrediction(this.storage, artifact);
    } catch (error) {
      if (error instanceof AlignmentPredictionReadError) {
        throw conflict("强制对齐预测对象已损坏或超过安全容量，不能应用。", {
          code: error.code,
        });
      }
      throw error;
    }
    assertPredictionMatchesRun(prediction, run);

    const current = await this.prisma.annotationFile.findUnique({
      where: { resourceId: annotationFileId },
      select: { revision: true, payload: true },
    });
    if (!current) throw notFound("活动标注文件不存在。");
    if (current.revision !== request.baseRevision) {
      throw conflict("标注文件已变化，请刷新后重新应用强制对齐结果。", {
        code: "alignment_application_revision_conflict",
        expectedRevision: current.revision,
        receivedRevision: request.baseRevision,
      });
    }
    const parsed = parseCurrentProjectData(current.payload);
    if (!parsed.success) {
      throw conflict("当前标注文档格式不完整，不能应用强制对齐结果。", {
        code: "alignment_application_payload_invalid",
      });
    }
    const plan = requireApplicationPlan(parsed.data, prediction);
    const operations = buildApplicationOperations(request.clientActionId, plan.commands);
    const batch: CommitAnnotationCommandBatchRequest = {
      baseRevision: request.baseRevision,
      operations,
    };
    const binding: AlignmentApplicationCommitBinding = {
      id: createApplicationId(annotationFileId, user.id, request.clientActionId),
      alignmentRunId: run.id,
      alignmentArtifactId: artifact.id,
      clientActionId: request.clientActionId,
      requestHash,
      appliedCharacterCount: plan.appliedCharacterCount,
      validateCurrent: async (transaction, _lockedFile, lockedProject) => {
        await this.validateCurrentApplicationFacts(
          transaction,
          user,
          annotationFileId,
          run,
          artifact,
          prediction,
          lockedProject,
          request.clientActionId,
          plan.appliedCharacterCount,
          operations,
        );
      },
    };
    const committed = await this.commandCommits.commitAlignmentApplication(
      user,
      annotationFileId,
      batch,
      binding,
    );
    return mapApplicationSummary(
      committed.application,
      committed.commit.operationCursor,
    );
  }

  private async findExistingApplication(
    user: ApiUser,
    annotationFileId: string,
    runId: string,
    request: ApplyAlignmentRunRequest,
    requestHash: string,
  ) {
    const application = await this.prisma.alignmentApplication.findUnique({
      where: {
        annotationFileId_actorUserId_clientActionId: {
          annotationFileId,
          actorUserId: user.id,
          clientActionId: request.clientActionId,
        },
      },
      include: {
        operations: {
          select: { committedRevision: true },
          orderBy: { sequence: "asc" },
        },
      },
    });
    if (!application) return null;
    if (
      application.alignmentRunId !== runId ||
      application.requestHash !== requestHash ||
      application.baseRevision !== request.baseRevision ||
      application.operations.length !== application.operationCount ||
      application.operations.some((operation) =>
        operation.committedRevision !== application.committedRevision)
    ) {
      throw conflict("clientActionId 已用于另一条或不完整的强制对齐应用。", {
        code: "alignment_application_idempotency_conflict",
      });
    }
    const { operations: _operations, ...row } = application;
    return mapApplicationSummary(
      row,
      encodeAnnotationSnapshotOperationCursor(
        annotationFileId,
        application.committedRevision,
      ),
    );
  }

  private async validateCurrentApplicationFacts(
    transaction: Prisma.TransactionClient,
    user: ApiUser,
    annotationFileId: string,
    preparedRun: AlignmentRunForApplication,
    preparedArtifact: PredictionArtifactMetadata,
    prediction: AlignmentPredictionArtifact,
    lockedProject: ProjectData,
    clientActionId: string,
    preparedCharacterCount: number,
    preparedOperations: AtomicAnnotationCommandOperation[],
  ) {
    const run = await transaction.alignmentRun.findFirst({
      where: { id: preparedRun.id, annotationFileId, status: "succeeded" },
      include: { artifacts: true },
    });
    const artifact = getSinglePredictionArtifact(run);
    if (!run || !artifact ||
        !isReadablePredictionArtifact(artifact, run.manifest) ||
        !sameArtifactMetadata(artifact, preparedArtifact)) {
      throw conflict("强制对齐结果在应用前已经变化。", {
        code: "alignment_application_artifact_changed",
      });
    }
    assertPredictionMatchesRun(prediction, run);
    const projectionResult = buildAlignmentTextProjection(lockedProject);
    if (!projectionResult.ok) {
      throw conflict("当前标注文档已不再满足强制对齐输入条件。", {
        code: "alignment_application_input_changed",
      });
    }
    const textFingerprint = createHash("sha256")
      .update(stableJsonStringify(projectionResult.projection))
      .digest("hex");
    if (
      run.inputTextFingerprint !== textFingerprint ||
      run.inputSentenceCount !== projectionResult.projection.sentences.length ||
      run.inputCharacterCount !== projectionResult.characterCount ||
      prediction.inputTextFingerprint !== textFingerprint
    ) {
      throw conflict("强制对齐结果对应的正文或句级范围已经变化。", {
        code: "alignment_application_input_changed",
      });
    }
    if (!run.mediaAudioTrackId) {
      throw conflict("强制对齐结果的音轨关系已经失效。", {
        code: "alignment_application_source_changed",
      });
    }
    const context = await resolveAnalysisAudioContext(
      transaction,
      this.access,
      user,
      annotationFileId,
      run.mediaAudioTrackId,
    );
    if (context.source.status !== "ready") {
      if (context.source.value.code === "analysis_audio_forbidden") {
        throw analysisAudioForbidden("当前账号已无法读取或下载强制对齐所用音频。");
      }
      throw conflict("当前账号已无法访问强制对齐所用音频。", {
        code: context.source.value.code,
      });
    }
    const source = context.source.value;
    if (
      source.media.resourceId !== run.sourceMediaResourceId ||
      source.mediaFingerprint !== run.sourceFingerprint ||
      BigInt(Math.round(source.offsetSeconds * 1_000_000)) !== run.audioOffsetMicros
    ) {
      throw conflict("强制对齐所用音频或偏移已经变化。", {
        code: "alignment_application_source_changed",
      });
    }

    const currentPlan = requireApplicationPlan(lockedProject, prediction);
    const currentOperations = buildApplicationOperations(
      clientActionId,
      currentPlan.commands,
    );
    if (
      currentPlan.appliedCharacterCount !== preparedCharacterCount ||
      stableJsonStringify(currentOperations) !== stableJsonStringify(preparedOperations)
    ) {
      throw conflict("强制对齐应用计划与当前文档不一致。", {
        code: "alignment_application_plan_changed",
      });
    }
  }
}

function normalizeApplicationLimit(value: number | undefined) {
  const limit = value ?? DEFAULT_APPLICATION_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_APPLICATION_PAGE_LIMIT) {
    throw badRequest(`强制对齐应用历史每页数量必须在 1 到 ${MAX_APPLICATION_PAGE_LIMIT} 之间。`);
  }
  return limit;
}

/** 应用游标绑定文件，不能拿另一个文件的时间锚点探测当前文件历史。 */
function encodeApplicationCursor(
  annotationFileId: string,
  application: { createdAt: Date; id: string },
) {
  return Buffer.from(JSON.stringify({
    version: 1,
    annotationFileId,
    createdAt: application.createdAt.toISOString(),
    id: application.id,
  }), "utf8").toString("base64url");
}

function decodeApplicationCursor(annotationFileId: string, token: string) {
  try {
    const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const cursor = value as {
      version?: unknown;
      annotationFileId?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      cursor.version !== 1 ||
      cursor.annotationFileId !== annotationFileId ||
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      !cursor.id ||
      cursor.id.length > 200
    ) throw new Error();
    const createdAt = new Date(cursor.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== cursor.createdAt) {
      throw new Error();
    }
    return { createdAt, id: cursor.id };
  } catch {
    throw badRequest("强制对齐应用历史分页游标无效，请刷新第一页。");
  }
}

function getSinglePredictionArtifact(run: AlignmentRunForApplication | null) {
  if (!run) return null;
  const predictions = run.artifacts.filter((artifact) => artifact.kind === "prediction");
  return predictions.length === 1 ? predictions[0]! : null;
}

function assertPredictionMatchesRun(
  prediction: AlignmentPredictionArtifact,
  run: AlignmentRunForApplication,
) {
  if (
    prediction.runId !== run.id ||
    prediction.inputRevision !== run.inputRevision ||
    prediction.inputTextFingerprint !== run.inputTextFingerprint ||
    BigInt(prediction.audioOffsetMicros) !== run.audioOffsetMicros
  ) {
    throw conflict("强制对齐预测与运行记录身份不一致。", {
      code: "alignment_application_prediction_identity_mismatch",
    });
  }
}

function requireApplicationPlan(project: ProjectData, prediction: AlignmentPredictionArtifact) {
  const result = buildAlignmentPredictionApplicationPlan(project, prediction);
  if (result.status === "ready") return result.plan;
  if (result.status === "no_changes") {
    throw conflict("当前逐字时间已经与该强制对齐结果一致。", {
      code: "alignment_application_no_changes",
    });
  }
  throw conflict("强制对齐结果不能完整映射到当前逐字轨。", {
    code: result.status === "too_large"
      ? "alignment_application_too_large"
      : "alignment_application_identity_mismatch",
  });
}

function buildApplicationOperations(
  clientActionId: string,
  commands: ReturnType<typeof requireApplicationPlan>["commands"],
): AtomicAnnotationCommandOperation[] {
  return commands.map((payload, index) => ({
    clientOperationId: `alignment-apply:${clientActionId}:${String(index).padStart(2, "0")}`,
    localRevision: null,
    action: payload.command.type,
    payload,
  }));
}

function createApplicationRequestHash(
  annotationFileId: string,
  runId: string,
  request: ApplyAlignmentRunRequest,
) {
  return createHash("sha256").update(stableJsonStringify({
    version: 1,
    annotationFileId,
    runId,
    clientActionId: request.clientActionId,
    baseRevision: request.baseRevision,
  })).digest("hex");
}

function createApplicationId(annotationFileId: string, actorUserId: string, clientActionId: string) {
  const hex = createHash("sha256")
    .update(stableJsonStringify({ annotationFileId, actorUserId, clientActionId }))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sameArtifactMetadata(left: PredictionArtifactMetadata, right: PredictionArtifactMetadata) {
  return left.id === right.id &&
    left.formatVersion === right.formatVersion &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.checksum === right.checksum &&
    left.storageKey === right.storageKey;
}

function mapApplicationSummary(
  application: AlignmentApplication,
  operationCursor: string,
): AlignmentApplicationSummary {
  return {
    id: application.id,
    alignmentRunId: application.alignmentRunId,
    baseRevision: application.baseRevision,
    committedRevision: application.committedRevision,
    operationCount: application.operationCount,
    appliedCharacterCount: application.appliedCharacterCount,
    operationCursor,
    createdAt: application.createdAt.toISOString(),
  };
}
