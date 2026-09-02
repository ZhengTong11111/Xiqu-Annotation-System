import { createHash } from "node:crypto";
import {
  AlignmentArtifactKind,
  Prisma,
  ProcessingJobStatus,
  type PrismaClient,
} from "@prisma/client";
import {
  ALIGNMENT_TRAINING_MANIFEST_FORMAT,
  ALIGNMENT_TRAINING_MANIFEST_MAX_GROUPS_PER_ITEM,
  ALIGNMENT_TRAINING_MANIFEST_VERSION,
  buildAlignmentTrainingManifest,
  parseAlignmentTrainingManifest,
  type AlignmentTrainingManifestItem,
  type AlignmentTrainingSampleDraft,
} from "@xiqu/document-model";
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
import { lockAlignmentResearchGroupCatalog } from "./alignmentResearchGroupService.js";
import { deriveAlignmentTrainingEvidence } from "./alignmentTrainingEvidence.js";
import type { ApiUser } from "./domain.js";
import { conflict } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const MAX_APPLICATION_WINDOW_SCAN_PER_FILE = 5_000;
const MAX_TOTAL_APPLICATION_WINDOW_SCAN = 20_000;
const MAX_OPERATION_SCAN_PER_APPLICATION = 500;
const MAX_ASSESSMENT_SCAN_PER_APPLICATION = 500;

const FREEZE_APPLICATION_INCLUDE = {
  run: {
    select: {
      annotationFileIdSnapshot: true,
      manifest: true,
      status: true,
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
  annotationFile: { select: { revision: true } },
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
              items: {
                create: built.manifest.items.map((item) => {
                  const sample = preparedByApplicationId.get(item.alignmentApplicationId);
                  if (!sample) throw new Error("训练冻结样本映射不完整。");
                  return mapItemCreate(item, sample);
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
  };
}

function mapItemCreate(item: AlignmentTrainingManifestItem, sample: PreparedSample) {
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

function mapExistingExport(row: {
  id: string;
  manifest: Prisma.JsonValue;
  manifestFormat: string;
  manifestVersion: number;
  manifestChecksum: string;
  splitSeedHash: string;
  splitRatios: Prisma.JsonValue;
  splitCounts: Prisma.JsonValue;
  sampleCount: number;
  componentCount: number;
  createdAt: Date;
}) {
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
  return mapManifestSummary(row.id, row.createdAt, parsed.value);
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
