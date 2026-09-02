import {
  AnnotationConfirmationDomain as DbAnnotationConfirmationDomain,
  Prisma,
  type AnnotationFile as DbAnnotationFile,
  type MediaFile as DbMediaFile,
  type PrismaClient,
  type ResourceType as DbResourceType,
} from "@prisma/client";
import type {
  AnnotationConfirmationDomain,
  AnnotationConfirmationDraft,
  AnnotationConfirmationList,
  AnnotationConfirmationRecord,
  AnnotationRangeCommentDraft,
  AnnotationRangeCommentPage,
  AnnotationRangeCommentRecord,
  AnnotationWorkflowStatus,
  AnnotationClientSyncFailureReport,
  AnnotationClientSyncFailureReportResult,
  AnnotationFile,
  AnnotationMediaReference,
  AnnotationMutationLeaseGrant,
  AnnotationMutationLeaseSummary,
  AnnotationMutationPurpose,
  AnnotationRecoverySnapshotDetail,
  AnnotationRecoverySnapshotSummary,
  AliyunVodPlaybackSession,
  AliyunVodWebPlayerLicense,
  BatchMoveResourcesRequest,
  BatchMoveResourcesResponse,
  BatchTrashResourcesRequest,
  BatchTrashResourcesResponse,
  CopyResourceRequest,
  CreateAliyunVodMediaRequest,
  CreateAnnotationFileRequest,
  CreateResourceRequest,
  EffectiveResourcePermission,
  ListPermissionManagementProjectsOptions,
  ListResourcesOptions,
  MediaProviderCapabilities,
  PermissionManagementProjectPage,
  ProjectWorkflowGroups,
  ResourceCapability,
  ResourceBreadcrumb,
  ResourceEntry,
  ResourceListPage,
  ResourcePermissionMatrixRow,
  ResourcePermissionRecord,
  UserReference,
  RestoreAnnotationRecoverySnapshotRequest,
  SaveAnnotationFileRequest,
  UpdateResourceRequest,
  UpdateAnnotationMediaRequest,
  UpdateAnnotationWorkflowStatusRequest,
  UpdateProjectWorkflowGroupsRequest,
  UpsertResourcePermissionRequest,
} from "@xiqu/shared";
import {
  ANNOTATION_REVIEW_PAGE_MAX_LIMIT,
  getAnnotationWorkflowTransition,
  getProjectWorkflowGroupCapabilities,
} from "@xiqu/shared";
import {
  canCreateAnnotationReviewFact,
  canCreateAnnotationRangeComment,
  canWithdrawAnnotationReviewFact,
  canWithdrawAnnotationRangeComment,
  extractPersistedAnnotationReviewTrackIds,
  validateAnnotationConfirmationDraft,
  validateAnnotationRangeCommentDraft,
  validateAnnotationReviewTracks,
} from "@xiqu/document-model";
import { randomUUID } from "node:crypto";
import type { ApiUser } from "./domain.js";
import {
  badRequest,
  conflict,
  externalMediaUnavailable,
  externalServiceUnavailable,
  forbidden,
  notFound,
  storageQuotaExceeded,
  unsupportedMedia,
} from "./errors.js";
import {
  AliyunVodGatewayError,
  type AliyunVodProvider,
} from "./aliyunVodGateway.js";
import { issueAliyunVodPlaybackSession } from "./aliyunVodPlaybackSessionIssuer.js";
import { ResourceAccessService } from "./resourceAccess.js";
import { createOriginalMediaAudioTrack } from "./mediaAudioTrackService.js";
import {
  buildResourceCopyPlan,
  MAX_RECURSIVE_COPY_NODES,
  type CopySourceNode,
} from "./resourceCopy.js";
import {
  normalizeResourceSelection,
  type ResourceSelectionNode,
} from "./resourceSelection.js";
import {
  ResourceCursorError,
  buildResourceOrderBy,
  decodeResourceCursor,
  encodeResourceCursor,
  getResourceScanBatchSize,
  mapWithConcurrency,
  normalizeResourceQuery,
  type NormalizedResourceQuery,
} from "./resourcePagination.js";
import { encodeAnnotationSnapshotOperationCursor } from "./annotationCommittedOperationPagination.js";
import { toPublicUser } from "./repositoryMappers.js";
import {
  calculateAnnotationMutationLeaseExpiry,
  createAnnotationMutationLeaseToken,
  hashAnnotationMutationLeaseToken,
  isAnnotationMutationLeaseExpired,
  matchesAnnotationMutationLeaseToken,
} from "./annotationMutationLease.js";
import { assertAnnotationMutationLeaseForWrite } from "./annotationMutationLeaseStore.js";
import { lockActiveAnnotationFileForWrite } from "./annotationFileWriteLock.js";
import { assertActiveAnnotationFile as assertActiveAnnotationFileActivity } from "./annotationFileActivity.js";
import type { AnnotationRevisionPublisher } from "./annotationCollaborationHub.js";
import type { AnnotationReviewPublisher } from "./annotationCollaborationHub.js";
import {
  decodeAnnotationConfirmationCursor,
  encodeAnnotationConfirmationCursor,
} from "./annotationConfirmationPagination.js";
import {
  decodeAnnotationRangeCommentCursor,
  encodeAnnotationRangeCommentCursor,
} from "./annotationRangeCommentPagination.js";
import {
  annotationConfirmationInclude,
  annotationRangeCommentInclude,
  mapAnnotationConfirmation,
  mapAnnotationRangeComment,
} from "./annotationReviewRecordMapper.js";
import {
  resolveAnnotationRecoverySnapshotPayload,
  type AnnotationRecoverySnapshotResolvableRow,
} from "./annotationRecoverySnapshotResolver.js";

const resourceBaseInclude = {
  owner: { include: { roles: true } },
  _count: { select: { children: true } },
} satisfies Prisma.ResourceEntryInclude;

// 集中权限面板使用轻量项目行；完整标注、媒体和子项计数不应随项目选择列表一起加载。
const permissionManagementProjectSelect = {
  id: true,
  parentId: true,
  type: true,
  name: true,
  archivedAt: true,
  trashedAt: true,
  updatedAt: true,
  owner: { select: { id: true, accountName: true, displayName: true } },
} satisfies Prisma.ResourceEntrySelect;

const annotationMutationLeaseInclude = {
  holder: { include: { roles: true } },
} satisfies Prisma.AnnotationMutationLeaseInclude;

const projectWorkflowMemberInclude = {
  user: { select: { id: true, accountName: true, displayName: true } },
} satisfies Prisma.ProjectWorkflowMemberInclude;

type ResourceBaseRow = Prisma.ResourceEntryGetPayload<{
  include: typeof resourceBaseInclude;
}>;
type ResourceRow = ResourceBaseRow & {
  annotationFile: DbAnnotationFile | null;
  mediaFile: DbMediaFile | null;
  projectWorkflowStatus: AnnotationWorkflowStatus | null;
  annotationResponsibles: UserReference[];
};
type PermissionManagementProjectRow = Prisma.ResourceEntryGetPayload<{
  select: typeof permissionManagementProjectSelect;
}>;
type ResourcePathNode = Pick<
  PermissionManagementProjectRow,
  "id" | "parentId" | "type" | "name" | "archivedAt" | "trashedAt"
>;

/**
 * 详情与恢复共用同一个快照解析门禁。错误只暴露定位事实和稳定原因码，不把历史正文、hash 或未来 recipe 带入响应。
 */
function resolveRecoverySnapshotPayloadOrThrow<TPayload>(
  row: AnnotationRecoverySnapshotResolvableRow<TPayload>,
) {
  const resolution = resolveAnnotationRecoverySnapshotPayload(row);
  if (resolution.ok) return resolution.payload;
  const message = resolution.code === "snapshot_payload_hash_mismatch"
    ? "恢复快照完整性校验失败，未读取或恢复该版本。"
    : "当前服务版本暂不支持读取该恢复快照的存储形态。";
  throw conflict(message, {
    reason: resolution.code,
    snapshotId: resolution.snapshotId,
    annotationFileId: resolution.annotationFileId,
    revision: resolution.revision,
  });
}
type AnnotationMutationLeaseRow = Prisma.AnnotationMutationLeaseGetPayload<{
  include: typeof annotationMutationLeaseInclude;
}>;
type ProjectWorkflowMemberRow = Prisma.ProjectWorkflowMemberGetPayload<{
  include: typeof projectWorkflowMemberInclude;
}>;

export type CopyResourceResult = {
  resource: ResourceEntry;
  summary: {
    copiedNodeCount: number;
    copiedAnnotationCount: number;
    reusedFileObjectCount: number;
  };
};

// 下载描述只携带路由发送响应所需的数据；对象存储流仍由路由层按需打开，避免服务层持有 HTTP 响应。
export type DownloadableResource =
  | {
      kind: "media";
      fileName: string;
      mimeType: string;
      size: number;
      storageKey: string;
    }
  | {
      kind: "annotation";
      fileName: string;
      mimeType: "application/json; charset=utf-8";
      content: string;
    };

const MAX_CONFIRMATION_REVOKE_REASON_LENGTH = 1_000;
const MAX_RANGE_COMMENT_WITHDRAW_REASON_LENGTH = 1_000;

// Prisma 枚举与共享合同保持显式双向映射，避免数据库命名变化被隐式类型断言掩盖。
const DB_CONFIRMATION_DOMAINS: Record<
  AnnotationConfirmationDomain,
  DbAnnotationConfirmationDomain
> = {
  subtitle_lines: DbAnnotationConfirmationDomain.subtitle_lines,
  character_annotations: DbAnnotationConfirmationDomain.character_annotations,
  gongche_annotations: DbAnnotationConfirmationDomain.gongche_annotations,
  banyan_sections: DbAnnotationConfirmationDomain.banyan_sections,
  banyan_marks: DbAnnotationConfirmationDomain.banyan_marks,
  custom_tracks: DbAnnotationConfirmationDomain.custom_tracks,
  custom_blocks: DbAnnotationConfirmationDomain.custom_blocks,
  attached_points: DbAnnotationConfirmationDomain.attached_points,
};

