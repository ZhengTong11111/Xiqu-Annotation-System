import type { MediaAudioTrackPlaybackSession, MediaAudioTrackRecord } from "@xiqu/shared";
import type { PlatformClient } from "../api/platformClient";
import type { ExternalAudioPlaybackSource } from "../media/externalAudioPlaybackBackendFactory";

type SourceContext = {
  annotationFileId: string;
  primaryMediaResourceId: string;
  track: MediaAudioTrackRecord;
  client: Pick<
    PlatformClient,
    "createMediaAudioTrackPlaybackSession" | "getFileContentUrl"
  >;
};

/**
 * 音轨记录只决定稳定来源；每次 load 都重新请求并核对会话身份，迟到响应不能被错接到另一音轨。
 */
export function buildPlatformExternalAudioPlaybackSource(
  context: SourceContext,
): ExternalAudioPlaybackSource | null {
  const { track } = context;
  if (
    !track.enabled ||
    track.kind === "original" ||
    track.primaryMediaResourceId !== context.primaryMediaResourceId ||
    track.source.type === "embedded_original"
  ) {
    return null;
  }
  const loadValidated = async (signal?: AbortSignal) => {
    const session = await context.client.createMediaAudioTrackPlaybackSession(
      context.annotationFileId,
      track.id,
      signal,
    );
    assertSessionIdentity(session, context);
    return session;
  };
  if (track.source.type === "media_resource" && track.source.sourceType === "uploaded") {
    return {
      type: "uploaded_audio",
      trackId: track.id,
      audioMediaResourceId: track.source.mediaResourceId,
      offsetSeconds: track.offsetSeconds,
      load: async (signal) => {
        const session = await loadValidated(signal);
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
  if (track.source.type === "aliyun_vod_rendition") {
    const rendition = track.source.rendition;
    return {
      type: "aliyun_vod_rendition_audio",
      trackId: track.id,
      audioMediaResourceId: track.source.mediaResourceId,
      renditionJobId: rendition.jobId,
      offsetSeconds: track.offsetSeconds,
      loadSession: async (signal) => {
        const session = await loadValidated(signal);
        if (
          session.sourceType !== "aliyun_vod_rendition" ||
          session.jobId !== rendition.jobId
        ) {
          throw new Error("VOD 音频转码会话来源已经变化，请刷新音轨列表。");
        }
        return session;
      },
    };
  }
  return {
    type: "aliyun_vod_audio",
    trackId: track.id,
    audioMediaResourceId: track.source.mediaResourceId,
    offsetSeconds: track.offsetSeconds,
    loadSession: async (signal) => {
      const session = await loadValidated(signal);
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
  const expectedAudioMediaId = context.track.source.type === "embedded_original"
    ? null
    : context.track.source.mediaResourceId;
  if (
    session.annotationFileId !== context.annotationFileId ||
    session.primaryMediaResourceId !== context.primaryMediaResourceId ||
    session.trackId !== context.track.id ||
    session.audioMediaResourceId !== expectedAudioMediaId
  ) {
    throw new Error("音轨播放会话与当前文件或音轨不匹配。");
  }
}
