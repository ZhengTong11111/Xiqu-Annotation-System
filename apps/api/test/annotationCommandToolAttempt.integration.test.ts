import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformUser } from "@xiqu/shared";
import {
  buildAnnotationTransactionEnvelope,
  buildTimelineTimingUpdateEnvelope,
  type CommitAnnotationCommandBatchRequest,
} from "@xiqu/shared";
import type { ProjectData } from "@xiqu/document-model";
import { AnnotationCommandCommitService } from "../src/annotationCommandCommitService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";

test("平均重置 attempt 与真实 operation/revision 原子绑定并支持精确重放", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const owner = await createUser(prisma, "tool-commit-owner");
    const fileId = await createAnnotationFile(prisma, owner.id, createProject());
    await createPendingAttempt(prisma, owner.id, fileId);
    const service = createCommitService(prisma);
    const request = createCommandRequest();

    const committed = await service.commitBatch(owner, fileId, request);
    assert.equal(committed.committedRevision, 2);
    assert.equal(committed.operations.length, 1);
    const operation = committed.operations[0]!;
    const attempt = await prisma.annotationToolAttempt.findUniqueOrThrow({
      where: { id: ATTEMPT_ID },
    });
    assert.equal(attempt.outcome, "committed");
    assert.equal(attempt.annotationOperationId, operation.id);
    assert.equal(attempt.committedRevision, 2);
    assert.ok(attempt.finishedAt && attempt.confirmedAt && attempt.finishedAt >= attempt.confirmedAt);

    const stored = await prisma.annotationFile.findUniqueOrThrow({ where: { resourceId: fileId } });
    const project = stored.payload as ProjectData;
    assert.equal(stored.revision, 2);
    assert.deepEqual(
      project.characterAnnotations.map(({ startTime, endTime }) => [startTime, endTime]),
      [[1, 3], [3, 5]],
    );

    // 相同网络重试返回原 operation，旁表终态和文件 revision 都不能再次推进。
    const replayed = await service.commitBatch(owner, fileId, request);
    assert.equal(replayed.operations[0]?.id, operation.id);
    assert.equal((await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: fileId },
    })).revision, 2);
    assert.equal(await prisma.annotationOperation.count({ where: { annotationFileId: fileId } }), 1);
  } finally {
    await closeConnections(connections);
  }
});

test("伪造非平均结果或已结束 attempt 会回滚整个 command commit", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const owner = await createUser(prisma, "tool-commit-reject");
    const fileId = await createAnnotationFile(prisma, owner.id, createProject());
    await createPendingAttempt(prisma, owner.id, fileId);
    const service = createCommitService(prisma);
    const forged = createCommandRequest([[1, 2.5], [2.5, 5]], "forged-operation");
    await assert.rejects(
      () => service.commitBatch(owner, fileId, forged),
      /工具尝试与本次标注命令不匹配/u,
    );
    await assertUnchanged(prisma, fileId);

    await prisma.annotationToolAttempt.update({
      where: { id: ATTEMPT_ID },
      data: {
        outcome: "cancelled",
        finishedAt: new Date("2026-09-02T00:00:02.000Z"),
        details: { reasonCode: "user_cancelled" },
      },
    });
    await assert.rejects(
      () => service.commitBatch(owner, fileId, createCommandRequest(undefined, "terminal-operation")),
      /工具尝试与本次标注命令不匹配/u,
    );
    await assertUnchanged(prisma, fileId);
  } finally {
    await closeConnections(connections);
  }
});

test("其他账号的 attempt 不能被当前提交者绑定", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const owner = await createUser(prisma, "tool-commit-owner-scope");
    const other = await createUser(prisma, "tool-commit-other-scope");
    const fileId = await createAnnotationFile(prisma, owner.id, createProject());
    await createPendingAttempt(prisma, other.id, fileId);
    const service = createCommitService(prisma);
    await assert.rejects(
      () => service.commitBatch(owner, fileId, createCommandRequest()),
      /工具尝试与本次标注命令不匹配/u,
    );
    await assertUnchanged(prisma, fileId);
  } finally {
    await closeConnections(connections);
  }
});

