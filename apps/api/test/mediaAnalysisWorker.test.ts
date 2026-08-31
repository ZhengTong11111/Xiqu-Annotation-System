import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { AliyunVodGatewayError } from "../src/aliyunVodGateway.js";
import {
  createAliyunVodFfmpegInput,
  MediaAnalysisWorkerService,
} from "../src/mediaAnalysisWorkerService.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("worker 对 rendition 精确使用 JobId，普通 VOD 仍使用自动分析音频", async () => {
  const calls: string[] = [];
  const gateway = {
    inspectVideo: async () => { throw new Error("not used"); },
    createPlaybackCredential: async () => { throw new Error("not used"); },
    listAudioRenditions: async () => { throw new Error("not used"); },
    createAnalysisAudioStream: async (videoId: string) => {
      calls.push(`auto:${videoId}`);
      return {
        url: "https://vod.example.test/auto.mp3",
        expiresAt: new Date(Date.now() + 60_000),
        format: "mp3" as const,
        duration: 10,
        bitrate: 128_000,
      };
    },
    createAudioRenditionStream: async (videoId: string, jobId: string) => {
      calls.push(`rendition:${videoId}:${jobId}`);
      return {
        jobId,
        format: "mp3" as const,
        definition: "SQ",
        bitrate: 128_000,
        duration: 10,
        url: "https://vod.example.test/rendition.mp3",
        expiresAt: new Date(Date.now() + 60_000),
      };
    },
  };

  assert.deepEqual(
    await createAliyunVodFfmpegInput(gateway, "vod-1", null),
    { kind: "vod", url: "https://vod.example.test/auto.mp3" },
  );
  assert.deepEqual(
    await createAliyunVodFfmpegInput(gateway, "vod-1", "job-sq"),
    { kind: "vod", url: "https://vod.example.test/rendition.mp3" },
  );
  assert.deepEqual(calls, ["auto:vod-1", "rendition:vod-1:job-sq"]);
});

test("worker 拒绝供应商返回不同 JobId 的 rendition", async () => {
  const gateway = {
    inspectVideo: async () => { throw new Error("not used"); },
    createPlaybackCredential: async () => { throw new Error("not used"); },
    listAudioRenditions: async () => { throw new Error("not used"); },
    createAnalysisAudioStream: async () => { throw new Error("not used"); },
    createAudioRenditionStream: async () => ({
      jobId: "job-other",
      format: "mp3" as const,
      definition: "SQ",
      bitrate: 128_000,
      duration: 10,
      url: "https://vod.example.test/rendition.mp3",
      expiresAt: new Date(Date.now() + 60_000),
    }),
  };
  await assert.rejects(
    () => createAliyunVodFfmpegInput(gateway, "vod-1", "job-sq"),
    /analysis_source_invalid/u,
  );
});

