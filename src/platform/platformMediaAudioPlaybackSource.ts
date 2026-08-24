import type {
  AliyunVodPlaybackSession,
  MediaAudioTrackPlaybackSession,
  MediaAudioTrackRecord,
} from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";

type SourceContext = {
  annotationFileId: string;
  primaryMediaResourceId: string;
  track: MediaAudioTrackRecord;
  client: Pick<
    PlatformClient,
    "createMediaAudioTrackPlaybackSession" | "getFileContentUrl"
  >;
};

export type PlatformExternalAudioPlaybackSource =
  | {
      type: "uploaded_audio";
      trackId: string;
      audioMediaResourceId: string;
      offsetSeconds: number;
      load: () => Promise<{
        url: string;
        mimeType: string;
        duration: number | null;
      }>;
    }
  | {
      type: "aliyun_vod_audio";
      trackId: string;
      audioMediaResourceId: string;
      offsetSeconds: number;
      loadSession: () => Promise<AliyunVodPlaybackSession>;
    };

/**
 * 音轨记录只决定稳定来源；每次 load 都重新请求并核对会话身份，迟到响应不能被错接到另一音轨。
 */
export function buildPlatformExternalAudioPlaybackSource(
  context: SourceContext,
): PlatformExternalAudioPlaybackSource | null {
  const { track } = context;
  if (
    !track.enabled ||
    track.kind === "original" ||
    track.primaryMediaResourceId !== context.primaryMediaResourceId ||
    track.source.type !== "media_resource"
  ) {
    return null;
  }
  const loadValidated = async () => {
    const session = await context.client.createMediaAudioTrackPlaybackSession(
      context.annotationFileId,
      track.id,
    );
    assertSessionIdentity(session, context);
    return session;
  };
  if (track.source.sourceType === "uploaded") {
    return {
      type: "uploaded_audio",
      trackId: track.id,
      audioMediaResourceId: track.source.mediaResourceId,
      offsetSeconds: track.offsetSeconds,
      load: async () => {
        const session = await loadValidated();
        if (session.sourceType !== "uploaded") {
          throw new Error("音轨播放会话来源已经变化，请刷新音轨列表。");
        }
        return {
          url: context.client.getFileContentUrl(session.fileId),
          mimeType: session.mimeType,
          duration: session.duration,
        };
      },
    };
  }
  return {
    type: "aliyun_vod_audio",
    trackId: track.id,
    audioMediaResourceId: track.source.mediaResourceId,
    offsetSeconds: track.offsetSeconds,
    loadSession: async () => {
      const session = await loadValidated();
      if (session.sourceType !== "aliyun_vod") {
        throw new Error("音轨播放会话来源已经变化，请刷新音轨列表。");
      }
      return {
        sourceType: "aliyun_vod",
        mediaKind: "audio",
        videoId: session.videoId,
        region: session.region,
        playAuth: session.playAuth,
        expiresAt: session.expiresAt,
        webPlayerLicense: session.webPlayerLicense,
      };
    },
  };
}

function assertSessionIdentity(
  session: MediaAudioTrackPlaybackSession,
  context: SourceContext,
) {
  const expectedAudioMediaId = context.track.source.type === "media_resource"
    ? context.track.source.mediaResourceId
    : null;
  if (
    session.annotationFileId !== context.annotationFileId ||
    session.primaryMediaResourceId !== context.primaryMediaResourceId ||
    session.trackId !== context.track.id ||
    session.audioMediaResourceId !== expectedAudioMediaId
  ) {
    throw new Error("音轨播放会话与当前文件或音轨不匹配。");
  }
}
