import { createHash } from "node:crypto";
import {
  AlignmentArtifactKind,
  Prisma,
  ProcessingJobStatus,
  type PrismaClient,
} from "@prisma/client";
import {
  ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT,
  ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION,
  ALIGNMENT_TRAINING_MANIFEST_FORMAT,
  ALIGNMENT_TRAINING_MANIFEST_MAX_GROUPS_PER_ITEM,
  ALIGNMENT_TRAINING_MANIFEST_VERSION,
  buildAlignmentTrainingInputManifest,
  buildAlignmentTrainingManifest,
  canonicalAlignmentTrainingJson,
  parseAlignmentTrainingInputManifest,
  parseAlignmentTrainingManifest,
  parseAlignmentTrainingSourceSnapshot,
  parseAlignmentTrainingTargetSnapshot,
  type AlignmentTrainingManifestItem,
  type AlignmentTrainingSampleDraft,
} from "@xiqu/document-model";
import { parseCurrentProjectData } from "@xiqu/document-model/project-data-schema";
import {
  MAX_PROJECT_ALIGNMENT_RESEARCH_GROUPS,
  normalizeAlignmentResearchGroupDisplayName,
  type AlignmentQualityIssueCode,
  type AlignmentQualityVerdict,
  type AlignmentResearchGroupKind,
  type AlignmentTrainingExportSummary,
  type CreateAlignmentTrainingExportRequest,
} from "@xiqu/shared";
import { stableJsonStringify } from "./annotationOperationIdempotency.js";
import { resolveAnnotationRecoverySnapshotPayload } from "./annotationRecoverySnapshotResolver.js";
import { lockAlignmentResearchGroupCatalog } from "./alignmentResearchGroupService.js";
import { deriveAlignmentTrainingEvidence } from "./alignmentTrainingEvidence.js";
import {
  prepareAlignmentTrainingSource,
  prepareAlignmentTrainingTarget,
  type PreparedAlignmentTrainingSource,
  type PreparedAlignmentTrainingTarget,
} from "./alignmentTrainingExportInput.js";
import type { ReadyAnalysisAudioSource } from "./analysisAudioSourceResolver.js";
import type { ApiUser } from "./domain.js";
import { conflict } from "./errors.js";
import { createMediaAnalysisSourceFingerprint } from "./mediaAnalysisSourceFingerprint.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const MAX_APPLICATION_WINDOW_SCAN_PER_FILE = 5_000;
const MAX_TOTAL_APPLICATION_WINDOW_SCAN = 20_000;
const MAX_OPERATION_SCAN_PER_APPLICATION = 500;
const MAX_ASSESSMENT_SCAN_PER_APPLICATION = 500;

const EXISTING_EXPORT_INCLUDE = {
  items: {
    select: {
      alignmentApplicationId: true,
      alignmentArtifactId: true,
      input: {
        select: {
          sourceFileId: true,
          targetSnapshot: true,
          targetSnapshotChecksum: true,
          targetSentenceCount: true,
          targetCharacterCount: true,
          targetSnapshotBytes: true,
          sourceSnapshot: true,
          sourceSnapshotChecksum: true,
        },
      },
    },
  },
} satisfies Prisma.AlignmentTrainingExportInclude;

type ExistingTrainingExport = Prisma.AlignmentTrainingExportGetPayload<{
  include: typeof EXISTING_EXPORT_INCLUDE;
}>;

const FREEZE_APPLICATION_INCLUDE = {
  run: {
    select: {
      annotationFileIdSnapshot: true,
      manifest: true,
      status: true,
      inputTextFingerprint: true,
      inputSentenceCount: true,
      inputCharacterCount: true,
      sourceMediaResourceId: true,
      sourceMediaResourceIdSnapshot: true,
      sourceFingerprint: true,
      mediaAudioTrackId: true,
      mediaAudioTrackIdSnapshot: true,
      audioOffsetMicros: true,
      sourceMedia: {
        include: {
          resource: {
            select: {
              name: true,
              type: true,
              archivedAt: true,
              trashedAt: true,
            },
          },
          file: {
            select: {
              id: true,
              storageKey: true,
              checksum: true,
              size: true,
            },
          },
        },
      },
      mediaAudioTrack: {
        select: {
          id: true,
          primaryMediaResourceId: true,
          audioMediaResourceId: true,
          vodRenditionMediaResourceId: true,
          vodRenditionJobId: true,
          vodRenditionFormat: true,
          kind: true,
          offsetSeconds: true,
          enabled: true,
        },
      },
    },
  },
  artifact: {
    select: {
      runId: true,
      kind: true,
      formatVersion: true,
      checksum: true,
      size: true,
    },
  },
  annotationFile: { select: { revision: true, payload: true, mediaResourceId: true } },
  _count: {
    select: {
      operations: true,
      qualityAssessments: { where: { supersededAt: null } },
    },
  },
} satisfies Prisma.AlignmentApplicationInclude;

type FreezeApplication = Prisma.AlignmentApplicationGetPayload<{
  include: typeof FREEZE_APPLICATION_INCLUDE;
}>;

type ResourceChainRow = {
  targetId: string;
  resourceId: string;
  parentId: string | null;
  type: string;
  archivedAt: Date | null;
  trashedAt: Date | null;
  depth: number;
};

type ApplicationWindowRow = {
  annotationFileId: string;
  applicationId: string;
  committedRevision: number;
  scanRank: bigint;
};

type WindowOperationRow = {
  selectedApplicationId: string;
  committedRevision: number;
  action: string;
  payload: Prisma.JsonValue;
  alignmentApplicationId: string | null;
  scanRank: bigint;
};

type ProjectContext = {
  projectResourceId: string;
  researchGroupRevision: number;
  groups: Array<{
    id: string;
    kind: AlignmentResearchGroupKind;
    displayName: string;
  }>;
};

