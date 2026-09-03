import assert from "node:assert/strict";
import test from "node:test";
import { resolveAnnotationRecoverySnapshotPayloadAsync } from "../src/annotationRecoverySnapshotPayloadService.js";
import { loadAnnotationHistoryReconstructionFacts } from "../src/annotationHistoryReconstructionFacts.js";
import { AnnotationHistoryShadowRecipeService } from "../src/annotationHistoryShadowRecipeService.js";
import { AnnotationHistoryStoredRecipeVerificationService } from "../src/annotationHistoryStoredRecipeVerificationService.js";
import { createPrismaReadOnlyConnection } from "../src/database.js";
import {
  closeAnnotationHistoryTestConnections,
  createAnnotationHistoryFixture,
  createAnnotationHistoryProject,
  createColdAnnotationHistoryPlan,
  enableAnnotationHistoryTestMaintenance,
  toInputJson,
} from "./annotationHistoryTestFixture.js";
import { createTestPrisma, TEST_DATABASE_URL, truncateTestDatabase } from "./testEnvironment.js";

test("已存影子 recipe 在可重复读快照中复核通过且不修改数据库", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnnotationHistoryFixture(prisma, "verify-clean");
    const plan = await createColdAnnotationHistoryPlan(prisma, fixture.resourceId);
    await writeRecipes(prisma, fixture.resourceId, plan.files[0]!.decisions, 2);
    const before = await readProtectedFacts(prisma, fixture.resourceId);
    const firstTarget = await prisma.annotationRecoverySnapshot.findFirstOrThrow({
      where: { annotationFileId: fixture.resourceId, recipeVerifiedAt: { not: null } },
      orderBy: { revision: "asc" },
    });

    const loadedFacts = await prisma.$transaction((transaction) =>
      loadAnnotationHistoryReconstructionFacts(transaction, fixture.resourceId, firstTarget));
    assert.equal(loadedFacts.ok, true);
    if (!loadedFacts.ok) return;
    assert.equal(loadedFacts.checkpoint.annotationFileId, fixture.resourceId);
    assert.equal(loadedFacts.checkpoint.revision, loadedFacts.recipe.checkpointRevision);
    assert.equal(loadedFacts.operations.length, loadedFacts.recipe.operationCount);

    const reconstructed = await prisma.$transaction((transaction) =>
      resolveAnnotationRecoverySnapshotPayloadAsync({
        transaction,
        row: {
          ...firstTarget,
          // 数据库行仍为 inline；这里只投影未来形态，证明候选读取不依赖目标 payload。
          storageMode: "reconstructible",
          payload: null,
          compactedAt: new Date("2026-09-02T01:00:00.000Z"),
        },
      }));
    assert.equal(reconstructed.ok, true);
    if (!reconstructed.ok) return;
    assert.deepEqual(reconstructed.payload, fixture.projects[firstTarget.revision - 1]);

    const readOnly = createPrismaReadOnlyConnection(TEST_DATABASE_URL, {
      statementTimeoutMs: 5_000,
      maxConnections: 2,
    });
    let report;
    try {
      report = await new AnnotationHistoryStoredRecipeVerificationService(readOnly.prisma)
        .verifyFileRecipes({ annotationFileId: fixture.resourceId, limitCandidates: 2 });
    } finally {
      await readOnly.prisma.$disconnect();
      await readOnly.pool.end();
    }

    assert.equal(report.fileFound, true);
    assert.equal(report.verifiedCount, 2);
    assert.equal(report.blockedCount, 0);
    assert.equal(report.truncated, false);
    assert.equal(report.interrupted, false);
    assert.deepEqual(await readProtectedFacts(prisma, fixture.resourceId), before);
  } finally {
    await closeAnnotationHistoryTestConnections(connections);
  }
});

test("目标 payload 漂移会固定阻断且复核过程不尝试修复", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnnotationHistoryFixture(prisma, "verify-drift");
    const plan = await createColdAnnotationHistoryPlan(prisma, fixture.resourceId);
    await writeRecipes(prisma, fixture.resourceId, plan.files[0]!.decisions, 1);
    const target = await prisma.annotationRecoverySnapshot.findFirstOrThrow({
      where: { annotationFileId: fixture.resourceId, recipeVerifiedAt: { not: null } },
      orderBy: { revision: "asc" },
    });
    await prisma.annotationRecoverySnapshot.update({
      where: { id: target.id },
      data: { payload: toInputJson(createAnnotationHistoryProject("目标已漂移")) },
    });
    const before = await readProtectedFacts(prisma, fixture.resourceId);

    const report = await new AnnotationHistoryStoredRecipeVerificationService(prisma)
      .verifyFileRecipes({ annotationFileId: fixture.resourceId, limitCandidates: 1 });

    assert.equal(report.blockedCount, 1);
    assert.equal(report.results[0]?.code, "target_payload_hash_changed");
    assert.deepEqual(await readProtectedFacts(prisma, fixture.resourceId), before);
  } finally {
    await closeAnnotationHistoryTestConnections(connections);
  }
});

