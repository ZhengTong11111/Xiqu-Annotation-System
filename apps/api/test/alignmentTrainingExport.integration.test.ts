import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
import { ObjectLifecycleService } from "../src/objectLifecycleService.js";
import { stableJsonStringify } from "../src/annotationOperationIdempotency.js";
import { createMediaAnalysisSourceFingerprint } from "../src/mediaAnalysisSourceFingerprint.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
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
  const sourceChecksum = sha256("training-export-source-audio");
  const sourceFile = await prisma.fileObject.create({
    data: {
      name: "训练音频.mp3",
      mimeType: "audio/mpeg",
      size: 1_024n,
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
          size: 1_024n,
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
    size: 1_024n,
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
          size: 128n,
          checksum: "4".repeat(64),
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
      artifactId: artifact.id,
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

function sha256(value: string) {
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
