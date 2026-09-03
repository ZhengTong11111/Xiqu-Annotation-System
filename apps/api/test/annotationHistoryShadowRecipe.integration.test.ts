import assert from "node:assert/strict";
import test from "node:test";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
import { AnnotationHistoryShadowRecipeService } from "../src/annotationHistoryShadowRecipeService.js";
import {
  closeAnnotationHistoryTestConnections,
  createAnnotationHistoryFixture,
  createColdAnnotationHistoryPlan,
  enableAnnotationHistoryTestMaintenance,
} from "./annotationHistoryTestFixture.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("HC3a 只写影子 recipe，payload 与 inline 模式保持不变且精确重试幂等", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnnotationHistoryFixture(prisma, "write-idempotent");
    await enableAnnotationHistoryTestMaintenance(prisma);
    const plan = await createColdAnnotationHistoryPlan(prisma, fixture.resourceId);
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
    await closeAnnotationHistoryTestConnections(connections);
  }
});

test("文件 revision 漂移或既有 recipe 冲突会停止写入且保留 payload", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnnotationHistoryFixture(prisma, "write-conflict");
    await enableAnnotationHistoryTestMaintenance(prisma);
    const plan = await createColdAnnotationHistoryPlan(prisma, fixture.resourceId);
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
    await closeAnnotationHistoryTestConnections(connections);
  }
});

test("维护状态未开启时影子 recipe 写入会 fail closed 且不改变快照", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const fixture = await createAnnotationHistoryFixture(prisma, "maintenance-required");
    const plan = await createColdAnnotationHistoryPlan(prisma, fixture.resourceId);
    const target = await prisma.annotationRecoverySnapshot.findFirstOrThrow({
      where: { annotationFileId: fixture.resourceId, revision: 2 },
    });

    const report = await new AnnotationHistoryShadowRecipeService(prisma).writeFileRecipes({
      annotationFileId: fixture.resourceId,
      expectedAnnotationRevision: 4,
      decisions: plan.files[0]!.decisions,
      limitCandidates: 1,
    });

    assert.equal(report.writtenCount, 0);
    assert.equal(report.blockedCount, 1);
    assert.equal(report.results[0]?.code, "maintenance_required");
    const unchanged = await prisma.annotationRecoverySnapshot.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(unchanged.payloadSha256, null);
    assert.equal(unchanged.checkpointSnapshotId, null);
    assert.equal(unchanged.recipeVerifiedAt, null);
    assert.deepEqual(unchanged.payload, target.payload);
  } finally {
    await closeAnnotationHistoryTestConnections(connections);
  }
});
