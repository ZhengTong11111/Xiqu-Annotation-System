import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { parseAlignmentTrainingManifest } from "@xiqu/document-model";
import {
  buildTimelineTimingUpdateEnvelope,
  type AlignmentQualityIssueCode,
  type AlignmentQualityVerdict,
  type PlatformUser,
} from "@xiqu/shared";
import { AlignmentTrainingExportService } from "../src/alignmentTrainingExportService.js";
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
      include: { items: { include: { groups: true } } },
    });
    const parsed = parseAlignmentTrainingManifest(stored.manifest, sha256);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.checksum, created.manifestChecksum);
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0]?.targetMode, "prediction");
    assert.equal(stored.items[0]?.targetRevision, 2);
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
  const annotation = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: "训练标注.json",
      parentId: project.id,
      ownerUserId: adminRow.id,
      annotationFile: {
        create: {
          payload: { version: 7, marker: "保持不变" },
          revision: options.withManualTiming ? 3 : 2,
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
      inputTextFingerprint: "1".repeat(64),
      inputSentenceCount: 1,
      inputCharacterCount: 1,
      sourceMediaResourceIdSnapshot: randomUUID(),
      sourceFingerprint: "2".repeat(64),
      mediaAudioTrackIdSnapshot: randomUUID(),
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
    },
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
