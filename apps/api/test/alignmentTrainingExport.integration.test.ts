import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { Prisma } from "@prisma/client";
import {
  buildAlignmentTextProjection,
  parseAlignmentTrainingInputManifest,
  parseAlignmentTrainingManifest,
  parseAlignmentTrainingTargetSnapshot,
} from "@xiqu/document-model";
import {
  buildTimelineTimingUpdateEnvelope,
  type AlignmentQualityIssueCode,
  type AlignmentQualityVerdict,
  type PlatformUser,
} from "@xiqu/shared";
import { AlignmentTrainingExportService } from "../src/alignmentTrainingExportService.js";
import { AlignmentTrainingExportJobService } from "../src/alignmentTrainingExportJobService.js";
import { AlignmentTrainingExportWorkerService } from "../src/alignmentTrainingExportWorkerService.js";
import { ObjectLifecycleService } from "../src/objectLifecycleService.js";
import type { ObjectStorage } from "../src/objectStorage.js";
import { MediaAnalysisJobService } from "../src/mediaAnalysisJobService.js";
import { ProcessingJobCommandService } from "../src/processingJobCommandService.js";
import { ProcessingJobQueryService } from "../src/processingJobQueryService.js";
import { stableJsonStringify } from "../src/annotationOperationIdempotency.js";
import { createMediaAnalysisSourceFingerprint } from "../src/mediaAnalysisSourceFingerprint.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("正确候选冻结为不可变 manifest，幂等重放且不改在线标注事实", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    const before = await readOnlineFacts(prisma, fixture.annotationFileId);
    const request = createRequest(fixture.applicationId);
    await assert.rejects(
      service.freeze(fixture.viewer, { ...request, clientActionId: randomUUID() }),
      hasStatus(403),
    );
    const [created, concurrentReplay] = await Promise.all([
      service.freeze(fixture.admin, request),
      service.freeze(fixture.admin, request),
    ]);
    assert.deepEqual(concurrentReplay, created);
    assert.equal(created.sampleCount, 1);
    assert.equal(created.componentCount, 1);

    const stored = await prisma.alignmentTrainingExport.findUniqueOrThrow({
      where: { id: created.id },
      include: { items: { include: { groups: true, input: true } } },
    });
    const parsed = parseAlignmentTrainingManifest(stored.manifest, sha256);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.checksum, created.manifestChecksum);
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0]?.targetMode, "prediction");
    assert.equal(stored.items[0]?.targetRevision, 2);
    assert.equal(parseAlignmentTrainingInputManifest(stored.inputManifest, sha256).ok, true);
    assert.equal(parseAlignmentTrainingTargetSnapshot(stored.items[0]?.input?.targetSnapshot).ok, true);
    assert.equal(stored.items[0]?.input?.sourceFileId, fixture.sourceFileId);
    assert.deepEqual(stored.items[0]?.groups.map(({ kind }) => kind).sort(), ["performer", "work"]);
    for (const forbidden of ["ProjectData", "storage/key", "https://media", "唱词正文"]) {
      assert.equal(JSON.stringify(stored).includes(forbidden), false);
    }
    assert.deepEqual(await readOnlineFacts(prisma, fixture.annotationFileId), before);

    // 模糊响应重试只返回原冻结结果，不重复写 item/group/audit。
    assert.deepEqual(await service.freeze(fixture.admin, request), created);
    assert.equal(await prisma.alignmentTrainingExport.count(), 1);
    assert.equal(await prisma.alignmentTrainingExportItem.count(), 1);
    assert.equal(await prisma.alignmentTrainingExportGroup.count(), 2);
    assert.equal(await prisma.auditLog.count({
      where: { action: "alignment_training_export_freeze" },
    }), 1);
    await assert.rejects(
      service.freeze(fixture.admin, {
        ...request,
        splitRatios: { train: 10_000, validation: 0, test: 0 },
      }),
      hasConflictCode("alignment_training_export_action_conflict"),
    );

    // 在线 application 与媒体关系即使随后删除，冻结输入仍必须独立保护 prediction 和上传源文件。
    await prisma.alignmentApplication.delete({ where: { id: fixture.applicationId } });
    await assert.rejects(
      prisma.alignmentArtifact.delete({ where: { id: fixture.artifactId } }),
    );
    await prisma.resourceEntry.delete({ where: { id: fixture.sourceMediaResourceId } });
    const lifecycle = new ObjectLifecycleService(
      prisma,
      new ResourceAccessService(prisma),
      {
        listStoredObjects: async () => [],
        deleteObject: async () => undefined,
      },
      {
        maxUploadBytes: 1,
        userQuotaBytes: 1,
        platformQuotaBytes: 1,
        orphanGraceMs: 0,
      },
    );
    const orphanReport = await lifecycle.inspect(fixture.admin);
    assert.equal(orphanReport.items.some((item) =>
      item.category === "unreferenced_file" && item.fileId === fixture.sourceFileId), false);
    assert.equal(orphanReport.items.some((item) =>
      item.category === "missing_binary" && item.fileId === fixture.sourceFileId), true);
    await assert.rejects(
      prisma.fileObject.delete({ where: { id: fixture.sourceFileId } }),
    );
  });
});

