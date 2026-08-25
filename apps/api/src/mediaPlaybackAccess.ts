import type { Prisma, PrismaClient } from "@prisma/client";
import type { MediaKind } from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, forbidden, HttpError, notFound } from "./errors.js";
import { requireActiveMediaResource } from "./mediaResourceActivity.js";
import type { ResourceAccessService } from "./resourceAccess.js";

type DatabaseClient = PrismaClient | Prisma.TransactionClient;
type ActiveMediaResource = Awaited<ReturnType<typeof requireActiveMediaResource>>;

export type MediaPlaybackAccessResult =
  | { status: "available"; media: ActiveMediaResource }
  | { status: "permission_denied" }
  | { status: "source_unavailable" }
  | { status: "invalid_source" };

/**
 * 播放列表和真实会话共用同一活动性、ACL 与媒体身份判断；这里只返回有限状态，不签发凭据或读取对象。
 */
export async function resolveMediaPlaybackAccess(
  database: DatabaseClient,
  access: ResourceAccessService,
  user: ApiUser,
  resourceId: string,
  expectedKind?: MediaKind,
): Promise<MediaPlaybackAccessResult> {
  let media: ActiveMediaResource;
  try {
    media = await requireActiveMediaResource(database, resourceId);
  } catch (error) {
    if (error instanceof HttpError && error.code === "not_found") {
      return { status: "source_unavailable" };
    }
    throw error;
  }
  const permission = await access.getEffectivePermission(user, resourceId, database);
  if (
    !permission.capabilities.includes("read") ||
    !permission.capabilities.includes("download")
  ) {
    return { status: "permission_denied" };
  }
  if (expectedKind && media.mediaKind !== expectedKind) {
    return { status: "invalid_source" };
  }

  const expectedMimePrefix = `${media.mediaKind}/`;
  if (media.sourceType === "uploaded") {
    const mimeType = media.mimeType ?? media.file?.mimeType;
    if (!media.file || !mimeType?.startsWith(expectedMimePrefix)) {
      return { status: "invalid_source" };
    }
  } else if (!media.aliyunVodVideoId || !media.aliyunVodRegion) {
    return { status: "invalid_source" };
  }
  return { status: "available", media };
}

/** 真实播放会话把有限选项状态恢复为稳定 HTTP 语义，并继续执行后续短时凭据签发。 */
export async function requireMediaPlaybackAccess(
  database: DatabaseClient,
  access: ResourceAccessService,
  user: ApiUser,
  resourceId: string,
  expectedKind?: MediaKind,
) {
  const result = await resolveMediaPlaybackAccess(
    database,
    access,
    user,
    resourceId,
    expectedKind,
  );
  if (result.status === "available") return result.media;
  if (result.status === "permission_denied") {
    throw forbidden("当前账号没有读取或下载该播放媒体的权限。");
  }
  if (result.status === "source_unavailable") {
    throw notFound("可播放媒体不存在。");
  }
  throw badRequest("媒体缺少有效的可播放来源。");
}