test("媒体分析 worker 原子 claim、流式生成资产并可恢复陈旧任务", async (context) => {
  const ffmpegPath = process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg";
  if (spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status !== 0) {
    context.skip("测试环境没有 FFmpeg");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-analysis-worker-"));
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(root);
  try {
    const fixture = await createWorkerFixture(prisma, storage);
    let vodCalls = 0;
    const service = new MediaAnalysisWorkerService(
      prisma,
      storage,
      {
        region: "cn-shanghai",
        gateway: {
          inspectVideo: async () => { throw new Error("not used"); },
          createPlaybackCredential: async () => { throw new Error("not used"); },
          listAudioRenditions: async () => { throw new Error("not used"); },
          createAudioRenditionStream: async () => { throw new Error("not used"); },
          createAnalysisAudioStream: async () => {
            vodCalls += 1;
            throw new Error("上传音频不应访问 VOD");
          },
        },
      },
      ffmpegPath,
      { info: () => undefined, warn: () => undefined },
    );

    const claims = await Promise.all([
      service.claimNext("worker-a"),
      service.claimNext("worker-b"),
    ]);
    assert.equal(claims.filter(Boolean).length, 1, "同一 queued job 只能被一个 worker claim");
    await prisma.processingJob.update({
      where: { id: fixture.jobId },
      data: { status: "queued", claimedBy: null, claimedAt: null, heartbeatAt: null },
    });
    await prisma.mediaAnalysisRun.update({
      where: { id: fixture.runId },
      data: { status: "queued" },
    });

    const stopping = new AbortController();
    stopping.abort();
    assert.equal(await service.processNext("worker-stop", stopping.signal), true);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).status,
      "queued",
      "正常停机中止的任务应回到队列而不是变成业务失败",
    );
    assert.equal(
      (await prisma.mediaAnalysisRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status,
      "queued",
    );

    assert.equal(await service.processNext("worker-c"), true);
    const run = await prisma.mediaAnalysisRun.findUniqueOrThrow({
      where: { id: fixture.runId },
      include: { assets: true, jobs: true },
    });
    assert.equal(run.status, "succeeded");
    assert.equal(run.progress, 1);
    assert.equal(run.sampleRate, 16_000);
    assert.ok(run.duration && run.duration > 0.09);
    assert.equal(run.assets.length, 7);
    assert.equal(run.jobs[0]?.status, "succeeded");
    assert.equal(vodCalls, 0, "强制/已解析的 uploaded 音频必须完全绕过阿里云");
    assert.ok((await Promise.all(
      run.assets.map(({ storageKey }) => storage.objectExists(storageKey)),
    )).every(Boolean));

    const staleRun = await prisma.mediaAnalysisRun.create({
      data: {
        sourceMediaResourceId: fixture.mediaResourceId,
        sourceFingerprint: "stale-source",
        mediaFingerprint: "d".repeat(64),
        algorithmVersion: "xiqu-media-analysis-v1",
        configHash: "stale-config",
        config: {},
        status: "running",
        createdBy: fixture.userId,
      },
    });
    const staleJob = await prisma.processingJob.create({
      data: {
        type: "media_analysis",
        status: "running",
        resourceId: fixture.annotationFileId,
        createdBy: fixture.userId,
        analysisRunId: staleRun.id,
        deduplicationKey: `test:stale:${staleRun.id}`,
        claimedBy: "dead-worker",
        claimedAt: new Date(Date.now() - 10 * 60_000),
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await prisma.processingJobRequest.create({
      data: {
        jobId: staleJob.id,
        requesterUserId: fixture.userId,
        contextResourceId: fixture.annotationFileId,
      },
    });
    assert.equal(await service.recoverStaleJobs(), 1);
    assert.equal(
      (await prisma.mediaAnalysisRun.findUniqueOrThrow({ where: { id: staleRun.id } })).status,
      "queued",
    );
    await prisma.processingJob.updateMany({
      where: { analysisRunId: staleRun.id },
      data: { status: "failed", finishedAt: new Date() },
    });
    await prisma.mediaAnalysisRun.update({
      where: { id: staleRun.id },
      data: { status: "failed" },
    });

    // worker 在 cancelling 状态崩溃后，陈旧恢复必须清理资产并进入 cancelled，不能重新排队。
    const cancellingRun = await prisma.mediaAnalysisRun.create({
      data: {
        sourceMediaResourceId: fixture.mediaResourceId,
        sourceFingerprint: "cancelling-source",
        mediaFingerprint: "c".repeat(64),
        algorithmVersion: "xiqu-media-analysis-v1",
        configHash: "cancelling-config",
        config: {},
        status: "cancelling",
        createdBy: fixture.userId,
      },
    });
    const cancellingJob = await prisma.processingJob.create({
      data: {
        type: "media_analysis",
        status: "cancelling",
        resourceId: fixture.annotationFileId,
        createdBy: fixture.userId,
        analysisRunId: cancellingRun.id,
        deduplicationKey: `test:cancelling:${cancellingRun.id}`,
        claimedBy: "cancelled-worker",
        claimedAt: new Date(Date.now() - 10 * 60_000),
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        cancelRequestedAt: new Date(Date.now() - 10 * 60_000),
        cancelRequestedBy: fixture.userId,
        cancellationMode: "user_request",
      },
    });
    await prisma.processingJobRequest.create({
      data: {
        jobId: cancellingJob.id,
        requesterUserId: fixture.userId,
        contextResourceId: fixture.annotationFileId,
        cancelledAt: new Date(Date.now() - 10 * 60_000),
        cancelledBy: fixture.userId,
      },
    });
    const cancelledAssetKey = storage.createStorageKey("xqa");
    const cancelledAsset = await storage.putStagedObject(
      cancelledAssetKey,
      Readable.from([Buffer.from("partial-analysis")]),
      64,
    );
    await storage.promoteStagedObject(cancelledAsset);
    await prisma.mediaAnalysisAsset.create({
      data: {
        runId: cancellingRun.id,
        kind: "waveform",
        preset: "default",
        level: 0,
        tileIndex: 0,
        startTime: 0,
        endTime: 10,
        mimeType: "application/vnd.xiqu.waveform-tile",
        size: cancelledAsset.size,
        checksum: cancelledAsset.checksum,
        storageKey: cancelledAsset.finalStorageKey,
      },
    });
    assert.equal(await service.recoverStaleJobs(), 1);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: cancellingJob.id } })).status,
      "cancelled",
    );
    assert.equal(
      (await prisma.mediaAnalysisRun.findUniqueOrThrow({ where: { id: cancellingRun.id } })).status,
      "cancelled",
    );
    assert.equal(await prisma.mediaAnalysisAsset.count({ where: { runId: cancellingRun.id } }), 0);
    assert.equal(await storage.objectExists(cancelledAsset.finalStorageKey), false);

    // superseded run 是只读迁移事实；即使历史数据残留 running job，也不得恢复或再次领取。
    const supersededRun = await prisma.mediaAnalysisRun.create({
      data: {
        sourceMediaResourceId: fixture.mediaResourceId,
        sourceFingerprint: "superseded-source",
        mediaFingerprint: "b".repeat(64),
        algorithmVersion: "xiqu-media-analysis-v1",
        configHash: "superseded-config",
        config: {},
        status: "running",
        createdBy: fixture.userId,
        supersededByRunId: fixture.runId,
        supersededAt: new Date(),
        supersededBy: fixture.userId,
      },
    });
    const supersededJob = await prisma.processingJob.create({
      data: {
        type: "media_analysis",
        status: "running",
        resourceId: fixture.annotationFileId,
        createdBy: fixture.userId,
        analysisRunId: supersededRun.id,
        deduplicationKey: `test:superseded:${supersededRun.id}`,
        claimedBy: "retired-worker",
        claimedAt: new Date(Date.now() - 10 * 60_000),
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    assert.equal(await service.recoverStaleJobs(), 0);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: supersededJob.id } })).status,
      "running",
    );
    assert.equal(await service.claimNext("worker-after-migration"), null);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("媒体分析资产发布失败时立即清理暂存对象并稳定落为失败", async (context) => {
  const ffmpegPath = process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg";
  if (spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status !== 0) {
    context.skip("测试环境没有 FFmpeg");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-analysis-compensation-"));
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(root);
  try {
    const fixture = await createWorkerFixture(prisma, storage);
    const originalPromote = storage.promoteStagedObject.bind(storage);
    let rejectNextPromote = true;
    storage.promoteStagedObject = async (staged) => {
      if (rejectNextPromote) {
        rejectNextPromote = false;
        // 先让 final 真实形成，再模拟远端成功响应丢失或 staged 清理失败。
        await originalPromote(staged);
        throw new Error("synthetic ambiguous promote failure");
      }
      await originalPromote(staged);
    };
    const service = new MediaAnalysisWorkerService(
      prisma,
      storage,
      null,
      ffmpegPath,
      { info: () => undefined, warn: () => undefined },
    );

    assert.equal(await service.processNext("worker-compensation"), true);
    assert.equal(
      (await prisma.mediaAnalysisRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status,
      "failed",
    );
    assert.equal(await prisma.mediaAnalysisAsset.count({ where: { runId: fixture.runId } }), 0);
    assert.deepEqual(
      (await storage.listStoredObjects()).map(({ storageKey }) => storageKey),
      [fixture.sourceStorageKey],
      "promote 结果不确定时必须清理分析对象，同时保留权威源媒体",
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("长输入等待期间独立 heartbeat 保持 claim 活跃", async (context) => {
  const ffmpegPath = process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg";
  if (spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status !== 0) {
    context.skip("测试环境没有 FFmpeg");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-analysis-heartbeat-"));
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(root);
  try {
    const fixture = await createWorkerFixture(prisma, storage);
    const blockedInput = new PassThrough();
    (storage as unknown as { getObjectStream: () => Promise<Readable> }).getObjectStream =
      async () => blockedInput;
    const service = new MediaAnalysisWorkerService(
      prisma,
      storage,
      null,
      ffmpegPath,
      { info: () => undefined, warn: () => undefined },
      2,
      5,
    );
    const shutdown = new AbortController();
    const processing = service.processNext("worker-heartbeat", shutdown.signal);
    await waitForJobStatus(prisma, fixture.jobId, "running");
    const initial = await prisma.processingJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
      select: { heartbeatAt: true },
    });
    const advanced = await waitForHeartbeatAfter(
      prisma,
      fixture.jobId,
      initial.heartbeatAt!,
    );
    assert.ok(advanced > initial.heartbeatAt!, "没有瓦片产出时 heartbeat 也必须前进");
    shutdown.abort();
    assert.equal(await processing, true);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).status,
      "queued",
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("monitor 数据库短故障后仍能追赶业务取消", async (context) => {
  const ffmpegPath = process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg";
  if (spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status !== 0) {
    context.skip("测试环境没有 FFmpeg");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-analysis-monitor-retry-"));
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(root);
  try {
    const fixture = await createWorkerFixture(prisma, storage);
    const blockedInput = new PassThrough();
    (storage as unknown as { getObjectStream: () => Promise<Readable> }).getObjectStream =
      async () => blockedInput;
    const delegate = prisma.processingJob as unknown as {
      findUnique: (args: {
        select?: { cancelRequestedAt?: boolean };
        [key: string]: unknown;
      }) => Promise<unknown>;
    };
    const originalFindUnique = delegate.findUnique.bind(prisma.processingJob);
    let monitorFailureInjected = false;
    delegate.findUnique = async (args) => {
      if (args.select?.cancelRequestedAt && !monitorFailureInjected) {
        monitorFailureInjected = true;
        throw new Error("测试 monitor 数据库短故障");
      }
      return originalFindUnique(args);
    };
    const service = new MediaAnalysisWorkerService(
      prisma,
      storage,
      null,
      ffmpegPath,
      { info: () => undefined, warn: () => undefined },
      2,
      1_000,
    );
    const processing = service.processNext("worker-monitor-retry");
    await waitForJobStatus(prisma, fixture.jobId, "running");
    await waitUntil(() => monitorFailureInjected);
    const request = await prisma.processingJobRequest.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    const cancelledAt = new Date();
    await prisma.$transaction([
      prisma.processingJobRequest.update({
        where: { id: request.id },
        data: { cancelledAt, cancelledBy: fixture.userId },
      }),
      prisma.processingJob.update({
        where: { id: fixture.jobId },
        data: {
          status: "cancelling",
          cancelRequestedAt: cancelledAt,
          cancelRequestedBy: fixture.userId,
          cancellationMode: "user_request",
        },
      }),
      prisma.mediaAnalysisRun.update({
        where: { id: fixture.runId },
        data: { status: "cancelling" },
      }),
    ]);
    assert.equal(await processing, true);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).status,
      "cancelled",
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("claim 转移后旧 attempt 不能发布迟到资产或覆盖新状态", async (context) => {
  const ffmpegPath = process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg";
  if (spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status !== 0) {
    context.skip("测试环境没有 FFmpeg");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-analysis-claim-fence-"));
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(root);
  try {
    const fixture = await createWorkerFixture(prisma, storage);
    const blockedInput = new PassThrough();
    (storage as unknown as { getObjectStream: () => Promise<Readable> }).getObjectStream =
      async () => blockedInput;
    // 长 monitor 间隔让测试由 asset job-row fencing 拒绝迟到写入，而不是依赖轮询先发现 claim 变化。
    const service = new MediaAnalysisWorkerService(
      prisma,
      storage,
      null,
      ffmpegPath,
      { info: () => undefined, warn: () => undefined },
      60_000,
      60_000,
    );
    const processing = service.processNext("worker-old-attempt");
    await waitForJobStatus(prisma, fixture.jobId, "running");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await prisma.$transaction([
      prisma.processingJob.update({
        where: { id: fixture.jobId },
        data: {
          status: "queued",
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
        },
      }),
      prisma.mediaAnalysisRun.update({
        where: { id: fixture.runId },
        data: { status: "queued" },
      }),
    ]);
    // 同名 worker 重新 claim 也必须生成新 attempt；旧执行流随后只能观察到 fence 失效。
    const replacement = await service.claimNext("worker-old-attempt");
    assert.ok(replacement);
    assert.equal(replacement.attemptCount, 2);
    blockedInput.end(buildWav(8_000, 0.1, 220));
    assert.equal(await processing, true);
    assert.equal(await prisma.mediaAnalysisAsset.count({ where: { runId: fixture.runId } }), 0);
    const current = await prisma.processingJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    assert.equal(current.status, "running");
    assert.equal(current.claimedBy, "worker-old-attempt");
    assert.equal(current.attemptCount, 2);
    assert.equal((await prisma.mediaAnalysisRun.findUniqueOrThrow({
      where: { id: fixture.runId },
    })).status, "running");
    assert.deepEqual(
      (await storage.listStoredObjects()).map(({ storageKey }) => storageKey),
      [fixture.sourceStorageKey],
      "旧 attempt 只能保留权威源媒体，不能遗留迟到分析对象",
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("VOD 来源失败只落稳定错误类别且不泄露供应商事实", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-analysis-vod-failure-"));
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  const storage = new LocalObjectStorage(root);
  try {
    for (const [category, expectedCode] of [
      ["not_found", "audio_stream_missing"],
      ["temporarily_unavailable", "analysis_external_service_unavailable"],
    ] as const) {
      await truncateTestDatabase(prisma);
      const fixture = await createWorkerFixture(prisma, storage);
      await prisma.mediaFile.update({
        where: { resourceId: fixture.mediaResourceId },
        data: {
          sourceType: "aliyun_vod",
          fileId: null,
          mimeType: null,
          size: null,
          aliyunVodVideoId: "vod-test-stable-id",
          aliyunVodRegion: "cn-test",
        },
      });
      const warnings: Array<Record<string, unknown>> = [];
      const service = new MediaAnalysisWorkerService(
        prisma,
        storage,
        {
          region: "cn-test",
          gateway: {
            inspectVideo: async () => { throw new Error("not used"); },
            createPlaybackCredential: async () => { throw new Error("not used"); },
            listAudioRenditions: async () => { throw new Error("not used"); },
            createAudioRenditionStream: async () => { throw new Error("not used"); },
            createAnalysisAudioStream: async () => {
              throw new AliyunVodGatewayError(category, "provider-request-secret");
            },
          },
        },
        "ffmpeg",
        { info: () => undefined, warn: (facts) => warnings.push(facts) },
      );
      assert.equal(await service.processNext(`worker-vod-${category}`), true);
      const job = await prisma.processingJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      });
      assert.equal(job.status, "failed");
      assert.equal(job.errorCode, expectedCode);
      assert.deepEqual(warnings, [{
        jobId: fixture.jobId,
        runId: fixture.runId,
        errorCode: expectedCode,
      }]);
      assert.equal(JSON.stringify(warnings).includes("provider-request-secret"), false);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

test("运行中的媒体分析收到业务取消后清理资产并进入 cancelled", async (context) => {
  const ffmpegPath = process.env.XIQU_FFMPEG_PATH?.trim() || "ffmpeg";
  if (spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status !== 0) {
    context.skip("测试环境没有 FFmpeg");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-analysis-cancellation-"));
  const { prisma, pool, maintenancePool, collaborationPool } = createTestPrisma();
  await truncateTestDatabase(prisma);
  const storage = new LocalObjectStorage(root);
  try {
    // 20 秒输入保证测试有时间在 worker 完成前写入 cancelling；5ms watcher 仅用于缩短测试等待。
    const fixture = await createWorkerFixture(prisma, storage, 20);
    const service = new MediaAnalysisWorkerService(
      prisma,
      storage,
      null,
      ffmpegPath,
      { info: () => undefined, warn: () => undefined },
      5,
    );
    const processing = service.processNext("worker-business-cancel");
    await waitForJobStatus(prisma, fixture.jobId, "running");
    const request = await prisma.processingJobRequest.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    const cancelledAt = new Date();
    await prisma.$transaction([
      prisma.processingJobRequest.update({
        where: { id: request.id },
        data: {
          cancelledAt,
          cancelledBy: fixture.userId,
        },
      }),
      prisma.processingJob.update({
        where: { id: fixture.jobId },
        data: {
          status: "cancelling",
          cancelRequestedAt: cancelledAt,
          cancelRequestedBy: fixture.userId,
          cancellationMode: "user_request",
        },
      }),
      prisma.mediaAnalysisRun.update({
        where: { id: fixture.runId },
        data: { status: "cancelling" },
      }),
    ]);
    assert.equal(await processing, true);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).status,
      "cancelled",
    );
    assert.equal(
      (await prisma.mediaAnalysisRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status,
      "cancelled",
    );
    assert.equal(await prisma.mediaAnalysisAsset.count({ where: { runId: fixture.runId } }), 0);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
});

async function createWorkerFixture(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  storage: LocalObjectStorage,
  duration = 0.1,
) {
  const userId = "analysis-worker-user";
  const annotationFileId = "analysis-worker-annotation";
  const mediaResourceId = "analysis-worker-media";
  await prisma.user.create({
    data: {
      id: userId,
      accountName: "analysis-worker",
      displayName: "分析 Worker",
      passwordHash: "unused",
    },
  });
  await prisma.resourceEntry.create({
    data: {
      id: annotationFileId,
      type: "annotation_file",
      name: "worker.json",
      ownerUserId: userId,
    },
  });
  await prisma.annotationFile.create({
    data: {
      resourceId: annotationFileId,
      payload: {},
      lastEditedBy: userId,
    },
  });
  const wav = buildWav(8_000, duration, 220);
  const finalStorageKey = storage.createStorageKey("wav");
  const staged = await storage.putStagedObject(
    finalStorageKey,
    Readable.from([wav]),
    wav.byteLength,
  );
  await storage.promoteStagedObject(staged);
  const file = await prisma.fileObject.create({
    data: {
      name: "worker.wav",
      mimeType: "audio/wav",
      size: wav.byteLength,
      storageKey: finalStorageKey,
      checksum: staged.checksum,
      ownerUserId: userId,
    },
  });
  await prisma.resourceEntry.create({
    data: {
      id: mediaResourceId,
      type: "media_file",
      name: "worker.wav",
      ownerUserId: userId,
    },
  });
  await prisma.mediaFile.create({
    data: {
      resourceId: mediaResourceId,
      sourceType: "uploaded",
      mediaKind: "audio",
      fileId: file.id,
      mimeType: "audio/wav",
      size: wav.byteLength,
      duration,
    },
  });
  const run = await prisma.mediaAnalysisRun.create({
    data: {
      sourceMediaResourceId: mediaResourceId,
      sourceFingerprint: "worker-source",
      mediaFingerprint: "a".repeat(64),
      algorithmVersion: "xiqu-media-analysis-v1",
      configHash: "worker-config",
      config: {},
      createdBy: userId,
    },
  });
  const audioTrack = await prisma.mediaAudioTrack.create({
    data: {
      primaryMediaResourceId: mediaResourceId,
      name: "原声",
      kind: "original",
      sortOrder: 0,
      createdBy: userId,
    },
  });
  const job = await prisma.processingJob.create({
    data: {
      type: "media_analysis",
      resourceId: annotationFileId,
      inputFileIds: [file.id],
      createdBy: userId,
      analysisRunId: run.id,
      deduplicationKey: `test:worker:${run.id}`,
    },
  });
  await prisma.processingJobRequest.create({
    data: {
      jobId: job.id,
      requesterUserId: userId,
      contextResourceId: annotationFileId,
      mediaAudioTrackId: audioTrack.id,
    },
  });
  return {
    userId,
    annotationFileId,
    mediaResourceId,
    sourceStorageKey: finalStorageKey,
    runId: run.id,
    jobId: job.id,
  };
}

async function waitForJobStatus(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  jobId: string,
  status: "running",
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = await prisma.processingJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (job?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`等待任务进入 ${status} 超时。`);
}

async function waitForHeartbeatAfter(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  jobId: string,
  baseline: Date,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = await prisma.processingJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { heartbeatAt: true },
    });
    if (row.heartbeatAt && row.heartbeatAt > baseline) return row.heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("等待 worker heartbeat 前进超时。");
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待测试状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function buildWav(sampleRate: number, duration: number, frequency: number) {
  const sampleCount = Math.round(sampleRate * duration);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.sin((2 * Math.PI * frequency * index) / sampleRate);
    buffer.writeInt16LE(Math.round(value * 16_000), 44 + index * 2);
  }
  return buffer;
}