test("缺 performer 分组或无当前评价都会整批阻断且零落库", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    await prisma.projectAlignmentResearchGroup.delete({
      where: {
        projectResourceId_researchGroupId: {
          projectResourceId: fixture.projectId,
          researchGroupId: fixture.performerGroupId,
        },
      },
    });
    await assert.rejects(
      service.freeze(fixture.admin, createRequest(fixture.applicationId)),
      hasConflictCode("alignment_training_export_group_incomplete"),
    );
    assert.equal(await prisma.alignmentTrainingExport.count(), 0);

    await prisma.projectAlignmentResearchGroup.create({
      data: {
        projectResourceId: fixture.projectId,
        researchGroupId: fixture.performerGroupId,
        assignedBy: fixture.admin.id,
      },
    });
    await prisma.alignmentQualityAssessment.deleteMany({
      where: { alignmentApplicationId: fixture.applicationId },
    });
    await assert.rejects(
      service.freeze(fixture.admin, {
        ...createRequest(fixture.applicationId),
        clientActionId: randomUUID(),
      }),
      hasConflictCode("alignment_training_export_unrated"),
    );
    assert.equal(await prisma.alignmentTrainingExport.count(), 0);
    assert.equal(await prisma.alignmentTrainingExportItem.count(), 0);
    assert.equal(await prisma.auditLog.count({
      where: { action: "alignment_training_export_freeze" },
    }), 0);

    await prisma.alignmentQualityAssessment.create({
      data: {
        alignmentApplicationId: fixture.applicationId,
        assessorUserId: fixture.admin.id,
        clientActionId: randomUUID(),
        requestHash: "9".repeat(64),
        scope: "reviewer",
        verdict: "unusable",
        issueCodes: ["unclear_audio"],
      },
    });
    await assert.rejects(
      service.freeze(fixture.admin, {
        ...createRequest(fixture.applicationId),
        clientActionId: randomUUID(),
      }),
      hasConflictCode("alignment_training_export_unusable"),
    );
    assert.equal(await prisma.alignmentTrainingExport.count(), 0);
  });
});

test("需修改候选冻结人工观察 revision 和有限 timing 证据", async () => {
  await withFixture({
    verdict: "needs_adjustment",
    issueCodes: ["boundary_offset"],
    withManualTiming: true,
  }, async ({ prisma, service, fixture }) => {
    const before = await readOnlineFacts(prisma, fixture.annotationFileId);
    const created = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
    const item = await prisma.alignmentTrainingExportItem.findFirstOrThrow({
      where: { exportId: created.id },
    });
    const snapshot = item.snapshot as {
      target: { mode: string; revision: number };
      manualTiming: { operationCount: number; editedCharacterCount: number };
      quality: { verdict: string; issueCodes: string[] };
    };
    assert.equal(item.targetMode, "manual_revision");
    assert.equal(item.targetRevision, 3);
    assert.deepEqual(snapshot.target, { mode: "manual_revision", revision: 3 });
    assert.equal(snapshot.manualTiming.operationCount, 1);
    assert.equal(snapshot.manualTiming.editedCharacterCount, 1);
    assert.deepEqual(snapshot.quality, {
      verdict: "needs_adjustment",
      issueCodes: ["boundary_offset"],
      assessmentIds: [fixture.assessmentId],
    });
    assert.deepEqual(await readOnlineFacts(prisma, fixture.annotationFileId), before);
  });
});

test("畸形 timing 与超过 500 条的观察窗口分别以 invalid/partial 阻断", async () => {
  await withFixture({
    verdict: "needs_adjustment",
    issueCodes: ["boundary_offset"],
  }, async ({ prisma, service, fixture }) => {
    await prisma.annotationOperation.create({
      data: {
        annotationFileId: fixture.annotationFileId,
        actorUserId: fixture.admin.id,
        clientOperationId: randomUUID(),
        requestHash: "a".repeat(64),
        sequence: 2,
        baseRevision: 2,
        action: "timeline.items.timing.update",
        payload: { invalid: true },
        committedRevision: 3,
        committedAt: new Date(),
      },
    });
    await prisma.annotationFile.update({
      where: { resourceId: fixture.annotationFileId },
      data: { revision: 3 },
    });
    await assert.rejects(
      service.freeze(fixture.admin, createRequest(fixture.applicationId)),
      hasConflictCode("alignment_training_export_evidence_invalid"),
    );

    await prisma.annotationOperation.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({
        annotationFileId: fixture.annotationFileId,
        actorUserId: fixture.admin.id,
        clientOperationId: randomUUID(),
        requestHash: (index + 10).toString(16).padStart(64, "0"),
        sequence: index + 3,
        baseRevision: index + 3,
        action: "annotation.content.update",
        payload: {},
        committedRevision: index + 4,
        committedAt: new Date(),
      })),
    });
    await prisma.annotationFile.update({
      where: { resourceId: fixture.annotationFileId },
      data: { revision: 503 },
    });
    await assert.rejects(
      service.freeze(fixture.admin, {
        ...createRequest(fixture.applicationId),
        clientActionId: randomUUID(),
      }),
      hasConflictCode("alignment_training_export_evidence_partial"),
    );
    assert.equal(await prisma.alignmentTrainingExport.count(), 0);
  });
});