type PreparedSample = {
  draft: AlignmentTrainingSampleDraft;
  project: ProjectContext;
  targetRevision: number;
};

type PreparedExportInput = {
  target: PreparedAlignmentTrainingTarget;
  source: PreparedAlignmentTrainingSource;
};

type HistoricalTargetSnapshotRow = {
  id: string;
  annotationFileId: string;
  revision: number;
  storageMode: string;
  payload: Prisma.JsonValue;
  payloadSha256: string | null;
};

/**
 * 冻结服务把一组显式 application 收敛为不可变训练 provenance。
 * 它只读取现有事实并追加冻结表，绝不修改在线标注内容、revision、operation 或审核记录。
 */
export class AlignmentTrainingExportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async freeze(
    user: ApiUser,
    input: CreateAlignmentTrainingExportRequest,
  ): Promise<AlignmentTrainingExportSummary> {
    const requestHash = createRequestHash(input);
    // Serializable 能冻结一致快照，但并发同 action 的较旧快照可能被 PostgreSQL 主动中止；只对 P2034 有限重开事务。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (transaction) => {
          // action lock 是幂等边界；相同浏览器动作在模糊响应重试时只能得到同一冻结事实。
          await transaction.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtext(${`xiqu:alignment-training-export:${user.id}:${input.clientActionId}`})
            )::text AS locked
          `;
          await this.access.assertFullResourceAccess(user, transaction);

          const existing = await transaction.alignmentTrainingExport.findUnique({
            where: {
              createdBy_clientActionId: {
                createdBy: user.id,
                clientActionId: input.clientActionId,
              },
            },
            include: EXISTING_EXPORT_INCLUDE,
          });
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw conflict("clientActionId 已用于另一份训练冻结请求。", {
                code: "alignment_training_export_action_conflict",
              });
            }
            return mapExistingExport(existing);
          }

          // 分组 catalog 与资源树都在读取前锁定；冻结期间项目不能被重分组、移动、归档或回收。
          await lockAlignmentResearchGroupCatalog(transaction);
          await transaction.$executeRaw`
            SELECT pg_advisory_xact_lock_shared(hashtext('xiqu:resource-tree:mutation'))
          `;

          const applications = await loadSelectedApplications(transaction, input.applicationIds);
          const projectIdByFileId = await loadActiveProjectContexts(
            transaction,
            [...new Set(applications.map(({ annotationFileId }) => annotationFileId))],
          );
          const projectContexts = await loadAndLockProjectGroups(
            transaction,
            [...new Set(projectIdByFileId.values())].sort(),
          );
          const observationEndByApplicationId = await loadObservationWindows(transaction, applications);
          const operationsByApplicationId = await loadWindowOperations(
            transaction,
            applications,
            observationEndByApplicationId,
          );
          const assessmentsByApplicationId = await loadCurrentAssessments(transaction, applications);

          const prepared = applications.map((application) => prepareSample(
            application,
            observationEndByApplicationId.get(application.id),
            operationsByApplicationId.get(application.id) ?? [],
            assessmentsByApplicationId.get(application.id) ?? [],
            projectContexts.get(projectIdByFileId.get(application.annotationFileId) ?? ""),
          ));
          const preparedInputs = await prepareExportInputs(transaction, applications, prepared);
          const built = buildAlignmentTrainingManifest({
            splitSeedHash: input.splitSeedHash,
            splitRatios: input.splitRatios,
            samples: prepared.map(({ draft }) => draft),
          }, sha256Hex);
          if (!built.ok) {
            throw conflict("所选候选未通过训练清单冻结规则。", {
              code: "alignment_training_export_planner_rejected",
              issues: built.issues,
            });
          }
          const inputManifest = buildAlignmentTrainingInputManifest({
            provenanceManifestChecksum: built.manifest.checksum,
            items: built.manifest.items.map((item) => {
              const input = requireMapValue(preparedInputs, item.alignmentApplicationId);
              return {
                alignmentApplicationId: item.alignmentApplicationId,
                alignmentArtifactId: item.alignmentArtifactId,
                artifactChecksum: item.artifact.checksum,
                targetSnapshotChecksum: input.target.checksum,
                targetSentenceCount: input.target.snapshot.sentenceCount,
                targetCharacterCount: input.target.snapshot.characterCount,
                targetSnapshotBytes: input.target.bytes,
                sourceSnapshotChecksum: input.source.checksum,
              };
            }),
          }, sha256Hex);
          if (!inputManifest.ok) {
            throw conflict("训练冻结输入超过容量或未通过完整性规则。", {
              code: "alignment_training_export_input_invalid",
              issues: inputManifest.issues,
            });
          }

          const preparedByApplicationId = new Map(
            prepared.map((sample) => [sample.draft.alignmentApplicationId, sample]),
          );
          if (built.manifest.items.length !== preparedByApplicationId.size) {
            throw new Error("训练 manifest 与候选数量不一致。");
          }
          const manifestJson = JSON.parse(built.canonicalJson) as Prisma.InputJsonValue;
          const created = await transaction.alignmentTrainingExport.create({
            data: {
              createdBy: user.id,
              clientActionId: input.clientActionId,
              requestHash,
              manifestFormat: ALIGNMENT_TRAINING_MANIFEST_FORMAT,
              manifestVersion: ALIGNMENT_TRAINING_MANIFEST_VERSION,
              manifestChecksum: built.manifest.checksum,
              manifest: manifestJson,
              splitSeedHash: built.manifest.splitSeedHash,
              splitRatios: built.manifest.splitRatios,
              splitCounts: built.manifest.splitCounts,
              sampleCount: built.manifest.sampleCount,
              componentCount: built.manifest.componentCount,
              inputManifestFormat: ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT,
              inputManifestVersion: ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION,
              inputManifestChecksum: inputManifest.manifest.checksum,
              inputManifest: JSON.parse(inputManifest.canonicalJson) as Prisma.InputJsonValue,
              targetSentenceCount: inputManifest.manifest.targetSentenceCount,
              targetCharacterCount: inputManifest.manifest.targetCharacterCount,
              targetSnapshotBytes: inputManifest.manifest.targetSnapshotBytes,
              items: {
                create: built.manifest.items.map((item) => {
                  const sample = preparedByApplicationId.get(item.alignmentApplicationId);
                  if (!sample) throw new Error("训练冻结样本映射不完整。");
                  return mapItemCreate(
                    item,
                    sample,
                    requireMapValue(preparedInputs, item.alignmentApplicationId),
                  );
                }),
              },
            },
          });
          await transaction.auditLog.create({
            data: {
              action: "alignment_training_export_freeze",
              actorUserId: user.id,
              detail: {
                exportId: created.id,
                manifestChecksum: built.manifest.checksum,
                sampleCount: built.manifest.sampleCount,
                componentCount: built.manifest.componentCount,
                splitCounts: built.manifest.splitCounts,
                inputManifestChecksum: inputManifest.manifest.checksum,
                targetCharacterCount: inputManifest.manifest.targetCharacterCount,
                targetSnapshotBytes: inputManifest.manifest.targetSnapshotBytes,
              },
            },
          });
          return mapManifestSummary(created.id, created.createdAt, built.manifest);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!isSerializableWriteConflict(error)) throw error;
        if (attempt === 2) {
          throw conflict("训练冻结遇到持续并发更新，请复用同一动作稍后重试。", {
            code: "alignment_training_export_retry_required",
          });
        }
      }
    }
    throw new Error("训练冻结事务未返回结果。");
  }
}

async function loadSelectedApplications(
  transaction: Prisma.TransactionClient,
  applicationIds: readonly string[],
) {
  const applications = await transaction.alignmentApplication.findMany({
    where: { id: { in: [...applicationIds] } },
    include: FREEZE_APPLICATION_INCLUDE,
    orderBy: [{ annotationFileId: "asc" }, { committedRevision: "asc" }, { id: "asc" }],
  });
  if (applications.length !== applicationIds.length) {
    throw conflict("所选强制对齐 application 不完整或已不存在。", {
      code: "alignment_training_export_selection_incomplete",
    });
  }
  for (const application of applications) validateApplicationRelation(application);
  return applications;
}

function validateApplicationRelation(application: FreezeApplication) {
  const artifactSize = Number(application.artifact.size);
  if (
    application.run.status !== ProcessingJobStatus.succeeded ||
    application.run.annotationFileIdSnapshot !== application.annotationFileId ||
    application.artifact.runId !== application.alignmentRunId ||
    application.artifact.kind !== AlignmentArtifactKind.prediction ||
    application.artifact.formatVersion !== 1 ||
    !Number.isSafeInteger(artifactSize) || artifactSize < 1 ||
    application._count.operations !== application.operationCount ||
    application.committedRevision !== application.baseRevision + 1 ||
    application.annotationFile.revision < application.committedRevision
  ) {
    throw conflict("强制对齐 application、run、artifact 或 revision 关系不完整。", {
      code: "alignment_training_export_selection_incomplete",
    });
  }
  if (application._count.qualityAssessments > MAX_ASSESSMENT_SCAN_PER_APPLICATION) {
    throw conflict("所选 application 的当前质量评价超过冻结扫描上限。", {
      code: "alignment_training_export_evidence_partial",
    });
  }
}

async function loadActiveProjectContexts(
  transaction: Prisma.TransactionClient,
  annotationFileIds: readonly string[],
) {
  const rows = await transaction.$queryRaw<ResourceChainRow[]>(Prisma.sql`
    WITH RECURSIVE resource_chain AS (
      SELECT
        resource."id" AS "targetId",
        resource."id" AS "resourceId",
        resource."parent_id" AS "parentId",
        resource."type"::text AS "type",
        resource."archived_at" AS "archivedAt",
        resource."trashed_at" AS "trashedAt",
        0 AS "depth",
        ARRAY[resource."id"]::text[] AS "path"
      FROM "resource_entries" AS resource
      WHERE resource."id" IN (${Prisma.join(annotationFileIds)})

      UNION ALL

      SELECT
        child."targetId",
        parent."id",
        parent."parent_id",
        parent."type"::text,
        parent."archived_at",
        parent."trashed_at",
        child."depth" + 1,
        child."path" || parent."id"
      FROM resource_chain AS child
      INNER JOIN "resource_entries" AS parent ON parent."id" = child."parentId"
      WHERE child."depth" < 255
        AND NOT parent."id" = ANY(child."path")
    )
    SELECT "targetId", "resourceId", "parentId", "type", "archivedAt", "trashedAt", "depth"
    FROM resource_chain
    ORDER BY "targetId" ASC, "depth" ASC
  `);
  const rowsByTarget = groupBy(rows, ({ targetId }) => targetId);
  const projectIdByFileId = new Map<string, string>();
  for (const annotationFileId of annotationFileIds) {
    const chain = rowsByTarget.get(annotationFileId) ?? [];
    const target = chain[0];
    const tail = chain.at(-1);
    const project = chain.find(({ type }) => type === "project");
    if (
      !target || target.depth !== 0 || target.type !== "annotation_file" ||
      !tail || tail.parentId !== null ||
      chain.some(({ archivedAt, trashedAt }) => archivedAt !== null || trashedAt !== null) ||
      !project
    ) {
      throw conflict("所选 application 所属文件或项目不再处于活动资源树。", {
        code: "alignment_training_export_resource_inactive",
      });
    }
    projectIdByFileId.set(annotationFileId, project.resourceId);
  }
  return projectIdByFileId;
}

async function loadAndLockProjectGroups(
  transaction: Prisma.TransactionClient,
  projectResourceIds: readonly string[],
) {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "resource_id"
    FROM "project_metadata"
    WHERE "resource_id" IN (${Prisma.join(projectResourceIds)})
    ORDER BY "resource_id"
    FOR UPDATE
  `);
  const metadata = await transaction.projectMetadata.findMany({
    where: { resourceId: { in: [...projectResourceIds] } },
    select: { resourceId: true, researchGroupRevision: true },
    orderBy: { resourceId: "asc" },
  });
  if (metadata.length !== projectResourceIds.length) {
    throw conflict("项目研究分组元数据不完整。", {
      code: "alignment_training_export_group_incomplete",
    });
  }
  const maxRows = projectResourceIds.length * (MAX_PROJECT_ALIGNMENT_RESEARCH_GROUPS + 1);
  const links = await transaction.projectAlignmentResearchGroup.findMany({
    where: { projectResourceId: { in: [...projectResourceIds] } },
    select: {
      projectResourceId: true,
      group: { select: { id: true, kind: true, displayName: true } },
    },
    orderBy: [
      { projectResourceId: "asc" },
      { group: { kind: "asc" } },
      { researchGroupId: "asc" },
    ],
    take: maxRows + 1,
  });
  if (links.length > maxRows) {
    throw conflict("项目研究分组超过冻结扫描上限。", {
      code: "alignment_training_export_group_incomplete",
    });
  }
  const linksByProject = groupBy(links, ({ projectResourceId }) => projectResourceId);
  const contexts = new Map<string, ProjectContext>();
  for (const row of metadata) {
    const groups = (linksByProject.get(row.resourceId) ?? []).map(({ group }) => ({
      id: group.id,
      kind: group.kind as AlignmentResearchGroupKind,
      displayName: group.displayName,
    }));
    const kinds = new Set(groups.map(({ kind }) => kind));
    if (
      groups.length > MAX_PROJECT_ALIGNMENT_RESEARCH_GROUPS ||
      groups.length > ALIGNMENT_TRAINING_MANIFEST_MAX_GROUPS_PER_ITEM ||
      groups.some(({ displayName }) =>
        normalizeAlignmentResearchGroupDisplayName(displayName) !== displayName) ||
      !kinds.has("work") || !kinds.has("performer")
    ) {
      throw conflict("每个训练项目必须具有可冻结的 work 与 performer 研究分组。", {
        code: "alignment_training_export_group_incomplete",
        projectResourceId: row.resourceId,
      });
    }
    contexts.set(row.resourceId, {
      projectResourceId: row.resourceId,
      researchGroupRevision: row.researchGroupRevision,
      groups,
    });
  }
  return contexts;
}

