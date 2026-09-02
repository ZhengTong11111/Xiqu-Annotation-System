import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { PlatformUser } from "@xiqu/shared";
import { buildTimelineTimingUpdateEnvelope } from "@xiqu/shared";
import type { AlignmentTextProjection } from "@xiqu/document-model";
import { AlignmentApplicationService } from "../src/alignmentApplicationService.js";
import { AlignmentRunService } from "../src/alignmentRunService.js";
import { AlignmentWorkerService } from "../src/alignmentWorkerService.js";
import { AlignmentTrainingCandidateService } from "../src/alignmentTrainingCandidateService.js";
import { AnnotationCommandCommitService } from "../src/annotationCommandCommitService.js";
import type { ForceAlignmentExecutor } from "../src/alignmentExecutor.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("强制对齐应用原子写入真实 operation，并支持幂等重放和同 run 再应用", async () => {
  await withFixture(async ({ prisma, fixture, applications, candidates, commandCommits, publishedRevisions }) => {
    const firstActionId = randomUUID();
    const first = await applications.apply(
      fixture.user,
      fixture.annotationFileId,
      fixture.runId,
      { clientActionId: firstActionId, baseRevision: 1 },
    );
    assert.equal(first.committedRevision, 2);
    assert.equal(first.appliedCharacterCount, 2);
    assert.equal(first.operationCount, 1);
    assert.deepEqual(readCharacterTimes(
      (await prisma.annotationFile.findUniqueOrThrow({
        where: { resourceId: fixture.annotationFileId },
      })).payload,
    ), [[1, 2], [2, 3]]);

    const application = await prisma.alignmentApplication.findUniqueOrThrow({
      where: { id: first.id },
      include: { operations: true },
    });
    assert.equal(application.operations.length, 1);
    assert.equal(application.operations[0]?.alignmentApplicationId, application.id);
    assert.equal(await prisma.annotationRecoverySnapshot.count({
      where: { annotationFileId: fixture.annotationFileId, revision: 1 },
    }), 1);
    assert.deepEqual(publishedRevisions, [2]);

    // 网络响应不确定时复用同一个 clientActionId，只返回既有提交，不生成第二次 revision。
    const replayed = await applications.apply(
      fixture.user,
      fixture.annotationFileId,
      fixture.runId,
      { clientActionId: firstActionId, baseRevision: 1 },
    );
    assert.deepEqual(replayed, first);
    assert.equal(await prisma.alignmentApplication.count(), 1);
    assert.deepEqual(publishedRevisions, [2]);

    const manual = buildTimelineTimingUpdateEnvelope([{
      entityType: "character",
      entityId: "char-1",
      before: { startTime: 1, endTime: 2 },
      after: { startTime: 1, endTime: 1.5 },
    }]);
    assert.ok(manual);
    await commandCommits.commitBatch(fixture.user, fixture.annotationFileId, {
      baseRevision: 2,
      operations: [{
        clientOperationId: `manual-timing:${randomUUID()}`,
        localRevision: null,
        action: manual.command.type,
        payload: manual,
      }],
    });
    const manualOperation = await prisma.annotationOperation.findFirstOrThrow({
      where: { clientOperationId: { startsWith: "manual-timing:" } },
    });
    assert.equal(manualOperation.alignmentApplicationId, null);

    // 逐字手改不会改变正文/音源身份；使用新的动作 id 可将同一预测明确再应用一次。
    const second = await applications.apply(
      fixture.user,
      fixture.annotationFileId,
      fixture.runId,
      { clientActionId: randomUUID(), baseRevision: 3 },
    );
    assert.equal(second.committedRevision, 4);
    assert.equal(await prisma.alignmentApplication.count(), 2);
    assert.deepEqual(publishedRevisions, [2, 3, 4]);

    await prisma.alignmentQualityAssessment.create({
      data: {
        alignmentApplicationId: first.id,
        assessorUserId: fixture.user.id,
        clientActionId: randomUUID(),
        requestHash: "9".repeat(64),
        scope: "editor",
        verdict: "correct",
        issueCodes: [],
      },
    });

    // application 历史按真实应用分页，同一个 run 的两次应用不能被折叠成一条。
    const firstPage = await applications.list(
      fixture.collaborator,
      fixture.annotationFileId,
      { limit: 1 },
    );
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0]?.id, second.id);
    assert.equal(firstPage.items[0]?.modelLabel, "昆曲逐字对齐 v1");
    assert.equal(firstPage.items[0]?.currentAssessmentCount, 0);
    assert.ok(firstPage.nextCursor);
    const secondPage = await applications.list(
      fixture.collaborator,
      fixture.annotationFileId,
      { limit: 1, cursor: firstPage.nextCursor! },
    );
    assert.deepEqual(secondPage.items.map((item) => item.id), [first.id]);
    assert.equal(secondPage.items[0]?.currentAssessmentCount, 1);
    assert.equal(secondPage.nextCursor, null);

    // 候选分页使用相邻 application revision 作为观察窗口；再次自动应用不计作人工调整。
    const newestCandidatePage = await candidates.list(
      fixture.collaborator,
      fixture.annotationFileId,
      { limit: 1 },
    );
    assert.equal(newestCandidatePage.items[0]?.alignmentApplicationId, second.id);
    assert.equal(newestCandidatePage.items[0]?.observationEndRevision, 4);
    assert.equal(newestCandidatePage.items[0]?.manualTiming.editedCharacterCount, 0);
    assert.equal(newestCandidatePage.items[0]?.predictionSummaryState, "ready");
    assert.equal(newestCandidatePage.items[0]?.unrated, true);
    assert.ok(newestCandidatePage.nextCursor);
    const olderCandidatePage = await candidates.list(
      fixture.collaborator,
      fixture.annotationFileId,
      { limit: 1, cursor: newestCandidatePage.nextCursor! },
    );
    assert.equal(olderCandidatePage.items[0]?.alignmentApplicationId, first.id);
    assert.equal(olderCandidatePage.items[0]?.observationEndRevision, 4);
    assert.deepEqual(olderCandidatePage.items[0]?.manualTiming, {
      operationCount: 1,
      editedCharacterCount: 1,
      totalBoundaryDeltaMicros: 500_000,
      maxBoundaryDeltaMicros: 500_000,
    });
    assert.deepEqual(olderCandidatePage.items[0]?.signals, ["manual_timing_adjustment"]);
    assert.equal(olderCandidatePage.items[0]?.assessments.correct, 1);
    assert.equal(olderCandidatePage.items[0]?.unrated, false);
    assert.equal(olderCandidatePage.nextCursor, null);
    await assert.rejects(
      applications.list(fixture.collaborator, fixture.annotationFileId, { limit: 101 }),
      hasStatus(400),
    );
    await assert.rejects(
      applications.list(fixture.collaborator, fixture.annotationFileId, { cursor: "bad" }),
      hasStatus(400),
    );
    await assert.rejects(
      candidates.list(fixture.collaborator, fixture.annotationFileId, { cursor: "bad" }),
      hasStatus(400),
    );
    await assert.rejects(
      candidates.list(fixture.collaborator, fixture.annotationFileId, { limit: 21 }),
      hasStatus(400),
    );
    const candidateCursorValue = JSON.parse(Buffer.from(
      newestCandidatePage.nextCursor!,
      "base64url",
    ).toString("utf8"));
    candidateCursorValue.fileId = randomUUID();
    await assert.rejects(
      candidates.list(fixture.collaborator, fixture.annotationFileId, {
        cursor: Buffer.from(JSON.stringify(candidateCursorValue), "utf8").toString("base64url"),
      }),
      hasStatus(400),
    );
    // 资源 ACL 不会因进入回收站自动消失；候选服务仍须在业务边界单独拒绝非活动文件。
    await prisma.resourceEntry.update({
      where: { id: fixture.annotationFileId },
      data: { trashedAt: new Date() },
    });
    await assert.rejects(
      candidates.list(fixture.collaborator, fixture.annotationFileId, { limit: 1 }),
      hasStatus(404),
    );
    await prisma.resourceEntry.update({
      where: { id: fixture.annotationFileId },
      data: { trashedAt: null },
    });
    const cursorValue = JSON.parse(Buffer.from(firstPage.nextCursor!, "base64url").toString("utf8"));
    cursorValue.annotationFileId = randomUUID();
    await assert.rejects(
      applications.list(fixture.collaborator, fixture.annotationFileId, {
        cursor: Buffer.from(JSON.stringify(cursorValue), "utf8").toString("base64url"),
      }),
      hasStatus(400),
    );

    await assert.rejects(
      applications.apply(
        fixture.user,
        fixture.annotationFileId,
        fixture.runId,
        { clientActionId: randomUUID(), baseRevision: 4 },
      ),
      hasConflictCode("alignment_application_no_changes"),
    );
    assert.equal((await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: fixture.annotationFileId },
    })).revision, 4);

    // 旧 prediction manifest 没有质量摘要仍可成为候选，但必须明确报告 missing，不能填充零分。
    const runWithArtifact = await prisma.alignmentRun.findUniqueOrThrow({
      where: { id: fixture.runId },
      include: { artifacts: true },
    });
    const predictionArtifact = runWithArtifact.artifacts[0]!;
    const manifest = runWithArtifact.manifest as Record<string, unknown>;
    await prisma.alignmentRun.update({
      where: { id: fixture.runId },
      data: { manifest: {
        version: 1,
        formatVersion: predictionArtifact.formatVersion,
        artifactId: predictionArtifact.id,
        sentenceCount: 1,
        characterCount: 2,
        compressedSize: Number(predictionArtifact.size),
        uncompressedSize: manifest.uncompressedSize as number,
        checksum: predictionArtifact.checksum,
      } },
    });
    assert.equal(
      (await candidates.list(fixture.collaborator, fixture.annotationFileId, { limit: 1 }))
        .items[0]?.predictionSummaryState,
      "missing",
    );

    // 扫描最多保留最新 500 条；窗口下界落在更早 revision 时只能报告 partial。
    await prisma.annotationOperation.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        annotationFileId: fixture.annotationFileId,
        actorUserId: fixture.user.id,
        clientOperationId: `candidate-cap-${String(index).padStart(4, "0")}`,
        requestHash: String(index + 1).padStart(64, "0"),
        sequence: index + 4,
        baseRevision: index + 4,
        localRevision: null,
        action: manual.command.type,
        payload: manual,
        status: "accepted" as const,
        committedRevision: index + 5,
        committedAt: new Date(),
      })),
    });
    await prisma.annotationFile.update({
      where: { resourceId: fixture.annotationFileId },
      data: { revision: 505 },
    });
    const partialCandidate = (await candidates.list(
      fixture.collaborator,
      fixture.annotationFileId,
      { limit: 1 },
    )).items[0]!;
    assert.equal(partialCandidate.evidenceState, "partial");
    assert.equal(partialCandidate.manualTiming.operationCount, 500);

    await prisma.alignmentApplication.update({
      where: { id: second.id },
      data: { operationCount: 99 },
    });
    await assert.rejects(
      candidates.list(fixture.collaborator, fixture.annotationFileId, { limit: 1 }),
      hasConflictCode("alignment_training_candidate_incomplete"),
    );
    await prisma.resourcePermission.update({
      where: {
        resourceId_userId: {
          resourceId: fixture.annotationFileId,
          userId: fixture.collaborator.id,
        },
      },
      data: { capabilities: [] },
    });
    await assert.rejects(
      candidates.list(fixture.collaborator, fixture.annotationFileId, { limit: 1 }),
      hasStatus(403),
    );
  });
});