test("当前文件继续编辑后只冻结目标 revision 的精确历史快照", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    const historicalPayload = createAnnotationPayload(2);
    await prisma.annotationRecoverySnapshot.create({
      data: {
        annotationFileId: fixture.annotationFileId,
        revision: 2,
        payload: historicalPayload,
        createdBy: fixture.admin.id,
        reason: "训练导出历史目标夹具",
      },
    });
    await prisma.annotationFile.update({
      where: { resourceId: fixture.annotationFileId },
      data: { revision: 3, payload: createAnnotationPayload(1.75) },
    });

    const created = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
    const input = await prisma.alignmentTrainingExportInput.findUniqueOrThrow({
      where: {
        exportId_alignmentApplicationId: {
          exportId: created.id,
          alignmentApplicationId: fixture.applicationId,
        },
      },
    });
    const parsed = parseAlignmentTrainingTargetSnapshot(input.targetSnapshot);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.sentences[0]?.characters[0]?.endMicros, 2_000_000);
  });
});

test("历史目标缺失或完整性校验失败时整批不落库", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    await prisma.annotationFile.update({
      where: { resourceId: fixture.annotationFileId },
      data: { revision: 3, payload: createAnnotationPayload(1.75) },
    });
    await assert.rejects(
      service.freeze(fixture.admin, createRequest(fixture.applicationId)),
      hasConflictCode("alignment_training_export_target_unavailable"),
    );
    assert.equal(await prisma.alignmentTrainingExport.count(), 0);

    await prisma.annotationRecoverySnapshot.create({
      data: {
        annotationFileId: fixture.annotationFileId,
        revision: 2,
        payload: createAnnotationPayload(2),
        payloadSha256: "0".repeat(64),
        createdBy: fixture.admin.id,
      },
    });
    await assert.rejects(
      service.freeze(fixture.admin, {
        ...createRequest(fixture.applicationId),
        clientActionId: randomUUID(),
      }),
      hasConflictCode("alignment_training_export_target_unavailable"),
    );
    assert.equal(await prisma.alignmentTrainingExport.count(), 0);
  });
});

test("来源关系漂移会阻断冻结，旧 provenance-only export 仍可幂等读取", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    await prisma.resourceEntry.update({
      where: { id: fixture.sourceMediaResourceId },
      data: { archivedAt: new Date() },
    });
    await assert.rejects(
      service.freeze(fixture.admin, createRequest(fixture.applicationId)),
      hasConflictCode("alignment_training_export_source_unavailable"),
    );
    assert.equal(await prisma.alignmentTrainingExport.count(), 0);

    await prisma.resourceEntry.update({
      where: { id: fixture.sourceMediaResourceId },
      data: { archivedAt: null },
    });
    const request = createRequest(fixture.applicationId);
    const created = await service.freeze(fixture.admin, request);
    await prisma.alignmentTrainingExportInput.deleteMany({ where: { exportId: created.id } });
    await prisma.alignmentTrainingExport.update({
      where: { id: created.id },
      data: {
        inputManifestFormat: null,
        inputManifestVersion: null,
        inputManifestChecksum: null,
        inputManifest: Prisma.DbNull,
        targetSentenceCount: null,
        targetCharacterCount: null,
        targetSnapshotBytes: null,
      },
    });
    assert.deepEqual(await service.freeze(fixture.admin, request), created);
  });
});

test("幂等重放拒绝顶层或逐项输入快照被篡改", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    const request = createRequest(fixture.applicationId);
    const created = await service.freeze(fixture.admin, request);
    const input = await prisma.alignmentTrainingExportInput.findUniqueOrThrow({
      where: {
        exportId_alignmentApplicationId: {
          exportId: created.id,
          alignmentApplicationId: fixture.applicationId,
        },
      },
    });
    await prisma.alignmentTrainingExportInput.update({
      where: {
        exportId_alignmentApplicationId: {
          exportId: created.id,
          alignmentApplicationId: fixture.applicationId,
        },
      },
      data: {
        targetSnapshot: {
          ...(input.targetSnapshot as Record<string, unknown>),
          characterCount: 99,
        },
      },
    });
    await assert.rejects(
      service.freeze(fixture.admin, request),
      hasConflictCode("alignment_training_export_corrupt"),
    );
  });
});