async function loadObservationWindows(
  transaction: Prisma.TransactionClient,
  applications: readonly FreezeApplication[],
) {
  const minimumRevisionByFile = new Map<string, number>();
  for (const application of applications) {
    const current = minimumRevisionByFile.get(application.annotationFileId);
    minimumRevisionByFile.set(
      application.annotationFileId,
      current === undefined ? application.committedRevision : Math.min(current, application.committedRevision),
    );
  }
  const bounds = [...minimumRevisionByFile.entries()].map(([fileId, revision]) =>
    Prisma.sql`(${fileId}::text, ${revision}::integer)`);
  const rows = await transaction.$queryRaw<ApplicationWindowRow[]>(Prisma.sql`
    WITH bounds("annotationFileId", "minimumRevision") AS (
      VALUES ${Prisma.join(bounds)}
    ), ranked AS (
      SELECT
        application."annotation_file_id" AS "annotationFileId",
        application."id" AS "applicationId",
        application."committed_revision" AS "committedRevision",
        ROW_NUMBER() OVER (
          PARTITION BY application."annotation_file_id"
          ORDER BY application."committed_revision" ASC, application."id" ASC
        ) AS "scanRank"
      FROM "alignment_applications" AS application
      INNER JOIN bounds
        ON bounds."annotationFileId" = application."annotation_file_id"
       AND application."committed_revision" > bounds."minimumRevision"
    )
    SELECT "annotationFileId", "applicationId", "committedRevision", "scanRank"
    FROM ranked
    WHERE "scanRank" <= ${MAX_APPLICATION_WINDOW_SCAN_PER_FILE + 1}
    ORDER BY "annotationFileId" ASC, "committedRevision" ASC, "applicationId" ASC
    LIMIT ${MAX_TOTAL_APPLICATION_WINDOW_SCAN + 1}
  `);
  if (
    rows.length > MAX_TOTAL_APPLICATION_WINDOW_SCAN ||
    rows.some(({ scanRank }) => scanRank > BigInt(MAX_APPLICATION_WINDOW_SCAN_PER_FILE))
  ) {
    throw conflict("所选 application 的观察窗口超过冻结扫描上限。", {
      code: "alignment_training_export_evidence_partial",
    });
  }
  const rowsByFile = groupBy(rows, ({ annotationFileId }) => annotationFileId);
  const result = new Map<string, number>();
  for (const application of applications) {
    const subsequent = rowsByFile.get(application.annotationFileId) ?? [];
    const nextRevision = findFirstGreaterRevision(subsequent, application.committedRevision);
    const observationEnd = nextRevision ?? application.annotationFile.revision;
    if (observationEnd < application.committedRevision || observationEnd > application.annotationFile.revision) {
      throw conflict("所选 application 的观察 revision 关系不完整。", {
        code: "alignment_training_export_selection_incomplete",
      });
    }
    result.set(application.id, observationEnd);
  }
  return result;
}

