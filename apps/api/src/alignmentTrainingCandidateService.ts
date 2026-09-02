import type { Prisma, PrismaClient } from "@prisma/client";
import {
  type AlignmentTrainingCandidatePage,
  type ListAlignmentTrainingCandidatesOptions,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { deriveAlignmentTrainingEvidence } from "./alignmentTrainingEvidence.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MAX_OPERATION_SCAN = 500;
const MAX_CURRENT_ASSESSMENT_SCAN = 500;

const CANDIDATE_APPLICATION_INCLUDE = {
  run: { select: { annotationFileIdSnapshot: true, manifest: true } },
  artifact: { select: { runId: true } },
  _count: {
    select: {
      operations: true,
      qualityAssessments: { where: { supersededAt: null } },
    },
  },
  qualityAssessments: {
    where: { supersededAt: null },
    select: { id: true, verdict: true, issueCodes: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_CURRENT_ASSESSMENT_SCAN,
  },
} satisfies Prisma.AlignmentApplicationInclude;

const CANDIDATE_OPERATION_SELECT = {
  committedRevision: true,
  sequence: true,
  action: true,
  payload: true,
  alignmentApplicationId: true,
} satisfies Prisma.AnnotationOperationSelect;

/** 文件级候选派生只读取有界历史事实；prediction 正文和当前 ProjectData 都不进入该查询。 */
export class AlignmentTrainingCandidateService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async list(
    user: ApiUser,
    annotationFileId: string,
    options: ListAlignmentTrainingCandidatesOptions,
  ): Promise<AlignmentTrainingCandidatePage> {
    await this.access.assertCapability(user, annotationFileId, "read");
    const limit = normalizeLimit(options.limit);
    const cursor = options.cursor ? decodeCursor(annotationFileId, options.cursor) : null;
    // ACL 只能证明账号对资源树有 read；归档或回收后的文件必须在业务查询中继续 fail closed。
    const file = await this.prisma.annotationFile.findFirst({
      where: {
        resourceId: annotationFileId,
        resource: { trashedAt: null, archivedAt: null, type: "annotation_file" },
      },
      select: { revision: true },
    });
    if (!file) throw notFound("活动标注文件不存在。");
    const firstWindowEndRevision = cursor?.windowEndRevision ?? file.revision;
    // Application 复合游标同时决定下一页首项的观察上界，不能只保存数据库行锚点。
    const rows = await this.prisma.alignmentApplication.findMany({
      where: {
        annotationFileId,
        ...(cursor ? {
          OR: [
            { committedRevision: { lt: cursor.committedRevision } },
            { committedRevision: cursor.committedRevision, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      include: CANDIDATE_APPLICATION_INCLUDE,
      orderBy: [{ committedRevision: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    validateApplicationRows(page, annotationFileId, firstWindowEndRevision);
    if (page.length === 0) return { items: [], nextCursor: null };

    const oldestRevision = page.at(-1)!.committedRevision;
    // 一页候选共用一次有限 operation 扫描；多次自动应用虽占容量，但不会被误算成人工修改。
    const operationRows = await this.prisma.annotationOperation.findMany({
      where: {
        annotationFileId,
        committedRevision: { gt: oldestRevision, lte: firstWindowEndRevision },
      },
      select: CANDIDATE_OPERATION_SELECT,
      orderBy: [{ committedRevision: "desc" }, { sequence: "desc" }],
      take: MAX_OPERATION_SCAN + 1,
    });
    const operationScanTruncated = operationRows.length > MAX_OPERATION_SCAN;
    const operations = operationRows.slice(0, MAX_OPERATION_SCAN);
    const oldestScannedRevision = operations.at(-1)?.committedRevision ?? firstWindowEndRevision;

    return {
      items: page.map((application, index) => deriveAlignmentTrainingEvidence({
        id: application.id,
        alignmentRunId: application.alignmentRunId,
        alignmentArtifactId: application.alignmentArtifactId,
        baseRevision: application.baseRevision,
        committedRevision: application.committedRevision,
        createdAt: application.createdAt,
        runManifest: application.run.manifest,
        currentAssessments: application.qualityAssessments,
      },
      index === 0 ? firstWindowEndRevision : page[index - 1]!.committedRevision,
      operations,
      (!operationScanTruncated || application.committedRevision >= oldestScannedRevision) &&
        application._count.qualityAssessments <= MAX_CURRENT_ASSESSMENT_SCAN).candidate),
      nextCursor: rows.length > limit
        ? encodeCursor(annotationFileId, page.at(-1)!, page.at(-1)!.committedRevision)
        : null,
    };
  }
}

type ApplicationRow = Prisma.AlignmentApplicationGetPayload<{
  include: typeof CANDIDATE_APPLICATION_INCLUDE;
}>;

function validateApplicationRows(rows: ApplicationRow[], fileId: string, firstWindowEnd: number) {
  let upper = firstWindowEnd;
  for (const [index, row] of rows.entries()) {
    if ((index === 0 ? row.committedRevision > upper : row.committedRevision >= upper) ||
        row.run.annotationFileIdSnapshot !== fileId ||
        row.artifact.runId !== row.alignmentRunId || row._count.operations !== row.operationCount) {
      throw conflict("强制对齐候选关系不完整，不能派生训练证据。", {
        code: "alignment_training_candidate_incomplete",
      });
    }
    upper = row.committedRevision;
  }
}

function normalizeLimit(value: number | undefined) {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw badRequest(`强制对齐候选每页数量必须在 1 到 ${MAX_LIMIT} 之间。`);
  }
  return limit;
}

function encodeCursor(
  fileId: string,
  row: { committedRevision: number; id: string },
  windowEndRevision: number,
) {
  return Buffer.from(JSON.stringify({
    version: 1,
    fileId,
    committedRevision: row.committedRevision,
    id: row.id,
    windowEndRevision,
  }), "utf8").toString("base64url");
}

function decodeCursor(fileId: string, token: string) {
  try {
    // 游标虽不含秘密，仍需限制输入体积，避免无界 base64/JSON 解码占用 API 内存。
    if (token.length > 2_048) throw new Error();
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.fileId !== fileId ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id) ||
      !Number.isInteger(value.committedRevision) ||
      !Number.isInteger(value.windowEndRevision) ||
      Number(value.committedRevision) < 1 ||
      Number(value.windowEndRevision) < Number(value.committedRevision)
    ) throw new Error();
    return {
      id: value.id,
      committedRevision: Number(value.committedRevision),
      windowEndRevision: Number(value.windowEndRevision),
    };
  } catch {
    throw badRequest("强制对齐候选分页游标无效，请刷新第一页。");
  }
}