test("训练冻结任务只允许管理员预约并复用同一账号需求与共享 job", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    const frozen = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
    const jobs = new AlignmentTrainingExportJobService(prisma, new ResourceAccessService(prisma));
    await assert.rejects(
      jobs.create(fixture.viewer, frozen.id, { clientRequestId: randomUUID() }),
      hasStatus(403),
    );

    const clientRequestId = randomUUID();
    const [created, replayed] = await Promise.all([
      jobs.create(fixture.admin, frozen.id, { clientRequestId }),
      jobs.create(fixture.admin, frozen.id, { clientRequestId }),
    ]);
    assert.deepEqual(replayed, created);
    const secondTab = await jobs.create(fixture.admin, frozen.id, {
      clientRequestId: randomUUID(),
    });
    assert.equal(secondTab.jobId, created.jobId);
    assert.equal(secondTab.requestId, created.requestId);
    assert.equal(await prisma.processingJob.count(), 1);
    assert.equal(await prisma.processingJobRequest.count(), 1);
    assert.equal(await prisma.processingJobRequestKey.count(), 2);

    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: created.jobId } });
    assert.equal(job.type, "alignment_training_export");
    assert.equal(job.alignmentTrainingExportId, frozen.id);
    assert.equal(job.resourceId, null);
    assert.equal(job.analysisRunId, null);
    assert.equal(job.alignmentRunId, null);
    assert.deepEqual(job.inputFileIds, [fixture.sourceFileId]);
    assert.equal(await prisma.auditLog.count({
      where: { action: "alignment_training_export_job_create" },
    }), 1);
    const query = new ProcessingJobQueryService(prisma, new ResourceAccessService(prisma));
    const mine = await query.list(fixture.admin, { scope: "mine" });
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0]?.job.type, "alignment_training_export");
    assert.equal(mine.items[0]?.contextResource, null);
    assert.equal((await query.list(fixture.admin, { scope: "related" })).items.length, 0);
    assert.equal((await query.list(fixture.admin, { scope: "all" })).items.length, 1);

    // 训练导出沿用通用 request 治理：可取消自己的需求，但本阶段尚未开放会重建包的重试语义。
    const access = new ResourceAccessService(prisma);
    const commands = new ProcessingJobCommandService(
      prisma,
      access,
      new MediaAnalysisJobService(prisma, access),
    );
    const cancelled = await commands.cancelRequest(fixture.admin, created.requestId, {
      clientCommandId: randomUUID(),
    });
    assert.equal(cancelled.outcome, "execution_cancelled");
    assert.equal(
      (await prisma.processingJob.findUniqueOrThrow({ where: { id: created.jobId } })).status,
      "cancelled",
    );
    await assert.rejects(
      commands.retryRequest(fixture.admin, created.requestId, {
        clientCommandId: randomUUID(),
      }),
      hasConflictCode("processing_job_retry_unsupported"),
    );
  });
});

test("训练 worker 流式发布不可变 ZIP，生命周期巡检保护 prediction 与训练包", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    await withTrainingStorage(fixture, async ({ storage }) => {
      const frozen = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
      const reservation = await new AlignmentTrainingExportJobService(
        prisma,
        new ResourceAccessService(prisma),
      ).create(fixture.admin, frozen.id, { clientRequestId: randomUUID() });
      const worker = createTrainingWorker(prisma, storage, async (input) => {
        assert.equal(input.kind, "uploaded");
        if (input.kind !== "uploaded") throw new Error("测试期望上传音频。 ");
        assert.deepEqual(await readStream(input.stream), fixture.sourceBytes);
        return Readable.from([Buffer.from("fLaC-training-fixture", "utf8")]);
      });

      assert.equal(await worker.processNext("training-worker-success"), true);
      const job = await prisma.processingJob.findUniqueOrThrow({
        where: { id: reservation.jobId },
      });
      const artifact = await prisma.alignmentTrainingPackageArtifact.findUniqueOrThrow({
        where: { processingJobId: reservation.jobId },
      });
      assert.equal(job.status, "succeeded");
      assert.equal(job.errorCode, null);
      assert.equal(artifact.exportId, frozen.id);
      assert.equal(await storage.objectExists(artifact.storageKey), true);
      const archive = await readStream(await storage.getObjectStream(artifact.storageKey));
      assert.equal(archive.subarray(0, 2).toString("ascii"), "PK");
      assert.equal(sha256(archive), artifact.checksum);

      const lifecycle = createLifecycle(prisma, storage);
      const healthy = await lifecycle.inspect(fixture.admin);
      assert.equal(healthy.items.some((item) =>
        item.storageKey === fixture.artifactStorageKey || item.storageKey === artifact.storageKey), false);
      await storage.deleteObject(artifact.storageKey);
      const missing = await lifecycle.inspect(fixture.admin);
      assert.equal(missing.items.some((item) =>
        item.category === "missing_binary" &&
        item.alignmentTrainingArtifactId === artifact.id), true);
    });
  });
});

