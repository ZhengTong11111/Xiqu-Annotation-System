import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PlatformUser, ResourceCapability } from "@xiqu/shared";
import { AlignmentResearchGroupService } from "../src/alignmentResearchGroupService.js";
import { ResourceAccessService } from "../src/resourceAccess.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

test("研究分组 UUID 创建幂等且不会自动改写项目集合", async () => {
  await withFixture(async ({ prisma, service, fixture }) => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const request = { id: groupId, kind: "work" as const, displayName: "牡丹亭" };
    const created = await service.create(fixture.manager, fixture.projectId, request);
    assert.equal(created.id, groupId);
    assert.equal((await service.getProjectGroups(fixture.reader, fixture.projectId)).groups.length, 0);

    const replayed = await service.create(fixture.manager, fixture.projectId, request);
    assert.deepEqual(replayed, created);
    assert.equal(await prisma.alignmentResearchGroup.count(), 1);
    assert.equal(await prisma.auditLog.count({
      where: { action: "alignment_research_group_create" },
    }), 1);

    await assert.rejects(
      service.create(fixture.manager, fixture.projectId, {
        ...request,
        displayName: "同一 UUID 的另一语义",
      }),
      hasConflictCode("alignment_research_group_identity_conflict"),
    );
    await assert.rejects(
      service.create(fixture.otherManager, fixture.projectId, request),
      hasConflictCode("alignment_research_group_identity_conflict"),
    );
    await assert.rejects(
      service.create(fixture.reader, fixture.projectId, {
        id: randomUUID(),
        kind: "performer",
        displayName: "无管理权限",
      }),
      hasStatus(403),
    );
  });
});

test("候选搜索使用有界筛选游标且只向项目管理者开放", async () => {
  await withFixture(async ({ service, fixture }) => {
    const groups = [
      { id: "20000000-0000-4000-8000-000000000001", kind: "work" as const, displayName: "牡丹亭" },
      { id: "20000000-0000-4000-8000-000000000002", kind: "performer" as const, displayName: "俞振飞" },
      { id: "20000000-0000-4000-8000-000000000003", kind: "performer" as const, displayName: "张继青" },
    ];
    for (const group of groups) await service.create(fixture.manager, fixture.projectId, group);

    const first = await service.listCandidates(fixture.manager, fixture.projectId, {
      kind: "performer",
      limit: 1,
    });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await service.listCandidates(fixture.manager, fixture.projectId, {
      kind: "performer",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0]?.id, first.items[0]?.id);

    const query = await service.listCandidates(fixture.manager, fixture.projectId, {
      query: "牡丹",
      limit: 20,
    });
    assert.deepEqual(query.items.map(({ displayName }) => displayName), ["牡丹亭"]);
    await assert.rejects(
      service.listCandidates(fixture.manager, fixture.projectId, {
        kind: "work",
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      }),
      hasStatus(400),
    );
    await assert.rejects(
      service.listCandidates(fixture.reader, fixture.projectId, {}),
      hasStatus(403),
    );
  });
});

test("完整集合以 revision 防止旧管理端覆盖并保留同目标幂等", async () => {
  await withFixture(async ({ prisma, service, fixture }) => {
    const workId = "30000000-0000-4000-8000-000000000001";
    const performerId = "30000000-0000-4000-8000-000000000002";
    await service.create(fixture.manager, fixture.projectId, {
      id: workId,
      kind: "work",
      displayName: "长生殿",
    });
    await service.create(fixture.manager, fixture.projectId, {
      id: performerId,
      kind: "performer",
      displayName: "蔡正仁",
    });

    const first = await service.replaceProjectGroups(fixture.manager, fixture.projectId, {
      expectedRevision: 0,
      groupIds: [workId, performerId].sort(),
    });
    assert.equal(first.revision, 1);
    assert.deepEqual(first.groups.map(({ kind }) => kind), ["work", "performer"]);
    const assignedAt = await prisma.projectAlignmentResearchGroup.findFirstOrThrow({
      where: { projectResourceId: fixture.projectId, researchGroupId: workId },
      select: { assignedAt: true },
    });

    // 第一次响应若丢失，旧 expectedRevision + 完全相同目标可读取已提交结果，不制造第二 revision。
    const replayed = await service.replaceProjectGroups(fixture.manager, fixture.projectId, {
      expectedRevision: 0,
      groupIds: [workId, performerId].sort(),
    });
    assert.equal(replayed.revision, 1);
    assert.equal(await prisma.auditLog.count({
      where: { action: "project_alignment_research_groups_update" },
    }), 1);
    assert.deepEqual(await prisma.projectAlignmentResearchGroup.findFirstOrThrow({
      where: { projectResourceId: fixture.projectId, researchGroupId: workId },
      select: { assignedAt: true },
    }), assignedAt);

    await assert.rejects(
      service.replaceProjectGroups(fixture.otherManager, fixture.projectId, {
        expectedRevision: 0,
        groupIds: [workId],
      }),
      hasConflictCode("alignment_research_group_revision_conflict"),
    );
    const changed = await service.replaceProjectGroups(fixture.otherManager, fixture.projectId, {
      expectedRevision: 1,
      groupIds: [workId],
    });
    assert.equal(changed.revision, 2);
    assert.deepEqual(changed.groups.map(({ id }) => id), [workId]);
    assert.equal((await service.getProjectGroups(fixture.reader, fixture.projectId)).revision, 2);

    await assert.rejects(
      service.replaceProjectGroups(fixture.manager, fixture.projectId, {
        expectedRevision: 2,
        groupIds: [randomUUID()],
      }),
      hasStatus(400),
    );
  });
});

test("撤权和项目归档会在权威边界阻断后续研究分组写入", async () => {
  await withFixture(async ({ prisma, service, fixture }) => {
    await prisma.resourcePermission.deleteMany({
      where: { resourceId: fixture.projectId, userId: fixture.manager.id },
    });
    await assert.rejects(
      service.create(fixture.manager, fixture.projectId, {
        id: randomUUID(),
        kind: "work",
        displayName: "撤权后创建",
      }),
      hasStatus(403),
    );

    await prisma.resourceEntry.update({
      where: { id: fixture.projectId },
      data: { archivedAt: new Date() },
    });
    await assert.rejects(
      service.getProjectGroups(fixture.owner, fixture.projectId),
      hasConflictCode("alignment_research_project_inactive"),
    );
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
  const owner = await createUser(prisma, "research-owner");
  const manager = await createUser(prisma, "research-manager");
  const otherManager = await createUser(prisma, "research-manager-2");
  const reader = await createUser(prisma, "research-reader");
  const project = await prisma.resourceEntry.create({
    data: {
      type: "project",
      name: "研究分组项目",
      ownerUserId: owner.id,
      projectMetadata: { create: { description: "fixture" } },
    },
  });
  await grant(prisma, project.id, owner.id, manager.id, ["read", "manage_permissions"]);
  await grant(prisma, project.id, owner.id, otherManager.id, ["read", "manage_permissions"]);
  await grant(prisma, project.id, owner.id, reader.id, ["read"]);
  return {
    prisma,
    service: new AlignmentResearchGroupService(prisma, new ResourceAccessService(prisma)),
    fixture: {
      owner: toApiUser(owner),
      manager: toApiUser(manager),
      otherManager: toApiUser(otherManager),
      reader: toApiUser(reader),
      projectId: project.id,
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
