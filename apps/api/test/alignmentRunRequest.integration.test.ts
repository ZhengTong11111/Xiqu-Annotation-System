import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PlatformUser } from "@xiqu/shared";
import { AlignmentRunService } from "../src/alignmentRunService.js";
import { MediaAnalysisJobService } from "../src/mediaAnalysisJobService.js";
import { ProcessingJobCommandService } from "../src/processingJobCommandService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("执行器关闭时拒绝创建且不留下 run、job 或需求", async () => {
  const connections = createTestPrisma();
  await truncateTestDatabase(connections.prisma);
  try {
    const fixture = await createFixture(connections.prisma);
    const service = createService(connections, false);
    await assert.rejects(
      service.create(fixture.owner, fixture.annotationFileId, {
        clientRequestId: randomUUID(), modelPreset: "kunqu_character_v1",
      }),
      hasHttpError(503, "analysis_tool_unavailable"),
    );
    assert.equal(await connections.prisma.alignmentRun.count(), 0);
    assert.equal(await connections.prisma.processingJob.count(), 0);
    assert.equal(await connections.prisma.processingJobRequest.count(), 0);
  } finally {
    await closeConnections(connections);
  }
});

test("相同输入共享 canonical 执行，但账号需求和幂等别名保持独立", async () => {
  const connections = createTestPrisma();
  await truncateTestDatabase(connections.prisma);
  try {
    const fixture = await createFixture(connections.prisma);
    const service = createService(connections, true);
    const ownerRequestId = randomUUID();
    const first = await service.create(fixture.owner, fixture.annotationFileId, {
      clientRequestId: ownerRequestId, modelPreset: "kunqu_character_v1",
    });
    const replayed = await service.create(fixture.owner, fixture.annotationFileId, {
      clientRequestId: ownerRequestId, modelPreset: "kunqu_character_v1",
    });
    assert.equal(replayed.id, first.id);
    await service.create(fixture.owner, fixture.annotationFileId, {
      clientRequestId: randomUUID(), modelPreset: "kunqu_character_v1",
    });
    await service.create(fixture.collaborator, fixture.annotationFileId, {
      clientRequestId: randomUUID(), modelPreset: "kunqu_character_v1",
    });
    assert.equal(await connections.prisma.alignmentRun.count(), 1);
    assert.equal(await connections.prisma.processingJob.count(), 1);
    assert.equal(await connections.prisma.processingJobRequest.count(), 2);
    assert.equal(await connections.prisma.processingJobRequestKey.count(), 3);

    const page = await service.list(fixture.owner, fixture.annotationFileId, { limit: 1 });
    assert.equal(page.items[0]?.matchesCurrentInput, true);
    assert.equal(page.items[0]?.artifactAvailable, false);
    assert.equal(page.items[0]?.inputSentenceCount, 1);
    assert.equal(page.items[0]?.inputCharacterCount, 2);
    const detail = await service.detail(fixture.owner, fixture.annotationFileId, first.id);
    assert.equal(detail.requestActive, true);
    assert.equal(detail.audioTrackId, fixture.audioTrackId);

    const access = new ResourceAccessService(connections.prisma);
    const commands = new ProcessingJobCommandService(
      connections.prisma,
      access,
      new MediaAnalysisJobService(connections.prisma, access),
    );
    const requests = await connections.prisma.processingJobRequest.findMany({
      orderBy: { requestedAt: "asc" },
    });
    const ownerRequest = requests.find((request) => request.requesterUserId === fixture.owner.id)!;
    const collaboratorRequest = requests.find((request) => request.requesterUserId === fixture.collaborator.id)!;
    const ownerCancellation = await commands.cancelRequest(fixture.owner, ownerRequest.id, {
      clientCommandId: randomUUID(),
    });
    assert.equal(ownerCancellation.outcome, "request_cancelled_execution_continues");
    const finalCancellation = await commands.cancelRequest(fixture.collaborator, collaboratorRequest.id, {
      clientCommandId: randomUUID(),
    });
    assert.equal(finalCancellation.outcome, "execution_cancelled");
    assert.equal((await connections.prisma.processingJob.findFirstOrThrow()).status, "cancelled");
    assert.equal((await connections.prisma.alignmentRun.findFirstOrThrow()).status, "cancelled");
    await assert.rejects(
      service.list(fixture.outsider, fixture.annotationFileId, {}),
      hasHttpError(403, "forbidden"),
    );
  } finally {
    await closeConnections(connections);
  }
});