test("训练 worker 在上传源摘要不匹配或 publish 响应失败时不留下伪成功资产", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    await withTrainingStorage(fixture, async ({ storage, root }) => {
      // 保持字节数不变但改写内容，验证流式 SHA 复核不是只检查大小。
      await writeStorageObject(
        root,
        fixture.sourceStorageKey,
        Buffer.alloc(fixture.sourceBytes.byteLength, 0x78),
      );
      const frozen = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
      const reservation = await new AlignmentTrainingExportJobService(
        prisma,
        new ResourceAccessService(prisma),
      ).create(fixture.admin, frozen.id, { clientRequestId: randomUUID() });
      const worker = createTrainingWorker(prisma, storage, async (input) => {
        if (input.kind !== "uploaded") throw new Error("测试期望上传音频。");
        await readStream(input.stream);
        return Readable.from([Buffer.from("fLaC-unreachable", "utf8")]);
      });
      await worker.processNext("training-worker-corrupt-source");
      const job = await prisma.processingJob.findUniqueOrThrow({
        where: { id: reservation.jobId },
      });
      assert.equal(job.status, "failed");
      assert.equal(await prisma.alignmentTrainingPackageArtifact.count(), 0);
      assert.equal((await storage.listStoredObjects()).some((item) =>
        item.storageKey.endsWith(".zip") || item.staged), false);
    });
  });

  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    await withTrainingStorage(fixture, async ({ storage }) => {
      const frozen = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
      const reservation = await new AlignmentTrainingExportJobService(
        prisma,
        new ResourceAccessService(prisma),
      ).create(fixture.admin, frozen.id, { clientRequestId: randomUUID() });
      const ambiguousStorage = createPromoteResponseFailureStorage(storage);
      const worker = createTrainingWorker(prisma, ambiguousStorage, normalizeFixtureAudio);
      await worker.processNext("training-worker-promote-failure");
      const job = await prisma.processingJob.findUniqueOrThrow({
        where: { id: reservation.jobId },
      });
      assert.equal(job.status, "failed");
      assert.equal(await prisma.alignmentTrainingPackageArtifact.count(), 0);
      assert.equal((await storage.listStoredObjects()).some((item) =>
        item.storageKey.endsWith(".zip") || item.staged), false);
    });
  });
});

test("训练 worker 的运行中取消、停机重排和陈旧 claim 恢复都保留围栏", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    await withTrainingStorage(fixture, async ({ storage }) => {
      const frozen = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
      const reservation = await new AlignmentTrainingExportJobService(
        prisma,
        new ResourceAccessService(prisma),
      ).create(fixture.admin, frozen.id, { clientRequestId: randomUUID() });
      let audioOpened = false;
      const blockedAudio = new PassThrough();
      const worker = createTrainingWorker(prisma, storage, async (input) => {
        if (input.kind !== "uploaded") throw new Error("测试期望上传音频。");
        await readStream(input.stream);
        audioOpened = true;
        return blockedAudio;
      });
      const processing = worker.processNext("training-worker-cancel");
      await waitUntil(() => audioOpened);
      await prisma.processingJob.update({
        where: { id: reservation.jobId },
        data: {
          status: "cancelling",
          cancelRequestedAt: new Date(),
          cancelRequestedBy: fixture.admin.id,
          cancellationMode: "user_request",
        },
      });
      await processing;
      assert.equal((await prisma.processingJob.findUniqueOrThrow({
        where: { id: reservation.jobId },
      })).status, "cancelled");
      assert.equal(await prisma.alignmentTrainingPackageArtifact.count(), 0);
      assert.equal((await storage.listStoredObjects()).some((item) => item.staged), false);
    });
  });

  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    await withTrainingStorage(fixture, async ({ storage }) => {
      const frozen = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
      const reservation = await new AlignmentTrainingExportJobService(
        prisma,
        new ResourceAccessService(prisma),
      ).create(fixture.admin, frozen.id, { clientRequestId: randomUUID() });
      const shutdown = new AbortController();
      shutdown.abort();
      await createTrainingWorker(prisma, storage, normalizeFixtureAudio)
        .processNext("training-worker-shutdown", shutdown.signal);
      const requeued = await prisma.processingJob.findUniqueOrThrow({
        where: { id: reservation.jobId },
      });
      assert.equal(requeued.status, "queued");
      assert.equal(requeued.claimedBy, null);

      const staleWorker = createTrainingWorker(prisma, storage, normalizeFixtureAudio);
      const claimed = await staleWorker.claimNext("training-worker-stale");
      assert.ok(claimed);
      const staleDate = new Date(Date.now() - 10 * 60_000);
      await prisma.processingJob.update({
        where: { id: reservation.jobId },
        data: { claimedAt: staleDate, heartbeatAt: staleDate },
      });
      assert.equal(await staleWorker.recoverStaleJobs(), 1);
      assert.equal((await prisma.processingJob.findUniqueOrThrow({
        where: { id: reservation.jobId },
      })).status, "queued");
    });
  });
});

