import type {
  MediaAudioTrackKind as DbMediaAudioTrackKind,
  MediaKind,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH,
  MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS,
  MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA,
  type AnnotationAudioPreference,
  type CreateMediaAudioTrackRequest,
  type MediaAudioTrackList,
  type MediaAudioTrackRecord,
  type ReorderMediaAudioTracksRequest,
  type UpdateAnnotationAudioPreferenceRequest,
  type UpdateMediaAudioTrackRequest,
} from "@xiqu/shared";
import { assertActiveAnnotationFile } from "./annotationFileActivity.js";
import { lockActiveAnnotationFileForWrite } from "./annotationFileWriteLock.js";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { ResourceAccessService } from "./resourceAccess.js";
import {
  assertActiveResourceAncestors,
  requireActiveMediaResource,
} from "./mediaResourceActivity.js";

const audioTrackInclude = {
  primaryMedia: { select: { sourceType: true } },
  audioMedia: { select: { sourceType: true } },
} satisfies Prisma.MediaAudioTrackInclude;

type AudioTrackRow = Prisma.MediaAudioTrackGetPayload<{
  include: typeof audioTrackInclude;
}>;

const EXTERNAL_TRACK_KINDS = new Set<DbMediaAudioTrackKind>([
  "vocal",
  "accompaniment",
  "denoised",
  "reference",
  "custom",
]);

export type CreateOriginalMediaAudioTrackInput = {
  primaryMediaResourceId: string;
  mediaKind: MediaKind;
  createdBy: string;
};

// 每份新媒体都在创建事务内得到唯一原声音轨；既有媒体由正式 migration 使用同一命名语义回填。
export async function createOriginalMediaAudioTrack(
  transaction: Prisma.TransactionClient,
  input: CreateOriginalMediaAudioTrackInput,
) {
  const existing = await transaction.mediaAudioTrack.findFirst({
    where: {
      primaryMediaResourceId: input.primaryMediaResourceId,
      kind: "original",
    },
  });
  if (existing) return existing;
  return transaction.mediaAudioTrack.create({
    data: {
      primaryMediaResourceId: input.primaryMediaResourceId,
      audioMediaResourceId: null,
      name: input.mediaKind === "video" ? "视频原声" : "媒体原声",
      kind: "original",
      offsetSeconds: 0,
      sortOrder: 0,
      enabled: true,
      createdBy: input.createdBy,
    },
  });
}

