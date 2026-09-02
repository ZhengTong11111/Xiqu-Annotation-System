import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PlatformUser, ResourceCapability } from "@xiqu/shared";
import { AlignmentQualityAssessmentService } from "../src/alignmentQualityAssessmentService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("编辑评价支持幂等重放、追加改判，并保持标注文档事实不变", async () => {
  await withFixture(async ({ prisma, service, fixture }) => {
    const before = await readDocumentFacts(prisma, fixture.annotationFileId);
    const firstActionId = randomUUID();
    const first = await service.upsert(
      fixture.editor,
      fixture.annotationFileId,
      fixture.applicationId,
      {
        clientActionId: firstActionId,
        scope: "editor",
        verdict: "needs_adjustment",
        issueCodes: ["boundary_offset"],
      },
    );
    assert.equal(first.isCurrent, true);
    assert.equal(first.verdict, "needs_adjustment");

    // HTTP 响应丢失后复用同一个 action，只返回原事实，不生成第二行或第二条审计。
    const replayed = await service.upsert(
      fixture.editor,
      fixture.annotationFileId,
      fixture.applicationId,
      {
        clientActionId: firstActionId,
        scope: "editor",
        verdict: "needs_adjustment",
        issueCodes: ["boundary_offset"],
      },
    );
    assert.deepEqual(replayed, first);
    assert.equal(await prisma.alignmentQualityAssessment.count(), 1);

    await assert.rejects(
      service.upsert(
        fixture.editor,
        fixture.annotationFileId,
        fixture.applicationId,
        {
          clientActionId: firstActionId,
          scope: "editor",
          verdict: "unusable",
          issueCodes: ["unclear_audio"],
        },
      ),
      hasConflictCode("alignment_quality_action_conflict"),
    );
    await assert.rejects(
      service.upsert(
        fixture.editor,
        fixture.annotationFileId,
        fixture.applicationId,
        {
          clientActionId: randomUUID(),
          scope: "editor",
          verdict: "needs_adjustment",
          issueCodes: ["boundary_offset"],
        },
      ),
      hasConflictCode("alignment_quality_no_change"),
    );

    const changed = await service.upsert(
      fixture.editor,
      fixture.annotationFileId,
      fixture.applicationId,
      {
        clientActionId: randomUUID(),
        scope: "editor",
        verdict: "correct",
        issueCodes: [],
      },
    );
    assert.equal(changed.verdict, "correct");
    const history = await prisma.alignmentQualityAssessment.findMany({
      where: { alignmentApplicationId: fixture.applicationId },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(history.length, 2);
    assert.ok(history[0]?.supersededAt);
    assert.equal(history[1]?.supersededAt, null);
    assert.equal(await prisma.auditLog.count({
      where: { action: "alignment_quality_assessment_upsert" },
    }), 2);

    const current = await service.listCurrent(
      fixture.reader,
      fixture.annotationFileId,
      fixture.applicationId,
    );
    assert.equal(current.isPartial, false);
    assert.deepEqual(current.items.map((row) => row.id), [changed.id]);
    assert.deepEqual(await readDocumentFacts(prisma, fixture.annotationFileId), before);
  });
});

test("编辑与审核 scope 分别使用 write 和 review，不以账号角色替代 ACL", async () => {
  await withFixture(async ({ prisma, service, fixture }) => {
    await assert.rejects(
      service.upsert(
        fixture.editor,
        fixture.annotationFileId,
        fixture.applicationId,
        {
          clientActionId: randomUUID(),
          scope: "reviewer",
          verdict: "correct",
          issueCodes: [],
        },
      ),
      hasStatus(403),
    );
    await assert.rejects(
      service.upsert(
        fixture.reviewer,
        fixture.annotationFileId,
        fixture.applicationId,
        {
          clientActionId: randomUUID(),
          scope: "editor",
          verdict: "correct",
          issueCodes: [],
        },
      ),
      hasStatus(403),
    );
    const review = await service.upsert(
      fixture.reviewer,
      fixture.annotationFileId,
      fixture.applicationId,
      {
        clientActionId: randomUUID(),
        scope: "reviewer",
        verdict: "unusable",
        issueCodes: ["lyric_mismatch", "audio_desync"],
      },
    );
    assert.equal(review.scope, "reviewer");
    assert.equal(await prisma.alignmentQualityAssessment.count(), 1);
  });
});