test("历史 provenance-only 或逐项损坏冻结不能预约任务", async () => {
  await withFixture({ verdict: "correct", issueCodes: [] }, async ({ prisma, service, fixture }) => {
    const frozen = await service.freeze(fixture.admin, createRequest(fixture.applicationId));
    const jobs = new AlignmentTrainingExportJobService(prisma, new ResourceAccessService(prisma));
    await prisma.alignmentTrainingExportInput.deleteMany({ where: { exportId: frozen.id } });
    await prisma.alignmentTrainingExport.update({
      where: { id: frozen.id },
      data: {
        inputManifestFormat: null,
        inputManifestVersion: null,
        inputManifestChecksum: null,
        inputManifest: Prisma.DbNull,
        targetSentenceCount: null,
        targetCharacterCount: null,
        targetSnapshotBytes: null,
      },
    });
    await assert.rejects(
      jobs.create(fixture.admin, frozen.id, { clientRequestId: randomUUID() }),
      hasConflictCode("alignment_training_export_inputs_missing"),
    );
    assert.equal(await prisma.processingJob.count(), 0);
    assert.equal(await prisma.processingJobRequest.count(), 0);
  });
});

async function withFixture(
  options: {
    verdict: AlignmentQualityVerdict;
    issueCodes: AlignmentQualityIssueCode[];
    withManualTiming?: boolean;
  },
  callback: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const connections = createTestPrisma();
  await truncateTestDatabase(connections.prisma);
  try {
    await callback(await createFixture(connections.prisma, options));
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
    await connections.maintenancePool.end();
    await connections.collaborationPool.end();
  }
}

