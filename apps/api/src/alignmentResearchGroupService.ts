import {
  AlignmentResearchGroupKind as DbAlignmentResearchGroupKind,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  ALIGNMENT_RESEARCH_GROUP_KINDS,
  MAX_ALIGNMENT_RESEARCH_GROUP_DISPLAY_NAME_LENGTH,
  MAX_PROJECT_ALIGNMENT_RESEARCH_GROUPS,
  normalizeAlignmentResearchGroupDisplayName,
  type AlignmentResearchGroupKind,
  type AlignmentResearchGroupPage,
  type AlignmentResearchGroupSummary,
  type CreateAlignmentResearchGroupRequest,
  type ListAlignmentResearchGroupsOptions,
  type ProjectAlignmentResearchGroups,
  type ReplaceProjectAlignmentResearchGroupsRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const MAX_CURSOR_LENGTH = 2_048;
const RESEARCH_GROUP_LOCK_KEY = "xiqu-alignment-research-groups";
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

type ProjectGroupState = {
  resourceId: string;
  researchGroupRevision: number;
  alignmentResearchGroups: Array<{
    researchGroupId: string;
    group: {
      id: string;
      kind: DbAlignmentResearchGroupKind;
      displayName: string;
      createdAt: Date;
    };
  }>;
};

/**
 * 研究分组是训练治理元数据，不属于 ProjectData、ACL 或职责组。
 * 所有写入都在统一 advisory lock 后重验项目和当前权限，避免两个管理端用旧集合彼此覆盖。
 */
export class AlignmentResearchGroupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async getProjectGroups(
    user: ApiUser,
    projectResourceId: string,
  ): Promise<ProjectAlignmentResearchGroups> {
    await this.access.assertCapability(user, projectResourceId, "read");
    await assertActiveProject(this.prisma, projectResourceId);
    return mapProjectState(await loadProjectState(this.prisma, projectResourceId));
  }

  async listCandidates(
    user: ApiUser,
    projectResourceId: string,
    options: ListAlignmentResearchGroupsOptions,
  ): Promise<AlignmentResearchGroupPage> {
    await this.access.assertCapability(user, projectResourceId, "manage_permissions");
    await assertActiveProject(this.prisma, projectResourceId);
    const filter = normalizeListFilter(options);
    const cursor = options.cursor
      ? decodeCursor(projectResourceId, filter, options.cursor)
      : null;
    const rows = await this.prisma.alignmentResearchGroup.findMany({
      where: {
        ...(filter.kind ? { kind: filter.kind as DbAlignmentResearchGroupKind } : {}),
        ...(filter.query ? {
          displayName: { contains: filter.query, mode: "insensitive" },
        } : {}),
        ...(cursor ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filter.limit + 1,
    });
    const page = rows.slice(0, filter.limit);
    return {
      items: page.map(mapGroup),
      nextCursor: rows.length > filter.limit
        ? encodeCursor(projectResourceId, filter, page.at(-1)!)
        : null,
    };
  }

  async create(
    user: ApiUser,
    projectResourceId: string,
    input: CreateAlignmentResearchGroupRequest,
  ): Promise<AlignmentResearchGroupSummary> {
    return this.prisma.$transaction(async (transaction) => {
      await lockAlignmentResearchGroupCatalog(transaction);
      await lockAndAssertManagedProject(transaction, this.access, user, projectResourceId);
      const existing = await transaction.alignmentResearchGroup.findUnique({
        where: { id: input.id },
      });
      if (existing) {
        // UUID 是逻辑创建身份；迟到重放只能读取原事实，不能改名、改 kind 或接管其他账号的 identity。
        if (
          existing.kind !== input.kind ||
          existing.displayName !== input.displayName ||
          existing.createdBy !== user.id
        ) {
          throw conflict("研究分组 id 已被不同语义使用。", {
            code: "alignment_research_group_identity_conflict",
          });
        }
        return mapGroup(existing);
      }
      const row = await transaction.alignmentResearchGroup.create({
        data: {
          id: input.id,
          kind: input.kind as DbAlignmentResearchGroupKind,
          displayName: input.displayName,
          createdBy: user.id,
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "alignment_research_group_create",
          actorUserId: user.id,
          resourceId: projectResourceId,
          detail: { groupId: row.id, kind: row.kind },
        },
      });
      return mapGroup(row);
    });
  }

  async replaceProjectGroups(
    user: ApiUser,
    projectResourceId: string,
    input: ReplaceProjectAlignmentResearchGroupsRequest,
  ): Promise<ProjectAlignmentResearchGroups> {
    if (input.groupIds.length > MAX_PROJECT_ALIGNMENT_RESEARCH_GROUPS) {
      throw badRequest(`每个项目最多设置 ${MAX_PROJECT_ALIGNMENT_RESEARCH_GROUPS} 个研究分组。`);
    }
    return this.prisma.$transaction(async (transaction) => {
      await lockAlignmentResearchGroupCatalog(transaction);
      await lockAndAssertManagedProject(transaction, this.access, user, projectResourceId);
      const current = await loadProjectState(transaction, projectResourceId);
      const currentIds = current.alignmentResearchGroups
        .map(({ researchGroupId }) => researchGroupId)
        .sort();
      if (input.expectedRevision > current.researchGroupRevision) {
        throw conflict("项目研究分组 revision 超前，请刷新后重试。", {
          code: "alignment_research_group_revision_conflict",
          currentRevision: current.researchGroupRevision,
        });
      }
      // 网络响应丢失后的同目标重放不再推进 revision，也不会重复写审计或更新时间。
      if (sameStringArray(currentIds, input.groupIds)) return mapProjectState(current);
      if (input.expectedRevision !== current.researchGroupRevision) {
        throw conflict("项目研究分组已被其他账号更新，请刷新后重试。", {
          code: "alignment_research_group_revision_conflict",
          currentRevision: current.researchGroupRevision,
        });
      }
      if (current.researchGroupRevision >= 2_147_483_646) {
        throw conflict("项目研究分组 revision 已达到安全上限。", {
          code: "alignment_research_group_revision_exhausted",
        });
      }

      const targetGroups = input.groupIds.length
        ? await transaction.alignmentResearchGroup.findMany({
            where: { id: { in: input.groupIds } },
            select: { id: true, kind: true },
          })
        : [];
      if (targetGroups.length !== input.groupIds.length) {
        throw badRequest("项目研究分组中包含不存在的 identity。");
      }
      const currentSet = new Set(currentIds);
      const targetSet = new Set(input.groupIds);
      const removedIds = currentIds.filter((id) => !targetSet.has(id));
      const addedIds = input.groupIds.filter((id) => !currentSet.has(id));
      if (removedIds.length) {
        await transaction.projectAlignmentResearchGroup.deleteMany({
          where: { projectResourceId, researchGroupId: { in: removedIds } },
        });
      }
      if (addedIds.length) {
        await transaction.projectAlignmentResearchGroup.createMany({
          data: addedIds.map((researchGroupId) => ({
            projectResourceId,
            researchGroupId,
            assignedBy: user.id,
          })),
        });
      }
      const nextRevision = current.researchGroupRevision + 1;
      await transaction.projectMetadata.update({
        where: { resourceId: projectResourceId },
        data: { researchGroupRevision: nextRevision },
      });
      await transaction.resourceEntry.update({
        where: { id: projectResourceId },
        data: { updatedAt: new Date() },
      });
      const kindById = new Map(targetGroups.map((group) => [group.id, group.kind]));
      await transaction.auditLog.create({
        data: {
          action: "project_alignment_research_groups_update",
          actorUserId: user.id,
          resourceId: projectResourceId,
          detail: {
            previousRevision: current.researchGroupRevision,
            nextRevision,
            workCount: input.groupIds.filter((id) => kindById.get(id) === "work").length,
            performerCount: input.groupIds.filter((id) => kindById.get(id) === "performer").length,
            addedGroupIds: addedIds,
            removedGroupIds: removedIds,
          },
        },
      });
      return mapProjectState(await loadProjectState(transaction, projectResourceId));
    });
  }
}

/** 分组写入与训练冻结共用同一 catalog lock，保证冻结看到的 project revision 与关系属于同一时点。 */
export async function lockAlignmentResearchGroupCatalog(transaction: Prisma.TransactionClient) {
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${RESEARCH_GROUP_LOCK_KEY}))
  `;
}

async function lockAndAssertManagedProject(
  transaction: Prisma.TransactionClient,
  access: ResourceAccessService,
  user: ApiUser,
  projectResourceId: string,
) {
  // 先锁资源和 metadata，再在同一事务解析当前 actor/角色/ACL；请求开始时的权限快照不能授权排队写入。
  await transaction.$queryRaw`
    SELECT "id" FROM "resource_entries"
    WHERE "id" = ${projectResourceId}
    FOR UPDATE
  `;
  await transaction.$queryRaw`
    SELECT "resource_id" FROM "project_metadata"
    WHERE "resource_id" = ${projectResourceId}
    FOR UPDATE
  `;
  await assertActiveProject(transaction, projectResourceId);
  await access.assertCapability(user, projectResourceId, "manage_permissions", transaction);
}

async function assertActiveProject(database: DatabaseClient, projectResourceId: string) {
  const rows = await database.$queryRaw<Array<{
    rootType: string | null;
    inactiveCount: bigint;
    truncated: boolean;
  }>>(Prisma.sql`
    WITH RECURSIVE resource_chain AS (
      SELECT
        "id",
        "parent_id" AS "parentId",
        "type"::text AS "type",
        "archived_at" AS "archivedAt",
        "trashed_at" AS "trashedAt",
        0 AS "depth",
        ARRAY["id"]::text[] AS "path"
      FROM "resource_entries"
      WHERE "id" = ${projectResourceId}

      UNION ALL

      SELECT
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
    SELECT
      MAX("type") FILTER (WHERE "depth" = 0) AS "rootType",
      COUNT(*) FILTER (WHERE "archivedAt" IS NOT NULL OR "trashedAt" IS NOT NULL) AS "inactiveCount",
      COALESCE(BOOL_OR("depth" = 255 AND "parentId" IS NOT NULL), false) AS "truncated"
    FROM resource_chain
  `);
  const row = rows[0];
  if (!row?.rootType || row.rootType !== "project") throw notFound("项目不存在。");
  if (row.inactiveCount > 0n || row.truncated) {
    throw conflict("归档、回收站或层级异常的项目不能管理研究分组。", {
      code: "alignment_research_project_inactive",
    });
  }
}

async function loadProjectState(
  database: DatabaseClient,
  projectResourceId: string,
): Promise<ProjectGroupState> {
  const metadata = await database.projectMetadata.findUnique({
    where: { resourceId: projectResourceId },
    select: { resourceId: true, researchGroupRevision: true },
  });
  if (!metadata) throw conflict("项目研究分组元数据不完整。", {
    code: "alignment_research_project_metadata_missing",
  });
  // Prisma transaction adapter 使用单连接；关系读取必须顺序执行，不能在同一事务 client 上 Promise.all。
  const alignmentResearchGroups = await database.projectAlignmentResearchGroup.findMany({
    where: { projectResourceId },
    select: {
      researchGroupId: true,
      group: {
        select: {
          id: true,
          kind: true,
          displayName: true,
          createdAt: true,
        },
      },
    },
  });
  return { ...metadata, alignmentResearchGroups };
}

function mapProjectState(state: ProjectGroupState): ProjectAlignmentResearchGroups {
  return {
    projectResourceId: state.resourceId,
    revision: state.researchGroupRevision,
    groups: state.alignmentResearchGroups
      .map(({ group }) => mapGroup(group))
      .sort(compareGroups),
  };
}

function mapGroup(row: {
  id: string;
  kind: DbAlignmentResearchGroupKind;
  displayName: string;
  createdAt: Date;
}): AlignmentResearchGroupSummary {
  return {
    id: row.id,
    kind: row.kind as AlignmentResearchGroupKind,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
  };
}

function compareGroups(left: AlignmentResearchGroupSummary, right: AlignmentResearchGroupSummary) {
  return ALIGNMENT_RESEARCH_GROUP_KINDS.indexOf(left.kind) -
    ALIGNMENT_RESEARCH_GROUP_KINDS.indexOf(right.kind) ||
    left.displayName.localeCompare(right.displayName, "zh-CN") ||
    left.id.localeCompare(right.id);
}

function normalizeListFilter(options: ListAlignmentResearchGroupsOptions) {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw badRequest(`研究分组每页数量必须在 1 到 ${MAX_LIST_LIMIT} 之间。`);
  }
  if (options.kind !== undefined &&
      !ALIGNMENT_RESEARCH_GROUP_KINDS.includes(options.kind)) {
    throw badRequest("研究分组 kind 不受支持。");
  }
  const query = options.query === undefined || options.query.trim() === ""
    ? null
    : normalizeAlignmentResearchGroupDisplayName(options.query);
  if (options.query !== undefined && options.query.trim() !== "" && !query) {
    throw badRequest(`研究分组搜索词不能超过 ${MAX_ALIGNMENT_RESEARCH_GROUP_DISPLAY_NAME_LENGTH} 个字符或包含控制字符。`);
  }
  return { kind: options.kind ?? null, query, limit };
}

type NormalizedListFilter = ReturnType<typeof normalizeListFilter>;

function encodeCursor(
  projectResourceId: string,
  filter: NormalizedListFilter,
  row: { id: string; createdAt: Date },
) {
  return Buffer.from(JSON.stringify({
    version: 1,
    projectResourceId,
    kind: filter.kind,
    query: filter.query,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  }), "utf8").toString("base64url");
}

function decodeCursor(
  projectResourceId: string,
  filter: NormalizedListFilter,
  token: string,
) {
  try {
    if (!token || token.length > MAX_CURSOR_LENGTH) throw new Error();
    const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown;
    if (!isCursorRecord(value) ||
        value.version !== 1 ||
        value.projectResourceId !== projectResourceId ||
        value.kind !== filter.kind ||
        value.query !== filter.query ||
        !CANONICAL_UUID_PATTERN.test(value.id)) throw new Error();
    const createdAt = new Date(value.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) {
      throw new Error();
    }
    return { createdAt, id: value.id };
  } catch {
    throw badRequest("研究分组分页游标无效或筛选条件已变化。");
  }
}

function isCursorRecord(value: unknown): value is {
  version: number;
  projectResourceId: string;
  kind: AlignmentResearchGroupKind | null;
  query: string | null;
  createdAt: string;
  id: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.join(",") === "createdAt,id,kind,projectResourceId,query,version" &&
    typeof record.projectResourceId === "string" &&
    (record.kind === null || typeof record.kind === "string") &&
    (record.query === null || typeof record.query === "string") &&
    typeof record.createdAt === "string" &&
    typeof record.id === "string";
}

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
