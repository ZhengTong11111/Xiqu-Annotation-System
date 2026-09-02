import assert from "node:assert/strict";
import test from "node:test";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
import { AnnotationHistoryCapacityMetricsCollector } from "../src/annotationHistoryCapacityMetrics.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("容量指标在隔离 PostgreSQL 聚合轻量列且不修改快照", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const user = await prisma.user.create({
      data: {
        accountName: "history-capacity",
        displayName: "容量指标测试",
        passwordHash: "not-used",
      },
    });
    const resource = await prisma.resourceEntry.create({
      data: {
        type: "annotation_file",
        name: "容量指标测试.json",
        ownerUserId: user.id,
        annotationFile: {
          create: {
            payload: { marker: "current" },
            lastEditedBy: user.id,
          },
        },
      },
    });
    const now = new Date("2026-09-02T12:00:00.000Z");
    const payloads = [
      { revision: 1, marker: "recent" },
      { revision: 2, marker: "week" },
      { revision: 3, marker: "old" },
    ];
    await prisma.annotationRecoverySnapshot.createMany({
      data: [
        {
          annotationFileId: resource.id,
          revision: 1,
          payload: payloads[0]!,
          payloadSha256: createAnnotationHistoryCanonicalHash(payloads[0]!),
          createdBy: user.id,
          reason: "save",
          createdAt: new Date(now.getTime() - 12 * 60 * 60 * 1_000),
        },
        {
          annotationFileId: resource.id,
          revision: 2,
          payload: payloads[1]!,
          createdBy: user.id,
          reason: "save",
          createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000),
        },
        {
          annotationFileId: resource.id,
          revision: 3,
          payload: payloads[2]!,
          createdBy: user.id,
          reason: "save",
          createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000),
        },
      ],
    });
    const before = await prisma.annotationRecoverySnapshot.findMany({
      select: { id: true, revision: true, payload: true, payloadSha256: true },
      orderBy: { revision: "asc" },
    });

    const snapshot = await new AnnotationHistoryCapacityMetricsCollector(prisma).collect(now);

    assert.deepEqual(snapshot.snapshotsByStorageMode, { inline: 3, reconstructible: 0, archived: 0 });
    assert.deepEqual(snapshot.payloadsByState, { present: 3, missing: 0 });
    assert.deepEqual(snapshot.hashesByState, { present: 1, missing: 2 });
    assert.deepEqual(snapshot.recentCreated, { "24h": 1, "7d": 2 });
    assert.ok(snapshot.relationTotalBytes > 0);
    assert.deepEqual(await prisma.annotationRecoverySnapshot.findMany({
      select: { id: true, revision: true, payload: true, payloadSha256: true },
      orderBy: { revision: "asc" },
    }), before);
  } finally {
    await connections.prisma.$disconnect();
    await connections.pool.end();
    await connections.maintenancePool.end();
    await connections.collaborationPool.end();
  }
});
