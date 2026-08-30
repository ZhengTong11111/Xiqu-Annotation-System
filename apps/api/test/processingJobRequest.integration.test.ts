import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PlatformUser } from "@xiqu/shared";
import { MediaAnalysisJobService } from "../src/mediaAnalysisJobService.js";
import { ProcessingJobQueryService } from "../src/processingJobQueryService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("媒体分析请求在账号、标签页和共享执行之间保持幂等", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnalysisRequestFixture(prisma);
    const service = new MediaAnalysisJobService(prisma, new ResourceAccessService(prisma));
    const ownerRequestId = randomUUID();

    const first = await service.createAnalysis(fixture.owner, fixture.annotationFileId, {
      audioTrackId: fixture.audioTrackId,
      clientRequestId: ownerRequestId,
    });
    const replayed = await service.createAnalysis(fixture.owner, fixture.annotationFileId, {
      audioTrackId: fixture.audioTrackId,
      clientRequestId: ownerRequestId,
    });
    assert.equal(replayed.id, first.id);
    assert.equal(await prisma.processingJob.count(), 1);
    assert.equal(await prisma.processingJobRequest.count(), 1);
    assert.equal(await prisma.processingJobRequestKey.count(), 1);

    // 同一账号另一个标签页复用需求，但必须保存新的幂等别名，后续重试仍能追到原执行。
    const secondTabId = randomUUID();
    await service.createAnalysis(fixture.owner, fixture.annotationFileId, {
      audioTrackId: fixture.audioTrackId,
      clientRequestId: secondTabId,
    });
    assert.equal(await prisma.processingJob.count(), 1);
    assert.equal(await prisma.processingJobRequest.count(), 1);
    assert.equal(await prisma.processingJobRequestKey.count(), 2);

    // 另一个有权账号表达独立需求，但 canonical 计算仍只有一份。
    await service.createAnalysis(fixture.collaborator, fixture.annotationFileId, {
      audioTrackId: fixture.audioTrackId,
      clientRequestId: randomUUID(),
    });
    assert.equal(await prisma.processingJob.count(), 1);
    assert.equal(await prisma.processingJobRequest.count(), 2);
    assert.equal(await prisma.processingJobRequestKey.count(), 3);

    const job = await prisma.processingJob.findFirstOrThrow();
    const queries = new ProcessingJobQueryService(prisma, new ResourceAccessService(prisma));
    const ownerMine = await queries.list(fixture.owner, { scope: "mine" });
    assert.equal(ownerMine.items.length, 1);
    assert.equal(ownerMine.items[0]?.contextResource?.id, fixture.annotationFileId);
    const ownerRelatedFirst = await queries.list(fixture.owner, { scope: "related", limit: 1 });
    assert.equal(ownerRelatedFirst.items.length, 1);
    assert.ok(ownerRelatedFirst.nextCursor);
    const ownerRelatedSecond = await queries.list(fixture.owner, {
      scope: "related",
      limit: 1,
      cursor: ownerRelatedFirst.nextCursor ?? undefined,
    });
    assert.equal(ownerRelatedSecond.items.length, 1);
    assert.notEqual(
      ownerRelatedSecond.items[0]?.requestId,
      ownerRelatedFirst.items[0]?.requestId,
    );
    assert.equal((await queries.list(fixture.viewer, { scope: "related" })).items.length, 0);
    await assert.rejects(
      () => queries.detail(fixture.viewer, job.id),
      (error: unknown) => Boolean(
        error && typeof error === "object" && "statusCode" in error && error.statusCode === 404
      ),
    );
    await assert.rejects(
      () => queries.list(fixture.owner, { scope: "all" }),
      (error: unknown) => Boolean(
        error && typeof error === "object" && "statusCode" in error && error.statusCode === 403
      ),
    );
    assert.equal((await queries.list(fixture.administrator, { scope: "all" })).items.length, 2);
    assert.equal((await queries.list(fixture.administrator, {
      scope: "all",
      query: "共享分析",
    })).items.length, 2);
    assert.equal((await queries.list(fixture.administrator, {
      scope: "all",
      query: "processing-collaborator",
    })).items.length, 1);
    assert.equal((await queries.list(fixture.administrator, {
      scope: "all",
      query: job.id.slice(0, 12),
    })).items.length, 2);
    assert.equal((await queries.list(fixture.administrator, {
      scope: "all",
      query: "不存在的后台任务",
    })).items.length, 0);
    assert.equal((await queries.summary(fixture.owner, "mine")).visibleRequestCount, 1);
    assert.equal((await queries.summary(fixture.administrator, "all")).visibleRequestCount, 2);

    await prisma.resourcePermission.delete({
      where: {
        resourceId_userId: {
          resourceId: fixture.annotationFileId,
          userId: fixture.collaborator.id,
        },
      },
    });
    const revokedMine = await queries.list(fixture.collaborator, { scope: "mine" });
    assert.equal(revokedMine.items.length, 1);
    assert.equal(revokedMine.items[0]?.contextResource, null);

    await assert.rejects(
      () => service.createAnalysis(fixture.owner, fixture.annotationFileId, {
        audioTrackId: fixture.audioTrackId,
        clientRequestId: ownerRequestId,
        force: true,
      }),
      (error: unknown) => Boolean(
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        error.statusCode === 409,
      ),
    );

    await assert.rejects(
      () => prisma.processingJob.create({
        data: {
          type: "media_analysis",
          resourceId: fixture.annotationFileId,
          createdBy: fixture.owner.id,
          analysisRunId: first.id,
          deduplicationKey: job.deduplicationKey,
        },
      }),
      (error: unknown) => Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002",
      ),
    );

    // run/job 终态若被外部错误写成不一致，创建接口必须保留现场并稳定失败，不能返回无法追踪的伪成功。
    await prisma.mediaAnalysisRun.update({
      where: { id: first.id },
      data: { status: "succeeded", progress: 1 },
    });
    await assert.rejects(
      () => service.createAnalysis(fixture.owner, fixture.annotationFileId, {
        audioTrackId: fixture.audioTrackId,
        clientRequestId: randomUUID(),
      }),
      (error: unknown) => Boolean(
        error &&
        typeof error === "object" &&
        "details" in error &&
        error.details &&
        typeof error.details === "object" &&
        "code" in error.details &&
        error.details.code === "processing_job_completion_missing",
      ),
    );

    // 正常完成的共享任务仍可接收新的幂等别名，不会重复创建执行或业务需求。
    await prisma.processingJob.update({
      where: { id: job.id },
      data: { status: "succeeded", progress: 1, finishedAt: new Date() },
    });
    await service.createAnalysis(fixture.owner, fixture.annotationFileId, {
      audioTrackId: fixture.audioTrackId,
      clientRequestId: randomUUID(),
    });
    assert.equal(await prisma.processingJob.count(), 1);
    assert.equal(await prisma.processingJobRequest.count(), 2);
    assert.equal(await prisma.processingJobRequestKey.count(), 4);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