async function loadWindowOperations(
  transaction: Prisma.TransactionClient,
  applications: readonly FreezeApplication[],
  observationEndByApplicationId: ReadonlyMap<string, number>,
) {
  const windows = applications.map((application) => Prisma.sql`(
    ${application.id}::text,
    ${application.annotationFileId}::text,
    ${application.committedRevision}::integer,
    ${requireMapValue(observationEndByApplicationId, application.id)}::integer
  )`);
  const globalLimit = applications.length * (MAX_OPERATION_SCAN_PER_APPLICATION + 1);
  const rows = await transaction.$queryRaw<WindowOperationRow[]>(Prisma.sql`
    WITH windows("selectedApplicationId", "annotationFileId", "startRevision", "endRevision") AS (
      VALUES ${Prisma.join(windows)}
    ), ranked AS (
      SELECT
        windows."selectedApplicationId",
        operation."committed_revision" AS "committedRevision",
        operation."action",
        operation."payload",
        operation."alignment_application_id" AS "alignmentApplicationId",
        ROW_NUMBER() OVER (
          PARTITION BY windows."selectedApplicationId"
          ORDER BY operation."committed_revision" DESC, operation."sequence" DESC
        ) AS "scanRank"
      FROM windows
      INNER JOIN "annotation_operations" AS operation
        ON operation."annotation_file_id" = windows."annotationFileId"
       AND operation."committed_revision" > windows."startRevision"
       AND operation."committed_revision" <= windows."endRevision"
    )
    SELECT "selectedApplicationId", "committedRevision", "action", "payload", "alignmentApplicationId", "scanRank"
    FROM ranked
    WHERE "scanRank" <= ${MAX_OPERATION_SCAN_PER_APPLICATION + 1}
    ORDER BY "selectedApplicationId" ASC, "scanRank" ASC
    LIMIT ${globalLimit + 1}
  `);
  if (
    rows.length > globalLimit ||
    rows.some(({ scanRank }) => scanRank > BigInt(MAX_OPERATION_SCAN_PER_APPLICATION))
  ) {
    throw conflict("所选 application 的 operation 观察窗口不完整。", {
      code: "alignment_training_export_evidence_partial",
    });
  }
  return groupBy(rows, ({ selectedApplicationId }) => selectedApplicationId);
}