export class ResourceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly revisionPublisher: AnnotationRevisionPublisher = {
      publishRevisionAdvanced: () => undefined,
    },
    private readonly aliyunVod: AliyunVodProvider | null = null,
    private readonly aliyunVodWebPlayerLicense: AliyunVodWebPlayerLicense | null = null,
    private readonly reviewPublisher: AnnotationReviewPublisher = {
      publishReviewChanged: () => undefined,
    },
  ) {}

  async listResources(
    user: ApiUser,
    options: ListResourcesOptions,
  ): Promise<ResourceListPage> {
    const query = normalizeResourceQuery(options);
    const where = this.buildListWhere(user, query);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const scanBatchSize = getResourceScanBatchSize(limit);
    let candidateCursorId: string | null = null;
    if (options.cursor) {
      try {
        candidateCursorId = decodeResourceCursor(options.cursor, query);
      } catch (error) {
        if (error instanceof ResourceCursorError) throw badRequest(error.message);
        throw error;
      }
      // cursor 行必须仍属于同一数据库候选集合；资源已移动/删除时要求调用方刷新第一页。
      const cursorStillMatches = await this.prisma.resourceEntry.findFirst({
        where: { AND: [where, { id: candidateCursorId }] },
        select: { id: true },
      });
      if (!cursorStillMatches) {
        throw badRequest("资源分页游标已经失效，请刷新当前目录。");
      }
    }

    const visible: Array<{ row: ResourceRow; permission: EffectiveResourcePermission }> = [];
    let exhausted = false;
    // ACL 在数据库候选之后判断，因此按有限批次持续扫描，直到得到 limit+1 个可见项或候选耗尽。
    while (visible.length <= limit && !exhausted) {
      const baseRows = await this.prisma.resourceEntry.findMany({
        where,
        include: resourceBaseInclude,
        orderBy: buildResourceOrderBy(query),
        take: scanBatchSize,
        ...(candidateCursorId
          ? { cursor: { id: candidateCursorId }, skip: 1 }
          : {}),
      });
      const rows = await this.attachResourceTypeMetadata(baseRows);
      if (rows.length === 0) break;
      exhausted = rows.length < scanBatchSize;
      candidateCursorId = rows.at(-1)!.id;

      // 每批以有界并发计算软删除祖先和有效 ACL，结果顺序仍与数据库稳定排序一致。
      const evaluated = await mapWithConcurrency(rows, 12, async (row) => {
        if (
          query.view !== "trash" &&
          await this.hasTrashedAncestor(this.prisma, row.parentId)
        ) {
          return null;
        }
        const permission = await this.access.getEffectivePermission(user, row.id);
        return permission.capabilities.includes("read")
          ? { row, permission }
          : null;
      });
      for (const item of evaluated) {
        if (item) visible.push(item);
      }
    }

    const page = visible.slice(0, limit);
    return {
      items: await Promise.all(page.map(({ row, permission }) =>
        this.mapResource(user, row, permission))),
      breadcrumbs: options.parentId
        ? await this.buildBreadcrumbs(user, options.parentId)
        : [],
      nextCursor: visible.length > limit && page.length > 0
        ? encodeResourceCursor(page.at(-1)!.row.id, query)
        : null,
    };
  }

  // 集中权限面板跨目录列出全部活动项目，但仍以轻量分页返回，不能预先展开项目×账号权限矩阵。
  async listPermissionManagementProjects(
    actor: ApiUser,
    options: ListPermissionManagementProjectsOptions,
  ): Promise<PermissionManagementProjectPage> {
    if (!this.access.hasFullResourceAccess(actor)) {
      throw forbidden("只有系统管理员和管理员可以使用项目权限管理。");
    }
    const normalizedSearch = options.query?.trim() || null;
    if (normalizedSearch && normalizedSearch.length > 120) {
      throw badRequest("项目搜索词不能超过 120 个字符。");
    }
    // 复用资源分页的查询指纹和稳定 name/id 排序，但不复用 all_projects 的“仅根项目”数据库条件。
    const query = normalizeResourceQuery({
      view: "all_projects",
      query: normalizedSearch ?? undefined,
      type: "project",
      sortBy: "name",
      direction: "asc",
    });
    const where: Prisma.ResourceEntryWhereInput = {
      type: "project",
      archivedAt: null,
      trashedAt: null,
      ...(normalizedSearch
        ? { name: { contains: normalizedSearch, mode: "insensitive" } }
        : {}),
    };
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const scanBatchSize = getResourceScanBatchSize(limit);
    let candidateCursorId: string | null = null;
    if (options.cursor) {
      try {
        candidateCursorId = decodeResourceCursor(options.cursor, query);
      } catch (error) {
        if (error instanceof ResourceCursorError) throw badRequest(error.message);
        throw error;
      }
      const cursorStillMatches = await this.prisma.resourceEntry.findFirst({
        where: { AND: [where, { id: candidateCursorId }] },
        select: { id: true },
      });
      if (!cursorStillMatches) {
        throw badRequest("项目分页游标已经失效，请刷新项目列表。");
      }
    }

    const visible: Array<{
      row: PermissionManagementProjectRow;
      path: ResourceBreadcrumb[];
    }> = [];
    let exhausted = false;
    while (visible.length <= limit && !exhausted) {
      const rows = await this.prisma.resourceEntry.findMany({
        where,
        select: permissionManagementProjectSelect,
        orderBy: buildResourceOrderBy(query),
        take: scanBatchSize,
        ...(candidateCursorId
          ? { cursor: { id: candidateCursorId }, skip: 1 }
          : {}),
      });
      if (rows.length === 0) break;
      exhausted = rows.length < scanBatchSize;
      candidateCursorId = rows.at(-1)!.id;

      // 一批项目共享祖先查询，避免为每个项目逐层发起 N+1 路径请求；归档/回收祖先使整棵子树退出活动列表。
      const paths = await this.buildActiveResourcePaths(rows);
      for (const row of rows) {
        const path = paths.get(row.id);
        if (path) visible.push({ row, path });
      }
    }

    const page = visible.slice(0, limit);
    return {
      items: page.map(({ row, path }) => ({
        id: row.id,
        name: row.name,
        path,
        owner: row.owner,
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor: visible.length > limit && page.length > 0
        ? encodeResourceCursor(page.at(-1)!.row.id, query)
        : null,
    };
  }

  async getResource(user: ApiUser, resourceId: string) {
    await this.access.assertCapability(user, resourceId, "read");
    return this.getMappedResource(user, resourceId);
  }

  async createResource(user: ApiUser, input: CreateResourceRequest) {
    if (input.parentId) {
      await this.assertContainer(input.parentId);
      await this.access.assertCapability(user, input.parentId, "create_child");
    } else if (!this.access.hasFullResourceAccess(user)) {
      throw forbidden("只有管理员可以在资源根目录创建项目或文件夹。");
    }
    const name = this.validateName(input.name);
    const parentId = input.parentId ?? null;
    const resourceId = await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeForContentWrite(transaction);
      await this.lockParentNamespaces(transaction, [parentId]);
      if (parentId) {
        await this.assertContainer(parentId, transaction);
        await this.access.assertCapability(
          user,
          parentId,
          "create_child",
          transaction,
        );
      } else {
        // 根目录没有可承载 ACL 的父节点，仍要在资源树锁后用数据库当前角色复核管理员身份。
        await this.access.assertFullResourceAccess(user, transaction);
      }
      await this.assertNameAvailable(transaction, parentId, name);
      const created = await transaction.resourceEntry.create({
        data: {
          parentId,
          type: input.type,
          name,
          ownerUserId: user.id,
        },
      });
      // 项目元数据顺序写入，避免 Prisma nested write 在单连接交互事务中并发 query。
      if (input.type === "project") {
        await transaction.projectMetadata.create({
          data: {
            resourceId: created.id,
            description: input.description ?? null,
          },
        });
      }
      return created.id;
    });
    // owner、子项计数和类型元数据会展开多条关系查询，统一放到事务提交后读取。
    return this.getMappedResource(user, resourceId);
  }

  async createAnnotationFile<TPayload>(
    user: ApiUser,
    input: CreateAnnotationFileRequest<TPayload>,
  ): Promise<AnnotationFile<TPayload>> {
    return this.createAnnotationFileWithPolicy(user, input, false);
  }

  async createBatchImportedAnnotationFile<TPayload>(
    user: ApiUser,
    input: CreateAnnotationFileRequest<TPayload>,
  ): Promise<AnnotationFile<TPayload>> {
    if (!this.access.hasFullResourceAccess(user)) {
      throw forbidden("只有管理员可以执行批量标注导入。");
    }
    return this.createAnnotationFileWithPolicy(user, input, true);
  }

  private async createAnnotationFileWithPolicy<TPayload>(
    user: ApiUser,
    input: CreateAnnotationFileRequest<TPayload>,
    requireFullResourceAccess: boolean,
  ): Promise<AnnotationFile<TPayload>> {
    await this.assertContainer(input.parentId);
    await this.access.assertCapability(user, input.parentId, "create_child");
    const name = this.validateName(input.name);
    const resourceId = await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeForContentWrite(transaction);
      await this.lockParentNamespaces(transaction, [input.parentId]);
      if (requireFullResourceAccess) {
        // 批量入口不能只信任请求开始时的 session 角色；资源树锁内重新读取活动账号与当前角色。
        await this.access.assertFullResourceAccess(user, transaction);
      }
      await this.assertContainer(input.parentId, transaction);
      await this.access.assertCapability(
        user,
        input.parentId,
        "create_child",
        transaction,
      );
      if (input.mediaResourceId) {
        await this.assertMediaResourceForBinding(user, input.mediaResourceId, transaction);
      }
      await this.assertNameAvailable(
        transaction,
        input.parentId,
        name,
      );
      const created = await transaction.resourceEntry.create({
        data: {
          parentId: input.parentId,
          type: "annotation_file",
          name,
          ownerUserId: user.id,
        },
        select: { id: true },
      });
      // 资源节点与标注实体仍在同一事务中提交，但显式顺序写入以适配单连接事务。
      await transaction.annotationFile.create({
        data: {
          resourceId: created.id,
          payload: input.payload as Prisma.InputJsonValue,
          mediaResourceId: input.mediaResourceId ?? null,
          lastEditedBy: user.id,
        },
      });
      return created.id;
    });
    // 关系 DTO 在事务外统一装配，避免 include 在 transaction client 上并行查询。
    return this.getAnnotationFile<TPayload>(user, resourceId);
  }

  // 能力查询只暴露可公开 region，不触发凭据解析或远端请求。
  getMediaProviderCapabilities(): MediaProviderCapabilities {
    return {
      aliyunVod: this.aliyunVod
        ? { enabled: true, region: this.aliyunVod.region }
        : { enabled: false, region: null },
    };
  }

  // VOD 创建先在事务外验证远端媒资，再在锁内重检目录与命名空间。
  async createAliyunVodMedia(
    user: ApiUser,
    input: CreateAliyunVodMediaRequest,
  ): Promise<ResourceEntry> {
    const provider = this.requireAliyunVodProvider();
    await this.assertContainer(input.parentId);
    await this.access.assertCapability(user, input.parentId, "create_child");
    const name = this.validateName(input.name);
    const videoId = validateAliyunVodVideoId(input.videoId);

    // 云端读取不能占用数据库事务；最终写入时会重新验证目录、ACL 和同名冲突。
    const metadata = await this.callAliyunVod(
      () => provider.gateway.inspectVideo(videoId),
      "无法验证阿里云 VOD 媒资，请稍后重试。",
    );
    if (metadata.status !== "Normal") {
      throw externalMediaUnavailable("阿里云 VOD 媒资当前不可用。", {
        status: metadata.status,
      });
    }

    const createdId = await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeForContentWrite(transaction);
      await this.lockParentNamespaces(transaction, [input.parentId]);
      await this.assertContainer(input.parentId, transaction);
      await this.access.assertCapability(
        user,
        input.parentId,
        "create_child",
        transaction,
      );
      await this.assertNameAvailable(transaction, input.parentId, name);
      const resource = await transaction.resourceEntry.create({
        data: {
          parentId: input.parentId,
          type: "media_file",
          name,
          ownerUserId: user.id,
        },
        select: { id: true },
      });
      // VOD 元数据显式顺序写入，避免 nested create 在事务连接上并发执行。
      await transaction.mediaFile.create({
        data: {
          resourceId: resource.id,
          sourceType: "aliyun_vod",
          mediaKind: metadata.mediaKind,
          duration: metadata.duration,
          aliyunVodVideoId: metadata.videoId,
          aliyunVodRegion: provider.region,
        },
      });
      // 新 VOD 媒体与上传媒体共用同一原声音轨 invariant，外部音轨随后由独立管理 API 关联。
      await createOriginalMediaAudioTrack(transaction, {
        primaryMediaResourceId: resource.id,
        mediaKind: metadata.mediaKind,
        createdBy: user.id,
      });
      await transaction.auditLog.create({
        data: {
          action: "aliyun_vod_media_create",
          actorUserId: user.id,
          resourceId: resource.id,
          detail: {
            sourceType: "aliyun_vod",
            region: provider.region,
            mediaKind: metadata.mediaKind,
            duration: metadata.duration,
          },
        },
      });
      return resource.id;
    });
    return this.getMappedResource(user, createdId);
  }

  // 播放会话每次重新校验 ACL 与资源状态，临时凭据只存在于本次响应。
  async createAliyunVodPlaybackSession(
    user: ApiUser,
    resourceId: string,
  ): Promise<AliyunVodPlaybackSession> {
    await this.access.assertCapability(user, resourceId, "read");
    await this.access.assertCapability(user, resourceId, "download");
    const media = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
      include: { mediaFile: true },
    });
    if (!media?.mediaFile || media.type !== "media_file") {
      throw notFound("媒体资源不存在。");
    }
    if (media.trashedAt || media.archivedAt) {
      throw externalMediaUnavailable("请先恢复或取消归档该媒体资源。");
    }
    if (media.mediaFile.sourceType !== "aliyun_vod") {
      throw badRequest("服务器上传媒体继续使用受保护下载地址播放。");
    }
    if (
      !media.mediaFile.aliyunVodVideoId ||
      !media.mediaFile.aliyunVodRegion
    ) {
      throw externalMediaUnavailable("阿里云 VOD 媒资缺少稳定播放身份。");
    }
    return issueAliyunVodPlaybackSession(
      this.aliyunVod,
      this.aliyunVodWebPlayerLicense,
      {
        mediaKind: media.mediaFile.mediaKind,
        videoId: media.mediaFile.aliyunVodVideoId,
        region: media.mediaFile.aliyunVodRegion,
      },
    );
  }

  // 上传流开始前先拒绝无效目录和无权限请求，避免为必然失败的命令写入大文件。
  async prepareMediaUpload(user: ApiUser, parentId: string, name: string) {
    this.validateName(name);
    await this.assertContainer(parentId);
    await this.access.assertCapability(user, parentId, "create_child");
  }

  // 二进制原子发布后，在一个事务中完成容量复核、文件元数据、资源节点和审计记录。
  async commitUploadedMedia(
    user: ApiUser,
    input: {
      parentId: string;
      name: string;
      mimeType: string;
      size: number;
      storageKey: string;
      checksum: string;
      userQuotaBytes: number;
      platformQuotaBytes: number;
    },
  ) {
    await this.assertContainer(input.parentId);
    await this.access.assertCapability(user, input.parentId, "create_child");
    const name = this.validateName(input.name);
    const resource = await this.prisma.$transaction(async (transaction) => {
      // 锁顺序固定为资源树共享门禁、平台配额、用户配额、目录，避免权限撤销与上传提交交错。
      await this.lockResourceTreeForContentWrite(transaction);
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext('xiqu:storage-quota:platform'))
      `;
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${`xiqu:storage-quota:user:${user.id}`}))
      `;
      await this.lockParentNamespaces(transaction, [input.parentId]);
      await this.assertContainer(input.parentId, transaction);
      await this.access.assertCapability(
        user,
        input.parentId,
        "create_child",
        transaction,
      );
      await this.assertNameAvailable(
        transaction,
        input.parentId,
        name,
      );

      // FileObject 是容量计费单位；多个媒体资源复用同一对象时只计算一次。
      // PrismaPg 的事务使用单连接，容量查询顺序执行以避免在同一 client 上并发 query。
      const platformUsageRow = await transaction.$queryRaw<
        Array<{ total: bigint }>
      >`
        SELECT COALESCE(SUM(size), 0)::bigint AS total FROM files
      `;
      const userUsageRow = await transaction.$queryRaw<
        Array<{ total: bigint }>
      >`
        SELECT COALESCE(SUM(size), 0)::bigint AS total
        FROM files WHERE owner_user_id = ${user.id}
      `;
      const platformUsedBytes = Number(platformUsageRow[0]?.total ?? 0n);
      const userUsedBytes = Number(userUsageRow[0]?.total ?? 0n);
      if (platformUsedBytes + input.size > input.platformQuotaBytes) {
        throw storageQuotaExceeded("平台存储容量不足。", {
          usedBytes: platformUsedBytes,
          quotaBytes: input.platformQuotaBytes,
          requiredBytes: input.size,
        });
      }
      if (userUsedBytes + input.size > input.userQuotaBytes) {
        throw storageQuotaExceeded("当前账号的存储容量不足。", {
          usedBytes: userUsedBytes,
          quotaBytes: input.userQuotaBytes,
          requiredBytes: input.size,
        });
      }

      // 写边界：input.size 是 number（来自暂存流计数），列已迁 BigInt，需显式转换。
      const file = await transaction.fileObject.create({
        data: {
          name,
          mimeType: input.mimeType,
          size: BigInt(input.size),
          storageKey: input.storageKey,
          checksum: input.checksum,
          ownerUserId: user.id,
        },
      });
      const createdResource = await transaction.resourceEntry.create({
        data: {
          parentId: input.parentId,
          type: "media_file",
          name,
          ownerUserId: user.id,
        },
        select: { id: true },
      });
      // 二进制元数据与资源节点保持原子，但不使用会并行解释的 nested relation write。
      await transaction.mediaFile.create({
        data: {
          resourceId: createdResource.id,
          sourceType: "uploaded",
          mediaKind: mediaKindFromMimeType(input.mimeType),
          fileId: file.id,
          mimeType: input.mimeType,
          size: BigInt(input.size),
        },
      });
      // 原声音轨与媒体资源在同一事务提交，任何读取都不会观察到“有媒体但无原声”的中间状态。
      await createOriginalMediaAudioTrack(transaction, {
        primaryMediaResourceId: createdResource.id,
        mediaKind: mediaKindFromMimeType(input.mimeType),
        createdBy: user.id,
      });
      await transaction.auditLog.create({
        data: {
          action: "media_upload",
          actorUserId: user.id,
          resourceId: createdResource.id,
          fileId: file.id,
          detail: {
            name,
            mimeType: input.mimeType,
            size: input.size,
          },
        },
      });
      return createdResource;
    });
    // 这里只返回已提交资源 id；DTO 映射在上传编排层标记 committed 后进行，避免映射失败误删二进制。
    return resource.id;
  }

  async getAnnotationFile<TPayload>(
    user: ApiUser,
    resourceId: string,
  ): Promise<AnnotationFile<TPayload>> {
    await this.access.assertCapability(user, resourceId, "read");
    const resource = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
      include: {
        ...resourceBaseInclude,
        annotationFile: {
          include: {
            lastEditor: { include: { roles: true } },
            mediaResource: { include: { resource: true, file: true } },
          },
        },
      },
    });
    if (!resource?.annotationFile) throw notFound("标注文件不存在。");
    const resourceRow: ResourceRow = {
      ...resource,
      mediaFile: null,
      projectWorkflowStatus: null,
      annotationResponsibles: [],
    };
    return this.mapAnnotationFile<TPayload>(
      user,
      resourceRow,
      resource.annotationFile,
    );
  }

  // 客户端同步失败进入既有审计链，方便按账号、文件和时间回查；两秒限频避免错误渲染循环刷爆日志。
  async recordAnnotationClientSyncFailure(
    user: ApiUser,
    resourceId: string,
    report: AnnotationClientSyncFailureReport,
  ): Promise<AnnotationClientSyncFailureReportResult> {
    await this.access.assertCapability(user, resourceId, "read");
    const annotationFile = await this.prisma.annotationFile.findUnique({
      where: { resourceId },
      select: { resourceId: true },
    });
    if (!annotationFile) throw notFound("标注文件不存在。");

    const recent = await this.prisma.auditLog.findFirst({
      where: {
        action: "annotation_client_sync_failure",
        actorUserId: user.id,
        resourceId,
        createdAt: { gte: new Date(Date.now() - 2_000) },
      },
      select: { id: true },
    });
    if (recent) return { recorded: false };

    await this.prisma.auditLog.create({
      data: {
        action: "annotation_client_sync_failure",
        actorUserId: user.id,
        resourceId,
        detail: report as unknown as Prisma.InputJsonValue,
      },
    });
    return { recorded: true };
  }

  async getDownloadableResource(
    user: ApiUser,
    resourceId: string,
  ): Promise<DownloadableResource> {
    // 下载是独立于 read 的显式能力；能够在界面中看到资源不代表可以导出原始内容。
    await this.access.assertCapability(user, resourceId, "download");
    const resource = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
    });
    if (!resource) throw notFound("资源不存在。");
    if (resource.trashedAt) throw badRequest("请先恢复回收站中的资源，再执行下载。");

    // 两种文件关系互斥：先看资源类型，再只读取需要的关系，避免同 client 并行展开。
    if (resource.type === "media_file") {
      const mediaFile = await this.prisma.mediaFile.findUnique({
        where: { resourceId },
        include: { file: true },
      });
      if (
        !mediaFile ||
        mediaFile.sourceType !== "uploaded" ||
        !mediaFile.file ||
        mediaFile.mimeType === null ||
        mediaFile.size === null
      ) {
        throw unsupportedMedia("阿里云 VOD 是外部媒资，不能通过平台下载原文件。");
      }
      return {
        kind: "media",
        fileName: resource.name,
        mimeType: mediaFile.mimeType,
        size: Number(mediaFile.size),
        storageKey: mediaFile.file.storageKey,
      };
    }
    if (resource.type === "annotation_file") {
      const annotationFile = await this.prisma.annotationFile.findUnique({
        where: { resourceId },
        select: { payload: true },
      });
      if (!annotationFile) throw notFound("标注文件不存在。");
      // 标注文件导出权威 payload，不把运行时媒体 URL、访问 token 或浏览器草稿写入文件。
      const fileName = resource.name.toLowerCase().endsWith(".json")
        ? resource.name
        : `${resource.name}.json`;
      return {
        kind: "annotation",
        fileName,
        mimeType: "application/json; charset=utf-8",
        content: `${JSON.stringify(annotationFile.payload, null, 2)}\n`,
      };
    }
    throw badRequest("项目和文件夹暂不支持直接下载，请选择媒体或标注文件。");
  }

  async updateAnnotationMedia<TPayload>(
    user: ApiUser,
    resourceId: string,
    input: UpdateAnnotationMediaRequest,
  ): Promise<AnnotationFile<TPayload>> {
    await this.access.assertCapability(user, resourceId, "write");
    await this.prisma.$transaction(async (transaction) => {
      await lockActiveAnnotationFileForWrite(transaction, this.access, user, resourceId);
      if (input.mediaResourceId) {
        await this.assertMediaResourceForBinding(user, input.mediaResourceId, transaction);
      }
      const current = await transaction.annotationFile.findUnique({
        where: { resourceId },
        select: { mediaResourceId: true },
      });
      if (!current) throw notFound("标注文件不存在。");
      if (current.mediaResourceId === input.mediaResourceId) return;
      await transaction.annotationFile.update({
        where: { resourceId },
        data: { mediaResourceId: input.mediaResourceId },
      });
      // 默认音轨只对旧主媒体有效；改绑必须与外键更新原子清理，不能让下一会话引用其他视频的音轨。
      await transaction.annotationAudioPreference.deleteMany({
        where: { annotationFileId: resourceId },
      });
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { updatedAt: new Date() },
      });
      await transaction.auditLog.create({
        data: {
          action: input.mediaResourceId ? "annotation_media_bind" : "annotation_media_unbind",
          actorUserId: user.id,
          resourceId,
          detail: {
            previousMediaResourceId: current.mediaResourceId,
            nextMediaResourceId: input.mediaResourceId,
          },
        },
      });
    });
    return this.getAnnotationFile<TPayload>(user, resourceId);
  }

  // 最近打开是独立的非关键写命令；读取标注 payload 本身保持纯 GET，维护期间仍可只读查看。
  async markResourceOpened(user: ApiUser, resourceId: string) {
    await this.access.assertCapability(user, resourceId, "read");
    await this.prisma.resourceUserState.upsert({
      where: { resourceId_userId: { resourceId, userId: user.id } },
      update: { lastOpenedAt: new Date() },
      create: { resourceId, userId: user.id, lastOpenedAt: new Date() },
    });
  }

  async saveAnnotationFile<TPayload>(
    user: ApiUser,
    resourceId: string,
    input: SaveAnnotationFileRequest<TPayload>,
  ): Promise<AnnotationFile<TPayload>> {
    // 锁外预检用于快速拒绝常见无权限请求；事务内仍会在树结构稳定后再次复核。
    await this.access.assertCapability(user, resourceId, "write");
    const committedRevision = await this.prisma.$transaction(async (transaction) => {
      // 普通保存与快照恢复共用同一锁顺序，避免保存期间资源被移动或藏入回收站。
      const current = await lockActiveAnnotationFileForWrite(transaction, this.access, user, resourceId);
      if (current.revision !== input.baseRevision) {
        throw conflict("标注文件已被其他人修改，请刷新后再保存。", {
          expectedRevision: current.revision,
          receivedRevision: input.baseRevision,
        });
      }
      const leaseGuard = await assertAnnotationMutationLeaseForWrite(
        transaction,
        resourceId,
        user.id,
        input.baseRevision,
        input.mutationLeaseToken,
      );

      // 本次完整 payload 覆盖的 operation 必须全部属于当前文件、账号和 base revision。
      // 先完整验证再写快照，任何缺失或重复都不能形成部分 committed 事实。
      const operationIds = [...new Set(input.clientOperationIds)];
      if (operationIds.length !== input.clientOperationIds.length || operationIds.length > 500) {
        throw badRequest("保存关联的 operation 编号重复或超过 500 项。");
      }
      const operations = operationIds.length > 0
        ? await transaction.annotationOperation.findMany({
            where: {
              annotationFileId: resourceId,
              actorUserId: user.id,
              clientOperationId: { in: operationIds },
            },
            select: {
              clientOperationId: true,
              baseRevision: true,
              committedRevision: true,
            },
          })
        : [];
      if (
        operations.length !== operationIds.length ||
        operations.some((operation) =>
          operation.baseRevision !== input.baseRevision ||
          operation.committedRevision !== null)
      ) {
        throw conflict("保存关联的 operation 不存在、版本不一致或已经提交。", {
          code: "operation_commit_conflict",
        });
      }

      // 保存前把旧内容写入恢复快照；它只通过标注文件 Inspector 受控查看，不是业务“版本”。
      await transaction.annotationRecoverySnapshot.upsert({
        where: {
          annotationFileId_revision: {
            annotationFileId: resourceId,
            revision: current.revision,
          },
        },
        update: {},
        create: {
          annotationFileId: resourceId,
          revision: current.revision,
          payload: current.payload as Prisma.InputJsonValue,
          createdBy: user.id,
          reason: "save",
        },
      });

      // revision 必须参与 UPDATE 条件。即使两个请求同时读到同一 revision，
      // 也只能有一个请求真正取得写入权，另一个事务会整体回滚。
      const targetRevision = input.baseRevision + 1;
      const committedAt = new Date();
      const updated = await transaction.annotationFile.updateMany({
        where: { resourceId, revision: input.baseRevision },
        data: {
          payload: input.payload as Prisma.InputJsonValue,
          revision: { increment: 1 },
          lastEditedBy: user.id,
          lastSavedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        const latest = await transaction.annotationFile.findUnique({
          where: { resourceId },
          select: { revision: true },
        });
        throw conflict("标注文件已被其他人修改，请刷新后再保存。", {
          expectedRevision: latest?.revision ?? input.baseRevision,
          receivedRevision: input.baseRevision,
        });
      }
      // operation 与新 payload revision 在同一事务绑定；保存回滚时 committed 字段也必须回滚。
      if (operationIds.length > 0) {
        const committed = await transaction.annotationOperation.updateMany({
          where: {
            annotationFileId: resourceId,
            actorUserId: user.id,
            clientOperationId: { in: operationIds },
            baseRevision: input.baseRevision,
            committedRevision: null,
          },
          data: {
            committedRevision: targetRevision,
            committedAt,
          },
        });
        if (committed.count !== operationIds.length) {
          throw conflict("保存期间 operation 状态发生变化，请刷新后重试。", {
            code: "operation_commit_race",
          });
        }
      }
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { updatedAt: new Date() },
      });

      // 受控结构变更只有在 payload、operation 和 revision 全部提交成功后才释放租约。
      if (leaseGuard.leaseWasUsed) {
        await transaction.annotationMutationLease.delete({ where: { annotationFileId: resourceId } });
      }

      // 保存审计与 payload 写入同属一个事务，失败时不会出现“已保存但无审计”的半完成状态。
      await transaction.auditLog.create({
        data: {
          action: "annotation_file_save",
          actorUserId: user.id,
          resourceId,
          detail: {
            revision: targetRevision,
            operationCount: operationIds.length,
            ...(leaseGuard.leaseWasUsed ? { mutationLeaseReleased: true } : {}),
          },
        },
      });
      return targetRevision;
    });
    // 事务返回本次确切 revision；不能在锁外重读后把另一笔更晚保存误报成本次提交。
    this.revisionPublisher.publishRevisionAdvanced({
      annotationFileId: resourceId,
      revision: committedRevision,
      operationCursor: encodeAnnotationSnapshotOperationCursor(resourceId, committedRevision),
    });
    return this.getAnnotationFile<TPayload>(user, resourceId);
  }

  async getAnnotationMutationLease(
    user: ApiUser,
    resourceId: string,
  ): Promise<AnnotationMutationLeaseSummary | null> {
    await this.access.assertCapability(user, resourceId, "read");
    await this.assertActiveAnnotationFile(resourceId);
    const lease = await this.prisma.annotationMutationLease.findUnique({
      where: { annotationFileId: resourceId },
      include: { holder: { include: { roles: true } } },
    });
    return !lease || isAnnotationMutationLeaseExpired(lease.expiresAt)
      ? null
      : mapAnnotationMutationLease(lease);
  }

  async acquireAnnotationMutationLease(
    user: ApiUser,
    resourceId: string,
    input: { baseRevision: number; purpose: AnnotationMutationPurpose },
  ): Promise<AnnotationMutationLeaseGrant> {
    await this.access.assertCapability(user, resourceId, "write");
    const token = createAnnotationMutationLeaseToken();
    return this.prisma.$transaction(async (transaction) => {
      const current = await lockActiveAnnotationFileForWrite(transaction, this.access, user, resourceId);
      if (current.revision !== input.baseRevision) {
        throw conflict("标注文件版本已变化，不能取得结构变更租约。", {
          code: "annotation_mutation_lease_revision_conflict",
          expectedRevision: current.revision,
          receivedRevision: input.baseRevision,
        });
      }
      const existing = await transaction.annotationMutationLease.findUnique({
        where: { annotationFileId: resourceId },
        include: { holder: { include: { roles: true } } },
      });
      if (existing && !isAnnotationMutationLeaseExpired(existing.expiresAt)) {
        throw conflict("该标注文件已有结构变更租约。", {
          code: "annotation_mutation_lease_held",
          holder: toPublicUser(existing.holder),
          purpose: existing.purpose,
          expiresAt: existing.expiresAt.toISOString(),
        });
      }
      if (existing) {
        await transaction.annotationMutationLease.delete({ where: { annotationFileId: resourceId } });
      }
      const now = new Date();
      const created = await transaction.annotationMutationLease.create({
        data: {
          annotationFileId: resourceId,
          holderUserId: user.id,
          tokenHash: hashAnnotationMutationLeaseToken(token),
          purpose: input.purpose,
          baseRevision: input.baseRevision,
          createdAt: now,
          expiresAt: calculateAnnotationMutationLeaseExpiry(now, now),
        },
        include: { holder: { include: { roles: true } } },
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_mutation_lease_acquire",
          actorUserId: user.id,
          resourceId,
          detail: {
            purpose: created.purpose,
            baseRevision: created.baseRevision,
            expiresAt: created.expiresAt.toISOString(),
          },
        },
      });
      return { ...mapAnnotationMutationLease(created), token };
    });
  }

  async renewAnnotationMutationLease(
    user: ApiUser,
    resourceId: string,
    token: string,
  ): Promise<AnnotationMutationLeaseGrant> {
    await this.access.assertCapability(user, resourceId, "write");
    return this.prisma.$transaction(async (transaction) => {
      const current = await lockActiveAnnotationFileForWrite(transaction, this.access, user, resourceId);
      const lease = await transaction.annotationMutationLease.findUnique({
        where: { annotationFileId: resourceId },
        include: { holder: { include: { roles: true } } },
      });
      assertOwnedActiveMutationLease(lease, user.id, token, current.revision);
      const now = new Date();
      const expiresAt = calculateAnnotationMutationLeaseExpiry(lease.createdAt, now);
      if (expiresAt.getTime() <= now.getTime()) {
        throw conflict("结构变更租约已达到最长生命周期，请重新取得。", {
          code: "annotation_mutation_lease_expired",
        });
      }
      const renewed = await transaction.annotationMutationLease.update({
        where: { annotationFileId: resourceId },
        data: { expiresAt },
        include: { holder: { include: { roles: true } } },
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_mutation_lease_renew",
          actorUserId: user.id,
          resourceId,
          detail: { purpose: renewed.purpose, baseRevision: renewed.baseRevision, expiresAt: expiresAt.toISOString() },
        },
      });
      return { ...mapAnnotationMutationLease(renewed), token };
    });
  }

  async releaseAnnotationMutationLease(user: ApiUser, resourceId: string, token: string) {
    await this.access.assertCapability(user, resourceId, "write");
    await this.prisma.$transaction(async (transaction) => {
      const current = await lockActiveAnnotationFileForWrite(transaction, this.access, user, resourceId);
      const lease = await transaction.annotationMutationLease.findUnique({ where: { annotationFileId: resourceId } });
      assertOwnedActiveMutationLease(lease, user.id, token, current.revision);
      await transaction.annotationMutationLease.delete({ where: { annotationFileId: resourceId } });
      await transaction.auditLog.create({
        data: {
          action: "annotation_mutation_lease_release",
          actorUserId: user.id,
          resourceId,
          detail: { purpose: lease.purpose, baseRevision: lease.baseRevision },
        },
      });
    });
  }

  // 历史列表只返回轻量元数据，避免一次读取最多 50 份完整 ProjectData。
  async listRecoverySnapshots(
    user: ApiUser,
    resourceId: string,
  ): Promise<AnnotationRecoverySnapshotSummary[]> {
    await this.access.assertCapability(user, resourceId, "write");
    await this.assertActiveAnnotationFile(resourceId);
    const rows = await this.prisma.annotationRecoverySnapshot.findMany({
      where: { annotationFileId: resourceId },
      select: {
        id: true,
        annotationFileId: true,
        revision: true,
        creator: { include: { roles: true } },
        reason: true,
        createdAt: true,
      },
      // revision 理论上已唯一；附加时间和 id 让异常迁移数据也保持稳定顺序。
      orderBy: [
        { revision: "desc" },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
      creator: toPublicUser(row.creator),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // 详情查询同时绑定文件和快照 id，防止利用其他文件的 snapshot id 越权读取 payload。
  async getRecoverySnapshot<TPayload>(
    user: ApiUser,
    resourceId: string,
    snapshotId: string,
  ): Promise<AnnotationRecoverySnapshotDetail<TPayload>> {
    await this.access.assertCapability(user, resourceId, "write");
    await this.assertActiveAnnotationFile(resourceId);
    const row = await this.prisma.annotationRecoverySnapshot.findFirst({
      where: {
        id: snapshotId,
        annotationFileId: resourceId,
      },
      include: { creator: { include: { roles: true } } },
    });
    if (!row) throw notFound("恢复快照不存在。");
    const payload = resolveRecoverySnapshotPayloadOrThrow<TPayload>({
      id: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
      storageMode: row.storageMode,
      payload: row.payload as TPayload,
      payloadSha256: row.payloadSha256,
    });
    return {
      id: row.id,
      annotationFileId: row.annotationFileId,
      revision: row.revision,
      payload,
      creator: toPublicUser(row.creator),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // 恢复历史不是 revision 回退，而是把目标 payload 写成新的当前 revision，并保留恢复前内容。
  async restoreAnnotationRecoverySnapshot<TPayload>(
    user: ApiUser,
    resourceId: string,
    snapshotId: string,
    input: RestoreAnnotationRecoverySnapshotRequest,
  ): Promise<AnnotationFile<TPayload>> {
    // 锁外预检减少无权限请求占用事务；真正安全边界仍在锁内 helper 中。
    await this.access.assertCapability(user, resourceId, "write");
    const committedRevision = await this.prisma.$transaction(async (transaction) => {
      const current = await lockActiveAnnotationFileForWrite(transaction, this.access, user, resourceId);
      if (current.revision !== input.baseRevision) {
        throw conflict("标注文件已被其他人修改，请刷新后再恢复。", {
          expectedRevision: current.revision,
          receivedRevision: input.baseRevision,
        });
      }

      const leaseGuard = await assertAnnotationMutationLeaseForWrite(
        transaction,
        resourceId,
        user.id,
        input.baseRevision,
        input.mutationLeaseToken,
      );

      // 快照 id 必须和路径中的文件 id 同时匹配，不能借其他文件的 id 读取或恢复 payload。
      const sourceSnapshot = await transaction.annotationRecoverySnapshot
        .findFirst({
          where: {
            id: snapshotId,
            annotationFileId: resourceId,
          },
        });
      if (!sourceSnapshot) throw notFound("恢复快照不存在。");
      const sourcePayload = resolveRecoverySnapshotPayloadOrThrow<Prisma.JsonValue>({
        id: sourceSnapshot.id,
        annotationFileId: sourceSnapshot.annotationFileId,
        revision: sourceSnapshot.revision,
        storageMode: sourceSnapshot.storageMode,
        payload: sourceSnapshot.payload,
        payloadSha256: sourceSnapshot.payloadSha256,
      });

      // 覆盖前保存当前内容，使用户能够再次恢复到本次操作之前的状态。
      await transaction.annotationRecoverySnapshot.upsert({
        where: {
          annotationFileId_revision: {
            annotationFileId: resourceId,
            revision: current.revision,
          },
        },
        update: {},
        create: {
          annotationFileId: resourceId,
          revision: current.revision,
          payload: current.payload as Prisma.InputJsonValue,
          createdBy: user.id,
          reason: "before_snapshot_restore",
        },
      });

      // revision 仍参与条件更新；即使未来锁实现变化，乐观锁也不会静默覆盖并发写入。
      const updated = await transaction.annotationFile.updateMany({
        where: { resourceId, revision: input.baseRevision },
        data: {
          payload: sourcePayload as Prisma.InputJsonValue,
          revision: { increment: 1 },
          lastEditedBy: user.id,
          lastSavedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        const latest = await transaction.annotationFile.findUnique({
          where: { resourceId },
          select: { revision: true },
        });
        throw conflict("标注文件已被其他人修改，请刷新后再恢复。", {
          expectedRevision: latest?.revision ?? input.baseRevision,
          receivedRevision: input.baseRevision,
        });
      }

      // 资源修改时间和恢复审计与内容替换同时提交，审计只记录定位信息而不复制 payload。
      const nextRevision = current.revision + 1;
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { updatedAt: new Date() },
      });
      if (leaseGuard.leaseWasUsed) {
        await transaction.annotationMutationLease.delete({ where: { annotationFileId: resourceId } });
      }
      await transaction.auditLog.create({
        data: {
          action: "annotation_snapshot_restore",
          actorUserId: user.id,
          resourceId,
          detail: {
            sourceSnapshotId: sourceSnapshot.id,
            sourceRevision: sourceSnapshot.revision,
            previousRevision: current.revision,
            revision: nextRevision,
            ...(leaseGuard.leaseWasUsed ? { mutationLeaseReleased: true } : {}),
          },
        },
      });
      return nextRevision;
    });
    // 快照恢复同样形成新的权威 revision，clean 客户端通过既有 HTTP catch-up 获取真实内容。
    this.revisionPublisher.publishRevisionAdvanced({
      annotationFileId: resourceId,
      revision: committedRevision,
      operationCursor: encodeAnnotationSnapshotOperationCursor(resourceId, committedRevision),
    });
    return this.getAnnotationFile<TPayload>(user, resourceId);
  }

  // 确认记录采用稳定复合 keyset 分页；撤销事实仍在同一历史流中返回。
  async listAnnotationConfirmations(
    user: ApiUser,
    resourceId: string,
    options: { cursor?: string; limit?: number },
  ): Promise<AnnotationConfirmationList> {
    await this.access.assertCapability(user, resourceId, "read");
    await this.assertActiveAnnotationFile(resourceId);
    const limit = Math.max(1, Math.min(options.limit ?? 50, ANNOTATION_REVIEW_PAGE_MAX_LIMIT));
    const cursor = options.cursor
      ? decodeAnnotationConfirmationCursor(options.cursor, resourceId)
      : null;
    if (options.cursor && !cursor) throw badRequest("确认记录分页游标无效或不属于当前文件。");
    const cursorWhere = cursor ? {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    } : {};
    const [file, rows] = await Promise.all([
      this.prisma.annotationFile.findUnique({
        where: { resourceId },
        select: { revision: true },
      }),
      this.prisma.annotationConfirmation.findMany({
        where: { annotationFileId: resourceId, ...cursorWhere },
        include: annotationConfirmationInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
    ]);
    if (!file) throw notFound("标注文件不存在。");
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      currentRevision: file.revision,
      confirmations: pageRows.map(mapAnnotationConfirmation),
      nextCursor: rows.length > limit && last
        ? encodeAnnotationConfirmationCursor({
            annotationFileId: resourceId,
            createdAt: last.createdAt,
            id: last.id,
          })
        : null,
    };
  }

  // 创建确认在锁内重新校验 revision、活动资源、逐资源 review 和真实持久轨道。
  async createAnnotationConfirmation(
    user: ApiUser,
    resourceId: string,
    input: Omit<AnnotationConfirmationDraft, "annotationFileId">,
  ): Promise<AnnotationConfirmationRecord> {
    const validated = validateAnnotationConfirmationDraft({
      annotationFileId: resourceId,
      ...input,
    });
    if (!validated.ok) {
      throw badRequest("确认范围格式不正确。", { issues: validated.issues });
    }

    const record = await this.prisma.$transaction(async (transaction) => {
      const { current, permission } = await this.lockAnnotationFileForRangeFact(
        transaction,
        user,
        resourceId,
      );
      const reviewDecision = canCreateAnnotationReviewFact({
        actorUserId: user.id,
        canRead: permission.capabilities.includes("read"),
        canReview: permission.capabilities.includes("review"),
        isAdminOrOwner: permission.source === "admin" || permission.isOwner,
      });
      if (!reviewDecision.allowed) throw forbidden("当前账号缺少该标注文件的审核权限。");
      if (current.revision !== validated.value.confirmedRevision) {
        throw conflict("标注文件已产生新修订，请刷新后重新审核。", {
          expectedRevision: current.revision,
          receivedRevision: validated.value.confirmedRevision,
        });
      }

      // tracks 只能引用当前 payload 中真实保存的顶层轨道；无法识别旧结构时保守拒绝。
      if (validated.value.scope.targets.mode === "tracks") {
        const trackIds = extractPersistedAnnotationReviewTrackIds(current.payload);
        if (!trackIds.ok) {
          throw badRequest("当前标注内容无法验证轨道作用域。", {
            issues: trackIds.issues,
          });
        }
        const trackScope = validateAnnotationReviewTracks(
          validated.value.scope,
          new Set(trackIds.value),
        );
        if (!trackScope.ok) {
          throw badRequest("确认范围包含无效轨道。", { issues: trackScope.issues });
        }
      }

      const created = await transaction.annotationConfirmation.create({
        data: this.toAnnotationConfirmationCreateData(user.id, validated.value),
        include: annotationConfirmationInclude,
      });
      // 审计与确认记录同事务提交，detail 只保留定位字段，不复制 note 或 payload。
      await transaction.auditLog.create({
        data: {
          action: "annotation_confirmation_create",
          actorUserId: user.id,
          resourceId,
          detail: {
            confirmationId: created.id,
            confirmedRevision: created.confirmedRevision,
            startTime: created.startTime,
            endTime: created.endTime,
            targetMode: created.targetMode,
          },
        },
      });
      return mapAnnotationConfirmation(created);
    });
    this.publishReviewChanged(resourceId);
    return record;
  }

  // 撤销只补充撤销事实；重复请求幂等返回原记录，不产生第二条审计。
  async revokeAnnotationConfirmation(
    user: ApiUser,
    resourceId: string,
    confirmationId: string,
    reason?: string | null,
  ): Promise<AnnotationConfirmationRecord> {
    const revokeReason = reason?.trim() || null;
    if (revokeReason && revokeReason.length > MAX_CONFIRMATION_REVOKE_REASON_LENGTH) {
      throw badRequest(
        `撤销原因不能超过 ${MAX_CONFIRMATION_REVOKE_REASON_LENGTH} 个字符。`,
      );
    }

    const result = await this.prisma.$transaction(async (transaction) => {
      const { permission: effectivePermission } = await this.lockAnnotationFileForRangeFact(
        transaction,
        user,
        resourceId,
      );
      await transaction.$queryRaw`
        SELECT id
        FROM annotation_confirmations
        WHERE id = ${confirmationId} AND annotation_file_id = ${resourceId}
        FOR UPDATE
      `;
      const existing = await transaction.annotationConfirmation.findFirst({
        where: { id: confirmationId, annotationFileId: resourceId },
        include: annotationConfirmationInclude,
      });
      if (!existing) throw notFound("确认记录不存在。");

      const isAdminOrOwner = await this.access.hasOwnerAuthority(
        user,
        resourceId,
        transaction,
      );
      const permissionDecision = canWithdrawAnnotationReviewFact({
        actorUserId: user.id,
        canRead: effectivePermission.capabilities.includes("read"),
        canReview: effectivePermission.capabilities.includes("review"),
        isAdminOrOwner,
      }, existing.createdBy);
      if (!permissionDecision.allowed) throw forbidden("当前账号不能撤销这条确认记录。");
      if (existing.revokedAt) {
        return { record: mapAnnotationConfirmation(existing), changed: false };
      }

      const revokedAt = new Date();
      const updated = await transaction.annotationConfirmation.update({
        where: { id: existing.id },
        data: { revokedBy: user.id, revokedAt, revokeReason },
        include: annotationConfirmationInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_confirmation_revoke",
          actorUserId: user.id,
          resourceId,
          detail: {
            confirmationId: updated.id,
            confirmedRevision: updated.confirmedRevision,
          },
        },
      });
      return { record: mapAnnotationConfirmation(updated), changed: true };
    });
    if (result.changed) this.publishReviewChanged(resourceId);
    return result.record;
  }

  // 带正文的范围记录采用稳定 keyset 分页；正文只通过需要 read 权限的 HTTP 响应返回。
  async listAnnotationRangeComments(
    user: ApiUser,
    resourceId: string,
    options: { cursor?: string; limit?: number; includeWithdrawn?: boolean },
  ): Promise<AnnotationRangeCommentPage> {
    await this.access.assertCapability(user, resourceId, "read");
    await this.assertActiveAnnotationFile(resourceId);
    const includeWithdrawn = options.includeWithdrawn ?? false;
    const limit = Math.max(1, Math.min(options.limit ?? 50, ANNOTATION_REVIEW_PAGE_MAX_LIMIT));
    const cursor = options.cursor
      ? decodeAnnotationRangeCommentCursor(options.cursor, { annotationFileId: resourceId, includeWithdrawn })
      : null;
    if (options.cursor && !cursor) throw badRequest("范围记录分页游标无效或与当前筛选不匹配。");
    const cursorWhere = cursor ? {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    } : {};
    const [file, rows] = await Promise.all([
      this.prisma.annotationFile.findUnique({ where: { resourceId }, select: { revision: true } }),
      this.prisma.annotationRangeComment.findMany({
        where: {
          annotationFileId: resourceId,
          ...(!includeWithdrawn ? { withdrawnAt: null } : {}),
          ...cursorWhere,
        },
        include: annotationRangeCommentInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      }),
    ]);
    if (!file) throw notFound("标注文件不存在。");
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      currentRevision: file.revision,
      items: pageRows.map(mapAnnotationRangeComment),
      nextCursor: rows.length > limit && last
        ? encodeAnnotationRangeCommentCursor({
            annotationFileId: resourceId,
            includeWithdrawn,
            createdAt: last.createdAt,
            id: last.id,
          })
        : null,
    };
  }

  // 审核评论和编辑反馈共用范围、分页与锁；kind 只选择权限来源和审计语义。
  async createAnnotationRangeComment(
    user: ApiUser,
    resourceId: string,
    input: Omit<AnnotationRangeCommentDraft, "annotationFileId">,
  ): Promise<AnnotationRangeCommentRecord> {
    const validated = validateAnnotationRangeCommentDraft({ annotationFileId: resourceId, ...input });
    if (!validated.ok) {
      throw badRequest("范围记录格式不正确。", { issues: validated.issues });
    }
    const record = await this.prisma.$transaction(async (transaction) => {
      const { current, permission } = await this.lockAnnotationFileForRangeFact(transaction, user, resourceId);
      const permissionDecision = canCreateAnnotationRangeComment({
        actorUserId: user.id,
        canRead: permission.capabilities.includes("read"),
        canReview: permission.capabilities.includes("review"),
        canWrite: permission.capabilities.includes("write"),
        isAdminOrOwner: permission.source === "admin" || permission.isOwner,
      }, validated.value.kind);
      if (!permissionDecision.allowed) {
        throw forbidden(validated.value.kind === "editor_feedback"
          ? "当前账号缺少该标注文件的编辑权限。"
          : "当前账号缺少该标注文件的审核权限。");
      }
      if (current.revision !== validated.value.commentedRevision) {
        throw conflict("标注文件已产生新修订，请刷新后重新提交范围记录。", {
          expectedRevision: current.revision,
          receivedRevision: validated.value.commentedRevision,
        });
      }
      if (validated.value.scope.targets.mode === "tracks") {
        const trackIds = extractPersistedAnnotationReviewTrackIds(current.payload);
        if (!trackIds.ok) {
          throw badRequest("当前标注内容无法验证轨道作用域。", { issues: trackIds.issues });
        }
        const scope = validateAnnotationReviewTracks(validated.value.scope, new Set(trackIds.value));
        if (!scope.ok) throw badRequest("范围记录包含无效轨道。", { issues: scope.issues });
      }
      const created = await transaction.annotationRangeComment.create({
        data: this.toAnnotationRangeCommentCreateData(user.id, validated.value),
        include: annotationRangeCommentInclude,
      });
      // 审计刻意不保存正文、轨道列表或完整作用域，减少治理日志中的敏感研究内容。
      await transaction.auditLog.create({
        data: {
          action: validated.value.kind === "editor_feedback"
            ? "annotation_range_feedback_create"
            : "annotation_range_comment_create",
          actorUserId: user.id,
          resourceId,
          detail: {
            commentId: created.id,
            commentedRevision: created.commentedRevision,
            startTime: created.startTime,
            endTime: created.endTime,
            targetMode: created.targetMode,
          },
        },
      });
      return mapAnnotationRangeComment(created);
    });
    this.publishReviewChanged(resourceId);
    return record;
  }

  // 撤回保持幂等；评论重验 review，反馈重验 write，且都保留作者/owner/admin 边界。
  async withdrawAnnotationRangeComment(
    user: ApiUser,
    resourceId: string,
    commentId: string,
    reason?: string | null,
  ): Promise<AnnotationRangeCommentRecord> {
    const withdrawReason = reason?.trim() || null;
    if (withdrawReason && withdrawReason.length > MAX_RANGE_COMMENT_WITHDRAW_REASON_LENGTH) {
      throw badRequest(`撤回原因不能超过 ${MAX_RANGE_COMMENT_WITHDRAW_REASON_LENGTH} 个字符。`);
    }
    const result = await this.prisma.$transaction(async (transaction) => {
      const { permission } = await this.lockAnnotationFileForRangeFact(transaction, user, resourceId);
      await transaction.$queryRaw`
        SELECT id FROM annotation_range_comments
        WHERE id = ${commentId} AND annotation_file_id = ${resourceId}
        FOR UPDATE
      `;
      const existing = await transaction.annotationRangeComment.findFirst({
        where: { id: commentId, annotationFileId: resourceId },
        include: annotationRangeCommentInclude,
      });
      if (!existing) throw notFound("范围记录不存在。");
      const isAdminOrOwner = await this.access.hasOwnerAuthority(user, resourceId, transaction);
      const permissionDecision = canWithdrawAnnotationRangeComment({
        actorUserId: user.id,
        canRead: permission.capabilities.includes("read"),
        canReview: permission.capabilities.includes("review"),
        canWrite: permission.capabilities.includes("write"),
        isAdminOrOwner,
      }, existing.kind, existing.createdBy);
      if (!permissionDecision.allowed) throw forbidden("当前账号不能撤回这条范围记录。");
      if (existing.withdrawnAt) {
        return { record: mapAnnotationRangeComment(existing), changed: false };
      }
      const updated = await transaction.annotationRangeComment.update({
        where: { id: existing.id },
        data: { withdrawnBy: user.id, withdrawnAt: new Date(), withdrawReason },
        include: annotationRangeCommentInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: existing.kind === "editor_feedback"
            ? "annotation_range_feedback_withdraw"
            : "annotation_range_comment_withdraw",
          actorUserId: user.id,
          resourceId,
          detail: { commentId: updated.id, commentedRevision: updated.commentedRevision },
        },
      });
      return { record: mapAnnotationRangeComment(updated), changed: true };
    });
    if (result.changed) this.publishReviewChanged(resourceId);
    return result.record;
  }

  async updateAnnotationWorkflowStatus(
    user: ApiUser,
    resourceId: string,
    input: UpdateAnnotationWorkflowStatusRequest,
  ): Promise<ResourceEntry> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeForContentWrite(transaction);
      await this.lockResourceRows(transaction, [resourceId]);
      await this.assertActiveAnnotationFile(resourceId, transaction);
      const permission = await this.access.getEffectivePermission(
        user,
        resourceId,
        transaction,
      );
      if (!permission.capabilities.includes("read")) {
        throw forbidden("当前账号不能读取该标注文件。");
      }

      // 状态使用 annotation 行锁串行化，避免两个陈旧菜单同时覆盖后到达的治理结论。
      const lockedRows = await transaction.$queryRaw<Array<{
        workflowStatus: AnnotationWorkflowStatus;
      }>>`
        SELECT workflow_status AS "workflowStatus"
        FROM annotation_files
        WHERE resource_id = ${resourceId}
        FOR UPDATE
      `;
      const currentStatus = lockedRows[0]?.workflowStatus;
      if (!currentStatus) throw notFound("标注文件不存在。");
      if (currentStatus !== input.expectedStatus) {
        throw conflict("标注状态已被其他账号更新，请刷新后重试。", {
          currentStatus,
        });
      }

      const transition = getAnnotationWorkflowTransition(
        currentStatus,
        input.status,
      );
      if (transition.kind === "invalid_order") {
        throw conflict(
          currentStatus === "unannotated"
            ? "未完成标注前不能标记为已审核，请先标记为已标注。"
            : "已审核文件不能直接改为未标注，请先撤回审核结论。",
          {
          currentStatus,
          requestedStatus: input.status,
        },
        );
      }
      if (transition.kind === "unchanged") return;
      if (!permission.capabilities.includes(transition.requiredCapability)) {
        throw forbidden(
          transition.requiredCapability === "write"
            ? "当前账号缺少该文件的编辑权限。"
            : "当前账号缺少该文件的审核权限。",
        );
      }

      const changedAt = new Date();
      await transaction.annotationFile.update({
        where: { resourceId },
        data: {
          workflowStatus: input.status,
          workflowUpdatedAt: changedAt,
          workflowUpdatedBy: user.id,
        },
      });
      // 工作流是资源元数据变更，因此同步推进资源修改时间，但不推进 annotation revision。
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { updatedAt: changedAt },
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_workflow_status_update",
          actorUserId: user.id,
          resourceId,
          detail: { from: currentStatus, to: input.status },
        },
      });
    });
    return this.getMappedResource(user, resourceId);
  }

  async getProjectWorkflowGroups(
    user: ApiUser,
    projectResourceId: string,
  ): Promise<ProjectWorkflowGroups> {
    await this.access.assertCapability(user, projectResourceId, "manage_permissions");
    await this.assertActiveProject(projectResourceId);
    const rows = await this.prisma.projectWorkflowMember.findMany({
      where: { projectResourceId },
      include: projectWorkflowMemberInclude,
    });
    return this.mapProjectWorkflowGroups(projectResourceId, rows);
  }

  async listProjectWorkflowCandidates(
    user: ApiUser,
    projectResourceId: string,
    query?: string,
  ): Promise<UserReference[]> {
    // 候选目录绑定具体项目的管理能力，项目 owner 无需额外拥有教师或全局管理员角色。
    await this.access.assertCapability(user, projectResourceId, "manage_permissions");
    await this.assertActiveProject(projectResourceId);
    const normalizedQuery = query?.trim();
    const accounts = await this.prisma.user.findMany({
      where: {
        isActive: true,
        ...(normalizedQuery
          ? {
              OR: [
                { displayName: { contains: normalizedQuery, mode: "insensitive" as const } },
                { accountName: { contains: normalizedQuery, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      include: { roles: true },
      orderBy: [{ displayName: "asc" }, { accountName: "asc" }],
      take: 200,
    });
    return accounts.map(toPublicUser);
  }

  async updateProjectWorkflowGroups(
    user: ApiUser,
    projectResourceId: string,
    input: UpdateProjectWorkflowGroupsRequest,
  ): Promise<ProjectWorkflowGroups> {
    const annotationUserIds = [...new Set(input.annotationUserIds)];
    const reviewUserIds = [...new Set(input.reviewUserIds)];
    await this.prisma.$transaction(async (transaction) => {
      // 职责组本身是有效权限来源；更新必须取得独占树锁，不能与已完成权限复核的内容事务交错撤权。
      await this.lockResourceTreeMutation(transaction);
      await this.lockResourceRows(transaction, [projectResourceId]);
      await this.assertActiveProject(projectResourceId, transaction);
      const permission = await this.access.getEffectivePermission(
        user,
        projectResourceId,
        transaction,
      );
      if (!permission.capabilities.includes("manage_permissions")) {
        throw forbidden("当前账号不能管理该项目的职责组。");
      }

      const existing = await transaction.projectWorkflowMember.findMany({
        where: { projectResourceId },
        select: { userId: true, group: true },
      });
      const existingPairs = new Set(
        existing.map((row) => `${row.group}:${row.userId}`),
      );
      const desiredPairs = [
        ...annotationUserIds.map((userId) => ({ group: "annotation" as const, userId })),
        ...reviewUserIds.map((userId) => ({ group: "review" as const, userId })),
      ];
      const additions = desiredPairs.filter(({ group, userId }) =>
        !existingPairs.has(`${group}:${userId}`));
      if (permission.source !== "admin") {
        const delegatedCapabilities = new Set(
          additions.flatMap(({ group }) => getProjectWorkflowGroupCapabilities(group)),
        );
        if ([...delegatedCapabilities].some((capability) =>
          !permission.capabilities.includes(capability))) {
          throw forbidden("不能通过职责组授予自己并不拥有的资源能力。");
        }
      }
      const desiredUserIds = [...new Set(desiredPairs.map(({ userId }) => userId))];
      const users = desiredUserIds.length
        ? await transaction.user.findMany({
            where: { id: { in: desiredUserIds } },
            select: { id: true, isActive: true },
          })
        : [];
      const usersById = new Map(users.map((account) => [account.id, account]));
      if (usersById.size !== desiredUserIds.length) {
        throw badRequest("职责组中包含不存在的账号。");
      }
      // 已停用账号可以保留原有职责历史，但不能被新增到另一组或重新加入。
      const invalidInactive = desiredPairs.find(({ group, userId }) =>
        !usersById.get(userId)?.isActive &&
        !existingPairs.has(`${group}:${userId}`));
      if (invalidInactive) throw badRequest("已停用账号不能新增到项目职责组。");

      await this.replaceProjectWorkflowGroup(
        transaction,
        projectResourceId,
        "annotation",
        annotationUserIds,
        existingPairs,
        user.id,
      );
      await this.replaceProjectWorkflowGroup(
        transaction,
        projectResourceId,
        "review",
        reviewUserIds,
        existingPairs,
        user.id,
      );
      await transaction.resourceEntry.update({
        where: { id: projectResourceId },
        data: { updatedAt: new Date() },
      });
      await transaction.auditLog.create({
        data: {
          action: "project_workflow_groups_update",
          actorUserId: user.id,
          resourceId: projectResourceId,
          detail: {
            annotationUserIds,
            reviewUserIds,
            annotationCount: annotationUserIds.length,
            reviewCount: reviewUserIds.length,
          },
        },
      });
    });
    return this.getProjectWorkflowGroups(user, projectResourceId);
  }

  async updateResource(
    user: ApiUser,
    resourceId: string,
    input: UpdateResourceRequest,
  ) {
    if (input.name !== undefined) {
      await this.access.assertCapability(user, resourceId, "write");
    }
    const normalizedName = input.name === undefined
      ? undefined
      : this.validateName(input.name);
    if (input.archived !== undefined) {
      await this.access.assertCapability(user, resourceId, "delete");
    }
    await this.prisma.$transaction(async (transaction) => {
      if (input.name !== undefined || input.archived !== undefined) {
        await this.lockResourceTreeMutation(transaction);
      }
      await this.lockResourceRows(transaction, [resourceId]);
      if (input.name !== undefined) {
        await this.access.assertCapability(user, resourceId, "write", transaction);
      }
      if (input.archived !== undefined) {
        await this.access.assertCapability(user, resourceId, "delete", transaction);
      }
      const latest = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!latest) throw notFound("资源不存在。");
      if (normalizedName !== undefined) {
        await this.lockParentNamespaces(transaction, [latest.parentId]);
        await this.assertNameAvailable(
          transaction,
          latest.parentId,
          normalizedName,
          resourceId,
        );
      }
      if (input.name !== undefined || input.archived !== undefined) {
        await transaction.resourceEntry.update({
          where: { id: resourceId },
          data: {
            name: normalizedName,
            archivedAt: input.archived ? new Date() : null,
          },
        });
      }
      if (input.favorite !== undefined) {
        await transaction.resourceUserState.upsert({
          where: { resourceId_userId: { resourceId, userId: user.id } },
          update: { favorite: input.favorite },
          create: {
            resourceId,
            userId: user.id,
            favorite: input.favorite,
          },
        });
      }
    });
    return this.getMappedResource(user, resourceId);
  }

  async moveResources(
    user: ApiUser,
    input: BatchMoveResourcesRequest,
  ): Promise<BatchMoveResourcesResponse> {
    const requestedIds = [...new Set(input.resourceIds)];
    const selectionSnapshot = await this.loadResourceSelectionNodes(
      this.prisma,
      requestedIds,
    );
    const requestedNodeIds = new Set(selectionSnapshot.map(({ id }) => id));
    if (requestedIds.some((id) => !requestedNodeIds.has(id))) {
      throw notFound("部分待移动资源不存在。");
    }
    const normalizedSnapshot = normalizeResourceSelection(
      requestedIds,
      selectionSnapshot,
    );
    for (const resourceId of normalizedSnapshot.rootIds) {
      // 选中父目录时，后代随父目录保持内部层级，不要求后代额外具备 move 权限。
      await this.access.assertCapability(user, resourceId, "move");
    }
    if (input.parentId) {
      await this.assertContainer(input.parentId);
      await this.access.assertCapability(user, input.parentId, "create_child");
    } else if (!this.access.hasFullResourceAccess(user)) {
      throw forbidden("只有管理员可以把资源移动到根目录。");
    }
    const moved = await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeMutation(transaction);
      const latestSelection = await this.loadResourceSelectionNodes(
        transaction,
        requestedIds,
      );
      const normalizedLatest = normalizeResourceSelection(
        requestedIds,
        latestSelection,
      );
      if (!sameStringSets(
        normalizedSnapshot.rootIds,
        normalizedLatest.rootIds,
      )) {
        throw conflict("移动期间资源层级发生变化，请刷新后重试。");
      }

      for (const resourceId of normalizedLatest.rootIds) {
        await this.access.assertCapability(user, resourceId, "move", transaction);
      }
      if (input.parentId) {
        await this.assertContainer(input.parentId, transaction);
        await this.access.assertCapability(
          user,
          input.parentId,
          "create_child",
          transaction,
        );
      } else {
        // 移到根目录属于平台级能力，不能继续使用请求开始时可能已经过期的角色快照。
        await this.access.assertFullResourceAccess(user, transaction);
      }

      await this.lockResourceRows(transaction, normalizedLatest.rootIds);
      const roots = await transaction.resourceEntry.findMany({
        where: { id: { in: normalizedLatest.rootIds } },
        select: {
          id: true,
          parentId: true,
          type: true,
          name: true,
          trashedAt: true,
        },
      });
      if (roots.length !== normalizedLatest.rootIds.length) {
        throw notFound("部分待移动资源不存在。");
      }
      for (const root of roots) {
        if (
          root.trashedAt ||
          await this.hasTrashedAncestor(transaction, root.parentId)
        ) {
          throw badRequest("不能移动回收站中的资源。");
        }
      }

      if (input.parentId) {
        const target = await transaction.resourceEntry.findUnique({
          where: { id: input.parentId },
        });
        if (!target) throw notFound("目标目录不存在。");
        if (target.type !== "folder" && target.type !== "project") {
          throw badRequest("目标资源不能包含子文件。");
        }
        if (
          target.trashedAt ||
          await this.hasTrashedAncestor(transaction, target.parentId)
        ) {
          throw badRequest("不能移动到回收站资源中。");
        }
      }
      await this.lockParentNamespaces(transaction, [
        ...roots.map(({ parentId }) => parentId),
        input.parentId,
      ]);

      const rootById = new Map(roots.map((root) => [root.id, root]));
      const movedIds: string[] = [];
      const unchangedIds: string[] = [];
      // 固定顺序执行名称检查和更新。第一项写入后，后续同名来源会被同一事务检测并整体回滚。
      for (const resourceId of [...normalizedLatest.rootIds].sort()) {
        const root = rootById.get(resourceId)!;
        if (root.parentId === input.parentId) {
          unchangedIds.push(resourceId);
          continue;
        }
        if (
          input.parentId &&
          (root.type === "folder" || root.type === "project") &&
          await this.isDescendant(transaction, input.parentId, resourceId)
        ) {
          throw badRequest("不能把文件夹移动到它自己的子目录中。");
        }
        await this.assertNameAvailable(
          transaction,
          input.parentId,
          root.name,
          resourceId,
        );
        await transaction.resourceEntry.update({
          where: { id: resourceId },
          data: { parentId: input.parentId },
        });
        movedIds.push(resourceId);
      }
      return {
        movedIds,
        unchangedIds,
        collapsedDescendantIds: normalizedLatest.collapsedDescendantIds,
      };
    });

    return {
      moved: await Promise.all(moved.movedIds.map((id) =>
        this.getMappedResource(user, id))),
      unchanged: await Promise.all(moved.unchangedIds.map((id) =>
        this.getMappedResource(user, id))),
      collapsedDescendantIds: moved.collapsedDescendantIds,
    };
  }

  async copyResource(
    user: ApiUser,
    resourceId: string,
    input: CopyResourceRequest,
  ): Promise<CopyResourceResult> {
    await this.access.assertCapability(user, resourceId, "read");
    await this.access.assertCapability(user, resourceId, "copy");
    await this.assertContainer(input.parentId);
    await this.access.assertCapability(user, input.parentId, "create_child");
    const source = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
    });
    if (!source) throw notFound("资源不存在。");
    if (
      source.trashedAt ||
      await this.hasTrashedAncestor(this.prisma, source.parentId)
    ) {
      throw badRequest("不能复制回收站中的资源。");
    }
    if (
      (source.type === "folder" || source.type === "project") &&
      await this.isDescendant(this.prisma, input.parentId, resourceId)
    ) {
      throw badRequest("不能把文件夹复制到它自己或它的子目录中。");
    }

    const authorizedSnapshot = await this.loadCopySourceNodes(
      this.prisma,
      resourceId,
    );
    if (authorizedSnapshot.length > MAX_RECURSIVE_COPY_NODES) {
      throw badRequest(
        `单次最多复制 ${MAX_RECURSIVE_COPY_NODES} 个资源，请缩小复制范围。`,
      );
    }
    for (const node of authorizedSnapshot) {
      // 容器复制必须对整棵活动子树都拥有 read + copy。任何一个受限后代都会让整个根复制失败，
      // 避免悄悄生成一棵缺文件且难以察觉的副本。
      await this.access.assertCapability(user, node.id, "read");
      await this.access.assertCapability(user, node.id, "copy");
    }
    const requestedName = input.name?.trim() || source.name;
    const authorizedIds = new Set(authorizedSnapshot.map((node) => node.id));
    const copied = await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeMutation(transaction);
      await this.lockResourceRows(transaction, [resourceId]);
      const sourceContainerIds = authorizedSnapshot
        .filter((node) => node.type === "folder" || node.type === "project")
        .map((node) => node.id);
      // 新建子项也会拿父命名空间锁。复制时锁住所有源容器，保证复制计划期间不会插入新后代。
      await this.lockParentNamespaces(transaction, [
        input.parentId,
        ...sourceContainerIds,
      ]);

      const latestSource = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!latestSource) throw notFound("资源不存在。");
      if (
        latestSource.trashedAt ||
        await this.hasTrashedAncestor(transaction, latestSource.parentId)
      ) {
        throw conflict("复制期间源资源位置发生变化，请刷新后重试。");
      }
      const target = await transaction.resourceEntry.findUnique({
        where: { id: input.parentId },
      });
      if (!target || (target.type !== "folder" && target.type !== "project")) {
        throw notFound("目标目录不存在。");
      }
      if (
        target.trashedAt ||
        await this.hasTrashedAncestor(transaction, target.parentId)
      ) {
        throw conflict("目标目录已在回收站中，请选择其他位置。");
      }
      if (
        (latestSource.type === "folder" || latestSource.type === "project") &&
        await this.isDescendant(transaction, input.parentId, resourceId)
      ) {
        throw badRequest("不能把文件夹复制到它自己或它的子目录中。");
      }

      const latestNodes = await this.loadCopySourceNodes(
        transaction,
        resourceId,
      );
      if (
        latestNodes.length !== authorizedIds.size ||
        latestNodes.some((node) => !authorizedIds.has(node.id))
      ) {
        throw conflict("复制期间源目录发生变化，请刷新后重试。");
      }
      await this.access.assertCapability(
        user,
        input.parentId,
        "create_child",
        transaction,
      );
      for (const node of latestNodes) {
        await this.access.assertCapability(user, node.id, "read", transaction);
        await this.access.assertCapability(user, node.id, "copy", transaction);
      }
      const name = await this.availableCopyName(
        transaction,
        input.parentId,
        requestedName,
      );
      const plan = buildResourceCopyPlan({
        sourceRootId: resourceId,
        targetParentId: input.parentId,
        rootName: name,
        nodes: latestNodes,
      });
      for (const node of plan.nodes) {
        await transaction.resourceEntry.create({
          data: {
            id: node.id,
            parentId: node.parentId,
            type: node.type,
            name: node.name,
            ownerUserId: user.id,
            breakPermissionInheritance: false,
            archivedAt: node.archivedAt,
          },
        });
        // 复制计划已按父子与媒体依赖拓扑排序；各类型实体继续按该顺序逐条落库。
        if (node.type === "project") {
          await transaction.projectMetadata.create({
            data: {
              resourceId: node.id,
              description: node.projectDescription,
            },
          });
        }
        if (node.type === "annotation_file") {
          await transaction.annotationFile.create({
            data: {
              resourceId: node.id,
              payload: node.annotationPayload as Prisma.InputJsonValue,
              revision: 1,
              mediaResourceId: node.annotationMediaResourceId,
              lastEditedBy: user.id,
            },
          });
        }
        if (node.type === "media_file" && node.mediaFile) {
          await transaction.mediaFile.create({
            data: {
              resourceId: node.id,
              sourceType: node.mediaFile.sourceType,
              mediaKind: node.mediaFile.mediaKind,
              fileId: node.mediaFile.fileId,
              mimeType: node.mediaFile.mimeType,
              size: node.mediaFile.size,
              duration: node.mediaFile.duration,
              aliyunVodVideoId: node.mediaFile.aliyunVodVideoId,
              aliyunVodRegion: node.mediaFile.aliyunVodRegion,
            },
          });
        }
        if (node.type === "media_file" && node.mediaFile) {
          // 普通复制复用二进制但创建独立媒体身份；只生成新原声，不复制外部音轨或源 ACL。
          await createOriginalMediaAudioTrack(transaction, {
            primaryMediaResourceId: node.id,
            mediaKind: node.mediaFile.mediaKind,
            createdBy: user.id,
          });
        }
      }
      return { rootId: plan.nodes[0]!.id, summary: plan };
    });
    // 副本不携带源 ACL、收藏、恢复历史或 operation；复制者拥有新节点，其余权限重新从目标继承。
    return {
      resource: await this.getMappedResource(user, copied.rootId),
      summary: {
        copiedNodeCount: copied.summary.copiedNodeCount,
        copiedAnnotationCount: copied.summary.copiedAnnotationCount,
        reusedFileObjectCount: copied.summary.reusedFileObjectCount,
      },
    };
  }

  async trashResources(
    user: ApiUser,
    input: BatchTrashResourcesRequest,
  ): Promise<BatchTrashResourcesResponse> {
    const requestedIds = [...new Set(input.resourceIds)];
    const selectionSnapshot = await this.loadResourceSelectionNodes(
      this.prisma,
      requestedIds,
    );
    const requestedNodeIds = new Set(selectionSnapshot.map(({ id }) => id));
    if (requestedIds.some((id) => !requestedNodeIds.has(id))) {
      throw notFound("部分待删除资源不存在。");
    }
    const normalizedSnapshot = normalizeResourceSelection(
      requestedIds,
      selectionSnapshot,
    );

    const trashed = await this.prisma.$transaction(async (transaction) => {
      // 所有资源树 mutation 共用同一把 advisory lock。锁后重新读取层级，避免删除期间父子关系变化。
      await this.lockResourceTreeMutation(transaction);
      const latestSelection = await this.loadResourceSelectionNodes(
        transaction,
        requestedIds,
      );
      const latestNodeIds = new Set(latestSelection.map(({ id }) => id));
      if (requestedIds.some((id) => !latestNodeIds.has(id))) {
        throw notFound("部分待删除资源不存在。");
      }
      const normalizedLatest = normalizeResourceSelection(
        requestedIds,
        latestSelection,
      );
      if (!sameStringSets(
        normalizedSnapshot.rootIds,
        normalizedLatest.rootIds,
      )) {
        throw conflict("删除期间资源层级发生变化，请刷新后重试。");
      }

      await this.lockResourceRows(transaction, normalizedLatest.rootIds);
      const roots = await transaction.resourceEntry.findMany({
        where: { id: { in: normalizedLatest.rootIds } },
        select: {
          id: true,
          parentId: true,
          trashedAt: true,
        },
      });
      if (roots.length !== normalizedLatest.rootIds.length) {
        throw notFound("部分待删除资源不存在。");
      }
      for (const root of roots) {
        if (
          root.trashedAt ||
          await this.hasTrashedAncestor(transaction, root.parentId)
        ) {
          throw badRequest("不能重复删除回收站中的资源。");
        }
        // 权限必须在资源树锁内通过 transaction client 重新解析，不能只依赖锁前的 UI 或预检查。
        await this.access.assertCapability(
          user,
          root.id,
          "delete",
          transaction,
        );
      }
      await this.lockParentNamespaces(
        transaction,
        roots.map(({ parentId }) => parentId),
      );

      const trashedAt = new Date();
      const sortedRootIds = [...normalizedLatest.rootIds].sort();
      await transaction.resourceEntry.updateMany({
        where: { id: { in: sortedRootIds } },
        data: { trashedAt },
      });
      // 审计与软删除处于同一事务；任一审计写入失败时整批状态也回滚。
      for (const resourceId of sortedRootIds) {
        await transaction.auditLog.create({
          data: {
            action: "resource_trash",
            actorUserId: user.id,
            resourceId,
            detail: {
              batchSize: requestedIds.length,
              logicalRootCount: sortedRootIds.length,
              collapsedSelectionCount:
                normalizedLatest.collapsedDescendantIds.length,
            },
          },
        });
      }
      return {
        rootIds: sortedRootIds,
        collapsedDescendantIds: normalizedLatest.collapsedDescendantIds,
      };
    });

    return {
      trashed: await Promise.all(trashed.rootIds.map((id) =>
        this.getMappedResource(user, id))),
      collapsedDescendantIds: trashed.collapsedDescendantIds,
    };
  }

  async restoreResource(user: ApiUser, resourceId: string) {
    await this.access.assertCapability(user, resourceId, "delete");
    await this.prisma.$transaction(async (transaction) => {
      // 移动、删除和恢复都会改变活动资源树；共用锁可防止恢复校验后父目录又被并发移动或删除。
      await this.lockResourceTreeMutation(transaction);
      await this.lockResourceRows(transaction, [resourceId]);
      const current = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!current) throw notFound("资源不存在。");
      await this.access.assertCapability(user, resourceId, "delete", transaction);
      if (!current.trashedAt) throw badRequest("资源不在回收站中。");
      await this.lockParentNamespaces(transaction, [current.parentId]);
      if (current.parentId) {
        const parent = await transaction.resourceEntry.findUnique({
          where: { id: current.parentId },
          select: {
            type: true,
            parentId: true,
            trashedAt: true,
          },
        });
        if (!parent || (parent.type !== "folder" && parent.type !== "project")) {
          throw conflict("原上级目录已经不存在，无法恢复到原位置。");
        }
        if (
          parent.trashedAt ||
          await this.hasTrashedAncestor(transaction, parent.parentId)
        ) {
          throw conflict("请先恢复上级目录。");
        }
      }
      await this.assertNameAvailable(
        transaction,
        current.parentId,
        current.name,
        resourceId,
      );
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { trashedAt: null },
      });
    });
    return this.getMappedResource(user, resourceId);
  }

  async listPermissionMatrix(
    actor: ApiUser,
    resourceId: string,
  ): Promise<ResourcePermissionMatrixRow[]> {
    await this.access.assertCapability(actor, resourceId, "manage_permissions");
    const [users, directRows] = await Promise.all([
      this.prisma.user.findMany({
        where: { isActive: true },
        include: { roles: true },
        orderBy: { displayName: "asc" },
      }),
      this.prisma.resourcePermission.findMany({
        where: { resourceId },
        include: {
          user: { include: { roles: true } },
          grantor: { include: { roles: true } },
        },
      }),
    ]);
    const directByUser = new Map(directRows.map((row) => [row.userId, row]));
    return Promise.all(users.map(async (user) => ({
      user: toPublicUser(user),
      directPermission: directByUser.has(user.id)
        ? this.mapPermission(directByUser.get(user.id)!)
        : null,
      effectivePermission: await this.access.getEffectivePermission(
        toPublicUser(user),
        resourceId,
      ),
    })));
  }

  async upsertPermission(
    actor: ApiUser,
    resourceId: string,
    userId: string,
    input: UpsertResourcePermissionRequest,
  ) {
    await this.access.assertCapability(
      actor,
      resourceId,
      "manage_permissions",
    );
    const capabilities = [...new Set(input.capabilities)];
    const row = await this.prisma.$transaction(async (transaction) => {
      // ACL 变化取得资源树独占锁；所有会依据 ACL 提交的事务都在同一锁内复核权限。
      await this.lockResourceTreeMutation(transaction);
      await this.lockResourceRows(transaction, [resourceId]);
      const actorPermission = await this.access.assertCapability(
        actor,
        resourceId,
        "manage_permissions",
        transaction,
      );
      const resource = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!resource) throw notFound("资源不存在。");
      if (resource.ownerUserId === userId) {
        throw badRequest("资源所有者始终拥有完整权限，无需另行授权。");
      }
      if (
        actorPermission.source !== "admin" &&
        capabilities.some((capability) =>
          !actorPermission.capabilities.includes(capability))
      ) {
        throw forbidden("不能授予自己并不拥有的资源能力。");
      }
      const subject = await transaction.user.findUnique({ where: { id: userId } });
      if (!subject?.isActive) throw notFound("目标账号不存在或已停用。");
      const permission = await transaction.resourcePermission.upsert({
        where: { resourceId_userId: { resourceId, userId } },
        update: {
          capabilities: this.access.toDatabaseCapabilities(capabilities),
          inheritToChildren: input.inheritToChildren ?? true,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdBy: actor.id,
        },
        create: {
          resourceId,
          userId,
          capabilities: this.access.toDatabaseCapabilities(capabilities),
          inheritToChildren: input.inheritToChildren ?? true,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdBy: actor.id,
        },
        select: {
          id: true,
          resourceId: true,
          capabilities: true,
          inheritToChildren: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      // Prisma interactive transaction 只有一个连接；两个关系分支必须顺序读取后在内存组装。
      const permissionUser = await transaction.user.findUniqueOrThrow({
        where: { id: userId },
        include: { roles: true },
      });
      const grantor = actor.id === userId
        ? permissionUser
        : await transaction.user.findUniqueOrThrow({
            where: { id: actor.id },
            include: { roles: true },
          });
      return { ...permission, user: permissionUser, grantor };
    });
    return this.mapPermission(row);
  }

  async removePermission(
    actor: ApiUser,
    resourceId: string,
    userId: string,
  ) {
    await this.access.assertCapability(actor, resourceId, "manage_permissions");
    await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeMutation(transaction);
      await this.lockResourceRows(transaction, [resourceId]);
      await this.access.assertCapability(
        actor,
        resourceId,
        "manage_permissions",
        transaction,
      );
      const resource = await transaction.resourceEntry.findUnique({
        where: { id: resourceId },
      });
      if (!resource) throw notFound("资源不存在。");
      if (resource.ownerUserId === userId) {
        throw badRequest("不能移除资源所有者权限。");
      }
      await transaction.resourcePermission.deleteMany({
        where: { resourceId, userId },
      });
    });
  }

  async updateInheritance(
    actor: ApiUser,
    resourceId: string,
    breakPermissionInheritance: boolean,
  ) {
    await this.access.assertCapability(actor, resourceId, "manage_permissions");
    await this.prisma.$transaction(async (transaction) => {
      await this.lockResourceTreeMutation(transaction);
      await this.lockResourceRows(transaction, [resourceId]);
      await this.access.assertCapability(
        actor,
        resourceId,
        "manage_permissions",
        transaction,
      );
      await transaction.resourceEntry.update({
        where: { id: resourceId },
        data: { breakPermissionInheritance },
      });
    });
    return this.getMappedResource(actor, resourceId);
  }

  private buildListWhere(
    user: ApiUser,
    options: NormalizedResourceQuery,
  ): Prisma.ResourceEntryWhereInput {
    const query = options.query?.trim();
    const common: Prisma.ResourceEntryWhereInput = {
      ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
      ...(options.type ? { type: options.type as DbResourceType } : {}),
    };
    switch (options.view ?? "children") {
      case "all_projects":
        // “所有项目”同时承担资源管理器根目录的职责。若把嵌套项目也平铺到这里，
        // 项目移动进另一个项目后会在根视图和目标项目中同时出现，视觉上像是复制。
        // 最近、收藏和共享仍是跨目录聚合视图；只有根项目视图遵循直接子项语义。
        return {
          ...common,
          parentId: null,
          type: "project",
          trashedAt: null,
        };
      case "recent":
        return {
          ...common,
          trashedAt: null,
          userStates: {
            some: { userId: user.id, lastOpenedAt: { not: null } },
          },
        };
      case "favorites":
        return {
          ...common,
          trashedAt: null,
          userStates: { some: { userId: user.id, favorite: true } },
        };
      case "shared":
        return {
          ...common,
          trashedAt: null,
          ownerUserId: { not: user.id },
        };
      case "archived":
        return { ...common, archivedAt: { not: null }, trashedAt: null };
      case "trash":
        return { ...common, trashedAt: { not: null } };
      default:
        return {
          ...common,
          parentId: options.parentId ?? null,
          trashedAt: null,
          archivedAt: null,
        };
    }
  }

  private async getMappedResource(user: ApiUser, resourceId: string) {
    const baseRow = await this.prisma.resourceEntry.findUnique({
      where: { id: resourceId },
      include: resourceBaseInclude,
    });
    if (!baseRow) throw notFound("资源不存在。");
    const [row] = await this.attachResourceTypeMetadata([baseRow]);
    if (!row) throw notFound("资源不存在。");
    return this.mapResource(
      user,
      row,
      await this.access.getEffectivePermission(user, resourceId),
    );
  }

  // 标注与媒体是互斥类型关系，按批次顺序读取后再装配，避免 Prisma 同 client 并行展开兄弟关系。
  private async attachResourceTypeMetadata(
    rows: ResourceBaseRow[],
  ): Promise<ResourceRow[]> {
    if (rows.length === 0) return [];
    const resourceIds = rows.map(({ id }) => id);
    const projectIds = rows
      .filter(({ type }) => type === "project")
      .map(({ id }) => id);
    const annotationFiles = await this.prisma.annotationFile.findMany({
      where: { resourceId: { in: resourceIds } },
    });
    const mediaFiles = await this.prisma.mediaFile.findMany({
      where: { resourceId: { in: resourceIds } },
    });
    const annotationGroupMembers = projectIds.length
      ? await this.prisma.projectWorkflowMember.findMany({
          where: {
            projectResourceId: { in: projectIds },
            group: "annotation",
          },
          include: projectWorkflowMemberInclude,
        })
      : [];
    const projectWorkflowStatuses = await this.loadProjectWorkflowStatuses(projectIds);
    const annotationByResourceId = new Map(
      annotationFiles.map((file) => [file.resourceId, file]),
    );
    const mediaByResourceId = new Map(
      mediaFiles.map((file) => [file.resourceId, file]),
    );
    const annotationResponsiblesByProject = new Map<string, UserReference[]>();
    for (const member of annotationGroupMembers) {
      const users = annotationResponsiblesByProject.get(member.projectResourceId) ?? [];
      users.push(member.user);
      annotationResponsiblesByProject.set(member.projectResourceId, users);
    }
    // 稳定排序保证分页刷新和跨视图切换时“负责人”文本不会抖动。
    for (const users of annotationResponsiblesByProject.values()) {
      users.sort((left, right) =>
        left.displayName.localeCompare(right.displayName, "zh-CN") ||
        left.accountName.localeCompare(right.accountName) ||
        left.id.localeCompare(right.id));
    }
    return rows.map((row) => ({
      ...row,
      annotationFile: annotationByResourceId.get(row.id) ?? null,
      mediaFile: mediaByResourceId.get(row.id) ?? null,
      projectWorkflowStatus: row.type === "project" &&
          !row.trashedAt && !row.archivedAt
        ? projectWorkflowStatuses.get(row.id) ?? "unannotated"
        : null,
      annotationResponsibles: annotationResponsiblesByProject.get(row.id) ?? [],
    }));
  }

  /**
   * 一个递归查询同时派生当前批次全部项目的最高工作流阶段，避免项目列表出现 N+1。
   * 归档或回收的中间容器不会继续向下递归，因此隐藏子树不会污染活动项目状态。
   */
  private async loadProjectWorkflowStatuses(
    projectIds: string[],
  ): Promise<Map<string, AnnotationWorkflowStatus>> {
    if (!projectIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{
      rootProjectId: string;
      workflowStatus: AnnotationWorkflowStatus;
    }>>`
      WITH RECURSIVE project_descendants AS (
        SELECT
          root.id AS "rootProjectId",
          root.id AS "resourceId"
        FROM resource_entries AS root
        WHERE root.id IN (${Prisma.join(projectIds)})
          AND root.trashed_at IS NULL
          AND root.archived_at IS NULL

        UNION ALL

        SELECT
          parent."rootProjectId",
          child.id AS "resourceId"
        FROM project_descendants AS parent
        INNER JOIN resource_entries AS child
          ON child.parent_id = parent."resourceId"
        WHERE child.trashed_at IS NULL
          AND child.archived_at IS NULL
      )
      SELECT
        descendants."rootProjectId",
        CASE
          WHEN COUNT(*) FILTER (WHERE file.workflow_status = 'reviewed') > 0
            THEN 'reviewed'
          WHEN COUNT(*) FILTER (WHERE file.workflow_status = 'annotated') > 0
            THEN 'annotated'
          ELSE 'unannotated'
        END AS "workflowStatus"
      FROM project_descendants AS descendants
      INNER JOIN annotation_files AS file
        ON file.resource_id = descendants."resourceId"
      GROUP BY descendants."rootProjectId"
    `;
    return new Map(rows.map((row) => [row.rootProjectId, row.workflowStatus]));
  }

  private async mapResource(
    user: ApiUser,
    row: ResourceRow,
    permission: EffectiveResourcePermission,
  ): Promise<ResourceEntry> {
    const state = await this.prisma.resourceUserState.findUnique({
      where: { resourceId_userId: { resourceId: row.id, userId: user.id } },
    });
    return {
      id: row.id,
      parentId: row.parentId,
      type: row.type,
      name: row.name,
      owner: toPublicUser(row.owner),
      breakPermissionInheritance: row.breakPermissionInheritance,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      trashedAt: row.trashedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      childCount: row._count.children,
      // 读边界：DB size 为 BigInt，转回 number 进入 JSON DTO。
      size: row.mediaFile?.size != null ? Number(row.mediaFile.size) : null,
      mimeType: row.mediaFile?.mimeType ?? null,
      mediaSourceType: row.mediaFile?.sourceType ?? null,
      mediaKind: row.mediaFile?.mediaKind ?? null,
      duration: row.mediaFile?.duration ?? null,
      revision: row.annotationFile?.revision ?? null,
      workflowStatus: row.annotationFile?.workflowStatus ?? row.projectWorkflowStatus,
      annotationResponsibles: row.annotationResponsibles,
      favorite: state?.favorite ?? false,
      permission,
    };
  }

  private async mapAnnotationFile<TPayload = unknown>(
    user: ApiUser,
    resource: ResourceRow,
    file: {
      payload: Prisma.JsonValue;
      revision: number;
      mediaResourceId: string | null;
      mediaResource?: {
        resourceId: string;
        sourceType: "uploaded" | "aliyun_vod";
        mediaKind: "video" | "audio";
        mimeType: string | null;
        size: bigint | null;
        duration: number | null;
        aliyunVodVideoId: string | null;
        aliyunVodRegion: string | null;
        resource: { name: string };
        file: { id: string } | null;
      } | null;
      lastSavedAt: Date;
      lastEditor: {
        id: string;
        accountName: string;
        displayName: string;
        roles: Array<{ role: string }>;
      };
    },
  ): Promise<AnnotationFile<TPayload>> {
    return {
      resource: await this.mapResource(
        user,
        resource,
        await this.access.getEffectivePermission(user, resource.id),
      ),
      payload: file.payload as TPayload,
      revision: file.revision,
      operationCursor: encodeAnnotationSnapshotOperationCursor(resource.id, file.revision),
      mediaResourceId: file.mediaResourceId,
      media: file.mediaResource
        ? mapAnnotationMediaReference(file.mediaResource)
        : null,
      lastEditor: toPublicUser(file.lastEditor),
      lastSavedAt: file.lastSavedAt.toISOString(),
    };
  }

  // 媒体绑定同时要求可见与可下载，避免通过标注关系绕过受保护二进制的读取权限。
  private async assertMediaResourceForBinding(
    user: ApiUser,
    mediaResourceId: string,
    database: PrismaClient | Prisma.TransactionClient,
  ) {
    const permission = await this.access.getEffectivePermission(user, mediaResourceId, database);
    if (!permission.capabilities.includes("read") || !permission.capabilities.includes("download")) {
      throw forbidden("当前账号不能读取或下载所选媒体。");
    }
    const media = await database.resourceEntry.findUnique({
      where: { id: mediaResourceId },
      include: { mediaFile: true },
    });
    if (!media?.mediaFile || media.type !== "media_file" || media.trashedAt || media.archivedAt) {
      throw badRequest("所选资源不是可用的媒体文件。");
    }
    if (media.mediaFile.mediaKind !== "video" && media.mediaFile.mediaKind !== "audio") {
      throw badRequest("标注文件只能关联视频或音频媒体。");
    }
  }

  // 确认创建输入映射集中处理互斥目标字段，数据库 CHECK 继续作为第二层保护。
  private toAnnotationConfirmationCreateData(
    createdBy: string,
    draft: AnnotationConfirmationDraft,
  ): Prisma.AnnotationConfirmationUncheckedCreateInput {
    const targets = draft.scope.targets;
    return {
      annotationFileId: draft.annotationFileId,
      confirmedRevision: draft.confirmedRevision,
      startTime: draft.scope.startTime,
      endTime: draft.scope.endTime,
      targetMode: targets.mode,
      domains: targets.mode === "domains"
        ? targets.domains.map((domain) => DB_CONFIRMATION_DOMAINS[domain])
        : [],
      trackIds: targets.mode === "tracks" ? targets.trackIds : [],
      note: draft.note ?? null,
      createdBy,
    };
  }

  // 带正文范围事实复用历史表；互斥目标字段仍由领域校验与 CHECK 双重约束。
  private toAnnotationRangeCommentCreateData(
    createdBy: string,
    draft: AnnotationRangeCommentDraft,
  ): Prisma.AnnotationRangeCommentUncheckedCreateInput {
    const targets = draft.scope.targets;
    return {
      annotationFileId: draft.annotationFileId,
      commentedRevision: draft.commentedRevision,
      startTime: draft.scope.startTime,
      endTime: draft.scope.endTime,
      targetMode: targets.mode,
      domains: targets.mode === "domains"
        ? targets.domains.map((domain) => DB_CONFIRMATION_DOMAINS[domain])
        : [],
      trackIds: targets.mode === "tracks" ? targets.trackIds : [],
      kind: draft.kind,
      body: draft.body,
      createdBy,
    };
  }

  // 失效通知只在事务提交后发布；通知失败不得反向撤销已经持久化的审核事实。
  private publishReviewChanged(annotationFileId: string) {
    this.reviewPublisher.publishReviewChanged({
      annotationFileId,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
    });
  }

  private mapPermission(row: {
    id: string;
    resourceId: string;
    capabilities: string[];
    inheritToChildren: boolean;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    user: {
      id: string;
      accountName: string;
      displayName: string;
      roles: Array<{ role: string }>;
    };
    grantor: {
      id: string;
      accountName: string;
      displayName: string;
      roles: Array<{ role: string }>;
    };
  }): ResourcePermissionRecord {
    return {
      id: row.id,
      resourceId: row.resourceId,
      user: toPublicUser(row.user),
      capabilities: row.capabilities as ResourceCapability[],
      inheritToChildren: row.inheritToChildren,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      createdBy: toPublicUser(row.grantor),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async buildBreadcrumbs(user: ApiUser, resourceId: string) {
    const items: ResourceListPage["breadcrumbs"] = [];
    let currentId: string | null = resourceId;
    while (currentId) {
      const row: {
        id: string;
        parentId: string | null;
        type: "folder" | "project" | "annotation_file" | "media_file";
        name: string;
      } | null = await this.prisma.resourceEntry.findUnique({
        where: { id: currentId },
        select: { id: true, parentId: true, type: true, name: true },
      });
      if (!row) break;
      await this.access.assertCapability(user, row.id, "read");
      items.unshift(row);
      currentId = row.parentId;
    }
    return items;
  }

  // 项目选择页按批次补齐祖先并构造路径；任何归档、回收、缺失或循环祖先都会隐藏对应项目。
  private async buildActiveResourcePaths(
    rows: readonly ResourcePathNode[],
  ): Promise<Map<string, ResourceBreadcrumb[]>> {
    const nodes = new Map<string, ResourcePathNode>(
      rows.map((row) => [row.id, row]),
    );
    let missingParentIds = [...new Set(rows.flatMap((row) =>
      row.parentId && !nodes.has(row.parentId) ? [row.parentId] : []))];
    while (missingParentIds.length > 0) {
      const ancestors = await this.prisma.resourceEntry.findMany({
        where: { id: { in: missingParentIds } },
        select: {
          id: true,
          parentId: true,
          type: true,
          name: true,
          archivedAt: true,
          trashedAt: true,
        },
      });
      for (const ancestor of ancestors) nodes.set(ancestor.id, ancestor);
      missingParentIds = [...new Set(ancestors.flatMap((ancestor) =>
        ancestor.parentId && !nodes.has(ancestor.parentId)
          ? [ancestor.parentId]
          : []))];
    }

    const paths = new Map<string, ResourceBreadcrumb[]>();
    for (const row of rows) {
      const reversedPath: ResourceBreadcrumb[] = [];
      const visited = new Set<string>();
      let current: ResourcePathNode | undefined = row;
      let valid = true;
      while (current) {
        if (visited.has(current.id) || current.archivedAt || current.trashedAt) {
          valid = false;
          break;
        }
        visited.add(current.id);
        reversedPath.push({
          id: current.id,
          parentId: current.parentId,
          type: current.type,
          name: current.name,
        });
        if (!current.parentId) break;
        current = nodes.get(current.parentId);
        if (!current) {
          valid = false;
          break;
        }
      }
      if (valid) paths.set(row.id, reversedPath.reverse());
    }
    return paths;
  }

  private requireAliyunVodProvider() {
    if (!this.aliyunVod) {
      throw externalServiceUnavailable("服务器尚未启用阿里云 VOD。");
    }
    return this.aliyunVod;
  }

  private async callAliyunVod<TResult>(
    operation: () => Promise<TResult>,
    fallbackMessage: string,
  ): Promise<TResult> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AliyunVodGatewayError)) {
        throw externalServiceUnavailable(fallbackMessage);
      }
      const details = error.requestId ? { requestId: error.requestId } : undefined;
      if (error.category === "not_found") {
        throw externalMediaUnavailable("未找到指定的阿里云 VOD 媒资。", details);
      }
      if (error.category === "permission_denied") {
        throw externalServiceUnavailable("服务器没有访问阿里云 VOD 媒资的权限。", details);
      }
      throw externalServiceUnavailable(fallbackMessage, details);
    }
  }

  private async assertContainer(
    resourceId: string,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ) {
    const row = await database.resourceEntry.findUnique({
      where: { id: resourceId },
    });
    if (!row) throw notFound("目标目录不存在。");
    if (row.type !== "folder" && row.type !== "project") {
      throw badRequest("目标资源不能包含子文件。");
    }
    // 后代通常不写 trashedAt；创建入口必须沿祖先链判断整个目标目录是否仍在活动树中。
    if (row.trashedAt || await this.hasTrashedAncestor(database, row.parentId)) {
      throw badRequest("不能在回收站资源中创建文件。");
    }
  }

  private validateName(value: string) {
    const name = value.trim();
    if (!name || name.length > 180 || /[\/\\\0]/.test(name)) {
      throw badRequest("资源名称不能为空、不能超过 180 字，且不能含路径分隔符。");
    }
    return name;
  }

  private async assertNameAvailable(
    database: Prisma.TransactionClient,
    parentId: string | null,
    name: string,
    excludeId?: string,
  ) {
    const duplicate = await database.resourceEntry.findFirst({
      where: {
        parentId,
        name: { equals: name, mode: "insensitive" },
        trashedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    if (duplicate) throw conflict("同一目录中已存在同名资源。");
  }

  private async availableCopyName(
    database: Prisma.TransactionClient,
    parentId: string,
    originalName: string,
  ) {
    const dot = originalName.lastIndexOf(".");
    const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
    const extension = dot > 0 ? originalName.slice(dot) : "";
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = index === 1
        ? `${stem} 副本${extension}`
        : `${stem} 副本 ${index}${extension}`;
      const exists = await database.resourceEntry.findFirst({
        where: {
          parentId,
          name: { equals: candidate, mode: "insensitive" },
          trashedAt: null,
        },
      });
      if (!exists) return candidate;
    }
    throw conflict("无法生成可用的副本名称。");
  }

  private async loadCopySourceNodes(
    database: PrismaClient | Prisma.TransactionClient,
    resourceId: string,
  ): Promise<CopySourceNode[]> {
    const ids = await database.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE resource_subtree AS (
        SELECT id
        FROM resource_entries
        WHERE id = ${resourceId}
          AND trashed_at IS NULL

        UNION ALL

        SELECT child.id
        FROM resource_entries AS child
        INNER JOIN resource_subtree AS parent ON child.parent_id = parent.id
        WHERE child.trashed_at IS NULL
      )
      SELECT id
      FROM resource_subtree
      LIMIT ${MAX_RECURSIVE_COPY_NODES + 1}
    `;
    if (!ids.length) return [];
    const resourceIds = ids.map(({ id }) => id);
    const resources = await database.resourceEntry.findMany({
      where: { id: { in: resourceIds } },
      select: {
        id: true,
        parentId: true,
        type: true,
        name: true,
        archivedAt: true,
      },
    });
    // 复制快照可能同时包含三种互斥类型关系；顺序批量读取，禁止 Prisma 在事务 client 上并发 fan-out。
    const projectMetadata = await database.projectMetadata.findMany({
      where: { resourceId: { in: resourceIds } },
      select: { resourceId: true, description: true },
    });
    const annotationFiles = await database.annotationFile.findMany({
      where: { resourceId: { in: resourceIds } },
      select: { resourceId: true, payload: true, mediaResourceId: true },
    });
    const mediaFiles = await database.mediaFile.findMany({
      where: { resourceId: { in: resourceIds } },
      select: {
        resourceId: true,
        sourceType: true,
        mediaKind: true,
        fileId: true,
        mimeType: true,
        size: true,
        duration: true,
        aliyunVodVideoId: true,
        aliyunVodRegion: true,
      },
    });
    const projectById = new Map(projectMetadata.map((row) => [row.resourceId, row]));
    const annotationById = new Map(annotationFiles.map((row) => [row.resourceId, row]));
    const mediaById = new Map(mediaFiles.map((row) => [row.resourceId, row]));
    return resources.map((resource): CopySourceNode => ({
      ...resource,
      projectMetadata: projectById.get(resource.id) ?? null,
      annotationFile: annotationById.get(resource.id) ?? null,
      mediaFile: mediaById.get(resource.id) ?? null,
    }));
  }

  private async loadResourceSelectionNodes(
    database: PrismaClient | Prisma.TransactionClient,
    resourceIds: string[],
  ): Promise<ResourceSelectionNode[]> {
    if (!resourceIds.length) return [];
    // 只读取所选节点到根目录的祖先链，足以判断“父与后代同时被选中”，无需加载整棵资源树。
    return database.$queryRaw<ResourceSelectionNode[]>`
      WITH RECURSIVE selected_ancestors AS (
        SELECT id, parent_id AS "parentId"
        FROM resource_entries
        WHERE id IN (${Prisma.join(resourceIds)})

        UNION

        SELECT parent.id, parent.parent_id AS "parentId"
        FROM resource_entries AS parent
        INNER JOIN selected_ancestors AS child ON child."parentId" = parent.id
      )
      SELECT DISTINCT id, "parentId"
      FROM selected_ancestors
    `;
  }

  private async assertActiveProject(
    resourceId: string,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ) {
    const resource = await database.resourceEntry.findUnique({
      where: { id: resourceId },
      select: {
        id: true,
        parentId: true,
        type: true,
        archivedAt: true,
        trashedAt: true,
      },
    });
    if (!resource || resource.type !== "project") {
      throw notFound("项目不存在。");
    }
    if (
      resource.archivedAt ||
      resource.trashedAt ||
      await this.hasTrashedAncestor(database, resource.parentId)
    ) {
      throw conflict("归档或回收站中的项目不能修改职责组。");
    }
    return resource;
  }

  private async replaceProjectWorkflowGroup(
    transaction: Prisma.TransactionClient,
    projectResourceId: string,
    group: "annotation" | "review",
    userIds: string[],
    existingPairs: Set<string>,
    actorUserId: string,
  ) {
    // 完整集合替换只删除退出当前组的关系；仍在组内的成员保留原始分配时间和分配者。
    await transaction.projectWorkflowMember.deleteMany({
      where: {
        projectResourceId,
        group,
        ...(userIds.length ? { userId: { notIn: userIds } } : {}),
      },
    });
    const additions = userIds.filter((userId) =>
      !existingPairs.has(`${group}:${userId}`));
    if (!additions.length) return;
    await transaction.projectWorkflowMember.createMany({
      data: additions.map((userId) => ({
        projectResourceId,
        userId,
        group,
        createdBy: actorUserId,
      })),
    });
  }

  private mapProjectWorkflowGroups(
    projectResourceId: string,
    rows: ProjectWorkflowMemberRow[],
  ): ProjectWorkflowGroups {
    const sorted = [...rows].sort((left, right) =>
      left.user.displayName.localeCompare(right.user.displayName, "zh-CN") ||
      left.user.accountName.localeCompare(right.user.accountName) ||
      left.user.id.localeCompare(right.user.id));
    return {
      projectResourceId,
      annotation: sorted
        .filter(({ group }) => group === "annotation")
        .map(({ user }) => user),
      review: sorted
        .filter(({ group }) => group === "review")
        .map(({ user }) => user),
    };
  }

  // 恢复历史和内容写入只能作用于活动标注文件；transaction 参数保证检查使用同一事务快照。
  private async assertActiveAnnotationFile(
    resourceId: string,
    database: PrismaClient | Prisma.TransactionClient = this.prisma,
  ) {
    await assertActiveAnnotationFileActivity(database, resourceId);
  }

  // 三类范围事实共用固定锁序；这里只验证 read，具体 review/write 由 kind 对应的领域门禁复核。
  private async lockAnnotationFileForRangeFact(
    transaction: Prisma.TransactionClient,
    user: ApiUser,
    resourceId: string,
  ) {
    await this.lockResourceTreeForContentWrite(transaction);
    await this.lockResourceRows(transaction, [resourceId]);
    await this.assertActiveAnnotationFile(resourceId, transaction);
    const permission = await this.access.getEffectivePermission(
      user,
      resourceId,
      transaction,
    );
    if (!permission.capabilities.includes("read")) {
      throw forbidden("当前账号无权读取该标注文件的范围记录。");
    }

    await transaction.$queryRaw`
      SELECT resource_id
      FROM annotation_files
      WHERE resource_id = ${resourceId}
      FOR SHARE
    `;
    const current = await transaction.annotationFile.findUnique({
      where: { resourceId },
    });
    if (!current) throw notFound("标注文件不存在。");
    return { current, permission };
  }

  private async isDescendant(
    database: PrismaClient | Prisma.TransactionClient,
    candidateId: string,
    ancestorId: string,
  ) {
    let currentId: string | null = candidateId;
    while (currentId) {
      if (currentId === ancestorId) return true;
      const row: { parentId: string | null } | null =
        await database.resourceEntry.findUnique({
        where: { id: currentId },
        select: { parentId: true },
      });
      currentId = row?.parentId ?? null;
    }
    return false;
  }

  private async lockParentNamespaces(
    transaction: Prisma.TransactionClient,
    parentIds: Array<string | null>,
  ) {
    // 同一事务可能同时涉及源、目标目录；固定排序可避免两个 move 以相反顺序拿锁而死锁。
    const lockKeys = [...new Set(parentIds.map((id) =>
      `xiqu:resource-parent:${id ?? "<root>"}`))].sort();
    for (const lockKey of lockKeys) {
      await transaction.$queryRaw`
        SELECT 1::integer AS locked
        FROM pg_advisory_xact_lock(hashtext(${lockKey}))
      `;
    }
  }

  private async lockResourceTreeMutation(
    transaction: Prisma.TransactionClient,
  ) {
    // 结构写操作必须先拿同一把事务锁；固定顺序可防止 move 与 restore 交错后产生隐藏资源。
    await transaction.$queryRaw`
      SELECT 1::integer AS locked
      FROM pg_advisory_xact_lock(hashtext('xiqu:resource-tree:mutation'))
    `;
  }

  private async lockResourceTreeForContentWrite(
    transaction: Prisma.TransactionClient,
  ) {
    // 内容写入取得同一 advisory key 的共享锁：不同文件可并发，树移动/回收则等待所有写入结束。
    await transaction.$queryRaw`
      SELECT 1::integer AS locked
      FROM pg_advisory_xact_lock_shared(
        hashtext('xiqu:resource-tree:mutation')
      )
    `;
  }

  private async lockResourceRows(
    transaction: Prisma.TransactionClient,
    resourceIds: string[],
  ) {
    const orderedIds = [...new Set(resourceIds)].sort();
    if (!orderedIds.length) return;
    // 批量移动会同时锁多行；所有调用统一按 id 排序，避免两个事务以相反顺序等待而死锁。
    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM resource_entries
      WHERE id IN (${Prisma.join(orderedIds)})
      ORDER BY id
      FOR UPDATE
    `;
    if (rows.length !== orderedIds.length) throw notFound("部分资源不存在。");
  }

  private async hasTrashedAncestor(
    database: PrismaClient | Prisma.TransactionClient,
    parentId: string | null,
  ) {
    let currentId = parentId;
    while (currentId) {
      const row: { parentId: string | null; trashedAt: Date | null } | null =
        await database.resourceEntry.findUnique({
          where: { id: currentId },
          select: { parentId: true, trashedAt: true },
        });
      if (!row) return true;
      if (row.trashedAt) return true;
      currentId = row.parentId;
    }
    return false;
  }
}

// VOD ID 仅接受供应商稳定标识所需字符，拒绝 URL、查询参数和控制字符。
function validateAliyunVodVideoId(value: string) {
  const videoId = value.trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(videoId)) {
    throw badRequest("阿里云 VOD ID 格式不正确。");
  }
  return videoId;
}

