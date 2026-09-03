import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { buildProjectAnnotationContentCommand, type ProjectData } from "@xiqu/document-model";
import { resolveAnnotationRecoverySnapshotPayloadAsync } from "../src/annotationRecoverySnapshotPayloadService.js";
import {
  notifyAnnotationHistoryFutureSnapshotObserver,
  writeFutureAnnotationRecoverySnapshot,
} from "../src/annotationHistoryFutureSnapshotWriter.js";
import {
  createTestPrisma,
  truncateTestDatabase,
} from "./testEnvironment.js";

test("显式 rollout 下有效命令链生成 reconstructible 快照并可恢复读取", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const user = await prisma.user.create({
      data: {
        accountName: "future-writer-valid",
        displayName: "未来快照有效链测试",
        passwordHash: "not-used",
      },
    });
    const before = createProject("修改前");
    const after = createProject("修改后");
    const resource = await prisma.resourceEntry.create({
      data: {
        type: "annotation_file",
        name: "future-writer-valid.json",
        ownerUserId: user.id,
        annotationFile: {
          create: {
            payload: toInputJson(after),
            revision: 2,
            lastOperationSequence: 1,
            lastEditedBy: user.id,
          },
        },
      },
    });
    await prisma.annotationRecoverySnapshot.create({
      data: {
        annotationFileId: resource.id,
        revision: 1,
        payload: toInputJson(before),
        createdBy: user.id,
        reason: "save",
        // 夹具必须落在 6 小时 checkpoint 窗口内，才能专门覆盖轻量目标而不是时间检查点。
        createdAt: new Date(Date.now() - 1_000),
      },
    });
    const command = buildProjectAnnotationContentCommand(before, after, [{
      entityType: "sentence",
      entityId: "line-1",
      field: "text",
    }]);
    assert.ok(command);
    await prisma.annotationOperation.create({
      data: {
        annotationFileId: resource.id,
        actorUserId: user.id,
        clientOperationId: "future-writer-operation-1",
        requestHash: "1".repeat(64),
        sequence: 1,
        baseRevision: 1,
        action: command.command.type,
        payload: toInputJson(command),
        status: "accepted",
        committedRevision: 2,
        committedAt: new Date("2026-09-01T00:00:01.000Z"),
      },
    });

    const current = await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: resource.id },
    });
    await prisma.$transaction(async (transaction) => {
      await writeFutureAnnotationRecoverySnapshot(transaction, {
        annotationFileId: resource.id,
        current,
        createdBy: user.id,
        reason: "save",
        rollout: "future-reconstructible-v1",
      });
    });

    const snapshot = await prisma.annotationRecoverySnapshot.findUniqueOrThrow({
      where: {
        annotationFileId_revision: {
          annotationFileId: resource.id,
          revision: 2,
        },
      },
    });
    assert.equal(snapshot.storageMode, "reconstructible");
    assert.equal(snapshot.payload, null);
    assert.equal(snapshot.checkpointSnapshotId !== null, true);
    assert.equal(snapshot.operationCount, 1);
    const resolved = await prisma.$transaction((transaction) =>
      resolveAnnotationRecoverySnapshotPayloadAsync({
        transaction,
        row: snapshot,
      }));
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.deepEqual(resolved.payload, after);
  } finally {
    await closeConnections(connections);
  }
});

test("轻量证明失败时保留完整 inline 快照", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const user = await prisma.user.create({
      data: {
        accountName: "future-writer-fallback",
        displayName: "未来快照回退测试",
        passwordHash: "not-used",
      },
    });
    const before = createProject("证明前");
    const after = createProject("证明后");
    const resource = await prisma.resourceEntry.create({
      data: {
        type: "annotation_file",
        name: "future-writer-fallback.json",
        ownerUserId: user.id,
        annotationFile: {
          create: {
            payload: toInputJson(after),
            revision: 2,
            lastOperationSequence: 1,
            lastEditedBy: user.id,
          },
        },
      },
    });
    await prisma.annotationRecoverySnapshot.create({
      data: {
        annotationFileId: resource.id,
        revision: 1,
        payload: toInputJson(before),
        createdBy: user.id,
        reason: "save",
      },
    });
    // 伪造的命令不能通过正式重放器，写入器必须静默保留完整正文。
    await prisma.annotationOperation.create({
      data: {
        annotationFileId: resource.id,
        actorUserId: user.id,
        clientOperationId: "future-writer-operation-invalid",
        requestHash: "2".repeat(64),
        sequence: 1,
        baseRevision: 1,
        action: "fake.command",
        payload: toInputJson({ fake: true }),
        status: "accepted",
        committedRevision: 2,
      },
    });

    const current = await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: resource.id },
    });
    await prisma.$transaction(async (transaction) => {
      await writeFutureAnnotationRecoverySnapshot(transaction, {
        annotationFileId: resource.id,
        current,
        createdBy: user.id,
        reason: "save",
        rollout: "future-reconstructible-v1",
      });
    });

    const snapshot = await prisma.annotationRecoverySnapshot.findUniqueOrThrow({
      where: {
        annotationFileId_revision: {
          annotationFileId: resource.id,
          revision: 2,
        },
      },
    });
    assert.equal(snapshot.storageMode, "inline");
    assert.deepEqual(snapshot.payload, toInputJson(after));
    assert.equal(snapshot.compactedAt, null);
  } finally {
    await closeConnections(connections);
  }
});