async function loadCurrentAssessments(
  transaction: Prisma.TransactionClient,
  applications: readonly FreezeApplication[],
) {
  const maxRows = applications.length * MAX_ASSESSMENT_SCAN_PER_APPLICATION;
  const rows = await transaction.alignmentQualityAssessment.findMany({
    where: {
      alignmentApplicationId: { in: applications.map(({ id }) => id) },
      supersededAt: null,
    },
    select: {
      id: true,
      alignmentApplicationId: true,
      verdict: true,
      issueCodes: true,
    },
    orderBy: [{ alignmentApplicationId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: maxRows + 1,
  });
  if (rows.length > maxRows) {
    throw conflict("所选 application 的当前质量评价不完整。", {
      code: "alignment_training_export_evidence_partial",
    });
  }
  return groupBy(rows, ({ alignmentApplicationId }) => alignmentApplicationId);
}

function prepareSample(
  application: FreezeApplication,
  observationEndRevision: number | undefined,
  operations: readonly WindowOperationRow[],
  assessments: ReadonlyArray<{
    id: string;
    verdict: AlignmentQualityVerdict;
    issueCodes: AlignmentQualityIssueCode[];
  }>,
  project: ProjectContext | undefined,
): PreparedSample {
  if (observationEndRevision === undefined || !project) {
    throw conflict("训练候选的观察窗口或项目分组上下文不完整。", {
      code: "alignment_training_export_selection_incomplete",
    });
  }
  const evidence = deriveAlignmentTrainingEvidence({
    id: application.id,
    alignmentRunId: application.alignmentRunId,
    alignmentArtifactId: application.alignmentArtifactId,
    baseRevision: application.baseRevision,
    committedRevision: application.committedRevision,
    createdAt: application.createdAt,
    runManifest: application.run.manifest,
    currentAssessments: assessments,
  }, observationEndRevision, operations, true);
  if (evidence.candidate.evidenceState !== "complete") {
    throw conflict("训练候选证据损坏，不能冻结。", {
      code: "alignment_training_export_evidence_invalid",
      alignmentApplicationId: application.id,
    });
  }
  if (evidence.quality.assessmentIds.length === 0) {
    throw conflict("训练候选尚未进行质量评价。", {
      code: "alignment_training_export_unrated",
      alignmentApplicationId: application.id,
    });
  }
  if (evidence.quality.verdict === "unusable") {
    throw conflict("质量评价为不可用的候选不能进入训练清单。", {
      code: "alignment_training_export_unusable",
      alignmentApplicationId: application.id,
    });
  }
  return {
    draft: {
      alignmentApplicationId: application.id,
      alignmentRunId: application.alignmentRunId,
      alignmentArtifactId: application.alignmentArtifactId,
      annotationFileId: application.annotationFileId,
      baseRevision: application.baseRevision,
      committedRevision: application.committedRevision,
      observationEndRevision,
      artifact: {
        checksum: application.artifact.checksum,
        size: Number(application.artifact.size),
        formatVersion: application.artifact.formatVersion,
      },
      predictionSummaryState: evidence.candidate.predictionSummaryState,
      evidenceState: evidence.candidate.evidenceState,
      unrated: false,
      manualTiming: evidence.candidate.manualTiming,
      quality: evidence.quality,
      signals: evidence.candidate.signals,
      groupReferences: project.groups.map(({ id, kind }) => ({ id, kind })),
    },
    project,
    targetRevision: evidence.quality.verdict === "correct"
      ? application.committedRevision
      : observationEndRevision,
  };
}

/**
 * 一次批量读取精确历史 target；任何缺失都整批失败，不能把当前 payload 当成历史 revision 的替代品。
 * 来源事实已随 application include 一次取回，避免为最多 200 个样本制造逐项查询。
 */
async function prepareExportInputs(
  transaction: Prisma.TransactionClient,
  applications: readonly FreezeApplication[],
  samples: readonly PreparedSample[],
) {
  const sampleByApplicationId = new Map(
    samples.map((sample) => [sample.draft.alignmentApplicationId, sample]),
  );
  const historicalTargets = applications.flatMap((application) => {
    const sample = requireMapValue(sampleByApplicationId, application.id);
    if (sample.targetRevision === application.annotationFile.revision) return [];
    if (sample.targetRevision > application.annotationFile.revision) {
      throw conflict("训练目标 revision 晚于当前文件。", {
        code: "alignment_training_export_target_unavailable",
      });
    }
    return [{ annotationFileId: application.annotationFileId, revision: sample.targetRevision }];
  });
  const historicalRows = historicalTargets.length === 0
    ? []
    : await loadHistoricalTargetSnapshots(transaction, historicalTargets);
  const historicalByKey = new Map(
    historicalRows.map((row) => [targetSnapshotKey(row.annotationFileId, row.revision), row]),
  );
  const result = new Map<string, PreparedExportInput>();

  for (const application of applications) {
    const sample = requireMapValue(sampleByApplicationId, application.id);
    const payload = sample.targetRevision === application.annotationFile.revision
      ? application.annotationFile.payload
      : resolveHistoricalTargetPayload(
          historicalByKey.get(targetSnapshotKey(application.annotationFileId, sample.targetRevision)),
        );
    const parsed = parseCurrentProjectData(payload);
    if (!parsed.success) {
      throw conflict("训练目标快照不是当前可解释的标注文档格式。", {
        code: "alignment_training_export_target_unavailable",
      });
    }
    const target = prepareAlignmentTrainingTarget(parsed.data, {
      inputTextFingerprint: application.run.inputTextFingerprint,
      inputSentenceCount: application.run.inputSentenceCount,
      inputCharacterCount: application.run.inputCharacterCount,
    }, sha256Hex);
    if (!target.ok) {
      throw conflict("训练目标与原强制对齐输入不再一致。", {
        code: target.code === "target_projection_mismatch"
          ? "alignment_training_export_target_projection_mismatch"
          : "alignment_training_export_target_invalid",
      });
    }
    const resolvedSource = resolveFrozenRunAudioSource(application);
    if (!resolvedSource) {
      throw conflict("强制对齐音频来源已变化或不再可用于训练导出。", {
        code: "alignment_training_export_source_unavailable",
      });
    }
    const source = prepareAlignmentTrainingSource(
      resolvedSource,
      application.run.audioOffsetMicros,
      sha256Hex,
    );
    if (!source.ok) {
      throw conflict("强制对齐音频来源快照不完整。", {
        code: "alignment_training_export_source_invalid",
      });
    }
    result.set(application.id, { target: target.value, source: source.value });
  }
  return result;
}

async function loadHistoricalTargetSnapshots(
  transaction: Prisma.TransactionClient,
  targets: ReadonlyArray<{ annotationFileId: string; revision: number }>,
) {
  const uniqueTargets = [...new Map(targets.map((target) => [
    targetSnapshotKey(target.annotationFileId, target.revision),
    target,
  ])).values()];
  const values = uniqueTargets.map((target) =>
    Prisma.sql`(${target.annotationFileId}::text, ${target.revision}::integer)`);
  const rows = await transaction.$queryRaw<HistoricalTargetSnapshotRow[]>(Prisma.sql`
    WITH targets("annotationFileId", "revision") AS (
      VALUES ${Prisma.join(values)}
    )
    SELECT
      snapshot."id",
      snapshot."annotation_file_id" AS "annotationFileId",
      snapshot."revision",
      snapshot."storage_mode"::text AS "storageMode",
      snapshot."payload",
      snapshot."payload_sha256" AS "payloadSha256"
    FROM "annotation_recovery_snapshots" AS snapshot
    INNER JOIN targets
      ON targets."annotationFileId" = snapshot."annotation_file_id"
     AND targets."revision" = snapshot."revision"
    ORDER BY snapshot."annotation_file_id" ASC, snapshot."revision" ASC
  `);
  if (rows.length !== uniqueTargets.length) {
    throw conflict("训练目标 revision 缺少精确恢复快照。", {
      code: "alignment_training_export_target_unavailable",
    });
  }
  return rows;
}

function resolveHistoricalTargetPayload(row: HistoricalTargetSnapshotRow | undefined) {
  if (!row) {
    throw conflict("训练目标 revision 缺少精确恢复快照。", {
      code: "alignment_training_export_target_unavailable",
    });
  }
  const resolved = resolveAnnotationRecoverySnapshotPayload(row);
  if (!resolved.ok) {
    throw conflict("训练目标恢复快照当前不可安全解析。", {
      code: "alignment_training_export_target_unavailable",
      reason: resolved.code,
    });
  }
  return resolved.payload;
}

function targetSnapshotKey(annotationFileId: string, revision: number) {
  return `${annotationFileId}:${revision}`;
}

/** 当前关系必须仍能重建 run 的同一稳定来源；这里只返回稳定事实，不请求 VOD 播放地址。 */
function resolveFrozenRunAudioSource(
  application: FreezeApplication,
): ReadyAnalysisAudioSource | null {
  const { run } = application;
  const media = run.sourceMedia;
  const track = run.mediaAudioTrack;
  if (
    !media ||
    !track ||
    !track.enabled ||
    run.sourceMediaResourceId !== media.resourceId ||
    run.sourceMediaResourceIdSnapshot !== media.resourceId ||
    run.mediaAudioTrackId !== track.id ||
    run.mediaAudioTrackIdSnapshot !== track.id ||
    application.annotationFile.mediaResourceId !== track.primaryMediaResourceId ||
    media.resource.type !== "media_file" ||
    media.resource.archivedAt ||
    media.resource.trashedAt
  ) return null;

  let sourceVodRenditionJobId: string | null = null;
  if (track.kind === "original") {
    if (track.primaryMediaResourceId !== media.resourceId) return null;
  } else if (track.audioMediaResourceId === media.resourceId && media.mediaKind === "audio") {
    // 平台上传或独立 VOD 音频沿用媒体本身的稳定 fingerprint。
  } else if (
    track.vodRenditionMediaResourceId === media.resourceId &&
    track.vodRenditionJobId &&
    track.vodRenditionFormat === "mp3" &&
    media.sourceType === "aliyun_vod" &&
    media.mediaKind === "video"
  ) {
    sourceVodRenditionJobId = track.vodRenditionJobId;
  } else {
    return null;
  }

  let currentFingerprint: string | null;
  try {
    currentFingerprint = sourceVodRenditionJobId
      ? createMediaAnalysisSourceFingerprint({
          sourceType: "aliyun_vod_rendition",
          mediaResourceId: media.resourceId,
          region: media.aliyunVodRegion,
          videoId: media.aliyunVodVideoId,
          jobId: sourceVodRenditionJobId,
          format: "mp3",
        })
      : createMediaAnalysisSourceFingerprint(
          media.sourceType === "uploaded"
            ? {
                sourceType: "uploaded",
                mediaResourceId: media.resourceId,
                fileId: media.file?.id ?? null,
                checksum: media.file?.checksum ?? null,
                size: media.file?.size ?? null,
              }
            : {
                sourceType: "aliyun_vod",
                mediaResourceId: media.resourceId,
                region: media.aliyunVodRegion,
                videoId: media.aliyunVodVideoId,
                duration: media.duration,
              },
        );
  } catch {
    return null;
  }
  if (!currentFingerprint || currentFingerprint !== run.sourceFingerprint) return null;
  return {
    offsetSeconds: track.offsetSeconds,
    media,
    mediaFingerprint: currentFingerprint,
    sourceVodRenditionJobId,
  };
}

function mapItemCreate(
  item: AlignmentTrainingManifestItem,
  sample: PreparedSample,
  input: PreparedExportInput,
) {
  return {
    alignmentApplicationId: item.alignmentApplicationId,
    annotationFileIdSnapshot: item.annotationFileId,
    projectResourceIdSnapshot: sample.project.projectResourceId,
    projectResearchGroupRevision: sample.project.researchGroupRevision,
    alignmentRunId: item.alignmentRunId,
    alignmentArtifactId: item.alignmentArtifactId,
    baseRevision: item.baseRevision,
    committedRevision: item.committedRevision,
    observationEndRevision: item.observationEndRevision,
    targetMode: item.target.mode,
    targetRevision: item.target.revision,
    groupComponentHash: item.groupComponentHash,
    split: item.split,
    snapshot: item as unknown as Prisma.InputJsonValue,
    groups: {
      create: sample.project.groups.map((group) => ({
        researchGroupId: group.id,
        projectResourceIdSnapshot: sample.project.projectResourceId,
        kind: group.kind,
        displayNameSnapshot: group.displayName,
      })),
    },
    input: {
      create: {
        sourceFileId: input.source.sourceFileId,
        targetSnapshot: input.target.snapshot as unknown as Prisma.InputJsonValue,
        targetSnapshotChecksum: input.target.checksum,
        targetSentenceCount: input.target.snapshot.sentenceCount,
        targetCharacterCount: input.target.snapshot.characterCount,
        targetSnapshotBytes: input.target.bytes,
        sourceSnapshot: input.source.snapshot as unknown as Prisma.InputJsonValue,
        sourceSnapshotChecksum: input.source.checksum,
      },
    },
  };
}

function createRequestHash(input: CreateAlignmentTrainingExportRequest) {
  return sha256Hex(stableJsonStringify({
    version: 1,
    clientActionId: input.clientActionId,
    applicationIds: input.applicationIds,
    splitSeedHash: input.splitSeedHash,
    splitRatios: input.splitRatios,
  }));
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function mapExistingExport(row: ExistingTrainingExport) {
  const parsed = parseAlignmentTrainingManifest(row.manifest, sha256Hex);
  if (
    !parsed.ok ||
    row.manifestFormat !== ALIGNMENT_TRAINING_MANIFEST_FORMAT ||
    row.manifestVersion !== ALIGNMENT_TRAINING_MANIFEST_VERSION ||
    parsed.value.checksum !== row.manifestChecksum ||
    parsed.value.splitSeedHash !== row.splitSeedHash ||
    parsed.value.sampleCount !== row.sampleCount ||
    parsed.value.componentCount !== row.componentCount ||
    stableJsonStringify(parsed.value.splitRatios) !== stableJsonStringify(row.splitRatios) ||
    stableJsonStringify(parsed.value.splitCounts) !== stableJsonStringify(row.splitCounts)
  ) {
    throw conflict("已冻结训练清单的完整性校验失败。", {
      code: "alignment_training_export_corrupt",
    });
  }
  const inputColumns = [
    row.inputManifestFormat,
    row.inputManifestVersion,
    row.inputManifestChecksum,
    row.inputManifest,
    row.targetSentenceCount,
    row.targetCharacterCount,
    row.targetSnapshotBytes,
  ];
  const presentInputColumns = inputColumns.filter((value) => value !== null).length;
  if (presentInputColumns === 0) {
    // 迁移前冻结记录没有输入行；顶层全空且逐项也全空时，仍可作为 provenance-only 结果读取。
    if (row.items.some((item) => item.input !== null)) throwCorruptExport();
  } else {
    const inputParsed = parseAlignmentTrainingInputManifest(row.inputManifest, sha256Hex);
    if (
      presentInputColumns !== inputColumns.length ||
      !inputParsed.ok ||
      row.inputManifestFormat !== ALIGNMENT_TRAINING_INPUT_MANIFEST_FORMAT ||
      row.inputManifestVersion !== ALIGNMENT_TRAINING_INPUT_MANIFEST_VERSION ||
      row.inputManifestChecksum !== inputParsed.manifest.checksum ||
      inputParsed.manifest.provenanceManifestChecksum !== row.manifestChecksum ||
      row.targetSentenceCount !== inputParsed.manifest.targetSentenceCount ||
      row.targetCharacterCount !== inputParsed.manifest.targetCharacterCount ||
      row.targetSnapshotBytes !== inputParsed.manifest.targetSnapshotBytes
    ) {
      throwCorruptExport();
    }
    validateStoredExportInputRows(row, parsed.value, inputParsed.manifest);
  }
  return mapManifestSummary(row.id, row.createdAt, parsed.value);
}

/**
 * 幂等重放必须验证真实输入行，而不能只信任顶层 manifest。后续 worker 会再次执行相同边界校验，
 * 这里先阻止缺行、换 artifact、篡改 target/source 或错误 FileObject 关系被伪装成健康冻结结果。
 */
function validateStoredExportInputRows(
  row: ExistingTrainingExport,
  provenance: Extract<ReturnType<typeof parseAlignmentTrainingManifest>, { ok: true }>["value"],
  inputManifest: Extract<ReturnType<typeof parseAlignmentTrainingInputManifest>, { ok: true }>["manifest"],
) {
  if (row.items.length !== inputManifest.itemCount || provenance.items.length !== row.items.length) {
    throwCorruptExport();
  }
  const storedByApplicationId = new Map(
    row.items.map((item) => [item.alignmentApplicationId, item]),
  );
  const provenanceByApplicationId = new Map(
    provenance.items.map((item) => [item.alignmentApplicationId, item]),
  );
  for (const item of inputManifest.items) {
    const stored = storedByApplicationId.get(item.alignmentApplicationId);
    const provenanceItem = provenanceByApplicationId.get(item.alignmentApplicationId);
    if (
      !stored?.input ||
      !provenanceItem ||
      stored.alignmentArtifactId !== item.alignmentArtifactId ||
      provenanceItem.alignmentArtifactId !== item.alignmentArtifactId ||
      provenanceItem.artifact.checksum !== item.artifactChecksum
    ) throwCorruptExport();

    const target = parseAlignmentTrainingTargetSnapshot(stored.input.targetSnapshot);
    const source = parseAlignmentTrainingSourceSnapshot(stored.input.sourceSnapshot);
    if (!target.ok || !source.ok) throwCorruptExport();
    const targetJson = canonicalAlignmentTrainingJson(target.value);
    const targetChecksum = sha256Hex(targetJson);
    const sourceChecksum = sha256Hex(canonicalAlignmentTrainingJson(source.value));
    const expectedSourceFileId = source.value.kind === "uploaded" ? source.value.fileId : null;
    if (
      stored.input.targetSnapshotChecksum !== targetChecksum ||
      item.targetSnapshotChecksum !== targetChecksum ||
      stored.input.targetSentenceCount !== target.value.sentenceCount ||
      item.targetSentenceCount !== target.value.sentenceCount ||
      stored.input.targetCharacterCount !== target.value.characterCount ||
      item.targetCharacterCount !== target.value.characterCount ||
      stored.input.targetSnapshotBytes !== Buffer.byteLength(targetJson, "utf8") ||
      item.targetSnapshotBytes !== stored.input.targetSnapshotBytes ||
      stored.input.sourceSnapshotChecksum !== sourceChecksum ||
      item.sourceSnapshotChecksum !== sourceChecksum ||
      stored.input.sourceFileId !== expectedSourceFileId
    ) throwCorruptExport();
  }
}

function throwCorruptExport(): never {
  throw conflict("已冻结训练输入清单的完整性校验失败。", {
    code: "alignment_training_export_corrupt",
  });
}

function mapManifestSummary(
  id: string,
  createdAt: Date,
  manifest: {
    checksum: string;
    sampleCount: number;
    componentCount: number;
    splitCounts: AlignmentTrainingExportSummary["splitCounts"];
  },
): AlignmentTrainingExportSummary {
  return {
    id,
    manifestChecksum: manifest.checksum,
    sampleCount: manifest.sampleCount,
    componentCount: manifest.componentCount,
    splitCounts: manifest.splitCounts,
    createdAt: createdAt.toISOString(),
  };
}

function findFirstGreaterRevision(rows: readonly ApplicationWindowRow[], revision: number) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle]!.committedRevision <= revision) low = middle + 1;
    else high = middle;
  }
  return rows[low]?.committedRevision;
}

function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K) {
  const value = map.get(key);
  if (value === undefined) throw new Error("训练冻结内部映射不完整。");
  return value;
}

function groupBy<T, K>(rows: readonly T[], getKey: (row: T) => K) {
  const result = new Map<K, T[]>();
  for (const row of rows) {
    const key = getKey(row);
    const values = result.get(key) ?? [];
    values.push(row);
    result.set(key, values);
  }
  return result;
}

function isSerializableWriteConflict(error: unknown) {
  return Boolean(
    error && typeof error === "object" &&
    "code" in error && error.code === "P2034",
  );
}