test("应用前撤销音频下载权限会返回明确 403 且保持文档零写入", async () => {
  await withFixture(async ({ prisma, fixture, applications }) => {
    await prisma.resourcePermission.update({
      where: {
        resourceId_userId: {
          resourceId: fixture.mediaResourceId,
          userId: fixture.collaborator.id,
        },
      },
      data: { capabilities: ["read"] },
    });
    await assert.rejects(
      applications.apply(
        fixture.collaborator,
        fixture.annotationFileId,
        fixture.runId,
        { clientActionId: randomUUID(), baseRevision: 1 },
      ),
      (error: unknown) => Boolean(
        error && typeof error === "object" &&
        "statusCode" in error && error.statusCode === 403 &&
        "code" in error && error.code === "analysis_audio_forbidden",
      ),
    );
    assert.equal(await prisma.alignmentApplication.count(), 0);
    assert.equal(await prisma.annotationOperation.count(), 0);
    assert.equal((await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: fixture.annotationFileId },
    })).revision, 1);
  });
});

test("损坏预测与陈旧 revision 均在写入前失败且不留下 application", async () => {
  await withFixture(async ({ prisma, storage, fixture, applications }) => {
    await assert.rejects(
      applications.apply(
        fixture.user,
        fixture.annotationFileId,
        fixture.runId,
        { clientActionId: randomUUID(), baseRevision: 2 },
      ),
      hasConflictCode("alignment_application_revision_conflict"),
    );
    const artifact = await prisma.alignmentArtifact.findFirstOrThrow({
      where: { runId: fixture.runId, kind: "prediction" },
    });
    await storage.deleteObject(artifact.storageKey);
    await assert.rejects(
      applications.apply(
        fixture.user,
        fixture.annotationFileId,
        fixture.runId,
        { clientActionId: randomUUID(), baseRevision: 1 },
      ),
      hasConflictCode("alignment_artifact_corrupted"),
    );
    assert.equal(await prisma.alignmentApplication.count(), 0);
    assert.equal(await prisma.annotationOperation.count(), 0);
    assert.equal((await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: fixture.annotationFileId },
    })).revision, 1);
  });
});

