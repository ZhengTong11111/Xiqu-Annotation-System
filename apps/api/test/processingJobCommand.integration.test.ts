import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PlatformUser } from "@xiqu/shared";
import { MediaAnalysisJobService } from "../src/mediaAnalysisJobService.js";
import { ProcessingJobCommandService } from "../src/processingJobCommandService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("个人取消、管理员强制取消与重试遵守共享执行和幂等边界", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createCommandFixture(prisma);
    const access = new ResourceAccessService(prisma);
    const analysis = new MediaAnalysisJobService(prisma, access);
    const commands = new ProcessingJobCommandService(prisma, access, analysis);
    await analysis.createAnalysis(fixture.owner, fixture.annotationFileId, {
      audioTrackId: fixture.audioTrackId,
      clientRequestId: randomUUID(),
    });
    await analysis.createAnalysis(fixture.collaborator, fixture.annotationFileId, {
      audioTrackId: fixture.audioTrackId,
      clientRequestId: randomUUID(),
    });
    const firstJob = await prisma.processingJob.findFirstOrThrow();
    const ownerRequest = await prisma.processingJobRequest.findFirstOrThrow({
      where: { jobId: firstJob.id, requesterUserId: fixture.owner.id },
    });
    const collaboratorRequest = await prisma.processingJobRequest.findFirstOrThrow({
      where: { jobId: firstJob.id, requesterUserId: fixture.collaborator.id },
    });

    const ownerCancelId = randomUUID();
    const ownerCancelled = await commands.cancelRequest(fixture.owner, ownerRequest.id, {
      clientCommandId: ownerCancelId,
      reason: "不再需要这一份分析",
    });
    assert.equal(ownerCancelled.outcome, "request_cancelled_execution_continues");
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: firstJob.id } })).status, "queued");
    assert.equal(
      (await commands.cancelRequest(fixture.owner, ownerRequest.id, {
        clientCommandId: ownerCancelId,
        reason: "不再需要这一份分析",
      })).commandId,
      ownerCancelled.commandId,
    );
    await assert.rejects(
      () => commands.cancelRequest(fixture.owner, ownerRequest.id, {
        clientCommandId: ownerCancelId,
        reason: "改写原因",
      }),
      hasConflictCode("idempotency_conflict"),
    );

    const lastCancelled = await commands.cancelRequest(
      fixture.collaborator,
      collaboratorRequest.id,
      { clientCommandId: randomUUID() },
    );
    assert.equal(lastCancelled.outcome, "execution_cancelled");
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: firstJob.id } })).status, "cancelled");
    assert.equal((await prisma.mediaAnalysisRun.findUniqueOrThrow({ where: { id: firstJob.analysisRunId! } })).status, "cancelled");

    const retried = await commands.retryRequest(fixture.owner, ownerRequest.id, {
      clientCommandId: randomUUID(),
    });
    assert.equal(retried.outcome, "retry_scheduled");
    assert.notEqual(retried.resultJobId, firstJob.id);
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: firstJob.id } })).status, "cancelled");
    assert.equal(await prisma.processingJob.count(), 2);

    const secondJob = await prisma.processingJob.findUniqueOrThrow({
      where: { id: retried.resultJobId! },
    });
    const secondOwnerRequest = await prisma.processingJobRequest.findFirstOrThrow({
      where: { jobId: secondJob.id, requesterUserId: fixture.owner.id },
    });
    await assert.rejects(
      () => commands.forceCancel(fixture.collaborator, secondJob.id, {
        clientCommandId: randomUUID(),
      }),
      (error: unknown) => Boolean(
        error && typeof error === "object" && "statusCode" in error && error.statusCode === 403,
      ),
    );
    const forceCancelled = await commands.forceCancel(fixture.administrator, secondJob.id, {
      clientCommandId: randomUUID(),
      reason: "管理员停止重复任务",
    });
    assert.equal(forceCancelled.outcome, "execution_cancelled");
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: secondJob.id } })).status, "cancelled");
    assert.ok((await prisma.processingJobRequest.findUniqueOrThrow({
      where: { id: secondOwnerRequest.id },
    })).cancelledAt);

    const retryCommandId = randomUUID();
    const retryAfterForce = await commands.retryRequest(fixture.owner, secondOwnerRequest.id, {
      clientCommandId: retryCommandId,
    });
    const replayedRetry = await commands.retryRequest(fixture.owner, secondOwnerRequest.id, {
      clientCommandId: retryCommandId,
    });
    assert.equal(replayedRetry.commandId, retryAfterForce.commandId);
    assert.equal(replayedRetry.resultJobId, retryAfterForce.resultJobId);
    assert.equal(await prisma.processingJob.count(), 3, "重试响应重放不能创建第二个执行");

    const thirdJob = await prisma.processingJob.findUniqueOrThrow({
      where: { id: retryAfterForce.resultJobId! },
    });
    const thirdRequest = await prisma.processingJobRequest.findFirstOrThrow({
      where: { jobId: thirdJob.id, requesterUserId: fixture.owner.id },
    });
    await prisma.$transaction([
      prisma.processingJob.update({
        where: { id: thirdJob.id },
        data: {
          status: "running",
          claimedBy: "test-worker",
          claimedAt: new Date(),
          heartbeatAt: new Date(),
        },
      }),
      prisma.mediaAnalysisRun.update({
        where: { id: thirdJob.analysisRunId! },
        data: { status: "running" },
      }),
    ]);
    const runningCancellation = await commands.cancelRequest(fixture.owner, thirdRequest.id, {
      clientCommandId: randomUUID(),
    });
    assert.equal(runningCancellation.outcome, "execution_cancelling");
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: thirdJob.id } })).status, "cancelling");
    assert.equal((await prisma.mediaAnalysisRun.findUniqueOrThrow({ where: { id: thirdJob.analysisRunId! } })).status, "cancelling");

    await prisma.$transaction([
      prisma.processingJob.update({
        where: { id: thirdJob.id },
        data: {
          status: "cancelled",
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          finishedAt: new Date(),
        },
      }),
      prisma.mediaAnalysisRun.update({
        where: { id: thirdJob.analysisRunId! },
        data: { status: "cancelled", completedAt: new Date() },
      }),
    ]);

    // 新需求附加与最后需求取消共用 canonical 锁；无论调度顺序，最终只能有一个活动执行且协作者需求不能丢。
    await analysis.createAnalysis(fixture.owner, fixture.annotationFileId, {
      audioTrackId: fixture.audioTrackId,
      clientRequestId: randomUUID(),
    });
    const raceJob = await prisma.processingJob.findFirstOrThrow({
      where: { status: "queued" },
      orderBy: { createdAt: "desc" },
    });
    const raceOwnerRequest = await prisma.processingJobRequest.findFirstOrThrow({
      where: { jobId: raceJob.id, requesterUserId: fixture.owner.id },
    });
    await Promise.all([
      commands.cancelRequest(fixture.owner, raceOwnerRequest.id, {
        clientCommandId: randomUUID(),
      }),
      analysis.createAnalysis(fixture.collaborator, fixture.annotationFileId, {
        audioTrackId: fixture.audioTrackId,
        clientRequestId: randomUUID(),
      }),
    ]);
    const activeJobs = await prisma.processingJob.findMany({
      where: {
        deduplicationKey: raceJob.deduplicationKey,
        status: { in: ["queued", "running", "cancelling"] },
      },
      include: { requests: { where: { cancelledAt: null } } },
    });
    assert.equal(activeJobs.length, 1);
    assert.ok(activeJobs[0]?.requests.some(({ requesterUserId }) =>
      requesterUserId === fixture.collaborator.id));
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