// 上传媒体只从服务端已验证的 MIME 推导种类，不信任浏览器扩展名。
function mediaKindFromMimeType(mimeType: string): "video" | "audio" {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  throw badRequest("媒体 MIME 必须是视频或音频类型。");
}

// 数据库 nullable 字段在 DTO 边界重新收窄为严格判别联合，脏行直接失败。
function mapAnnotationMediaReference(media: {
  resourceId: string;
  sourceType: "uploaded" | "aliyun_vod";
  mediaKind: "video" | "audio";
  mimeType: string | null;
  size: bigint | null;
  duration: number | null;
  aliyunVodVideoId: string | null;
  aliyunVodRegion: string | null;
  resource: { name: string };
  file: { id: string } | null;
}): AnnotationMediaReference {
  const common = {
    resourceId: media.resourceId,
    name: media.resource.name,
    mediaKind: media.mediaKind,
    duration: media.duration,
  };
  if (media.sourceType === "uploaded") {
    if (!media.file || media.mimeType === null || media.size === null) {
      throw new Error("uploaded 媒体缺少 FileObject 元数据。");
    }
    return {
      ...common,
      sourceType: "uploaded",
      fileId: media.file.id,
      mimeType: media.mimeType,
      size: Number(media.size),
    };
  }
  if (!media.aliyunVodVideoId || !media.aliyunVodRegion) {
    throw new Error("aliyun_vod 媒体缺少稳定供应商身份。");
  }
  return {
    ...common,
    sourceType: "aliyun_vod",
    videoId: media.aliyunVodVideoId,
    region: media.aliyunVodRegion,
  };
}