test("有界并发需求汇聚为一个共享执行并稳定保存全部幂等别名", async () => {
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnalysisRequestFixture(prisma);
    const service = new MediaAnalysisJobService(prisma, new ResourceAccessService(prisma));
    const requests = Array.from({ length: 24 }, (_, index) => ({
      user: index % 2 === 0 ? fixture.owner : fixture.collaborator,
      clientRequestId: randomUUID(),
    }));

    // 不同账号和标签页会并发撞到同一 canonical 执行；数据库锁必须收敛 job，同时保留每个请求别名。
    const firstResults = await Promise.all(requests.map(({ user, clientRequestId }) =>
      service.createAnalysis(user, fixture.annotationFileId, {
        audioTrackId: fixture.audioTrackId,
        clientRequestId,
      })));
    assert.equal(new Set(firstResults.map(({ id }) => id)).size, 1);
    assert.equal(await prisma.processingJob.count(), 1);
    assert.equal(await prisma.processingJobRequest.count(), 2);
    assert.equal(await prisma.processingJobRequestKey.count(), requests.length);

    // 网络模糊结果后整批精确重放，不能增加 job、业务需求或幂等别名。
    const replayed = await Promise.all(requests.map(({ user, clientRequestId }) =>
      service.createAnalysis(user, fixture.annotationFileId, {
        audioTrackId: fixture.audioTrackId,
        clientRequestId,
      })));
    assert.equal(new Set(replayed.map(({ id }) => id)).size, 1);
    assert.equal(await prisma.processingJob.count(), 1);
    assert.equal(await prisma.processingJobRequest.count(), 2);
    assert.equal(await prisma.processingJobRequestKey.count(), requests.length);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
  }
});

async function createAnalysisRequestFixture(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
) {
  const ownerRow = await prisma.user.create({
    data: {
      accountName: "processing-owner",
      displayName: "任务发起人",
      passwordHash: "unused",
    },
  });
  const collaboratorRow = await prisma.user.create({
    data: {
      accountName: "processing-collaborator",
      displayName: "任务协作者",
      passwordHash: "unused",
    },
  });
  const viewerRow = await prisma.user.create({
    data: {
      accountName: "processing-viewer",
      displayName: "无权查看者",
      passwordHash: "unused",
    },
  });
  const administratorRow = await prisma.user.create({
    data: {
      accountName: "processing-admin",
      displayName: "任务管理员",
      passwordHash: "unused",
      roles: { create: { role: "admin" } },
    },
  });
  const media = await prisma.resourceEntry.create({
    data: {
      type: "media_file",
      name: "共享 VOD 媒体",
      ownerUserId: ownerRow.id,
      mediaFile: {
        create: {
          sourceType: "aliyun_vod",
          mediaKind: "video",
          duration: 120,
          aliyunVodVideoId: "00000000000000000000000000000001",
          aliyunVodRegion: "cn-beijing",
        },
      },
    },
  });
  const annotation = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: "共享分析标注.json",
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
    viewer: toApiUser(viewerRow),
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
