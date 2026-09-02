import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { buildProjectAnnotationContentCommand, type ProjectData } from "@xiqu/document-model";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
import { AnnotationHistoryCompactionPlanner } from "../src/annotationHistoryCompactionPlanner.js";
import { PrismaAnnotationHistoryCompactionRepository } from "../src/annotationHistoryCompactionRepository.js";
import { ANNOTATION_HISTORY_HOUR_MS } from "../src/annotationHistoryCompactionPolicy.js";
import { AnnotationHistoryShadowRecipeService } from "../src/annotationHistoryShadowRecipeService.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("HC3a 只写影子 recipe，payload 与 inline 模式保持不变且精确重试幂等", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createFixture(prisma);
    const plan = await createColdPlan(prisma, fixture.resourceId);
    const targetDecision = plan.files[0]?.decisions.find(({ revision }) => revision === 2);
    assert.equal(targetDecision?.decision, "reconstructible");
    const before = await prisma.annotationRecoverySnapshot.findFirstOrThrow({
      where: { annotationFileId: fixture.resourceId, revision: 2 },
    });
    const beforePayload = structuredClone(before.payload);

    const service = new AnnotationHistoryShadowRecipeService(prisma);
    const first = await service.writeFileRecipes({
      annotationFileId: fixture.resourceId,
      expectedAnnotationRevision: 4,
      decisions: plan.files[0]!.decisions,
      limitCandidates: 1,
      verifiedAt: new Date("2026-09-02T00:00:00.000Z"),
    });
    assert.equal(first.writtenCount, 1);
    assert.equal(first.blockedCount, 0);

    const after = await prisma.annotationRecoverySnapshot.findUniqueOrThrow({
      where: { id: before.id },
    });
    assert.deepEqual(after.payload, beforePayload);
    assert.equal(after.storageMode, "inline");
    assert.equal(after.compactedAt, null);
    assert.equal(after.payloadSha256, createAnnotationHistoryCanonicalHash(beforePayload));
    assert.equal(after.checkpointSnapshotId, plan.files[0]!.decisions[0]!.snapshotId);
    assert.ok(after.recipeVerifiedAt);

    const second = await service.writeFileRecipes({
      annotationFileId: fixture.resourceId,
      expectedAnnotationRevision: 4,
      decisions: plan.files[0]!.decisions,
      limitCandidates: 1,
      verifiedAt: new Date("2026-09-03T00:00:00.000Z"),
    });
    assert.equal(second.alreadyVerifiedCount, 1);
    const afterRetry = await prisma.annotationRecoverySnapshot.findUniqueOrThrow({
      where: { id: before.id },
    });
    assert.equal(afterRetry.recipeVerifiedAt?.toISOString(), "2026-09-02T00:00:00.000Z");
    assert.deepEqual(afterRetry.payload, beforePayload);
  } finally {
    await closeConnections(connections);
  }
});

test("文件 revision 漂移或既有 recipe 冲突会停止写入且保留 payload", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createFixture(prisma);
    const plan = await createColdPlan(prisma, fixture.resourceId);
    const service = new AnnotationHistoryShadowRecipeService(prisma);
    const revisionChanged = await service.writeFileRecipes({
      annotationFileId: fixture.resourceId,
      expectedAnnotationRevision: 3,
      decisions: plan.files[0]!.decisions,
      limitCandidates: 2,
    });
    assert.equal(revisionChanged.blockedCount, 1);
    assert.equal(revisionChanged.results[0]?.code, "annotation_file_revision_changed");
    assert.equal(revisionChanged.stoppedEarly, true);

    const target = await prisma.annotationRecoverySnapshot.findFirstOrThrow({
      where: { annotationFileId: fixture.resourceId, revision: 2 },
    });
    await prisma.annotationRecoverySnapshot.update({
      where: { id: target.id },
      data: { payloadSha256: "0".repeat(64) },
    });
    const conflict = await service.writeFileRecipes({
      annotationFileId: fixture.resourceId,
      expectedAnnotationRevision: 4,
      decisions: plan.files[0]!.decisions,
      limitCandidates: 1,
    });
    assert.equal(conflict.results[0]?.code, "existing_recipe_conflict");
    const unchanged = await prisma.annotationRecoverySnapshot.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(unchanged.payloadSha256, "0".repeat(64));
    assert.equal(unchanged.checkpointSnapshotId, null);
    assert.equal(unchanged.storageMode, "inline");
  } finally {
    await closeConnections(connections);
  }
});

async function createFixture(prisma: ReturnType<typeof createTestPrisma>["prisma"]) {
  const user = await prisma.user.create({
    data: {
      accountName: `shadow-${Date.now()}`,
      displayName: "影子 recipe 测试",
      passwordHash: "not-used",
    },
  });
  const projects = ["甲", "乙", "丙", "丁"].map(createProject);
  const resource = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: "影子历史测试.json",
      ownerUserId: user.id,
      annotationFile: {
        create: {
          payload: toInputJson(projects[3]!),
          revision: 4,
          lastOperationSequence: 3,
          lastEditedBy: user.id,
        },
      },
    },
  });
  await prisma.annotationRecoverySnapshot.createMany({
    data: projects.map((project, index) => ({
      annotationFileId: resource.id,
      revision: index + 1,
      payload: toInputJson(project),
      createdBy: user.id,
      reason: "save",
      createdAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
    })),
  });
  await prisma.annotationOperation.createMany({
    data: projects.slice(1).map((project, index) => {
      const envelope = buildProjectAnnotationContentCommand(projects[index]!, project, [{
        entityType: "sentence",
        entityId: "line-1",
        field: "text",
      }]);
      assert.ok(envelope);
      return {
        annotationFileId: resource.id,
        actorUserId: user.id,
        clientOperationId: `shadow-operation-${index + 2}`,
        requestHash: String(index + 2).padStart(64, "0"),
        sequence: index + 1,
        baseRevision: index + 1,
        action: envelope.command.type,
        payload: toInputJson(envelope),
        status: "accepted" as const,
        committedRevision: index + 2,
        committedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
    }),
  });
  return { resourceId: resource.id };
}

async function createColdPlan(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  annotationFileId: string,
) {
  return new AnnotationHistoryCompactionPlanner(
    new PrismaAnnotationHistoryCompactionRepository(prisma),
  ).plan({
    annotationFileId,
    maxRevisionsPerFile: 100,
    maxOperationsPerFile: 100,
    now: new Date("2026-09-02T00:00:00.000Z"),
    policy: {
      hotWindowMs: ANNOTATION_HISTORY_HOUR_MS,
      recentSnapshotCount: 1,
      checkpointRevisionInterval: 1_000,
      checkpointOperationInterval: 10_000,
      checkpointTimeIntervalMs: 365 * 24 * ANNOTATION_HISTORY_HOUR_MS,
    },
  });
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

async function closeConnections(connections: ReturnType<typeof createTestPrisma>) {
  await connections.prisma.$disconnect();
  await connections.pool.end();
  await connections.maintenancePool.end();
  await connections.collaborationPool.end();
}