// 音轨服务只管理平台媒体关系和默认偏好，不接触 ProjectData、标注 revision 或分析运行状态。
export class MediaAudioTrackService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
  ) {}

  async listTracks(
    user: ApiUser,
    primaryMediaResourceId: string,
  ): Promise<MediaAudioTrackList> {
    await requireActiveMediaResource(this.prisma, primaryMediaResourceId);
    await this.access.assertCapability(user, primaryMediaResourceId, "read");
    const rows = await this.prisma.mediaAudioTrack.findMany({
      where: { primaryMediaResourceId },
      include: audioTrackInclude,
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    if (!rows.some((row) => row.kind === "original")) {
      throw conflict("媒体缺少原声音轨，请联系管理员修复媒体元数据。");
    }
    return {
      primaryMediaResourceId,
      tracks: rows.map(mapMediaAudioTrackRecord),
    };
  }

  async createTrack(
    user: ApiUser,
    primaryMediaResourceId: string,
    input: CreateMediaAudioTrackRequest,
  ): Promise<MediaAudioTrackRecord> {
    const name = validateTrackName(input.name);
    const kind = validateExternalTrackKind(input.kind);
    const offsetSeconds = validateTrackOffset(input.offsetSeconds ?? 0);
    const row = await this.prisma.$transaction(async (transaction) => {
      await this.lockPrimaryMediaForWrite(user, primaryMediaResourceId, transaction);
      if (input.audioMediaResourceId === primaryMediaResourceId) {
        throw badRequest("独立音轨不能再次引用主媒体自身。");
      }
      await this.assertReadableAudioSource(
        user,
        input.audioMediaResourceId,
        transaction,
      );

      // 主媒体行锁保证计数、重复检查和末尾顺序对并发创建保持一致。
      const existingRows = await transaction.mediaAudioTrack.findMany({
        where: { primaryMediaResourceId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      });
      if (existingRows.length >= MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA) {
        throw conflict(`每份媒体最多关联 ${MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA} 条音轨。`);
      }
      if (existingRows.some((entry) =>
        entry.audioMediaResourceId === input.audioMediaResourceId)) {
        throw conflict("该音频已经关联到当前主媒体。");
      }
      const created = await transaction.mediaAudioTrack.create({
        data: {
          primaryMediaResourceId,
          audioMediaResourceId: input.audioMediaResourceId,
          name,
          kind,
          offsetSeconds,
          sortOrder: existingRows.length,
          enabled: true,
          createdBy: user.id,
        },
        include: audioTrackInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "media_audio_track_create",
          actorUserId: user.id,
          resourceId: primaryMediaResourceId,
          detail: {
            trackId: created.id,
            audioMediaResourceId: input.audioMediaResourceId,
            kind,
            offsetSeconds,
          },
        },
      });
      return created;
    });
    return mapMediaAudioTrackRecord(row);
  }

  async updateTrack(
    user: ApiUser,
    primaryMediaResourceId: string,
    trackId: string,
    input: UpdateMediaAudioTrackRequest,
  ): Promise<MediaAudioTrackRecord> {
    if (
      input.name === undefined &&
      input.kind === undefined &&
      input.offsetSeconds === undefined &&
      input.enabled === undefined
    ) {
      throw badRequest("音轨更新至少需要一个字段。");
    }
    const data: Prisma.MediaAudioTrackUpdateInput = {};
    if (input.name !== undefined) data.name = validateTrackName(input.name);
    if (input.kind !== undefined) data.kind = validateExternalTrackKind(input.kind);
    if (input.offsetSeconds !== undefined) {
      data.offsetSeconds = validateTrackOffset(input.offsetSeconds);
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== "boolean") throw badRequest("enabled 必须是布尔值。");
      data.enabled = input.enabled;
    }

    const row = await this.prisma.$transaction(async (transaction) => {
      await this.lockPrimaryMediaForWrite(user, primaryMediaResourceId, transaction);
      const current = await this.requireOwnedTrack(
        transaction,
        primaryMediaResourceId,
        trackId,
      );
      if (current.kind === "original") {
        throw badRequest("系统原声音轨不能修改。");
      }

      // 禁用当前默认音轨时统一清空引用，避免标注文件保留不可选择的共享默认值。
      const clearedPreferenceCount = input.enabled === false
        ? (await transaction.annotationAudioPreference.updateMany({
            where: { defaultAudioTrackId: trackId },
            data: {
              defaultAudioTrackId: null,
              updatedBy: user.id,
              updatedAt: new Date(),
            },
          })).count
        : 0;
      const updated = await transaction.mediaAudioTrack.update({
        where: { id: trackId },
        data,
        include: audioTrackInclude,
      });
      await transaction.auditLog.create({
        data: {
          action: "media_audio_track_update",
          actorUserId: user.id,
          resourceId: primaryMediaResourceId,
          detail: {
            trackId,
            changedFields: Object.keys(data).sort(),
            clearedPreferenceCount,
          },
        },
      });
      return updated;
    });
    return mapMediaAudioTrackRecord(row);
  }

  async deleteTrack(
    user: ApiUser,
    primaryMediaResourceId: string,
    trackId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockPrimaryMediaForWrite(user, primaryMediaResourceId, transaction);
      const current = await this.requireOwnedTrack(
        transaction,
        primaryMediaResourceId,
        trackId,
      );
      if (current.kind === "original") {
        throw badRequest("系统原声音轨不能删除。");
      }

      // 删除关联不删除真实音频资源；只清理默认引用并压紧当前主媒体的展示顺序。
      const clearedPreferenceCount = (await transaction.annotationAudioPreference.updateMany({
        where: { defaultAudioTrackId: trackId },
        data: {
          defaultAudioTrackId: null,
          updatedBy: user.id,
          updatedAt: new Date(),
        },
      })).count;
      await transaction.mediaAudioTrack.delete({ where: { id: trackId } });
      const remaining = await transaction.mediaAudioTrack.findMany({
        where: { primaryMediaResourceId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      for (const [sortOrder, entry] of remaining.entries()) {
        await transaction.mediaAudioTrack.update({
          where: { id: entry.id },
          data: { sortOrder },
        });
      }
      await transaction.auditLog.create({
        data: {
          action: "media_audio_track_delete",
          actorUserId: user.id,
          resourceId: primaryMediaResourceId,
          detail: {
            trackId,
            audioMediaResourceId: current.audioMediaResourceId,
            clearedPreferenceCount,
          },
        },
      });
    });
  }

  async reorderTracks(
    user: ApiUser,
    primaryMediaResourceId: string,
    input: ReorderMediaAudioTracksRequest,
  ): Promise<MediaAudioTrackList> {
    if (
      !Array.isArray(input.trackIds) ||
      input.trackIds.length < 1 ||
      input.trackIds.length > MAX_MEDIA_AUDIO_TRACKS_PER_MEDIA ||
      input.trackIds.some((id) => typeof id !== "string" || id.trim().length === 0) ||
      new Set(input.trackIds).size !== input.trackIds.length
    ) {
      throw badRequest("音轨顺序必须是无重复的完整音轨 ID 列表。");
    }

    await this.prisma.$transaction(async (transaction) => {
      await this.lockPrimaryMediaForWrite(user, primaryMediaResourceId, transaction);
      const current = await transaction.mediaAudioTrack.findMany({
        where: { primaryMediaResourceId },
        select: { id: true },
      });
      const currentIds = new Set(current.map(({ id }) => id));
      if (
        currentIds.size !== input.trackIds.length ||
        input.trackIds.some((id) => !currentIds.has(id))
      ) {
        throw conflict("音轨集合已经变化，请刷新后重新排序。");
      }

      // sortOrder 没有即时 unique，整组在同一主媒体行锁下可直接写成连续顺序，不需要临时负数占位。
      for (const [sortOrder, id] of input.trackIds.entries()) {
        await transaction.mediaAudioTrack.update({
          where: { id },
          data: { sortOrder },
        });
      }
      await transaction.auditLog.create({
        data: {
          action: "media_audio_track_reorder",
          actorUserId: user.id,
          resourceId: primaryMediaResourceId,
          detail: { orderedTrackIds: input.trackIds },
        },
      });
    });
    return this.listTracks(user, primaryMediaResourceId);
  }

  async getAnnotationPreference(
    user: ApiUser,
    annotationFileId: string,
  ): Promise<AnnotationAudioPreference> {
    await this.access.assertCapability(user, annotationFileId, "read");
    await assertActiveAnnotationFile(this.prisma, annotationFileId);
    const preference = await this.prisma.annotationAudioPreference.findUnique({
      where: { annotationFileId },
    });
    return mapAnnotationAudioPreference(annotationFileId, preference);
  }

  async updateAnnotationPreference(
    user: ApiUser,
    annotationFileId: string,
    input: UpdateAnnotationAudioPreferenceRequest,
  ): Promise<AnnotationAudioPreference> {
    if (
      input.defaultAudioTrackId !== null &&
      (typeof input.defaultAudioTrackId !== "string" ||
        input.defaultAudioTrackId.trim().length === 0)
    ) {
      throw badRequest("默认音轨 ID 不正确。");
    }

    const preference = await this.prisma.$transaction(async (transaction) => {
      const annotation = await lockActiveAnnotationFileForWrite(
        transaction,
        this.access,
        user,
        annotationFileId,
      );
      if (input.defaultAudioTrackId !== null) {
        if (!annotation.mediaResourceId) {
          throw badRequest("标注文件尚未关联主媒体。");
        }
        const track = await transaction.mediaAudioTrack.findFirst({
          where: {
            id: input.defaultAudioTrackId,
            primaryMediaResourceId: annotation.mediaResourceId,
            enabled: true,
          },
          select: { id: true },
        });
        if (!track) throw badRequest("默认音轨不属于当前标注文件的主媒体或已被禁用。");
      }
      const current = await transaction.annotationAudioPreference.findUnique({
        where: { annotationFileId },
      });
      if (current?.defaultAudioTrackId === input.defaultAudioTrackId) return current;
      const updated = await transaction.annotationAudioPreference.upsert({
        where: { annotationFileId },
        update: {
          defaultAudioTrackId: input.defaultAudioTrackId,
          updatedBy: user.id,
        },
        create: {
          annotationFileId,
          defaultAudioTrackId: input.defaultAudioTrackId,
          updatedBy: user.id,
        },
      });
      await transaction.resourceEntry.update({
        where: { id: annotationFileId },
        data: { updatedAt: new Date() },
      });
      await transaction.auditLog.create({
        data: {
          action: "annotation_audio_preference_update",
          actorUserId: user.id,
          resourceId: annotationFileId,
          detail: {
            previousAudioTrackId: current?.defaultAudioTrackId ?? null,
            nextAudioTrackId: input.defaultAudioTrackId,
          },
        },
      });
      return updated;
    });
    return mapAnnotationAudioPreference(annotationFileId, preference);
  }

  private async lockPrimaryMediaForWrite(
    user: ApiUser,
    resourceId: string,
    transaction: Prisma.TransactionClient,
  ) {
    // 音轨关系与资源树 mutation 共用共享 advisory gate，锁后再复核活动性和 ACL。
    await transaction.$queryRaw`
      SELECT 1::integer AS locked
      FROM pg_advisory_xact_lock_shared(hashtext('xiqu:resource-tree:mutation'))
    `;
    const rows = await transaction.$queryRaw<Array<{
      id: string;
      type: string;
      parentId: string | null;
      trashedAt: Date | null;
      archivedAt: Date | null;
    }>>`
      SELECT id, type::text AS type, parent_id AS "parentId",
             trashed_at AS "trashedAt", archived_at AS "archivedAt"
      FROM resource_entries
      WHERE id = ${resourceId}
      FOR UPDATE
    `;
    const resource = rows[0];
    if (
      !resource ||
      resource.type !== "media_file" ||
      resource.trashedAt ||
      resource.archivedAt
    ) {
      throw notFound("活动主媒体不存在。");
    }
    await assertActiveResourceAncestors(transaction, resource.parentId);
    await this.access.assertCapability(user, resourceId, "write", transaction);
    const mediaRows = await transaction.$queryRaw<Array<{ resourceId: string }>>`
      SELECT resource_id AS "resourceId"
      FROM media_files
      WHERE resource_id = ${resourceId}
      FOR UPDATE
    `;
    if (!mediaRows[0]) throw notFound("活动主媒体不存在。");
  }

  private async assertReadableAudioSource(
    user: ApiUser,
    resourceId: string,
    transaction: Prisma.TransactionClient,
  ) {
    const media = await requireActiveMediaResource(transaction, resourceId);
    await this.access.assertCapability(user, resourceId, "read", transaction);
    await this.access.assertCapability(user, resourceId, "download", transaction);
    if (media.mediaKind !== "audio") {
      throw badRequest("独立音轨必须引用音频媒体资源。");
    }
  }

  private async requireOwnedTrack(
    transaction: Prisma.TransactionClient,
    primaryMediaResourceId: string,
    trackId: string,
  ) {
    const track = await transaction.mediaAudioTrack.findFirst({
      where: { id: trackId, primaryMediaResourceId },
    });
    if (!track) throw notFound("音轨不存在。");
    return track;
  }
}

function validateTrackName(value: unknown) {
  if (typeof value !== "string") throw badRequest("音轨名称不正确。");
  const name = value.trim();
  if (!name || name.length > MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH) {
    throw badRequest(`音轨名称长度必须为 1-${MAX_MEDIA_AUDIO_TRACK_NAME_LENGTH} 个字符。`);
  }
  return name;
}

function validateExternalTrackKind(value: unknown): Exclude<DbMediaAudioTrackKind, "original"> {
  if (!EXTERNAL_TRACK_KINDS.has(value as DbMediaAudioTrackKind)) {
    throw badRequest("音轨类型不正确。");
  }
  return value as Exclude<DbMediaAudioTrackKind, "original">;
}

function validateTrackOffset(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS
  ) {
    throw badRequest(`音轨偏移必须是 ±${MAX_MEDIA_AUDIO_TRACK_OFFSET_SECONDS} 秒内的有限数。`);
  }
  return value;
}

function mapMediaAudioTrackRecord(row: AudioTrackRow): MediaAudioTrackRecord {
  return {
    id: row.id,
    primaryMediaResourceId: row.primaryMediaResourceId,
    name: row.name,
    kind: row.kind,
    source: row.kind === "original"
      ? { type: "embedded_original", sourceType: row.primaryMedia.sourceType }
      : {
          type: "media_resource",
          mediaResourceId: row.audioMediaResourceId!,
          sourceType: row.audioMedia!.sourceType,
        },
    offsetSeconds: row.offsetSeconds,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  };
}

function mapAnnotationAudioPreference(
  annotationFileId: string,
  preference: {
    defaultAudioTrackId: string | null;
    updatedBy: string;
    updatedAt: Date;
  } | null,
): AnnotationAudioPreference {
  return {
    annotationFileId,
    defaultAudioTrackId: preference?.defaultAudioTrackId ?? null,
    updatedByAccountId: preference?.updatedBy ?? null,
    updatedAt: preference?.updatedAt.toISOString() ?? null,
  };
}
