import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PlatformUser, SubmitAnnotationToolAttemptBatchRequest } from "@xiqu/shared";
import { AnnotationToolAttemptService } from "../src/annotationToolAttemptService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

test("工具尝试批量幂等、单调补齐、撤权送达与管理员汇总", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const [owner, annotator, outsider, admin] = await Promise.all([
      createUser(prisma, "attempt-owner"),
      createUser(prisma, "attempt-annotator"),
      createUser(prisma, "attempt-outsider"),
      createUser(prisma, "attempt-admin", "super_admin"),
    ]);
    const fileId = await createAnnotationFile(prisma, owner.id);
    await prisma.resourcePermission.create({
      data: {
        resourceId: fileId,
        userId: annotator.id,
        capabilities: ["read", "write"],
        inheritToChildren: false,
        createdBy: owner.id,
      },
    });
    const service = new AnnotationToolAttemptService(prisma, new ResourceAccessService(prisma));
    const initial = createRequest(fileId);
    const [created, replayed, concurrentReplay] = await Promise.all([
      service.submitBatch(annotator, initial),
      service.submitBatch(annotator, initial),
      service.submitBatch(annotator, initial),
    ]);
    assert.equal(created.attempts[0]?.id, replayed.attempts[0]?.id);
    assert.equal(created.attempts[0]?.id, concurrentReplay.attempts[0]?.id);
    assert.equal(await prisma.annotationToolAttempt.count(), 1);

    await prisma.resourcePermission.deleteMany({ where: { resourceId: fileId, userId: annotator.id } });
    const completedRequest = createRequest(fileId, {
      confirmedAt: "2026-09-02T00:00:01.000Z",
      finishedAt: "2026-09-02T00:00:02.000Z",
      outcome: "no_change",
      suppressPrompt: true,
      details: { reasonCode: "no_timing_change" },
    });
    const completed = await service.submitBatch(annotator, completedRequest);
    assert.equal(completed.attempts[0]?.outcome, "no_change");
    assert.equal(completed.attempts[0]?.suppressPrompt, true);
    // 迟到的 invoked 状态只是已保存状态的前缀，不能把终态和“不再提示”倒退。
    const staleReplay = await service.submitBatch(annotator, initial);
    assert.equal(staleReplay.attempts[0]?.outcome, "no_change");
    assert.equal(staleReplay.attempts[0]?.suppressPrompt, true);

    await assert.rejects(() => service.submitBatch(outsider, initial), /不存在/u);
    await assert.rejects(() => service.submitBatch(annotator, createRequest(fileId, {
      sentenceId: "other-sentence",
    })), /另一项调用/u);
    await assert.rejects(() => service.submitBatch(outsider, createRequest(fileId, {
      id: "22222222-2222-4222-8222-222222222222",
    })), /write/u);

    const summary = await service.summarize(admin, {
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-09-03T00:00:00.000Z"),
    });
    assert.equal(summary.total, 1);
    assert.equal(summary.byOutcome.no_change, 1);
    assert.equal(summary.byOutcome.pending, 0);
    await assert.rejects(() => service.summarize(annotator, {
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-09-03T00:00:00.000Z"),
    }), /管理员/u);
  } finally {
    await closeConnections(connections);
  }
});

test("文件、operation 和账号删除后工具尝试通过 SetNull 保留", async () => {
  const connections = createTestPrisma();
  const { prisma } = connections;
  await truncateTestDatabase(prisma);
  try {
    const owner = await createUser(prisma, "attempt-set-null");
    const fileId = await createAnnotationFile(prisma, owner.id);
    const operation = await prisma.annotationOperation.create({
      data: {
        annotationFileId: fileId,
        actorUserId: owner.id,
        clientOperationId: "set-null-operation",
        requestHash: "a".repeat(64),
        sequence: 1,
        baseRevision: 1,
        action: "annotation.content.update",
        payload: {},
        status: "accepted",
        committedRevision: 2,
        committedAt: new Date("2026-09-02T00:00:02.000Z"),
      },
    });
    await prisma.annotationToolAttempt.create({
      data: {
        id: ATTEMPT_ID,
        eventName: "sentence_character_even_timing_reset",
        actorUserId: owner.id,
        annotationFileId: fileId,
        sentenceId: "sentence-1",
        entryPoint: "sentence_list",
        invokedAt: new Date("2026-09-02T00:00:00.000Z"),
        confirmedAt: new Date("2026-09-02T00:00:01.000Z"),
        finishedAt: new Date("2026-09-02T00:00:02.000Z"),
        outcome: "committed",
        characterCount: 4,
        sentenceDurationMs: 2_000,
        annotationOperationId: operation.id,
        committedRevision: 2,
      },
    });

    await prisma.resourceEntry.delete({ where: { id: fileId } });
    let retained = await prisma.annotationToolAttempt.findUniqueOrThrow({ where: { id: ATTEMPT_ID } });
    assert.equal(retained.annotationFileId, null);
    assert.equal(retained.annotationOperationId, null);
    assert.equal(retained.committedRevision, 2);
    await prisma.user.delete({ where: { id: owner.id } });
    retained = await prisma.annotationToolAttempt.findUniqueOrThrow({ where: { id: ATTEMPT_ID } });
    assert.equal(retained.actorUserId, null);
  } finally {
    await closeConnections(connections);
  }
});

test("FA-D1a migration 不允许改写既有核心大表", async () => {
  const sql = await readFile(
    new URL("../../../prisma/migrations/20260902020000_annotation_tool_attempts/migration.sql", import.meta.url),
    "utf8",
  );
  for (const table of ["annotation_files", "annotation_operations", "annotation_recovery_snapshots"]) {
    assert.doesNotMatch(sql, new RegExp(`(?:UPDATE|DELETE\\s+FROM|DROP\\s+TABLE|ALTER\\s+TABLE)\\s+"${table}"`, "iu"));
  }
  assert.match(sql, /ON DELETE SET NULL/iu);
  assert.match(sql, /octet_length\("details"::text\) <= 2048/iu);
});

function createRequest(
  annotationFileId: string,
  overrides: Partial<SubmitAnnotationToolAttemptBatchRequest["attempts"][number]> = {},
): SubmitAnnotationToolAttemptBatchRequest {
  return { attempts: [{
    id: ATTEMPT_ID,
    eventName: "sentence_character_even_timing_reset",
    annotationFileId,
    sentenceId: "sentence-1",
    entryPoint: "sentence_list",
    invokedAt: "2026-09-02T00:00:00.000Z",
    confirmedAt: null,
    finishedAt: null,
    outcome: null,
    suppressPrompt: false,
    characterCount: 4,
    sentenceDurationMs: 2_000,
    details: null,
    ...overrides,
  }] };
}

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
  return { id: row.id, accountName: row.accountName, displayName: row.displayName, roles: row.roles.map(({ role: value }) => value) };
}

async function createAnnotationFile(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  ownerUserId: string,
) {
  const resource = await prisma.resourceEntry.create({
    data: {
      type: "annotation_file",
      name: "工具尝试.json",
      ownerUserId,
      annotationFile: { create: { payload: { marker: true }, lastEditedBy: ownerUserId } },
    },
  });
  return resource.id;
}

async function closeConnections(connections: ReturnType<typeof createTestPrisma>) {
  await connections.prisma.$disconnect();
  await connections.pool.end();
  await connections.maintenancePool.end();
  await connections.collaborationPool.end();
}
