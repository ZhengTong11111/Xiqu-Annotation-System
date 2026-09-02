import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import type { PrismaClient } from "@prisma/client";
import { parseAlignmentPredictionArtifact, type AlignmentTextProjection } from "@xiqu/document-model";
import type { PlatformUser } from "@xiqu/shared";
import { AlignmentRunService } from "../src/alignmentRunService.js";
import { AlignmentWorkerService } from "../src/alignmentWorkerService.js";
import type { ForceAlignmentExecutor } from "../src/alignmentExecutor.js";
import { ProcessingJobCommandService } from "../src/processingJobCommandService.js";
import { MediaAnalysisJobService } from "../src/mediaAnalysisJobService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("强制对齐 worker 原子发布可校验且受 ACL 保护的单一 gzip prediction", async () => {
  await withFixture(async ({ prisma, storage, fixture, service, creator }) => {
    assert.equal(await service.processNext("alignment-worker-success"), true);
    const run = await prisma.alignmentRun.findUniqueOrThrow({
      where: { id: fixture.runId },
      include: { artifacts: true, jobs: true },
    });
    assert.equal(run.status, "succeeded");
    assert.equal(run.jobs[0]?.status, "succeeded");
    assert.equal(run.artifacts.length, 1);
    const artifact = run.artifacts[0]!;
    assert.equal(artifact.mimeType, "application/vnd.xiqu.alignment-prediction+json");
    assert.equal(await storage.objectExists(artifact.storageKey), true);
    const bytes = await readStream(await storage.getObjectStream(artifact.storageKey));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.checksum);
    const prediction = parseAlignmentPredictionArtifact(JSON.parse(gunzipSync(bytes).toString("utf8")));
    assert.ok(prediction);
    assert.equal(prediction.runId, run.id);
    assert.deepEqual(prediction.sentences[0]?.characters.map(({ characterId }) => characterId), ["char-1", "char-2"]);
    assert.equal(JSON.stringify(prediction).includes("寻梦"), false, "artifact 不能复制正文");
    const readable = await creator.getArtifactForRead(
      fixture.user,
      fixture.annotationFileId,
      run.id,
      artifact.id,
    );
    assert.equal(readable.storageKey, artifact.storageKey);
    await assert.rejects(
      creator.getArtifactForRead(
        fixture.outsider,
        fixture.annotationFileId,
        run.id,
        artifact.id,
      ),
      (error: unknown) => Boolean(error && typeof error === "object" &&
        "statusCode" in error && error.statusCode === 403),
    );
  });
});

test("worker 在正文漂移后稳定失败，正常停机则重新排队", async () => {
  await withFixture(async ({ prisma, fixture, service }) => {
    const changed = createProjectPayload();
    changed.subtitleLines[0]!.text = "寻梦惊";
    changed.characterAnnotations.push({
      id: "char-3", lineId: "line-1", char: "惊", startTime: 2.5, endTime: 3,
    });
    await prisma.annotationFile.update({
      where: { resourceId: fixture.annotationFileId },
      data: { revision: { increment: 1 }, payload: changed },
    });
    assert.equal(await service.processNext("alignment-worker-drift"), true);
    const failed = await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "alignment_input_changed");
  });

  await withFixture(async ({ prisma, fixture, service }) => {
    const shutdown = new AbortController();
    shutdown.abort();
    assert.equal(await service.processNext("alignment-worker-stop", shutdown.signal), true);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).status,
      "queued",
    );
    assert.equal(
      (await prisma.alignmentRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status,
      "queued",
    );
  });
});

test("运行中最后需求取消会中止 executor 并成对取消 job/run", async () => {
  let executorStarted = false;
  const blockingExecutor: ForceAlignmentExecutor = {
    execute: async (_input, signal) => {
      executorStarted = true;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
      throw new Error("unreachable");
    },
  };
  await withFixture(async ({ prisma, fixture, service, access, creator }, root) => {
    void root;
    const processing = service.processNext("alignment-worker-cancel");
    await waitUntil(() => executorStarted);
    const request = await prisma.processingJobRequest.findFirstOrThrow({ where: { jobId: fixture.jobId } });
    const commands = new ProcessingJobCommandService(
      prisma,
      access,
      new MediaAnalysisJobService(prisma, access),
      creator,
    );
    const result = await commands.cancelRequest(fixture.user, request.id, {
      clientCommandId: randomUUID(),
    });
    assert.equal(result.outcome, "execution_cancelling");
    assert.equal(await processing, true);
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).status, "cancelled");
    assert.equal((await prisma.alignmentRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status, "cancelled");
    const retry = await commands.retryRequest(fixture.user, request.id, {
      clientCommandId: randomUUID(),
    });
    assert.equal(retry.outcome, "retry_scheduled");
    const jobs = await prisma.processingJob.findMany({
      where: { alignmentRunId: fixture.runId },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1]?.status, "queued");
  }, blockingExecutor);
});

