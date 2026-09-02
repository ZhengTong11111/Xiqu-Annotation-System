import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import {
  buildProjectAnnotationContentCommand,
  type ProjectData,
} from "@xiqu/document-model";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
import { AnnotationHistoryCompactionPlanner } from "../src/annotationHistoryCompactionPlanner.js";
import { PrismaAnnotationHistoryCompactionRepository } from "../src/annotationHistoryCompactionRepository.js";
import { loadAnnotationHistoryDependencyProtection } from "../src/annotationHistoryDependencyProtection.js";
import { ANNOTATION_HISTORY_HOUR_MS } from "../src/annotationHistoryCompactionPolicy.js";
import { createPrismaReadOnlyConnection } from "../src/database.js";
import {
  createTestPrisma,
  TEST_DATABASE_URL,
  truncateTestDatabase,
} from "./testEnvironment.js";

test("HC1 planner 在隔离 PostgreSQL 中完成重放且不改写任何历史事实", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const user = await prisma.user.create({
      data: {
        accountName: "history-planner",
        displayName: "历史规划测试",
        passwordHash: "not-used",
        roles: { create: { role: "super_admin" } },
      },
    });
    const projects = Array.from({ length: 34 }, (_, index) => createProject(`句${index + 1}`));
    const resource = await prisma.resourceEntry.create({
      data: {
        type: "annotation_file",
        name: "历史规划测试.json",
        ownerUserId: user.id,
        annotationFile: {
          create: {
            payload: toInputJson(projects[33]!),
            revision: 34,
            lastOperationSequence: 33,
            lastEditedBy: user.id,
          },
        },
      },
    });
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    await prisma.annotationRecoverySnapshot.createMany({
      data: projects.slice(0, 33).map((project, index) => ({
        annotationFileId: resource.id,
        revision: index + 1,
        payload: toInputJson(project),
        createdBy: user.id,
        reason: "save",
        createdAt: new Date(createdAt.getTime() + index * 1_000),
      })),
    });
    const operations = projects.slice(1).map((project, index) =>
      createOperation(projects[index]!, project, index + 2, index + 1, resource.id, user.id));
    await prisma.annotationOperation.createMany({ data: operations });

    const before = await readProtectedDatabaseFacts(prisma, resource.id);
    const repository = new CountingCompactionRepository(prisma);
    const planner = new AnnotationHistoryCompactionPlanner(repository);
    const plan = await planner.plan({
      annotationFileId: resource.id,
      maxRevisionsPerFile: 100,
      maxOperationsPerFile: 100,
      now: new Date("2026-09-01T00:00:00.000Z"),
      policy: {
        hotWindowMs: ANNOTATION_HISTORY_HOUR_MS,
        recentSnapshotCount: 1,
        checkpointRevisionInterval: 1_000,
        checkpointOperationInterval: 10_000,
        checkpointTimeIntervalMs: 365 * 24 * ANNOTATION_HISTORY_HOUR_MS,
      },
    });
    const after = await readProtectedDatabaseFacts(prisma, resource.id);

    assert.equal(plan.summary.fileCount, 1);
    assert.equal(plan.summary.reconstructibleCount, 31);
    assert.equal(plan.summary.blockedCount, 0);
    assert.equal(plan.files[0]?.decisions[1]?.decision, "reconstructible");
    assert.equal(repository.payloadBatchQueryCount, 3);
    const dependencyProtection = await loadAnnotationHistoryDependencyProtection(prisma, {
      annotationFileId: resource.id,
    });
    assert.equal(dependencyProtection.valid, true);
    assert.equal(dependencyProtection.checkpointSnapshotIds.size, 0);
    assert.equal(dependencyProtection.operationRanges.length, 0);
    assert.deepEqual(after, before);

    // 专用 CLI 连接对池内每条物理连接强制只读；即使实现未来误加 create，也会由 PostgreSQL 拒绝。
    const readOnly = createPrismaReadOnlyConnection(TEST_DATABASE_URL, {
      statementTimeoutMs: 5_000,
      maxConnections: 2,
    });
    try {
      await assert.rejects(() => readOnly.prisma.user.create({
        data: {
          accountName: "must-not-be-created",
          displayName: "只读门禁",
          passwordHash: "not-used",
        },
      }));
    } finally {
      await readOnly.prisma.$disconnect();
      await readOnly.pool.end();
    }
    assert.deepEqual(await readProtectedDatabaseFacts(prisma, resource.id), before);
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
    await connections.maintenancePool.end();
    await connections.collaborationPool.end();
  }
});

class CountingCompactionRepository extends PrismaAnnotationHistoryCompactionRepository {
  payloadBatchQueryCount = 0;

  override async loadSnapshotPayloadBatch(input: {
    annotationFileId: string;
    snapshotIds: string[];
  }) {
    this.payloadBatchQueryCount += 1;
    return super.loadSnapshotPayloadBatch(input);
  }
}

async function readProtectedDatabaseFacts(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  annotationFileId: string,
) {
  const annotationFile = await prisma.annotationFile.findUniqueOrThrow({
    where: { resourceId: annotationFileId },
    select: { revision: true, payload: true, lastOperationSequence: true },
  });
  const snapshots = await prisma.annotationRecoverySnapshot.findMany({
    where: { annotationFileId },
    select: { id: true, revision: true, payload: true, reason: true },
    orderBy: { revision: "asc" },
  });
  return {
    annotationFile: {
      revision: annotationFile.revision,
      lastOperationSequence: annotationFile.lastOperationSequence,
      payloadHash: createAnnotationHistoryCanonicalHash(annotationFile.payload),
    },
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      revision: snapshot.revision,
      reason: snapshot.reason,
      payloadHash: createAnnotationHistoryCanonicalHash(snapshot.payload),
    })),
    operationCount: await prisma.annotationOperation.count({ where: { annotationFileId } }),
    confirmationCount: await prisma.annotationConfirmation.count({ where: { annotationFileId } }),
    rangeCommentCount: await prisma.annotationRangeComment.count({ where: { annotationFileId } }),
    reviewLinkCount: await prisma.annotationReviewLink.count({
      where: { sourceAnnotationFileId: annotationFileId },
    }),
  };
}

function createOperation(
  before: ProjectData,
  after: ProjectData,
  committedRevision: number,
  sequence: number,
  annotationFileId: string,
  actorUserId: string,
) {
  const envelope = buildProjectAnnotationContentCommand(before, after, [{
    entityType: "sentence",
    entityId: "line-1",
    field: "text",
  }]);
  assert.ok(envelope);
  const committedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    annotationFileId,
    actorUserId,
    clientOperationId: `operation-${committedRevision}`,
    requestHash: String(committedRevision).padStart(64, "0"),
    sequence,
    baseRevision: committedRevision - 1,
    action: envelope.command.type,
    payload: toInputJson(envelope),
    status: "accepted" as const,
    committedRevision,
    committedAt,
    createdAt: committedAt,
  };
}

function createProject(text: string): ProjectData {
  return {
    video: { url: "", name: null, source: "url" },
    sentenceAnnotationConfig: { roleOptions: [] },
    subtitleLines: [{
      id: "line-1",
      text,
      startTime: 0,
      endTime: 1,
      deliveryMode: null,
      roleTypes: [],
    }],
    characterAnnotations: [],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字",
      type: "character",
      attachedPointTracks: [],
    }],
    customTracks: [],
    activeTrackOrder: ["character-track"],
  };
}

function toInputJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
