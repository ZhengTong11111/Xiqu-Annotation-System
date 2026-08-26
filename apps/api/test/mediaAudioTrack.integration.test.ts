import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApiApp } from "../src/app.js";
import type { AliyunVodProvider } from "../src/aliyunVodGateway.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

type JsonObject = Record<string, unknown>;

const VIDEO_VOD_ID = "00000000000000000000000000000000";
const AUDIO_VOD_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND_VIDEO_VOD_ID = "11111111111111111111111111111111";
let playbackCredentialRequests = 0;
let renditionStreamRequests = 0;

// 集成测试用稳定 provider 区分视频与独立 VOD 音频，不读取宿主机凭据或访问公网。
const fakeAliyunVodProvider: AliyunVodProvider = {
  region: "cn-shanghai",
  gateway: {
    inspectVideo: async (videoId) => ({
      videoId,
      title: videoId === AUDIO_VOD_ID ? "VOD 人声音轨" : "VOD 主视频",
      status: "Normal",
      mediaKind: videoId === AUDIO_VOD_ID ? "audio" : "video",
      duration: 120,
    }),
    createPlaybackCredential: async (videoId) => {
      playbackCredentialRequests += 1;
      return {
        videoId,
        status: "Normal",
        playAuth: "integration-only-play-auth",
        expiresAt: new Date("2030-01-01T00:15:00.000Z"),
      };
    },
    createAnalysisAudioStream: async () => ({
      url: "https://example.test/audio.mp3?temporary=1",
      expiresAt: new Date("2030-01-01T00:15:00.000Z"),
      format: "mp3",
      duration: 120,
      bitrate: 128,
    }),
    listAudioRenditions: async (videoId) => videoId === VIDEO_VOD_ID
      ? [{
          jobId: "vod-main-audio-job",
          format: "mp3",
          definition: "SQ",
          bitrate: 128,
          duration: 120,
        }]
      : [],
    createAudioRenditionStream: async (videoId, jobId) => {
      renditionStreamRequests += 1;
      return {
        jobId,
        format: "mp3",
        definition: "SQ",
        bitrate: 128,
        duration: 120,
        url: `https://example.test/${videoId}/audio.mp3?temporary=1`,
        expiresAt: new Date("2030-01-01T00:15:00.000Z"),
      };
    },
  },
};

