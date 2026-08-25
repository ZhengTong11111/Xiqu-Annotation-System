import type { PrismaClient } from "@prisma/client";
import {
  MEDIA_AUDIO_PLAYBACK_SESSION_VERSION,
  type AliyunVodWebPlayerLicense,
  type MediaAudioTrackPlaybackSession,
} from "@xiqu/shared";
import type { AliyunVodProvider } from "./aliyunVodGateway.js";
import { issueAliyunVodPlaybackSession } from "./aliyunVodPlaybackSessionIssuer.js";
import { assertActiveAnnotationFile } from "./annotationFileActivity.js";
import type { ApiUser } from "./domain.js";
import { badRequest, notFound } from "./errors.js";
import { requireMediaPlaybackAccess } from "./mediaPlaybackAccess.js";
import type { ResourceAccessService } from "./resourceAccess.js";

/** 音轨播放会话只负责高频只读授权和短时来源，不修改偏好、ProjectData 或标注 revision。 */
export class MediaAudioPlaybackSessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly access: ResourceAccessService,
    private readonly aliyunVod: AliyunVodProvider | null,
    private readonly webPlayerLicense: AliyunVodWebPlayerLicense | null,
  ) {}

  async createSession(
    user: ApiUser,
    annotationFileId: string,
    trackId: string,
  ): Promise<MediaAudioTrackPlaybackSession> {
    await this.access.assertCapability(user, annotationFileId, "read");
    await assertActiveAnnotationFile(this.prisma, annotationFileId);
    const annotation = await this.prisma.annotationFile.findUnique({
      where: { resourceId: annotationFileId },
      select: { mediaResourceId: true },
    });
    if (!annotation?.mediaResourceId) throw badRequest("标注文件尚未关联主媒体。");

    const primaryMediaResourceId = annotation.mediaResourceId;
    await requireMediaPlaybackAccess(
      this.prisma,
      this.access,
      user,
      primaryMediaResourceId,
    );
    const track = await this.prisma.mediaAudioTrack.findFirst({
      where: { id: trackId, primaryMediaResourceId },
      select: {
        id: true,
        kind: true,
        enabled: true,
        audioMediaResourceId: true,
      },
    });
    if (!track || !track.enabled) throw notFound("可播放音轨不存在。");
    if (track.kind === "original" || !track.audioMediaResourceId) {
      throw badRequest("原声音轨不需要创建外部播放会话。");
    }

    const audioMedia = await requireMediaPlaybackAccess(
      this.prisma,
      this.access,
      user,
      track.audioMediaResourceId,
      "audio",
    );
    const base = {
      version: MEDIA_AUDIO_PLAYBACK_SESSION_VERSION,
      annotationFileId,
      primaryMediaResourceId,
      trackId: track.id,
      audioMediaResourceId: track.audioMediaResourceId,
    } as const;

    if (audioMedia.sourceType === "uploaded") {
      const mimeType = audioMedia.mimeType ?? audioMedia.file?.mimeType;
      if (!audioMedia.file || !mimeType?.startsWith("audio/")) {
        throw badRequest("上传音轨缺少可播放音频对象。");
      }
      return {
        ...base,
        sourceType: "uploaded",
        fileId: audioMedia.file.id,
        mimeType,
        duration: audioMedia.duration,
      };
    }
    if (!audioMedia.aliyunVodVideoId || !audioMedia.aliyunVodRegion) {
      throw badRequest("阿里云音轨缺少有效媒资身份。");
    }
    const vod = await issueAliyunVodPlaybackSession(
      this.aliyunVod,
      this.webPlayerLicense,
      {
        mediaKind: "audio",
        videoId: audioMedia.aliyunVodVideoId,
        region: audioMedia.aliyunVodRegion,
      },
    );
    return {
      ...base,
      sourceType: "aliyun_vod",
      videoId: vod.videoId,
      region: vod.region,
      playAuth: vod.playAuth,
      expiresAt: vod.expiresAt,
      webPlayerLicense: vod.webPlayerLicense,
    };
  }

}