test("并发相同 action 只写一行，迟到重放在后续改判后仍返回历史事实", async () => {
  await withFixture(async ({ prisma, service, fixture }) => {
    const actionId = randomUUID();
    const request = {
      clientActionId: actionId,
      scope: "editor" as const,
      verdict: "needs_adjustment" as const,
      issueCodes: ["boundary_offset" as const],
    };
    const [left, right] = await Promise.all([
      service.upsert(fixture.editor, fixture.annotationFileId, fixture.applicationId, request),
      service.upsert(fixture.editor, fixture.annotationFileId, fixture.applicationId, request),
    ]);
    assert.equal(left.id, right.id);
    assert.equal(await prisma.alignmentQualityAssessment.count(), 1);

    const latest = await service.upsert(
      fixture.editor,
      fixture.annotationFileId,
      fixture.applicationId,
      {
        clientActionId: randomUUID(),
        scope: "editor",
        verdict: "correct",
        issueCodes: [],
      },
    );
    const delayedReplay = await service.upsert(
      fixture.editor,
      fixture.annotationFileId,
      fixture.applicationId,
      request,
    );
    assert.equal(delayedReplay.id, left.id);
    assert.equal(delayedReplay.isCurrent, false);
    assert.equal((await service.listCurrent(
      fixture.reader,
      fixture.annotationFileId,
      fixture.applicationId,
    )).items[0]?.id, latest.id);
  });
});

test("跨文件和缺失 operation 关系的 application 不可被评价或枚举", async () => {
  await withFixture(async ({ prisma, service, fixture }) => {
    const otherFile = await createAnnotationFile(prisma, fixture.owner.id, "其他文件");
    await assert.rejects(
      service.listCurrent(fixture.owner, otherFile, fixture.applicationId),
      hasStatus(404),
    );
    await prisma.annotationOperation.deleteMany({
      where: { alignmentApplicationId: fixture.applicationId },
    });
    await assert.rejects(
      service.upsert(
        fixture.editor,
        fixture.annotationFileId,
        fixture.applicationId,
        {
          clientActionId: randomUUID(),
          scope: "editor",
          verdict: "correct",
          issueCodes: [],
        },
      ),
      hasStatus(404),
    );
    assert.equal(await prisma.alignmentQualityAssessment.count(), 0);
  });
});

async function withFixture(
  callback: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const connections = createTestPrisma();
  await truncateTestDatabase(connections.prisma);
  try {
    await callback(await createFixture(connections.prisma));
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
    await connections.maintenancePool.end();
    await connections.collaborationPool.end();
  }
}