function createCommandRequest(
  after: [[number, number], [number, number]] = [[1, 3], [3, 5]],
  clientOperationId = "tool-commit-operation",
): CommitAnnotationCommandBatchRequest {
  const timing = buildTimelineTimingUpdateEnvelope([{
    entityType: "character",
    entityId: "char-1",
    before: { startTime: 1, endTime: 2 },
    after: { startTime: after[0][0], endTime: after[0][1] },
  }, {
    entityType: "character",
    entityId: "char-2",
    before: { startTime: 2, endTime: 5 },
    after: { startTime: after[1][0], endTime: after[1][1] },
  }]);
  assert.ok(timing);
  const transaction = buildAnnotationTransactionEnvelope([timing]);
  assert.ok(transaction);
  return {
    baseRevision: 1,
    operations: [{
      clientOperationId,
      localRevision: 1,
      toolAttemptId: ATTEMPT_ID,
      action: transaction.command.type,
      payload: transaction,
    }],
  };
}

function createProject(): ProjectData {
  return {
    video: { url: "", name: null, source: "url" },
    sentenceAnnotationConfig: { roleOptions: ["闺门旦"] },
    subtitleLines: [{
      id: "sentence-1",
      text: "寻梦",
      startTime: 1,
      endTime: 5,
      deliveryMode: "sung",
      roleTypes: ["闺门旦"],
    }],
    characterAnnotations: [{
      id: "char-1",
      lineId: "sentence-1",
      char: "寻",
      startTime: 1,
      endTime: 2,
    }, {
      id: "char-2",
      lineId: "sentence-1",
      char: "梦",
      startTime: 2,
      endTime: 5,
    }],
    gongcheAnnotations: [],
    banyanSections: [],
    banyanMarks: [],
    actionAnnotations: [],
    builtinTracks: [{
      id: "character-track",
      name: "逐字文字轨",
      type: "character",
      attachedPointTracks: [],
    }],
    customTracks: [],
    activeTrackOrder: ["character-track"],
  };
}

function createCommitService(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
) {
  return new AnnotationCommandCommitService(
    prisma,
    new ResourceAccessService(prisma),
    { publishRevisionAdvanced() {} },
  );
}

async function createPendingAttempt(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  actorUserId: string,
  annotationFileId: string,
) {
  await prisma.annotationToolAttempt.create({
    data: {
      id: ATTEMPT_ID,
      eventName: "sentence_character_even_timing_reset",
      actorUserId,
      annotationFileId,
      sentenceId: "sentence-1",
      entryPoint: "sentence_list",
      invokedAt: new Date("2026-09-02T00:00:00.000Z"),
      confirmedAt: new Date("2026-09-02T00:00:01.000Z"),
      suppressPrompt: false,
      characterCount: 2,
      sentenceDurationMs: 4_000,
    },
  });
}

async function createUser(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  accountName: string,
): Promise<PlatformUser> {
  const row = await prisma.user.create({
    data: { accountName, displayName: accountName, passwordHash: "not-used" },
  });
  return { id: row.id, accountName: row.accountName, displayName: row.displayName, roles: [] };
}

async function createAnnotationFile(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  ownerUserId: string,
  payload: ProjectData,
) {
  const resource = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: "平均重置.json",
      ownerUserId,
      annotationFile: { create: { payload, lastEditedBy: ownerUserId } },
    },
  });
  return resource.id;
}

async function assertUnchanged(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  annotationFileId: string,
) {
  const file = await prisma.annotationFile.findUniqueOrThrow({
    where: { resourceId: annotationFileId },
  });
  assert.equal(file.revision, 1);
  assert.equal(await prisma.annotationOperation.count({ where: { annotationFileId } }), 0);
  assert.equal(await prisma.annotationRecoverySnapshot.count({ where: { annotationFileId } }), 0);
  assert.equal(await prisma.auditLog.count({ where: { resourceId: annotationFileId } }), 0);
}

async function closeConnections(connections: ReturnType<typeof createTestPrisma>) {
  await connections.prisma.$disconnect();
  await connections.pool.end();
  await connections.maintenancePool.end();
  await connections.collaborationPool.end();
}