async function createCommandFixture(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
) {
  const ownerRow = await prisma.user.create({
    data: {
      accountName: "command-owner",
      displayName: "任务发起人",
      passwordHash: "unused",
    },
  });
  const collaboratorRow = await prisma.user.create({
    data: {
      accountName: "command-collaborator",
      displayName: "任务协作者",
      passwordHash: "unused",
    },
  });
  const administratorRow = await prisma.user.create({
    data: {
      accountName: "command-admin",
      displayName: "任务管理员",
      passwordHash: "unused",
      roles: { create: { role: "admin" } },
    },
  });
  const media = await prisma.resourceEntry.create({
    data: {
      type: "media_file",
      name: "命令测试 VOD",
      ownerUserId: ownerRow.id,
      mediaFile: {
        create: {
          sourceType: "aliyun_vod",
          mediaKind: "video",
          duration: 120,
          aliyunVodVideoId: "00000000000000000000000000000002",
          aliyunVodRegion: "cn-beijing",
        },
      },
    },
  });
  const annotation = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: "任务命令测试.json",
      ownerUserId: ownerRow.id,
      annotationFile: {
        create: {
          payload: {},
          mediaResourceId: media.id,
          lastEditedBy: ownerRow.id,
        },
      },
    },
  });
  const audioTrack = await prisma.mediaAudioTrack.create({
    data: {
      primaryMediaResourceId: media.id,
      name: "原声",
      kind: "original",
      sortOrder: 0,
      createdBy: ownerRow.id,
    },
  });
  await prisma.resourcePermission.createMany({
    data: [
      {
        resourceId: annotation.id,
        userId: collaboratorRow.id,
        capabilities: ["read", "write"],
        createdBy: ownerRow.id,
      },
      {
        resourceId: media.id,
        userId: collaboratorRow.id,
        capabilities: ["read", "download"],
        createdBy: ownerRow.id,
      },
    ],
  });
  return {
    owner: toApiUser(ownerRow),
    collaborator: toApiUser(collaboratorRow),
    administrator: toApiUser(administratorRow, ["admin"]),
    annotationFileId: annotation.id,
    audioTrackId: audioTrack.id,
  };
}

function toApiUser(
  user: { id: string; accountName: string; displayName: string },
  roles: PlatformUser["roles"] = [],
): PlatformUser {
  return {
    id: user.id,
    accountName: user.accountName,
    displayName: user.displayName,
    roles,
  };
}

function hasConflictCode(code: string) {
  return (error: unknown) => Boolean(
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    error.statusCode === 409 &&
    "details" in error &&
    error.details &&
    typeof error.details === "object" &&
    "code" in error.details &&
    error.details.code === code,
  );
}