async function withFixture(
  callback: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-alignment-application-"));
  const connections = createTestPrisma();
  await truncateTestDatabase(connections.prisma);
  try {
    await callback(await createFixture(connections.prisma, root));
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
    await connections.maintenancePool.end();
    await connections.collaborationPool.end();
    await rm(root, { recursive: true, force: true });
  }
}

async function createFixture(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  root: string,
) {
  const storage = new LocalObjectStorage(root);
  const userRow = await prisma.user.create({ data: {
    accountName: `alignment-application-${randomUUID()}`,
    displayName: "对齐应用用户",
    passwordHash: "unused",
  } });
  const user = toApiUser(userRow);
  const collaboratorRow = await prisma.user.create({ data: {
    accountName: `alignment-application-collaborator-${randomUUID()}`,
    displayName: "对齐应用协作者",
    passwordHash: "unused",
  } });
  const collaborator = toApiUser(collaboratorRow);
  const sourceBytes = Buffer.from("alignment-application-audio");
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
  await prisma.mediaAudioTrack.create({ data: {
    primaryMediaResourceId: media.id,
    name: "原声",
    kind: "original",
    sortOrder: 0,
    createdBy: user.id,
  } });
  await prisma.resourcePermission.createMany({ data: [
    {
      resourceId: annotation.id,
      userId: collaborator.id,
      capabilities: ["read", "write"],
      createdBy: user.id,
    },
    {
      resourceId: media.id,
      userId: collaborator.id,
      capabilities: ["read", "download"],
      createdBy: user.id,
    },
  ] });
  const access = new ResourceAccessService(prisma);
  const runService = new AlignmentRunService(prisma, access, true);
  const run = await runService.create(user, annotation.id, {
    clientRequestId: randomUUID(),
    modelPreset: "kunqu_character_v1",
  });
  const worker = new AlignmentWorkerService(
    prisma,
    storage,
    access,
    null,
    deterministicExecutor(),
    { info: () => undefined, warn: () => undefined },
    5,
    20,
  );
  assert.equal(await worker.processNext("alignment-application-worker"), true);

  const publishedRevisions: number[] = [];
  const commandCommits = new AnnotationCommandCommitService(
    prisma,
    access,
    { publishRevisionAdvanced: ({ revision }) => publishedRevisions.push(revision) },
  );
  return {
    prisma,
    storage,
    applications: new AlignmentApplicationService(
      prisma,
      access,
      storage,
      commandCommits,
    ),
    candidates: new AlignmentTrainingCandidateService(prisma, access),
    commandCommits,
    publishedRevisions,
    fixture: {
      user,
      collaborator,
      annotationFileId: annotation.id,
      mediaResourceId: media.id,
      runId: run.id,
    },
  };
}

