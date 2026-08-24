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
    createPlaybackCredential: async (videoId) => ({
      videoId,
      status: "Normal",
      playAuth: "integration-only-play-auth",
      expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    }),
    createAnalysisAudioStream: async () => ({
      url: "https://example.test/audio.mp3?temporary=1",
      expiresAt: new Date("2030-01-01T00:15:00.000Z"),
      format: "mp3",
      duration: 120,
      bitrate: 128,
    }),
  },
};

test("媒体音轨 API 管理关系、默认偏好、权限和媒体生命周期", async () => {
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
        audioMediaResourceId: uploadedAudioId,
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
        audioMediaResourceId: vodAudioId,
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
        audioMediaResourceId: uploadedAudioId,
        name: "重复",
        kind: "custom",
      },
    });
    assert.equal(duplicate.statusCode, 409);
    const invalidVideoSource = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/media-files/${primaryVideoId}/audio-tracks`,
      payload: {
        audioMediaResourceId: secondVideoId,
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
    await prisma.resourcePermission.create({
      data: {
        resourceId: projectId,
        userId: student.id,
        capabilities: ["read"],
        inheritToChildren: true,
        createdBy: admin.id,
      },
    });
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
        audioMediaResourceId: vodAudioId,
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
        audioMediaResourceId: vodAudioId,
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

function recordOf(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}