test("媒体音轨 API 管理关系、默认偏好、权限和媒体生命周期", async () => {
  playbackCredentialRequests = 0;
  renditionStreamRequests = 0;
  const storageRoot = await mkdtemp(path.join(tmpdir(), "xiqu-audio-track-api-"));
  const { prisma, pool, maintenancePool, collaborationPool, schema } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const app = await buildApiApp({
    prisma,
    maintenancePool,
    collaborationPool,
    databaseSchema: schema,
    storage: new LocalObjectStorage(storageRoot),
    logger: false,
    seed: true,
    uploadPolicy: {
      maxUploadBytes: 1_024 * 1_024,
      userQuotaBytes: 10 * 1_024 * 1_024,
      platformQuotaBytes: 20 * 1_024 * 1_024,
      orphanGraceMs: 1_000,
    },
    aliyunVod: fakeAliyunVodProvider,
    aliyunVodWebPlayerLicense: {
      domain: "example.test",
      key: "integration-license-key",
    },
  });
  await app.ready();

  try {
    const adminToken = (await login(app, "admin", "admin123")).accessToken;
    const studentToken = (await login(app, "student", "student123")).accessToken;
    const admin = await prisma.user.findUniqueOrThrow({ where: { accountName: "admin" } });
    const student = await prisma.user.findUniqueOrThrow({ where: { accountName: "student" } });

    const projectResponse = await jsonRequest(app, adminToken, {
      method: "POST",
      url: "/api/resources",
      payload: { type: "project", name: "多音轨项目" },
    });
    assert.equal(projectResponse.statusCode, 200, projectResponse.body);
    const projectId = String(dataOf(projectResponse.json()).id);

    const primaryVideoId = await createVodMedia(
      app,
      adminToken,
      projectId,
      "主视频",
      VIDEO_VOD_ID,
    );
    const vodAudioId = await createVodMedia(
      app,
      adminToken,
      projectId,
      "VOD 人声",
      AUDIO_VOD_ID,
    );
    const secondVideoId = await createVodMedia(
      app,
      adminToken,
      projectId,
      "第二视频",
      SECOND_VIDEO_VOD_ID,
    );
    const uploadedAudioId = await uploadWav(
      app,
      adminToken,
      projectId,
      "分离人声.wav",
    );

    // 上传、VOD 视频和 VOD 音频都必须与媒体资源在同一事务生成唯一原声音轨。
    for (const mediaResourceId of [primaryVideoId, vodAudioId, secondVideoId, uploadedAudioId]) {
      const tracks = await prisma.mediaAudioTrack.findMany({
        where: { primaryMediaResourceId: mediaResourceId },
      });
      assert.equal(tracks.length, 1);
      assert.equal(tracks[0]?.kind, "original");
      assert.equal(tracks[0]?.audioMediaResourceId, null);
    }

    const initial = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
    });
    assert.equal(initial.statusCode, 200, initial.body);
    const original = (dataOf(initial.json()).tracks as JsonObject[])[0]!;
    assert.equal(original.kind, "original");
    assert.deepEqual(original.source, {
      type: "embedded_original",
      sourceType: "aliyun_vod",
    });

    // Service 保证媒体创建时有原声，数据库 partial unique 再阻止绕过服务写入第二条原声。
    await assert.rejects(() => prisma.mediaAudioTrack.create({
      data: {
        primaryMediaResourceId: primaryVideoId,
        name: "重复原声",
        kind: "original",
        offsetSeconds: 0,
        sortOrder: 1,
        enabled: true,
        createdBy: admin.id,
      },
    }));

    const uploadedTrackResponse = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
      payload: {
        source: { type: "media_resource", mediaResourceId: uploadedAudioId },
        name: "  人声分离  ",
        kind: "vocal",
        offsetSeconds: 0.25,
      },
    });
    assert.equal(uploadedTrackResponse.statusCode, 200, uploadedTrackResponse.body);
    const uploadedTrack = dataOf(uploadedTrackResponse.json());
    assert.equal(uploadedTrack.name, "人声分离");
    assert.deepEqual(uploadedTrack.source, {
      type: "media_resource",
      mediaResourceId: uploadedAudioId,
      sourceType: "uploaded",
    });

    const vodTrackResponse = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
      payload: {
        source: { type: "media_resource", mediaResourceId: vodAudioId },
        name: "VOD 伴奏",
        kind: "accompaniment",
        offsetSeconds: -0.1,
      },
    });
    assert.equal(vodTrackResponse.statusCode, 200, vodTrackResponse.body);
    const vodTrack = dataOf(vodTrackResponse.json());
    assert.equal((vodTrack.source as JsonObject).sourceType, "aliyun_vod");

    const duplicate = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
      payload: {
        source: { type: "media_resource", mediaResourceId: uploadedAudioId },
        name: "重复",
        kind: "custom",
      },
    });
    assert.equal(duplicate.statusCode, 409);
    const invalidVideoSource = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
      payload: {
        source: { type: "media_resource", mediaResourceId: secondVideoId },
        name: "错误视频",
        kind: "custom",
      },
    });
    assert.equal(invalidVideoSource.statusCode, 400);

    const updated = await jsonRequest(app, adminToken, {
      method: "PATCH",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${uploadedTrack.id}`,
      payload: { name: "干声", kind: "denoised", offsetSeconds: 0.5 },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(dataOf(updated.json()).name, "干声");
    assert.equal(dataOf(updated.json()).kind, "denoised");

    const originalUpdate = await jsonRequest(app, adminToken, {
      method: "PATCH",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${original.id}`,
      payload: { name: "不可改名" },
    });
    assert.equal(originalUpdate.statusCode, 400);
    const emptyUpdate = await jsonRequest(app, adminToken, {
      method: "PATCH",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${uploadedTrack.id}`,
      payload: {},
    });
    assert.equal(emptyUpdate.statusCode, 400);

    const reordered = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/reorder`,
      payload: { trackIds: [vodTrack.id, original.id, uploadedTrack.id] },
    });
    assert.equal(reordered.statusCode, 200, reordered.body);
    assert.deepEqual(
      (dataOf(reordered.json()).tracks as JsonObject[]).map((track) => track.id),
      [vodTrack.id, original.id, uploadedTrack.id],
    );
    const staleReorder = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/reorder`,
      payload: { trackIds: [original.id, uploadedTrack.id] },
    });
    assert.equal(staleReorder.statusCode, 409);
    const duplicateReorder = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/reorder`,
      payload: { trackIds: [original.id, original.id, uploadedTrack.id] },
    });
    assert.equal(duplicateReorder.statusCode, 400);

    const annotationResponse = await jsonRequest(app, adminToken, {
      method: "POST",
      url: "/api/annotation-files",
      payload: {
        parentId: projectId,
        name: "多音轨标注.json",
        payload: { marker: "audio-track" },
        mediaResourceId: primaryVideoId,
      },
    });
    assert.equal(annotationResponse.statusCode, 200, annotationResponse.body);
    const annotationFileId = String(
      recordOf(dataOf(annotationResponse.json()).resource).id,
    );

    // 选项快照只计算当前授权和稳定来源，不应为了渲染列表提前签发 VOD PlayAuth。
    const credentialRequestsBeforeOptions = playbackCredentialRequests;
    const initialOptions = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-playback-options`,
    });
    assert.equal(initialOptions.statusCode, 200, initialOptions.body);
    assert.equal(initialOptions.headers["cache-control"], "no-store");
    assert.equal(playbackCredentialRequests, credentialRequestsBeforeOptions);
    assert.equal(dataOf(initialOptions.json()).canManageTracks, true);
    assert.deepEqual(
      (dataOf(initialOptions.json()).tracks as JsonObject[]).map((entry) => ({
        id: recordOf(entry.track).id,
        availability: entry.availability,
      })),
      [
        { id: vodTrack.id, availability: "available" },
        { id: original.id, availability: "available" },
        { id: uploadedTrack.id, availability: "available" },
      ],
    );
    assert.equal(dataOf(initialOptions.json()).defaultAudioTrackId, null);

    // 同 VID 音频转码候选只暴露 JobId 和有限元数据，创建时由服务端重新核对供应商事实。
    const renditionList = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/media-files/${primaryVideoId}/audio-renditions`,
    });
    assert.equal(renditionList.statusCode, 200, renditionList.body);
    assert.equal(renditionList.headers["cache-control"], "no-store");
    assert.doesNotMatch(renditionList.body, /https?:\/\/|playauth/iu);
    assert.deepEqual(dataOf(renditionList.json()).renditions, [{
      jobId: "vod-main-audio-job",
      format: "mp3",
      definition: "SQ",
      bitrate: 128,
      duration: 120,
    }]);
    const renditionTrackResponse = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
      payload: {
        source: {
          type: "aliyun_vod_rendition",
          mediaResourceId: primaryVideoId,
          jobId: "vod-main-audio-job",
        },
        name: "VOD 视频人声转码",
        kind: "vocal",
      },
    });
    assert.equal(renditionTrackResponse.statusCode, 200, renditionTrackResponse.body);
    const renditionTrack = dataOf(renditionTrackResponse.json());
    assert.deepEqual(renditionTrack.source, {
      type: "aliyun_vod_rendition",
      mediaResourceId: primaryVideoId,
      sourceType: "aliyun_vod",
      rendition: {
        jobId: "vod-main-audio-job",
        format: "mp3",
        definition: "SQ",
        bitrate: 128,
        duration: 120,
      },
    });
    const renditionPlayback = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${renditionTrack.id}/playback-session`,
    });
    assert.equal(renditionPlayback.statusCode, 200, renditionPlayback.body);
    assert.equal(renditionPlayback.headers["cache-control"], "no-store");
    assert.equal(dataOf(renditionPlayback.json()).sourceType, "aliyun_vod_rendition");
    assert.equal(dataOf(renditionPlayback.json()).jobId, "vod-main-audio-job");
    assert.equal(dataOf(renditionPlayback.json()).mimeType, "audio/mpeg");
    assert.match(String(dataOf(renditionPlayback.json()).url), /^https:\/\//u);
    assert.doesNotMatch(renditionPlayback.body, /playauth/iu);
    assert.equal(renditionStreamRequests, 1);

    // 音轨级分析由 annotation + track 重新解析来源；同一 VOD 的原声和指定 JobId 不能共享同一 run。
    const originalAnalysis = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/media-analysis`,
      payload: { audioTrackId: original.id },
    });
    assert.equal(originalAnalysis.statusCode, 200, originalAnalysis.body);
    assert.equal(dataOf(originalAnalysis.json()).sourceVodRenditionJobId, null);
    const renditionAnalysis = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/media-analysis`,
      payload: { audioTrackId: renditionTrack.id },
    });
    assert.equal(renditionAnalysis.statusCode, 200, renditionAnalysis.body);
    assert.equal(
      dataOf(renditionAnalysis.json()).sourceVodRenditionJobId,
      "vod-main-audio-job",
    );
    assert.notEqual(dataOf(originalAnalysis.json()).id, dataOf(renditionAnalysis.json()).id);

    const repeatedRenditionAnalysis = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/media-analysis`,
      payload: { audioTrackId: renditionTrack.id },
    });
    assert.equal(repeatedRenditionAnalysis.statusCode, 200, repeatedRenditionAnalysis.body);
    assert.equal(
      dataOf(repeatedRenditionAnalysis.json()).id,
      dataOf(renditionAnalysis.json()).id,
      "同一 canonical identity 的活跃任务必须复用",
    );
    const renditionStatus = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/media-analysis?${new URLSearchParams({
        audioTrackId: String(renditionTrack.id),
      })}`,
    });
    assert.equal(renditionStatus.statusCode, 200, renditionStatus.body);
    assert.equal(dataOf(renditionStatus.json()).audioTrackId, renditionTrack.id);
    assert.equal(
      recordOf(dataOf(renditionStatus.json()).currentRun).id,
      dataOf(renditionAnalysis.json()).id,
    );
    const invalidTrackIdentity = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/media-analysis?audioTrackId=%20`,
    });
    assert.equal(invalidTrackIdentity.statusCode, 400);

    const uploadedAnalysis = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/media-analysis`,
      payload: { audioTrackId: uploadedTrack.id },
    });
    assert.equal(uploadedAnalysis.statusCode, 200, uploadedAnalysis.body);
    const uploadedRunId = String(dataOf(uploadedAnalysis.json()).id);
    const changeOffset = await jsonRequest(app, adminToken, {
      method: "PATCH",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${uploadedTrack.id}`,
      payload: { offsetSeconds: 0.75 },
    });
    assert.equal(changeOffset.statusCode, 200, changeOffset.body);
    const uploadedStatusAfterOffset = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/media-analysis?${new URLSearchParams({
        audioTrackId: String(uploadedTrack.id),
      })}`,
    });
    assert.equal(uploadedStatusAfterOffset.statusCode, 200, uploadedStatusAfterOffset.body);
    assert.equal(
      recordOf(dataOf(uploadedStatusAfterOffset.json()).currentRun).id,
      uploadedRunId,
    );
    assert.equal(
      recordOf(dataOf(uploadedStatusAfterOffset.json()).currentRun).sourceOffsetSeconds,
      0.75,
    );
    await jsonRequest(app, adminToken, {
      method: "PATCH",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${uploadedTrack.id}`,
      payload: { offsetSeconds: 0.25 },
    });

    const deleteRendition = await jsonRequest(app, adminToken, {
      method: "DELETE",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${renditionTrack.id}`,
    });
    assert.equal(deleteRendition.statusCode, 204, deleteRendition.body);
    assert.ok(await prisma.mediaAnalysisRun.findUnique({
      where: { id: String(dataOf(renditionAnalysis.json()).id) },
    }), "删除音轨关系不能删除媒体级 run");
    const deletedTrackStatus = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/media-analysis?${new URLSearchParams({
        audioTrackId: String(renditionTrack.id),
      })}`,
    });
    assert.equal(deletedTrackStatus.statusCode, 200, deletedTrackStatus.body);
    assert.equal(dataOf(deletedTrackStatus.json()).currentRun, null);
    assert.equal(
      recordOf(dataOf(deletedTrackStatus.json()).resolvedSource).code,
      "analysis_source_invalid",
    );

    // 播放会话每次都重新验证标注文件、主媒体和源音频，不能把建轨时的一次授权当成永久通行证。
    const uploadedPlayback = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(uploadedPlayback.statusCode, 200, uploadedPlayback.body);
    assert.equal(uploadedPlayback.headers["cache-control"], "no-store");
    assert.deepEqual(dataOf(uploadedPlayback.json()), {
      version: 1,
      annotationFileId,
      primaryMediaResourceId: primaryVideoId,
      trackId: uploadedTrack.id,
      audioMediaResourceId: uploadedAudioId,
      sourceType: "uploaded",
      fileId: String(
        (await prisma.mediaFile.findUniqueOrThrow({ where: { resourceId: uploadedAudioId } }))
          .fileId,
      ),
      mimeType: "audio/wav",
      duration: null,
    });
    assert.doesNotMatch(uploadedPlayback.body, /https?:\/\/|accesskey|secret/iu);

    const vodPlayback = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${vodTrack.id}/playback-session`,
    });
    assert.equal(vodPlayback.statusCode, 200, vodPlayback.body);
    assert.equal(vodPlayback.headers["cache-control"], "no-store");
    assert.deepEqual(dataOf(vodPlayback.json()), {
      version: 1,
      annotationFileId,
      primaryMediaResourceId: primaryVideoId,
      trackId: vodTrack.id,
      audioMediaResourceId: vodAudioId,
      sourceType: "aliyun_vod",
      videoId: AUDIO_VOD_ID,
      region: "cn-shanghai",
      playAuth: "integration-only-play-auth",
      expiresAt: "2030-01-01T00:15:00.000Z",
      webPlayerLicense: {
        domain: "example.test",
        key: "integration-license-key",
      },
    });
    assert.doesNotMatch(vodPlayback.body, /https?:\/\/|accesskey|secret/iu);

    const originalPlayback = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${original.id}/playback-session`,
    });
    assert.equal(originalPlayback.statusCode, 400);
    const foreignOriginal = await prisma.mediaAudioTrack.findFirstOrThrow({
      where: { primaryMediaResourceId: secondVideoId, kind: "original" },
    });
    const wrongPrimaryPlayback = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${foreignOriginal.id}/playback-session`,
    });
    assert.equal(wrongPrimaryPlayback.statusCode, 404);

    const unboundAnnotation = await jsonRequest(app, adminToken, {
      method: "POST",
      url: "/api/annotation-files",
      payload: {
        parentId: projectId,
        name: "未绑定媒体.json",
        payload: { marker: "unbound-audio-track" },
      },
    });
    const unboundAnnotationId = String(
      recordOf(dataOf(unboundAnnotation.json()).resource).id,
    );
    const unboundPlayback = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${unboundAnnotationId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(unboundPlayback.statusCode, 400);
    const unboundOptions = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${unboundAnnotationId}/audio-playback-options`,
    });
    assert.equal(unboundOptions.statusCode, 400);

    // 资源归档后即使音轨关系仍存在也必须停止签发；恢复活动状态后才能重新播放。
    await prisma.resourceEntry.update({
      where: { id: uploadedAudioId },
      data: { archivedAt: new Date("2026-08-24T00:00:00.000Z") },
    });
    const archivedPlayback = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(archivedPlayback.statusCode, 404);
    assert.equal(archivedPlayback.headers["cache-control"], "no-store");
    const archivedOptions = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-playback-options`,
    });
    assert.equal(
      findOptionAvailability(archivedOptions, uploadedTrack.id),
      "source_unavailable",
    );
    await prisma.resourceEntry.update({
      where: { id: uploadedAudioId },
      data: { archivedAt: null },
    });

    // 用三条直接 ACL 逐层推进授权，证明标注文件、主媒体和源音频缺一不可。
    await prisma.resourcePermission.create({
      data: {
        resourceId: annotationFileId,
        userId: student.id,
        capabilities: ["read"],
        inheritToChildren: false,
        createdBy: admin.id,
      },
    });
    const playbackWithoutPrimaryAccess = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(playbackWithoutPrimaryAccess.statusCode, 403);
    const optionsWithoutPrimaryAccess = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-playback-options`,
    });
    assert.equal(findOptionAvailability(optionsWithoutPrimaryAccess, original.id), "permission_denied");
    assert.equal(findOptionAvailability(optionsWithoutPrimaryAccess, uploadedTrack.id), "permission_denied");
    await prisma.resourcePermission.create({
      data: {
        resourceId: primaryVideoId,
        userId: student.id,
        capabilities: ["read", "download"],
        inheritToChildren: false,
        createdBy: admin.id,
      },
    });
    const playbackWithoutAudioAccess = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(playbackWithoutAudioAccess.statusCode, 403);
    const optionsWithoutAudioAccess = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-playback-options`,
    });
    assert.equal(findOptionAvailability(optionsWithoutAudioAccess, original.id), "available");
    assert.equal(findOptionAvailability(optionsWithoutAudioAccess, uploadedTrack.id), "permission_denied");
    assert.equal(dataOf(optionsWithoutAudioAccess.json()).canManageTracks, false);

    // 自定义 ACL 可以只授予主媒体 write：此时不能试听，但管理入口必须与真实 CRUD 门禁保持一致。
    await prisma.resourcePermission.update({
      where: { resourceId_userId: { resourceId: primaryVideoId, userId: student.id } },
      data: { capabilities: ["write"] },
    });
    const optionsWithWriteOnly = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-playback-options`,
    });
    assert.equal(findOptionAvailability(optionsWithWriteOnly, original.id), "permission_denied");
    assert.equal(dataOf(optionsWithWriteOnly.json()).canManageTracks, true);
    await prisma.resourcePermission.update({
      where: { resourceId_userId: { resourceId: primaryVideoId, userId: student.id } },
      data: { capabilities: ["read", "download"] },
    });
    await prisma.resourcePermission.create({
      data: {
        resourceId: uploadedAudioId,
        userId: student.id,
        capabilities: ["read"],
        inheritToChildren: false,
        createdBy: admin.id,
      },
    });
    const playbackWithoutAudioDownload = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(playbackWithoutAudioDownload.statusCode, 403);
    await prisma.resourcePermission.update({
      where: { resourceId_userId: { resourceId: uploadedAudioId, userId: student.id } },
      data: { capabilities: ["read", "download"] },
    });
    const playbackWithDownload = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(playbackWithDownload.statusCode, 200, playbackWithDownload.body);
    const analysisWithDownload = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/media-analysis?${new URLSearchParams({
        audioTrackId: String(uploadedTrack.id),
      })}`,
    });
    assert.equal(analysisWithDownload.statusCode, 200, analysisWithDownload.body);
    assert.equal(
      recordOf(dataOf(analysisWithDownload.json()).currentRun).id,
      uploadedRunId,
    );
    const optionsWithDownload = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-playback-options`,
    });
    assert.equal(findOptionAvailability(optionsWithDownload, uploadedTrack.id), "available");
    // 撤回 download 后立即失效，证明播放不是复用建轨时或上一次会话的权限结果。
    await prisma.resourcePermission.update({
      where: { resourceId_userId: { resourceId: uploadedAudioId, userId: student.id } },
      data: { capabilities: ["read"] },
    });
    const playbackAfterRevoke = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(playbackAfterRevoke.statusCode, 403);
    // 分析状态也必须逐次重验来源权限，不能因为浏览器持有旧 runId 就继续读取共享结果。
    const analysisAfterRevoke = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/media-analysis?${new URLSearchParams({
        audioTrackId: String(uploadedTrack.id),
      })}`,
    });
    assert.equal(analysisAfterRevoke.statusCode, 200, analysisAfterRevoke.body);
    assert.equal(dataOf(analysisAfterRevoke.json()).currentRun, null);
    assert.equal(
      recordOf(dataOf(analysisAfterRevoke.json()).resolvedSource).code,
      "analysis_audio_forbidden",
    );
    const optionsAfterRevoke = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-playback-options`,
    });
    assert.equal(findOptionAvailability(optionsAfterRevoke, uploadedTrack.id), "permission_denied");
    await prisma.resourcePermission.deleteMany({
      where: {
        userId: student.id,
        resourceId: { in: [annotationFileId, primaryVideoId, uploadedAudioId] },
      },
    });
    await prisma.resourcePermission.create({
      data: {
        resourceId: projectId,
        userId: student.id,
        capabilities: ["read"],
        inheritToChildren: true,
        createdBy: admin.id,
      },
    });

    const emptyPreference = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-preference`,
    });
    assert.deepEqual(dataOf(emptyPreference.json()), {
      annotationFileId,
      defaultAudioTrackId: null,
      updatedByAccountId: null,
      updatedAt: null,
    });

    const preference = await jsonRequest(app, adminToken, {
      method: "PUT",
      url: `/api/annotation-files/${annotationFileId}/audio-preference`,
      payload: { defaultAudioTrackId: uploadedTrack.id },
    });
    assert.equal(preference.statusCode, 200, preference.body);
    assert.equal(dataOf(preference.json()).defaultAudioTrackId, uploadedTrack.id);
    const preferredOptions = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-playback-options`,
    });
    assert.equal(dataOf(preferredOptions.json()).defaultAudioTrackId, uploadedTrack.id);

    const secondVideoTracks = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/media-files/${secondVideoId}/audio-tracks`,
    });
    const secondVideoOriginal = (dataOf(secondVideoTracks.json()).tracks as JsonObject[])[0]!;
    const crossMediaPreference = await jsonRequest(app, adminToken, {
      method: "PUT",
      url: `/api/annotation-files/${annotationFileId}/audio-preference`,
      payload: { defaultAudioTrackId: secondVideoOriginal.id },
    });
    assert.equal(crossMediaPreference.statusCode, 400);

    // 禁用当前默认音轨会清理引用，但不会删除真实音频资源。
    const disabled = await jsonRequest(app, adminToken, {
      method: "PATCH",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${uploadedTrack.id}`,
      payload: { enabled: false },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    const disabledPlayback = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/annotation-files/${annotationFileId}/audio-tracks/${uploadedTrack.id}/playback-session`,
    });
    assert.equal(disabledPlayback.statusCode, 404);
    const disabledAnalysis = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/media-analysis?${new URLSearchParams({
        audioTrackId: String(uploadedTrack.id),
      })}`,
    });
    assert.equal(disabledAnalysis.statusCode, 200, disabledAnalysis.body);
    assert.equal(dataOf(disabledAnalysis.json()).currentRun, null);
    assert.equal(
      recordOf(dataOf(disabledAnalysis.json()).resolvedSource).code,
      "analysis_source_invalid",
    );
    const clearedAfterDisable = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-preference`,
    });
    assert.equal(dataOf(clearedAfterDisable.json()).defaultAudioTrackId, null);
    assert.equal(await prisma.resourceEntry.count({ where: { id: uploadedAudioId } }), 1);

    await jsonRequest(app, adminToken, {
      method: "PUT",
      url: `/api/annotation-files/${annotationFileId}/audio-preference`,
      payload: { defaultAudioTrackId: vodTrack.id },
    });
    const deleted = await jsonRequest(app, adminToken, {
      method: "DELETE",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${vodTrack.id}`,
    });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(await prisma.resourceEntry.count({ where: { id: vodAudioId } }), 1);
    const clearedAfterDelete = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/annotation-files/${annotationFileId}/audio-preference`,
    });
    assert.equal(dataOf(clearedAfterDelete.json()).defaultAudioTrackId, null);

    const originalDelete = await jsonRequest(app, adminToken, {
      method: "DELETE",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${original.id}`,
    });
    assert.equal(originalDelete.statusCode, 400);

    // 标注文件改绑主媒体时偏好与媒体外键同事务清理，旧音轨不能跨视频残留。
    await jsonRequest(app, adminToken, {
      method: "PATCH",
      url: `/api/media-files/${primaryVideoId}/audio-tracks/${uploadedTrack.id}`,
      payload: { enabled: true },
    });
    await jsonRequest(app, adminToken, {
      method: "PUT",
      url: `/api/annotation-files/${annotationFileId}/audio-preference`,
      payload: { defaultAudioTrackId: uploadedTrack.id },
    });
    const rebound = await jsonRequest(app, adminToken, {
      method: "PATCH",
      url: `/api/annotation-files/${annotationFileId}/media`,
      payload: { mediaResourceId: secondVideoId },
    });
    assert.equal(rebound.statusCode, 200, rebound.body);
    assert.equal(
      await prisma.annotationAudioPreference.count({ where: { annotationFileId } }),
      0,
    );

    // 复制媒体只创建副本自己的原声音轨，不复制源音轨关联或权限。
    const copied = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/resources/${primaryVideoId}/copy`,
      payload: { parentId: projectId },
    });
    assert.equal(copied.statusCode, 200, copied.body);
    const copiedMediaId = String(dataOf(copied.json()).id);
    const copiedTracks = await prisma.mediaAudioTrack.findMany({
      where: { primaryMediaResourceId: copiedMediaId },
    });
    assert.equal(copiedTracks.length, 1);
    assert.equal(copiedTracks[0]?.kind, "original");

    // 只读用户可查看音轨和偏好，但不能修改共享默认值；write 也不能替代源音频的 download 权限。
    // 上方播放会话已创建项目级只读授权；这里继续验证管理 API，不重复制造 ACL 测试夹具。
    const studentList = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
    });
    assert.equal(studentList.statusCode, 200, studentList.body);
    const studentPreferenceDenied = await jsonRequest(app, studentToken, {
      method: "PUT",
      url: `/api/annotation-files/${annotationFileId}/audio-preference`,
      payload: { defaultAudioTrackId: secondVideoOriginal.id },
    });
    assert.equal(studentPreferenceDenied.statusCode, 403);
    await prisma.resourcePermission.update({
      where: { resourceId_userId: { resourceId: projectId, userId: student.id } },
      data: { capabilities: ["read", "write"] },
    });
    const studentDenied = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
      payload: {
        source: { type: "media_resource", mediaResourceId: vodAudioId },
        name: "学生音轨",
        kind: "custom",
      },
    });
    assert.equal(studentDenied.statusCode, 403);
    await prisma.resourcePermission.update({
      where: { resourceId_userId: { resourceId: projectId, userId: student.id } },
      data: { capabilities: ["read", "write", "download"] },
    });
    const studentAllowed = await jsonRequest(app, studentToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
      payload: {
        source: { type: "media_resource", mediaResourceId: vodAudioId },
        name: "学生音轨",
        kind: "custom",
      },
    });
    assert.equal(studentAllowed.statusCode, 200, studentAllowed.body);

    const actions = await prisma.auditLog.findMany({
      where: {
        action: {
          in: [
            "media_audio_track_create",
            "media_audio_track_update",
            "media_audio_track_delete",
            "media_audio_track_reorder",
            "annotation_audio_preference_update",
          ],
        },
      },
    });
    assert.ok(actions.length >= 5);
    for (const entry of actions) {
      const serialized = JSON.stringify(entry.detail);
      assert.doesNotMatch(serialized, /playauth|accesskey|https?:\/\//iu);
    }
  } finally {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

async function login(app: FastifyInstance, accountName: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { accountName, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  return dataOf(response.json()) as { accessToken: string };
}

async function createVodMedia(
  app: FastifyInstance,
  token: string,
  parentId: string,
  name: string,
  videoId: string,
) {
  const response = await jsonRequest(app, token, {
    method: "POST",
    url: "/api/media-files/aliyun-vod",
    payload: { parentId, name, videoId },
  });
  assert.equal(response.statusCode, 200, response.body);
  return String(dataOf(response.json()).id);
}

async function uploadWav(
  app: FastifyInstance,
  token: string,
  parentId: string,
  name: string,
) {
  const boundary = "----xiqu-audio-track-boundary";
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      "Content-Type: audio/wav\r\n\r\n",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const response = await app.inject({
    method: "POST",
    url: `/api/media-files/upload?${new URLSearchParams({ parentId, name })}`,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([prefix, minimalWav(), suffix]),
  });
  assert.equal(response.statusCode, 200, response.body);
  return String(dataOf(response.json()).id);
}

function minimalWav() {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

function jsonRequest(
  app: FastifyInstance,
  token: string,
  options: InjectOptions,
) {
  return app.inject({
    ...options,
    headers: {
      ...options.headers,
      authorization: `Bearer ${token}`,
    },
  });
}

function dataOf(value: unknown): JsonObject {
  const envelope = recordOf(value);
  assert.ok("data" in envelope);
  return recordOf(envelope.data);
}

function findOptionAvailability(
  response: { statusCode: number; body: string; json: () => unknown },
  trackId: unknown,
) {
  assert.equal(response.statusCode, 200, response.body);
  const option = (dataOf(response.json()).tracks as JsonObject[]).find(
    (entry) => recordOf(entry.track).id === trackId,
  );
  assert.ok(option, `缺少音轨选项：${String(trackId)}`);
  return option.availability;
}

function recordOf(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}