async function createFixture(prisma: ReturnType<typeof createTestPrisma>["prisma"]) {
  const owner = await createUser(prisma, "quality-owner");
  const editor = await createUser(prisma, "quality-editor");
  const reviewer = await createUser(prisma, "quality-reviewer");
  const reader = await createUser(prisma, "quality-reader");
  const annotationFileId = await createAnnotationFile(prisma, owner.id, "质量评价文件");
  await grant(prisma, annotationFileId, owner.id, editor.id, ["read", "write"]);
  await grant(prisma, annotationFileId, owner.id, reviewer.id, ["read", "review"]);
  await grant(prisma, annotationFileId, owner.id, reader.id, ["read"]);
  const run = await prisma.alignmentRun.create({
    data: {
      annotationFileId,
      annotationFileIdSnapshot: annotationFileId,
      inputRevision: 1,
      inputTextFingerprint: "a".repeat(64),
      inputSentenceCount: 1,
      inputCharacterCount: 2,
      sourceMediaResourceIdSnapshot: randomUUID(),
      sourceFingerprint: "b".repeat(64),
      mediaAudioTrackIdSnapshot: randomUUID(),
      audioOffsetMicros: 0,
      modelName: "kunqu-character-aligner",
      modelVersion: "1",
      dictionaryVersion: "1",
      codeVersion: "1",
      configHash: "c".repeat(64),
      config: {},
      identityHash: "d".repeat(64),
      status: "succeeded",
      progress: 1,
      manifest: {},
      createdBy: owner.id,
      completedAt: new Date(),
    },
  });
  const artifact = await prisma.alignmentArtifact.create({
    data: {
      runId: run.id,
      kind: "prediction",
      formatVersion: 1,
      mimeType: "application/vnd.xiqu.alignment-prediction+json+gzip",
      size: 128,
      checksum: "e".repeat(64),
      storageKey: `alignment/${run.id}.json.gz`,
    },
  });
  const application = await prisma.alignmentApplication.create({
    data: {
      alignmentRunId: run.id,
      alignmentArtifactId: artifact.id,
      annotationFileId,
      actorUserId: owner.id,
      clientActionId: randomUUID(),
      requestHash: "f".repeat(64),
      baseRevision: 1,
      committedRevision: 2,
      operationCount: 1,
      appliedCharacterCount: 2,
    },
  });
  await prisma.annotationOperation.create({
    data: {
      annotationFileId,
      actorUserId: owner.id,
      clientOperationId: `alignment-test:${randomUUID()}`,
      requestHash: "1".repeat(64),
      sequence: 1,
      baseRevision: 1,
      action: "timeline.items.timing.update",
      payload: {},
      status: "accepted",
      committedRevision: 2,
      committedAt: new Date(),
      alignmentApplicationId: application.id,
    },
  });
  const access = new ResourceAccessService(prisma);
  return {
    prisma,
    service: new AlignmentQualityAssessmentService(prisma, access),
    fixture: {
      owner: toApiUser(owner),
      editor: toApiUser(editor),
      reviewer: toApiUser(reviewer),
      reader: toApiUser(reader),
      annotationFileId,
      applicationId: application.id,
    },
  };
}

async function createUser(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  prefix: string,
) {
  return prisma.user.create({
    data: {
      accountName: `${prefix}-${randomUUID()}`,
      displayName: prefix,
      passwordHash: "unused",
    },
  });
}

async function createAnnotationFile(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  ownerUserId: string,
  name: string,
) {
  const resource = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name,
      ownerUserId,
      annotationFile: {
        create: {
          payload: { version: 7, name },
          revision: 2,
          lastOperationSequence: 1,
          lastEditedBy: ownerUserId,
        },
      },
    },
  });
  return resource.id;
}

async function grant(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  resourceId: string,
  grantorUserId: string,
  userId: string,
  capabilities: ResourceCapability[],
) {
  await prisma.resourcePermission.create({
    data: { resourceId, userId, capabilities, createdBy: grantorUserId },
  });
}

async function readDocumentFacts(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  annotationFileId: string,
) {
  return {
    file: await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: annotationFileId },
      select: {
        payload: true,
        revision: true,
        lastOperationSequence: true,
        lastSavedAt: true,
        workflowStatus: true,
      },
    }),
    operations: await prisma.annotationOperation.count({ where: { annotationFileId } }),
    snapshots: await prisma.annotationRecoverySnapshot.count({ where: { annotationFileId } }),
  };
}

function toApiUser(user: { id: string; accountName: string; displayName: string }): PlatformUser {
  return { id: user.id, accountName: user.accountName, displayName: user.displayName, roles: [] };
}

function hasStatus(statusCode: number) {
  return (error: unknown) => Boolean(
    error && typeof error === "object" &&
    "statusCode" in error && error.statusCode === statusCode,
  );
}

function hasConflictCode(code: string) {
  return (error: unknown) => Boolean(
    error && typeof error === "object" &&
    "statusCode" in error && error.statusCode === 409 &&
    "details" in error &&
    (error as { details?: { code?: string } }).details?.code === code,
  );
}