function deterministicExecutor(): ForceAlignmentExecutor {
  return {
    execute: async (input, signal) => {
      if (input.audio.kind === "uploaded") {
        for await (const _chunk of input.audio.stream) void _chunk;
      }
      signal.throwIfAborted();
      return buildEvenPrediction(input.projection);
    },
  };
}

function buildEvenPrediction(projection: AlignmentTextProjection) {
  return {
    version: 1 as const,
    sentences: projection.sentences.map((sentence) => ({
      sentenceId: sentence.sentenceId,
      startMicros: sentence.startMicros,
      endMicros: sentence.endMicros,
      confidence: 0.9,
      characters: sentence.characters.map((character, index) => ({
        characterId: character.characterId,
        startMicros: sentence.startMicros + Math.round(
          (sentence.endMicros - sentence.startMicros) * index / sentence.characters.length,
        ),
        endMicros: sentence.startMicros + Math.round(
          (sentence.endMicros - sentence.startMicros) * (index + 1) / sentence.characters.length,
        ),
        confidence: 0.8,
        candidates: [],
      })),
    })),
  };
}

function createProjectPayload() {
  return {
    video: { url: "", name: null, source: "url" as const },
    sentenceAnnotationConfig: { roleOptions: ["闺门旦"] },
    subtitleLines: [{
      id: "line-1", text: "寻梦", startTime: 1, endTime: 3,
      deliveryMode: "sung" as const, roleTypes: ["闺门旦"],
    }],
    characterAnnotations: [
      { id: "char-1", lineId: "line-1", char: "寻", startTime: 1, endTime: 1.4 },
      { id: "char-2", lineId: "line-1", char: "梦", startTime: 1.4, endTime: 3 },
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

function readCharacterTimes(payload: unknown): Array<[number, number]> {
  return (payload as { characterAnnotations: Array<{ startTime: number; endTime: number }> })
    .characterAnnotations.map(({ startTime, endTime }) => [startTime, endTime]);
}

function toApiUser(user: { id: string; accountName: string; displayName: string }): PlatformUser {
  return { id: user.id, accountName: user.accountName, displayName: user.displayName, roles: [] };
}

function hasConflictCode(code: string) {
  return (error: unknown) => Boolean(
    error && typeof error === "object" &&
    "statusCode" in error && error.statusCode === 409 &&
    "details" in error &&
    (error as { details?: { code?: string } }).details?.code === code,
  );
}

function hasStatus(statusCode: number) {
  return (error: unknown) => Boolean(
    error && typeof error === "object" &&
    "statusCode" in error && error.statusCode === statusCode,
  );
}