test("prediction promote 响应失败会清理对象并留下稳定失败状态", async () => {
  await withFixture(async ({ prisma, storage, fixture, service }) => {
    const promote = storage.promoteStagedObject.bind(storage);
    let reject = true;
    storage.promoteStagedObject = async (staged) => {
      await promote(staged);
      if (reject) {
        reject = false;
        throw new Error("synthetic promote response loss");
      }
    };
    assert.equal(await service.processNext("alignment-worker-promote"), true);
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
    assert.equal(job.status, "failed");
    assert.equal(await prisma.alignmentArtifact.count({ where: { runId: fixture.runId } }), 0);
    assert.deepEqual(
      (await storage.listStoredObjects()).map(({ storageKey }) => storageKey),
      [fixture.sourceStorageKey],
    );
  });
});

test("陈旧 claim 重排后旧 executor 被围栏中止，只有新 attempt 可以发布", async () => {
  let calls = 0;
  let firstStarted = false;
  const executor: ForceAlignmentExecutor = {
    execute: async (input, signal) => {
      calls += 1;
      if (calls === 1) {
        firstStarted = true;
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        signal.throwIfAborted();
      }
      if (input.audio.kind === "uploaded") await readStream(input.audio.stream);
      return buildEvenPrediction(input.projection);
    },
  };
  await withFixture(async ({ prisma, fixture, service }) => {
    const firstAttempt = service.processNext("alignment-worker-old-attempt");
    await waitUntil(() => firstStarted);
    const staleAt = new Date(Date.now() - 10 * 60_000);
    await prisma.processingJob.update({
      where: { id: fixture.jobId },
      data: { claimedAt: staleAt, heartbeatAt: staleAt },
    });
    assert.equal(await service.recoverStaleJobs(), 1);
    await firstAttempt;
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).status,
      "queued",
    );
    assert.equal(await service.processNext("alignment-worker-new-attempt"), true);
    const run = await prisma.alignmentRun.findUniqueOrThrow({
      where: { id: fixture.runId },
      include: { artifacts: true, jobs: true },
    });
    assert.equal(calls, 2);
    assert.equal(run.status, "succeeded");
    assert.equal(run.artifacts.length, 1);
    assert.equal(run.jobs[0]?.attemptCount, 2);
  }, executor);
});

test("数据库已提交但响应丢失时按 artifact id 核实成功并保留 final 对象", async () => {
  await withFixture(async ({ prisma, storage, access, fixture }) => {
    let injected = false;
    const ambiguousPrisma = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== "$transaction") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: Parameters<PrismaClient["$transaction"]>) => {
          const result = await (target.$transaction as (...values: typeof args) => Promise<unknown>)(...args);
          if (!injected && await target.alignmentArtifact.count({ where: { runId: fixture.runId } }) === 1) {
            injected = true;
            throw new Error("synthetic committed response loss");
          }
          return result;
        };
      },
    }) as PrismaClient;
    const service = new AlignmentWorkerService(
      ambiguousPrisma,
      storage,
      access,
      null,
      deterministicExecutor(),
      { info: () => undefined, warn: () => undefined },
      5,
      20,
    );
    assert.equal(await service.processNext("alignment-worker-ambiguous-db"), true);
    assert.equal(injected, true);
    const run = await prisma.alignmentRun.findUniqueOrThrow({
      where: { id: fixture.runId },
      include: { artifacts: true, jobs: true },
    });
    assert.equal(run.status, "succeeded");
    assert.equal(run.jobs[0]?.status, "succeeded");
    assert.equal(run.artifacts.length, 1);
    assert.equal(await storage.objectExists(run.artifacts[0]!.storageKey), true);
  });
});

test("撤权、音轨漂移和陈旧 cancelling 都按权威状态收口", async () => {
  await withFixture(async ({ prisma, fixture, service }) => {
    await prisma.user.update({ where: { id: fixture.user.id }, data: { isActive: false } });
    assert.equal(await service.processNext("alignment-worker-revoked"), true);
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "alignment_permission_revoked");
  });

  await withFixture(async ({ prisma, fixture, service }) => {
    await prisma.fileObject.update({
      where: { id: fixture.sourceFileId },
      data: { checksum: "b".repeat(64) },
    });
    assert.equal(await service.processNext("alignment-worker-source-drift"), true);
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } });
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "alignment_source_changed");
  });

  await withFixture(async ({ prisma, fixture, service }) => {
    const claimed = await service.claimNext("alignment-worker-dead-cancelling");
    assert.ok(claimed);
    const staleAt = new Date(Date.now() - 10 * 60_000);
    await prisma.processingJobRequest.updateMany({
      where: { jobId: fixture.jobId },
      data: { cancelledAt: staleAt, cancelledBy: fixture.user.id },
    });
    await prisma.processingJob.update({
      where: { id: fixture.jobId },
      data: {
        status: "cancelling",
        claimedAt: staleAt,
        heartbeatAt: staleAt,
        cancelRequestedAt: staleAt,
        cancelRequestedBy: fixture.user.id,
        cancellationMode: "user_request",
      },
    });
    await prisma.alignmentRun.update({
      where: { id: fixture.runId },
      data: { status: "cancelling" },
    });
    assert.equal(await service.recoverStaleJobs(), 1);
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: fixture.jobId } })).status,
      "cancelled",
    );
    assert.equal(
      (await prisma.alignmentRun.findUniqueOrThrow({ where: { id: fixture.runId } })).status,
      "cancelled",
    );
  });
});