async function createFixture(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  options: {
    verdict: AlignmentQualityVerdict;
    issueCodes: AlignmentQualityIssueCode[];
    withManualTiming?: boolean;
  },
) {
  const adminRow = await prisma.user.create({
    data: {
      accountName: `training-export-admin-${randomUUID()}`,
      displayName: "训练导出管理员",
      passwordHash: "unused",
      roles: { create: { role: "admin" } },
    },
  });
  const viewerRow = await prisma.user.create({
    data: {
      accountName: `training-export-viewer-${randomUUID()}`,
      displayName: "训练导出查看者",
      passwordHash: "unused",
    },
  });
  const project = await prisma.resourceEntry.create({
    data: {
      type: "project",
      name: "训练项目",
      ownerUserId: adminRow.id,
      projectMetadata: { create: { description: "fixture", researchGroupRevision: 1 } },
    },
  });
  const sourceBytes = Buffer.from("training-export-source-audio", "utf8");
  const sourceChecksum = sha256(sourceBytes);
  const sourceFile = await prisma.fileObject.create({
    data: {
      name: "训练音频.mp3",
      mimeType: "audio/mpeg",
      size: BigInt(sourceBytes.byteLength),
      checksum: sourceChecksum,
      storageKey: `training/source/${randomUUID()}.mp3`,
      ownerUserId: adminRow.id,
    },
  });
  const sourceMedia = await prisma.resourceEntry.create({
    data: {
      type: "media_file",
      name: "训练音频.mp3",
      parentId: project.id,
      ownerUserId: adminRow.id,
      mediaFile: {
        create: {
          sourceType: "uploaded",
          mediaKind: "audio",
          fileId: sourceFile.id,
          mimeType: "audio/mpeg",
          size: BigInt(sourceBytes.byteLength),
          duration: 10,
        },
      },
    },
  });
  const audioTrack = await prisma.mediaAudioTrack.create({
    data: {
      primaryMediaResourceId: sourceMedia.id,
      name: "原始音轨",
      kind: "original",
      offsetSeconds: 0,
      sortOrder: 0,
      enabled: true,
      createdBy: adminRow.id,
    },
  });
  const payload = createAnnotationPayload(options.withManualTiming ? 1.99 : 2);
  const projection = buildAlignmentTextProjection(payload);
  assert.equal(projection.ok, true);
  if (!projection.ok) throw new Error("训练夹具无法生成文本投影。");
  const inputTextFingerprint = sha256(stableJsonStringify(projection.projection));
  const sourceFingerprint = createMediaAnalysisSourceFingerprint({
    sourceType: "uploaded",
    mediaResourceId: sourceMedia.id,
    fileId: sourceFile.id,
    checksum: sourceChecksum,
    size: BigInt(sourceBytes.byteLength),
  });
  assert.ok(sourceFingerprint);
  const annotation = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: "训练标注.json",
      parentId: project.id,
      ownerUserId: adminRow.id,
      annotationFile: {
        create: {
          payload,
          revision: options.withManualTiming ? 3 : 2,
          mediaResourceId: sourceMedia.id,
          lastEditedBy: adminRow.id,
        },
      },
    },
  });
  const predictionBytes = Buffer.from("training-export-prediction", "utf8");
  const run = await prisma.alignmentRun.create({
    data: {
      annotationFileId: annotation.id,
      annotationFileIdSnapshot: annotation.id,
      inputRevision: 1,
      inputTextFingerprint,
      inputSentenceCount: 1,
      inputCharacterCount: 1,
      sourceMediaResourceId: sourceMedia.id,
      sourceMediaResourceIdSnapshot: sourceMedia.id,
      sourceFingerprint,
      mediaAudioTrackId: audioTrack.id,
      mediaAudioTrackIdSnapshot: audioTrack.id,
      audioOffsetMicros: 0n,
      modelName: "fixture",
      modelVersion: "1",
      dictionaryVersion: "1",
      codeVersion: "1",
      configHash: "3".repeat(64),
      config: {},
      identityHash: createHash("sha256").update(randomUUID()).digest("hex"),
      status: "succeeded",
      progress: 1,
      manifest: { version: 1 },
      createdBy: adminRow.id,
      completedAt: new Date(),
      artifacts: {
        create: {
          kind: "prediction",
          formatVersion: 1,
          mimeType: "application/gzip",
          size: BigInt(predictionBytes.byteLength),
          checksum: sha256(predictionBytes),
          storageKey: `alignment/fixture/${randomUUID()}.json.gz`,
        },
      },
    },
    include: { artifacts: true },
  });
  const artifact = run.artifacts[0]!;
  const application = await prisma.alignmentApplication.create({
    data: {
      alignmentRunId: run.id,
      alignmentArtifactId: artifact.id,
      annotationFileId: annotation.id,
      actorUserId: adminRow.id,
      clientActionId: randomUUID(),
      requestHash: "5".repeat(64),
      baseRevision: 1,
      committedRevision: 2,
      operationCount: 1,
      appliedCharacterCount: 1,
    },
  });
  await prisma.annotationOperation.create({
    data: {
      annotationFileId: annotation.id,
      actorUserId: adminRow.id,
      clientOperationId: randomUUID(),
      requestHash: "6".repeat(64),
      sequence: 1,
      baseRevision: 1,
      action: "alignment.prediction.apply",
      payload: {},
      committedRevision: 2,
      committedAt: new Date(),
      alignmentApplicationId: application.id,
    },
  });
  if (options.withManualTiming) {
    const timing = buildTimelineTimingUpdateEnvelope([{
      entityType: "character",
      entityId: "character-1",
      before: { startTime: 1, endTime: 2 },
      after: { startTime: 1, endTime: 1.99 },
    }]);
    assert.ok(timing);
    await prisma.annotationOperation.create({
      data: {
        annotationFileId: annotation.id,
        actorUserId: adminRow.id,
        clientOperationId: randomUUID(),
        requestHash: "7".repeat(64),
        sequence: 2,
        baseRevision: 2,
        action: timing.command.type,
        payload: timing,
        committedRevision: 3,
        committedAt: new Date(),
      },
    });
  }
  const assessment = await prisma.alignmentQualityAssessment.create({
    data: {
      alignmentApplicationId: application.id,
      assessorUserId: adminRow.id,
      clientActionId: randomUUID(),
      requestHash: "8".repeat(64),
      scope: "reviewer",
      verdict: options.verdict,
      issueCodes: options.issueCodes,
    },
  });
  const workGroupId = randomUUID();
  const performerGroupId = randomUUID();
  await prisma.alignmentResearchGroup.createMany({
    data: [
      { id: workGroupId, kind: "work", displayName: "牡丹亭", createdBy: adminRow.id },
      { id: performerGroupId, kind: "performer", displayName: "俞振飞", createdBy: adminRow.id },
    ],
  });
  await prisma.projectAlignmentResearchGroup.createMany({
    data: [workGroupId, performerGroupId].map((researchGroupId) => ({
      projectResourceId: project.id,
      researchGroupId,
      assignedBy: adminRow.id,
    })),
  });
  return {
    prisma,
    service: new AlignmentTrainingExportService(prisma, new ResourceAccessService(prisma)),
    fixture: {
      admin: {
        id: adminRow.id,
        accountName: adminRow.accountName,
        displayName: adminRow.displayName,
        roles: ["admin"],
      } satisfies PlatformUser,
      viewer: {
        id: viewerRow.id,
        accountName: viewerRow.accountName,
        displayName: viewerRow.displayName,
        roles: [],
      } satisfies PlatformUser,
      projectId: project.id,
      annotationFileId: annotation.id,
      applicationId: application.id,
      performerGroupId,
      assessmentId: assessment.id,
      sourceFileId: sourceFile.id,
      sourceMediaResourceId: sourceMedia.id,
      sourceStorageKey: sourceFile.storageKey,
      sourceBytes,
      artifactId: artifact.id,
      artifactStorageKey: artifact.storageKey,
      predictionBytes,
    },
  };
}