test("clientRequestId 在输入漂移后不能改绑，撤销来源下载权限也会 fail closed", async () => {
  const connections = createTestPrisma();
  await truncateTestDatabase(connections.prisma);
  try {
    const fixture = await createFixture(connections.prisma);
    const service = createService(connections, true);
    const requestId = randomUUID();
    await service.create(fixture.owner, fixture.annotationFileId, {
      clientRequestId: requestId, modelPreset: "kunqu_character_v1",
    });
    const changed = createProjectPayload();
    changed.subtitleLines[0]!.text = "寻梦惊";
    changed.characterAnnotations.push({
      id: "char-3", lineId: "line-1", char: "惊", startTime: 2, endTime: 3,
    });
    await connections.prisma.annotationFile.update({
      where: { resourceId: fixture.annotationFileId },
      data: { revision: { increment: 1 }, payload: changed },
    });
    await assert.rejects(
      service.create(fixture.owner, fixture.annotationFileId, {
        clientRequestId: requestId, modelPreset: "kunqu_character_v1",
      }),
      hasConflictCode("idempotency_conflict"),
    );
    const second = await service.create(fixture.owner, fixture.annotationFileId, {
      clientRequestId: randomUUID(), modelPreset: "kunqu_character_v1",
    });
    const firstPage = await service.list(fixture.owner, fixture.annotationFileId, { limit: 1 });
    assert.equal(firstPage.items[0]?.id, second.id);
    assert.ok(firstPage.nextCursor);
    const secondPage = await service.list(fixture.owner, fixture.annotationFileId, {
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    });
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.nextCursor, null);
    assert.equal(secondPage.items[0]?.matchesCurrentInput, false);

    await connections.prisma.resourcePermission.update({
      where: { resourceId_userId: { resourceId: fixture.mediaResourceId, userId: fixture.collaborator.id } },
      data: { capabilities: ["read"] },
    });
    await assert.rejects(
      service.create(fixture.collaborator, fixture.annotationFileId, {
        clientRequestId: randomUUID(), modelPreset: "kunqu_character_v1",
      }),
      hasHttpError(403, "analysis_audio_forbidden"),
    );
  } finally {
    await closeConnections(connections);
  }
});

function createService(connections: ReturnType<typeof createTestPrisma>, enabled: boolean) {
  return new AlignmentRunService(
    connections.prisma,
    new ResourceAccessService(connections.prisma),
    enabled,
  );
}

async function createFixture(prisma: ReturnType<typeof createTestPrisma>["prisma"]) {
  const ownerRow = await prisma.user.create({ data: {
    accountName: "alignment-owner", displayName: "对齐发起人", passwordHash: "unused",
  } });
  const collaboratorRow = await prisma.user.create({ data: {
    accountName: "alignment-collaborator", displayName: "对齐协作者", passwordHash: "unused",
  } });
  const outsiderRow = await prisma.user.create({ data: {
    accountName: "alignment-outsider", displayName: "无权账号", passwordHash: "unused",
  } });
  const media = await prisma.resourceEntry.create({ data: {
    type: "media_file",
    name: "寻梦.mp3",
    ownerUserId: ownerRow.id,
    mediaFile: { create: {
      sourceType: "uploaded",
      mediaKind: "audio",
      mimeType: "audio/mpeg",
      size: 1_024n,
      file: { create: {
        name: "寻梦.mp3",
        mimeType: "audio/mpeg",
        size: 1_024n,
        checksum: "a".repeat(64),
        storageKey: `alignment-request/${randomUUID()}.mp3`,
        ownerUserId: ownerRow.id,
      } },
    } },
  } });
  const annotation = await prisma.resourceEntry.create({ data: {
    type: "annotation_file",
    name: "寻梦标注.json",
    ownerUserId: ownerRow.id,
    annotationFile: { create: {
      payload: createProjectPayload(),
      mediaResourceId: media.id,
      lastEditedBy: ownerRow.id,
    } },
  } });
  const track = await prisma.mediaAudioTrack.create({ data: {
    primaryMediaResourceId: media.id,
    name: "原声",
    kind: "original",
    sortOrder: 0,
    createdBy: ownerRow.id,
  } });
  await prisma.resourcePermission.createMany({ data: [
    { resourceId: annotation.id, userId: collaboratorRow.id, capabilities: ["read", "write"], createdBy: ownerRow.id },
    { resourceId: media.id, userId: collaboratorRow.id, capabilities: ["read", "download"], createdBy: ownerRow.id },
  ] });
  return {
    owner: toApiUser(ownerRow),
    collaborator: toApiUser(collaboratorRow),
    outsider: toApiUser(outsiderRow),
    annotationFileId: annotation.id,
    mediaResourceId: media.id,
    audioTrackId: track.id,
  };
}

function createProjectPayload() {
  return {
    video: { url: "", name: null, source: "url" as const },
    sentenceAnnotationConfig: { roleOptions: ["闺门旦"] },
    subtitleLines: [
      { id: "line-1", text: "寻梦", startTime: 1, endTime: 3, deliveryMode: "sung" as const, roleTypes: ["闺门旦"] },
    ],
    characterAnnotations: [
      { id: "char-1", lineId: "line-1", char: "寻", startTime: 1, endTime: 2 },
      { id: "char-2", lineId: "line-1", char: "梦", startTime: 2, endTime: 3 },
    ],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [],
    customTracks: [],
    activeTrackOrder: [],
  };
}

function toApiUser(user: { id: string; accountName: string; displayName: string }): PlatformUser {
  return { id: user.id, accountName: user.accountName, displayName: user.displayName, roles: [] };
}

function hasHttpError(statusCode: number, code: string) {
  return (error: unknown) => Boolean(
    error && typeof error === "object" &&
    "statusCode" in error && error.statusCode === statusCode &&
    "code" in error && error.code === code,
  );
}

function hasConflictCode(code: string) {
  return (error: unknown) => Boolean(
    hasHttpError(409, "conflict")(error) &&
    "details" in (error as object) &&
    (error as { details?: { code?: string } }).details?.code === code,
  );
}

async function closeConnections(connections: ReturnType<typeof createTestPrisma>) {
  await connections.prisma.$disconnect();
  await connections.pool.end();
  await connections.maintenancePool.end();
  await connections.collaborationPool.end();
}