test("候选截断、checkpoint 缺失和超大 operation recipe 都有稳定边界", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnnotationHistoryFixture(prisma, "verify-bounds");
    const plan = await createColdAnnotationHistoryPlan(prisma, fixture.resourceId);
    await writeRecipes(prisma, fixture.resourceId, plan.files[0]!.decisions, 2);
    const service = new AnnotationHistoryStoredRecipeVerificationService(prisma);

    const truncated = await service.verifyFileRecipes({
      annotationFileId: fixture.resourceId,
      limitCandidates: 1,
    });
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.selectedCandidateCount, 1);
    assert.equal(truncated.verifiedCount, 1);

    const firstTarget = await prisma.annotationRecoverySnapshot.findFirstOrThrow({
      where: { annotationFileId: fixture.resourceId, recipeVerifiedAt: { not: null } },
      orderBy: { revision: "asc" },
    });
    await prisma.annotationRecoverySnapshot.update({
      where: { id: firstTarget.id },
      data: { checkpointSnapshotId: "00000000-0000-4000-8000-000000000099" },
    });
    const missingCheckpoint = await service.verifyFileRecipes({
      annotationFileId: fixture.resourceId,
      limitCandidates: 1,
    });
    assert.equal(missingCheckpoint.results[0]?.code, "checkpoint_missing");

    await prisma.annotationRecoverySnapshot.update({
      where: { id: firstTarget.id },
      data: {
        checkpointSnapshotId: firstTarget.checkpointSnapshotId,
        operationSequenceEnd: 10_001,
        operationCount: 10_001,
      },
    });
    const overLimit = await service.verifyFileRecipes({
      annotationFileId: fixture.resourceId,
      limitCandidates: 1,
    });
    assert.equal(overLimit.results[0]?.code, "recipe_operation_limit_exceeded");
  } finally {
    await closeAnnotationHistoryTestConnections(connections);
  }
});

test("已终止的复核不会读取候选或被误报为正常完成", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnnotationHistoryFixture(prisma, "verify-aborted");
    const plan = await createColdAnnotationHistoryPlan(prisma, fixture.resourceId);
    await writeRecipes(prisma, fixture.resourceId, plan.files[0]!.decisions, 1);
    const abortController = new AbortController();
    abortController.abort();

    const report = await new AnnotationHistoryStoredRecipeVerificationService(prisma)
      .verifyFileRecipes({
        annotationFileId: fixture.resourceId,
        limitCandidates: 1,
        signal: abortController.signal,
      });

    assert.equal(report.interrupted, true);
    assert.equal(report.stoppedEarly, true);
    assert.equal(report.results.length, 0);
  } finally {
    await closeAnnotationHistoryTestConnections(connections);
  }
});

async function writeRecipes(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  annotationFileId: string,
  decisions: Parameters<AnnotationHistoryShadowRecipeService["writeFileRecipes"]>[0]["decisions"],
  limitCandidates: number,
) {
  await enableAnnotationHistoryTestMaintenance(prisma);
  const report = await new AnnotationHistoryShadowRecipeService(prisma).writeFileRecipes({
    annotationFileId,
    expectedAnnotationRevision: 4,
    decisions,
    limitCandidates,
    verifiedAt: new Date("2026-09-02T00:00:00.000Z"),
  });
  assert.equal(report.writtenCount, limitCandidates);
  assert.equal(report.blockedCount, 0);
}

async function readProtectedFacts(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  annotationFileId: string,
) {
  return {
    snapshots: await prisma.annotationRecoverySnapshot.findMany({
      where: { annotationFileId },
      orderBy: [{ revision: "asc" }, { id: "asc" }],
    }),
    operations: await prisma.annotationOperation.findMany({
      where: { annotationFileId },
      orderBy: { sequence: "asc" },
    }),
    annotation: await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: annotationFileId },
    }),
  };
}