function sameStringSets(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function mapAnnotationMutationLease(lease: AnnotationMutationLeaseRow): AnnotationMutationLeaseSummary {
  return {
    annotationFileId: lease.annotationFileId,
    holder: toPublicUser(lease.holder),
    purpose: lease.purpose,
    baseRevision: lease.baseRevision,
    createdAt: lease.createdAt.toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
  };
}

type OwnedMutationLease = {
  holderUserId: string;
  tokenHash: string;
  purpose: AnnotationMutationPurpose;
  baseRevision: number;
  createdAt: Date;
  expiresAt: Date;
};

// renew/release 必须同时证明账号、明文凭据、基线版本和有效期，不能只凭“同一用户”解锁。
function assertOwnedActiveMutationLease(
  lease: OwnedMutationLease | null,
  actorUserId: string,
  token: string,
  currentRevision: number,
): asserts lease is OwnedMutationLease {
  if (!lease || isAnnotationMutationLeaseExpired(lease.expiresAt)) {
    throw conflict("结构变更租约不存在或已过期。", { code: "annotation_mutation_lease_expired" });
  }
  if (lease.baseRevision !== currentRevision) {
    throw conflict("文件版本已变化，结构变更租约失效。", {
      code: "annotation_mutation_lease_revision_conflict",
      expectedRevision: currentRevision,
      receivedRevision: lease.baseRevision,
    });
  }
  if (lease.holderUserId !== actorUserId || !matchesAnnotationMutationLeaseToken(token, lease.tokenHash)) {
    throw conflict("结构变更租约凭据不匹配。", { code: "annotation_mutation_lease_invalid" });
  }
}