test("关闭 rollout 和特殊保护快照始终保留 inline", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const user = await prisma.user.create({
      data: {
        accountName: "future-writer-disabled",
        displayName: "未来快照关闭态测试",
        passwordHash: "not-used",
      },
    });
    const resource = await createAnnotationResource(prisma, user.id, createProject("关闭态"));
    const current = await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: resource.id },
    });

    const disabled = await prisma.$transaction((transaction) =>
      writeFutureAnnotationRecoverySnapshot(transaction, {
        annotationFileId: resource.id,
        current,
        createdBy: user.id,
        reason: "save",
        rollout: "disabled",
      }));
    assert.equal(disabled.result, "inline");
    assert.equal(disabled.fallbackReason, "rollout_disabled");

    const protectedWrite = await prisma.$transaction((transaction) =>
      writeFutureAnnotationRecoverySnapshot(transaction, {
        annotationFileId: resource.id,
        current: { ...current, revision: 2 },
        createdBy: user.id,
        reason: "before_snapshot_restore",
        rollout: "future-reconstructible-v1",
      }));
    assert.equal(protectedWrite.result, "inline");
    assert.equal(protectedWrite.fallbackReason, "non_save_reason");
    const snapshots = await prisma.annotationRecoverySnapshot.findMany({
      where: { annotationFileId: resource.id },
      orderBy: { revision: "asc" },
    });
    assert.deepEqual(snapshots.map((snapshot) => snapshot.storageMode), ["inline", "inline"]);
    assert.ok(snapshots.every((snapshot) => snapshot.payload !== null));
  } finally {
    await closeConnections(connections);
  }
});

test("同 revision 重试不重算，事务回滚不留下快照", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const user = await prisma.user.create({
      data: {
        accountName: "future-writer-idempotent",
        displayName: "未来快照幂等测试",
        passwordHash: "not-used",
      },
    });
    const before = createProject("幂等前");
    const after = createProject("幂等后");
    const resource = await createAnnotationResource(prisma, user.id, after, 2);
    await prisma.annotationRecoverySnapshot.create({
      data: {
        annotationFileId: resource.id,
        revision: 1,
        payload: toInputJson(before),
        createdBy: user.id,
        reason: "save",
        createdAt: new Date(Date.now() - 1_000),
      },
    });
    const command = buildProjectAnnotationContentCommand(before, after, [{
      entityType: "sentence",
      entityId: "line-1",
      field: "text",
    }]);
    assert.ok(command);
    await prisma.annotationOperation.create({
      data: {
        annotationFileId: resource.id,
        actorUserId: user.id,
        clientOperationId: "future-writer-idempotent-operation",
        requestHash: "3".repeat(64),
        sequence: 1,
        baseRevision: 1,
        action: command.command.type,
        payload: toInputJson(command),
        status: "accepted",
        committedRevision: 2,
        committedAt: new Date("2026-09-01T00:00:01.000Z"),
      },
    });
    const current = await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: resource.id },
    });

    const first = await prisma.$transaction((transaction) =>
      writeFutureAnnotationRecoverySnapshot(transaction, {
        annotationFileId: resource.id,
        current,
        createdBy: user.id,
        reason: "save",
        rollout: "future-reconstructible-v1",
      }));
    const firstSnapshot = await prisma.annotationRecoverySnapshot.findUniqueOrThrow({
      where: { annotationFileId_revision: { annotationFileId: resource.id, revision: 2 } },
    });
    const second = await prisma.$transaction((transaction) =>
      writeFutureAnnotationRecoverySnapshot(transaction, {
        annotationFileId: resource.id,
        current,
        createdBy: user.id,
        reason: "save",
        rollout: "future-reconstructible-v1",
      }));
    const secondSnapshot = await prisma.annotationRecoverySnapshot.findUniqueOrThrow({
      where: { annotationFileId_revision: { annotationFileId: resource.id, revision: 2 } },
    });
    assert.equal(first.result, "reconstructible");
    assert.equal(second.result, "existing");
    assert.equal(secondSnapshot.id, firstSnapshot.id);
    assert.equal(secondSnapshot.createdAt.toISOString(), firstSnapshot.createdAt.toISOString());

    const rollbackResource = await createAnnotationResource(prisma, user.id, createProject("回滚"));
    const rollbackCurrent = await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: rollbackResource.id },
    });
    await assert.rejects(
      prisma.$transaction(async (transaction) => {
        await writeFutureAnnotationRecoverySnapshot(transaction, {
          annotationFileId: rollbackResource.id,
          current: rollbackCurrent,
          createdBy: user.id,
          reason: "save",
          rollout: "future-reconstructible-v1",
        });
        throw new Error("测试事务回滚");
      }),
      /测试事务回滚/u,
    );
    assert.equal(
      await prisma.annotationRecoverySnapshot.count({ where: { annotationFileId: rollbackResource.id } }),
      0,
    );
  } finally {
    await closeConnections(connections);
  }
});

test("观测回调异常不会向保存调用方传播", () => {
  assert.doesNotThrow(() => {
    notifyAnnotationHistoryFutureSnapshotObserver(() => {
      throw new Error("测试指标故障");
    }, {
      rollout: "disabled",
      result: "inline",
      fallbackReason: "rollout_disabled",
      durationMs: 1,
    });
  });
});

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

async function createAnnotationResource(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  ownerUserId: string,
  payload: ProjectData,
  revision = 1,
) {
  return prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: `future-writer-${revision}-${Date.now()}.json`,
      ownerUserId,
      annotationFile: {
        create: {
          payload: toInputJson(payload),
          revision,
          lastOperationSequence: revision > 1 ? 1 : 0,
          lastEditedBy: ownerUserId,
        },
      },
    },
  });
}

async function closeConnections(connections: ReturnType<typeof createTestPrisma>) {
  await connections.prisma.$disconnect();
  await connections.pool.end();
  await connections.maintenancePool.end();
  await connections.collaborationPool.end();
}