async function withFixture(
  callback: (
    context: Awaited<ReturnType<typeof createFixtureContext>>,
    root: string,
  ) => Promise<void>,
  executor: ForceAlignmentExecutor = deterministicExecutor(),
) {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-alignment-worker-"));
  const connections = createTestPrisma();
  await truncateTestDatabase(connections.prisma);
  try {
    const context = await createFixtureContext(connections.prisma, root, executor);
    await callback(context, root);
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
    await connections.maintenancePool.end();
    await connections.collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
}

async function createFixtureContext(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  root: string,
  executor: ForceAlignmentExecutor,
) {
  const storage = new LocalObjectStorage(root);
  const userRow = await prisma.user.create({ data: {
    accountName: `alignment-worker-${randomUUID()}`,
    displayName: "对齐 Worker 用户",
    passwordHash: "unused",
  } });
  const user = toApiUser(userRow);
  const outsider = toApiUser(await prisma.user.create({ data: {
    accountName: `alignment-outsider-${randomUUID()}`,
    displayName: "无权账号",
    passwordHash: "unused",
  } }));
  const sourceBytes = Buffer.from("test-alignment-audio");
  const sourceStorageKey = storage.createStorageKey("mp3");
  const staged = await storage.putStagedObject(
    sourceStorageKey,
    Readable.from([sourceBytes]),
    sourceBytes.byteLength,
  );
  await storage.promoteStagedObject(staged);
  const media = await prisma.resourceEntry.create({ data: {
    type: "media_file",
    name: "寻梦.mp3",
    ownerUserId: user.id,
    mediaFile: { create: {
      sourceType: "uploaded",
      mediaKind: "audio",
      mimeType: "audio/mpeg",
      size: sourceBytes.byteLength,
      duration: 3,
      file: { create: {
        name: "寻梦.mp3",
        mimeType: "audio/mpeg",
        size: sourceBytes.byteLength,
        checksum: staged.checksum,
        storageKey: sourceStorageKey,
        ownerUserId: user.id,
      } },
    } },
  } });
  const annotation = await prisma.resourceEntry.create({ data: {
    type: "annotation_file",
    name: "寻梦标注.json",
    ownerUserId: user.id,
    annotationFile: { create: {
      payload: createProjectPayload(),
      mediaResourceId: media.id,
      lastEditedBy: user.id,
    } },
  } });
  const audioTrack = await prisma.mediaAudioTrack.create({ data: {
    primaryMediaResourceId: media.id,
    name: "原声",
    kind: "original",
    sortOrder: 0,
    createdBy: user.id,
  } });
  const access = new ResourceAccessService(prisma);
  const creator = new AlignmentRunService(prisma, access, true);
  const summary = await creator.create(user, annotation.id, {
    clientRequestId: randomUUID(),
    modelPreset: "kunqu_character_v1",
  });
  const job = await prisma.processingJob.findFirstOrThrow({ where: { alignmentRunId: summary.id } });
  const sourceFile = await prisma.fileObject.findUniqueOrThrow({ where: { storageKey: sourceStorageKey } });
  return {
    prisma,
    storage,
    access,
    creator,
    fixture: {
      user,
      outsider,
      annotationFileId: annotation.id,
      mediaResourceId: media.id,
      runId: summary.id,
      jobId: job.id,
      sourceStorageKey,
      audioTrackId: audioTrack.id,
      sourceFileId: sourceFile.id,
    },
    service: new AlignmentWorkerService(
      prisma,
      storage,
      access,
      null,
      executor,
      { info: () => undefined, warn: () => undefined },
      5,
      20,
    ),
  };
}

function deterministicExecutor(): ForceAlignmentExecutor {
  return {
    execute: async (input, signal) => {
      if (input.audio.kind === "uploaded") await readStream(input.audio.stream);
      signal.throwIfAborted();
      return buildEvenPrediction(input.projection);
    },
  };
}

function buildEvenPrediction(projection: AlignmentTextProjection) {
  return {
    version: 1 as const,
    sentences: projection.sentences.map((sentence) => {
      const duration = sentence.endMicros - sentence.startMicros;
      return {
        sentenceId: sentence.sentenceId,
        startMicros: sentence.startMicros,
        endMicros: sentence.endMicros,
        confidence: 0.9,
        characters: sentence.characters.map((character, index) => ({
          characterId: character.characterId,
          startMicros: sentence.startMicros + Math.round(duration * index / sentence.characters.length),
          endMicros: sentence.startMicros + Math.round(duration * (index + 1) / sentence.characters.length),
          confidence: 0.8,
          candidates: [],
        })),
      };
    }),
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

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待测试状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
