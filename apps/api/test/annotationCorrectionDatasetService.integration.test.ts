import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnotationTransactionEnvelope,
  buildTimelineTimingUpdateEnvelope,
  type PlatformUser,
} from "@xiqu/shared";
import { AnnotationCorrectionDatasetService } from "../src/annotationCorrectionDatasetService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("管理员导出已提交逐字修正，普通账号和超长时间窗均 fail closed", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const [owner, admin] = await Promise.all([
      createUser(prisma, "correction-owner"),
      createUser(prisma, "correction-admin", "super_admin"),
    ]);
    const fileId = await createAnnotationFile(prisma, owner.id);
    const timing = buildTimelineTimingUpdateEnvelope([{
      entityType: "character",
      entityId: "char-1",
      before: { startTime: 1, endTime: 2 },
      after: { startTime: 1.01, endTime: 2.02 },
    }]);
    assert.ok(timing);
    const transaction = buildAnnotationTransactionEnvelope([timing]);
    assert.ok(transaction);
    const operation = await prisma.annotationOperation.create({
      data: {
        annotationFileId: fileId,
        actorUserId: owner.id,
        clientOperationId: "correction-operation",
        requestHash: "a".repeat(64),
        sequence: 1,
        baseRevision: 1,
        action: transaction.command.type,
        payload: transaction,
        status: "accepted",
        committedRevision: 2,
        committedAt: new Date("2026-09-02T12:00:00.000Z"),
      },
    });
    await prisma.annotationToolAttempt.create({
      data: {
        id: "44444444-4444-4444-8444-444444444444",
        eventName: "sentence_character_even_timing_reset",
        actorUserId: owner.id,
        annotationFileId: fileId,
        sentenceId: "sentence-1",
        entryPoint: "timeline_context_menu",
        invokedAt: new Date("2026-09-02T11:59:58.000Z"),
        confirmedAt: new Date("2026-09-02T11:59:59.000Z"),
        finishedAt: new Date("2026-09-02T12:00:00.000Z"),
        outcome: "committed",
        suppressPrompt: false,
        characterCount: 1,
        sentenceDurationMs: 1_000,
        annotationOperationId: operation.id,
        committedRevision: 2,
      },
    });

    const service = new AnnotationCorrectionDatasetService(prisma, new ResourceAccessService(prisma));
    const exported = await service.exportCorrections(admin, {
      from: new Date("2026-09-02T00:00:00.000Z"),
      to: new Date("2026-09-03T00:00:00.000Z"),
    });
    assert.equal(exported.exportedRowCount, 1);
    assert.equal(exported.scannedOperationCount, 1);
    assert.equal(exported.truncated, false);
    assert.match(exported.csv, /sentence_even_reset/u);
    assert.match(exported.csv, /10000/u);
    assert.match(exported.csv, /20000/u);
    assert.doesNotMatch(exported.csv, /ProjectData|媒体|AccessKey|PlayAuth/u);

    await assert.rejects(() => service.exportCorrections(owner, {
      from: new Date("2026-09-02T00:00:00.000Z"),
      to: new Date("2026-09-03T00:00:00.000Z"),
    }), /管理员/u);
    await assert.rejects(() => service.exportCorrections(admin, {
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-09-03T00:00:00.000Z"),
    }), /时间范围/u);
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
    await connections.maintenancePool.end();
    await connections.collaborationPool.end();
  }
});

test("人工修正导出达到一万行后停止并明确报告截断", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const [owner, admin] = await Promise.all([
      createUser(prisma, "correction-limit-owner"),
      createUser(prisma, "correction-limit-admin", "super_admin"),
    ]);
    const fileId = await createAnnotationFile(prisma, owner.id);
    const timing = buildTimelineTimingUpdateEnvelope(Array.from({ length: 500 }, (_, index) => ({
      entityType: "character" as const,
      entityId: `char-${index}`,
      before: { startTime: index, endTime: index + 0.4 },
      after: { startTime: index + 0.01, endTime: index + 0.41 },
    })));
    assert.ok(timing);
    await prisma.annotationOperation.createMany({
      data: Array.from({ length: 21 }, (_, index) => ({
        annotationFileId: fileId,
        actorUserId: owner.id,
        clientOperationId: `correction-limit-${index}`,
        requestHash: String(index).padStart(64, "0"),
        sequence: index + 1,
        baseRevision: index + 1,
        action: timing.command.type,
        payload: timing,
        status: "accepted" as const,
        committedRevision: index + 2,
        committedAt: new Date("2026-09-02T12:00:00.000Z"),
      })),
    });

    const service = new AnnotationCorrectionDatasetService(prisma, new ResourceAccessService(prisma));
    const exported = await service.exportCorrections(admin, {
      from: new Date("2026-09-02T00:00:00.000Z"),
      to: new Date("2026-09-03T00:00:00.000Z"),
    });
    assert.equal(exported.exportedRowCount, 10_000);
    assert.equal(exported.scannedOperationCount, 21);
    assert.equal(exported.truncated, true);
    assert.equal(exported.csv.split("\r\n").length - 2, 10_000);
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
    await connections.maintenancePool.end();
    await connections.collaborationPool.end();
  }
});

async function createUser(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  accountName: string,
  role?: "super_admin",
): Promise<PlatformUser> {
  const row = await prisma.user.create({
    data: {
      accountName,
      displayName: accountName,
      passwordHash: "not-used",
      ...(role ? { roles: { create: { role } } } : {}),
    },
    include: { roles: true },
  });
  return {
    id: row.id,
    accountName: row.accountName,
    displayName: row.displayName,
    roles: row.roles.map(({ role: value }) => value),
  };
}

async function createAnnotationFile(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  ownerUserId: string,
) {
  const resource = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: "人工修正.json",
      ownerUserId,
      annotationFile: { create: { payload: { marker: true }, lastEditedBy: ownerUserId } },
    },
  });
  return resource.id;
}