function createAnnotationPayload(characterEndTime: number) {
  return {
    video: {
      url: "",
      name: "训练音频.mp3",
      source: "url" as const,
      filePath: "platform-file:training-source",
    },
    sentenceAnnotationConfig: { roleOptions: ["生"] },
    subtitleLines: [{
      id: "sentence-1",
      text: "唱词",
      startTime: 0,
      endTime: 3,
      deliveryMode: "sung" as const,
      roleTypes: ["生"],
    }],
    characterAnnotations: [{
      id: "character-1",
      lineId: "sentence-1",
      char: "唱",
      startTime: 1,
      endTime: characterEndTime,
      tone: null,
    }],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [],
    customTracks: [],
    activeTrackOrder: [],
  };
}

function createRequest(applicationId: string) {
  return {
    clientActionId: randomUUID(),
    applicationIds: [applicationId],
    splitSeedHash: sha256("xiqu-training-export-test-seed"),
    splitRatios: { train: 8_000, validation: 1_000, test: 1_000 },
  };
}

async function readOnlineFacts(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  annotationFileId: string,
) {
  const file = await prisma.annotationFile.findUniqueOrThrow({
    where: { resourceId: annotationFileId },
    select: { revision: true, payload: true, workflowStatus: true },
  });
  return {
    file,
    operationCount: await prisma.annotationOperation.count({ where: { annotationFileId } }),
    snapshotCount: await prisma.annotationRecoverySnapshot.count({ where: { annotationFileId } }),
    confirmationCount: await prisma.annotationConfirmation.count({ where: { annotationFileId } }),
    rangeCommentCount: await prisma.annotationRangeComment.count({ where: { annotationFileId } }),
  };
}

type TrainingFixture = Awaited<ReturnType<typeof createFixture>>["fixture"];
type TrainingAudioNormalizer = ConstructorParameters<
  typeof AlignmentTrainingExportWorkerService
>[4];

/** 为 worker 集成测试写入与数据库冻结摘要严格一致的两类输入对象。 */
async function withTrainingStorage(
  fixture: TrainingFixture,
  callback: (context: { storage: LocalObjectStorage; root: string }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "xiqu-training-worker-"));
  const storage = new LocalObjectStorage(root);
  try {
    await Promise.all([
      writeStorageObject(root, fixture.sourceStorageKey, fixture.sourceBytes),
      writeStorageObject(root, fixture.artifactStorageKey, fixture.predictionBytes),
    ]);
    await callback({ storage, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeStorageObject(root: string, storageKey: string, content: Buffer) {
  const absolutePath = path.join(root, storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

function createTrainingWorker(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  storage: ObjectStorage,
  normalizer: TrainingAudioNormalizer,
) {
  return new AlignmentTrainingExportWorkerService(
    prisma,
    storage,
    new ResourceAccessService(prisma),
    null,
    normalizer,
    { info: () => undefined, warn: () => undefined },
    5,
    10,
  );
}

const normalizeFixtureAudio: TrainingAudioNormalizer = async (input) => {
  if (input.kind !== "uploaded") throw new Error("测试期望上传音频。");
  await readStream(input.stream);
  return Readable.from([Buffer.from("fLaC-training-fixture", "utf8")]);
};

/** 模拟 promote 已成功但响应丢失；worker 必须把 final/staged 一并补偿删除。 */
function createPromoteResponseFailureStorage(storage: LocalObjectStorage): ObjectStorage {
  return {
    describeBackend: () => storage.describeBackend(),
    createStorageKey: (extension) => storage.createStorageKey(extension),
    putStagedObject: (key, stream, maxBytes) => storage.putStagedObject(key, stream, maxBytes),
    promoteStagedObject: async (staged) => {
      await storage.promoteStagedObject(staged);
      throw new Error("simulated-promote-response-loss");
    },
    getObjectStream: (key, range) => storage.getObjectStream(key, range),
    objectExists: (key) => storage.objectExists(key),
    deleteObject: (key) => storage.deleteObject(key),
    checkReadiness: () => storage.checkReadiness(),
    listStoredObjects: () => storage.listStoredObjects(),
  };
}

function createLifecycle(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  storage: LocalObjectStorage,
) {
  return new ObjectLifecycleService(
    prisma,
    new ResourceAccessService(prisma),
    storage,
    {
      maxUploadBytes: 1,
      userQuotaBytes: 1,
      platformQuotaBytes: 1,
      orphanGraceMs: 0,
    },
  );
}

async function readStream(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待训练 worker 测试状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
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
