import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApiApp } from "../src/app.js";
import { LocalObjectStorage } from "../src/storage.js";
import { createTestPrisma, truncateTestDatabase } from "./testEnvironment.js";

type JsonObject = Record<string, unknown>;

test("标注工作流状态与项目职责组遵守权限、顺序和递归汇总", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "xiqu-workflow-test-"));
  const connections = createTestPrisma();
  const { prisma, pool, maintenancePool, collaborationPool, schema } = connections;
  await truncateTestDatabase(prisma);
  const app = await buildApiApp({
    prisma,
    maintenancePool,
    collaborationPool,
    databaseSchema: schema,
    storage: new LocalObjectStorage(storageRoot),
    logger: false,
    seed: true,
  });
  await app.ready();

  try {
    const adminToken = (await login(app, "admin", "admin123")).accessToken;
    const studentToken = (await login(app, "student", "student123")).accessToken;
    const reviewerToken = (await login(app, "ta", "ta123")).accessToken;
    const admin = await prisma.user.findUniqueOrThrow({ where: { accountName: "admin" } });
    const student = await prisma.user.findUniqueOrThrow({ where: { accountName: "student" } });
    const reviewer = await prisma.user.findUniqueOrThrow({ where: { accountName: "ta" } });

    const project = await prisma.resourceEntry.create({
      data: {
        type: "project",
        name: "工作流测试项目",
        ownerUserId: admin.id,
        projectMetadata: { create: { description: "workflow" } },
      },
    });
    const folder = await prisma.resourceEntry.create({
      data: {
        parentId: project.id,
        type: "folder",
        name: "嵌套目录",
        ownerUserId: admin.id,
      },
    });
    const file = await createAnnotationFile(prisma, {
      parentId: folder.id,
      ownerUserId: admin.id,
      lastEditedBy: admin.id,
      name: "第一份标注.json",
    });
    await prisma.resourcePermission.createMany({
      data: [
        {
          resourceId: file.id,
          userId: student.id,
          capabilities: ["read", "write"],
          inheritToChildren: false,
          createdBy: admin.id,
        },
        {
          resourceId: file.id,
          userId: reviewer.id,
          capabilities: ["read", "review"],
          inheritToChildren: false,
          createdBy: admin.id,
        },
      ],
    });

    const initial = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/resources/${file.id}`,
    });
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(dataOf(initial.json()).workflowStatus, "unannotated");

    // 审核者即使有 review，也不能越过“已标注”阶段直接完成审核。
    const skipped = await updateStatus(app, reviewerToken, file.id, {
      expectedStatus: "unannotated",
      status: "reviewed",
    });
    assert.equal(skipped.statusCode, 409, skipped.body);

    const annotated = await updateStatus(app, studentToken, file.id, {
      expectedStatus: "unannotated",
      status: "annotated",
    });
    assert.equal(annotated.statusCode, 200, annotated.body);
    assert.equal(dataOf(annotated.json()).workflowStatus, "annotated");
    const storedAfterAnnotation = await prisma.annotationFile.findUniqueOrThrow({
      where: { resourceId: file.id },
    });
    assert.equal(storedAfterAnnotation.revision, 1);
    assert.deepEqual(storedAfterAnnotation.payload, { marker: "unchanged" });
    assert.equal(storedAfterAnnotation.workflowUpdatedBy, student.id);

    const writeCannotReview = await updateStatus(app, studentToken, file.id, {
      expectedStatus: "annotated",
      status: "reviewed",
    });
    assert.equal(writeCannotReview.statusCode, 403, writeCannotReview.body);

    const stale = await updateStatus(app, reviewerToken, file.id, {
      expectedStatus: "unannotated",
      status: "annotated",
    });
    assert.equal(stale.statusCode, 409, stale.body);

    const reviewed = await updateStatus(app, reviewerToken, file.id, {
      expectedStatus: "annotated",
      status: "reviewed",
    });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.equal(dataOf(reviewed.json()).workflowStatus, "reviewed");

    const writeCannotWithdrawReview = await updateStatus(
      app,
      studentToken,
      file.id,
      { expectedStatus: "reviewed", status: "annotated" },
    );
    assert.equal(writeCannotWithdrawReview.statusCode, 403, writeCannotWithdrawReview.body);
    const reviewWithdrawn = await updateStatus(app, reviewerToken, file.id, {
      expectedStatus: "reviewed",
      status: "annotated",
    });
    assert.equal(reviewWithdrawn.statusCode, 200, reviewWithdrawn.body);

    const projectAnnotated = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/resources/${project.id}`,
    });
    assert.equal(dataOf(projectAnnotated.json()).workflowStatus, "annotated");

    const secondFile = await createAnnotationFile(prisma, {
      parentId: folder.id,
      ownerUserId: admin.id,
      lastEditedBy: admin.id,
      name: "第二份标注.json",
      workflowStatus: "reviewed",
    });
    const projectReviewed = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/resources/${project.id}`,
    });
    assert.equal(dataOf(projectReviewed.json()).workflowStatus, "reviewed");
    await prisma.resourceEntry.update({
      where: { id: secondFile.id },
      data: { trashedAt: new Date() },
    });
    const projectAfterTrash = await jsonRequest(app, adminToken, {
      method: "GET",
      url: `/api/resources/${project.id}`,
    });
    assert.equal(dataOf(projectAfterTrash.json()).workflowStatus, "annotated");

    const forbiddenGroups = await jsonRequest(app, studentToken, {
      method: "GET",
      url: `/api/projects/${project.id}/workflow-groups`,
    });
    assert.equal(forbiddenGroups.statusCode, 403, forbiddenGroups.body);
    const groups = await jsonRequest(app, adminToken, {
      method: "PUT",
      url: `/api/projects/${project.id}/workflow-groups`,
      payload: {
        annotationUserIds: [student.id],
        reviewUserIds: [reviewer.id, student.id],
      },
    });
    assert.equal(groups.statusCode, 200, groups.body);
    const groupData = dataOf(groups.json());
    assert.deepEqual(
      (groupData.annotation as JsonObject[]).map(({ id }) => id),
      [student.id],
    );
    assert.deepEqual(
      new Set((groupData.review as JsonObject[]).map(({ id }) => id)),
      new Set([reviewer.id, student.id]),
    );

    const list = await jsonRequest(app, adminToken, {
      method: "GET",
      url: "/api/resources?view=all_projects&sortBy=name&direction=asc",
    });
    assert.equal(list.statusCode, 200, list.body);
    const listedProject = (dataOf(list.json()).items as JsonObject[])
      .find(({ id }) => id === project.id);
    assert.ok(listedProject);
    assert.equal(listedProject.workflowStatus, "annotated");
    assert.deepEqual(
      (listedProject.annotationResponsibles as JsonObject[]).map(({ id }) => id),
      [student.id],
    );

    const duplicateGroupMember = await jsonRequest(app, adminToken, {
      method: "PUT",
      url: `/api/projects/${project.id}/workflow-groups`,
      payload: {
        annotationUserIds: [student.id, student.id],
        reviewUserIds: [],
      },
    });
    assert.equal(duplicateGroupMember.statusCode, 400, duplicateGroupMember.body);
    const unknownGroupMember = await jsonRequest(app, adminToken, {
      method: "PUT",
      url: `/api/projects/${project.id}/workflow-groups`,
      payload: {
        annotationUserIds: ["missing-account"],
        reviewUserIds: [],
      },
    });
    assert.equal(unknownGroupMember.statusCode, 400, unknownGroupMember.body);

    const destinationProject = await prisma.resourceEntry.create({
      data: {
        type: "project",
        name: "状态移动目标项目",
        ownerUserId: admin.id,
        projectMetadata: { create: { description: "move target" } },
      },
    });
    const destinationFolder = await prisma.resourceEntry.create({
      data: {
        parentId: destinationProject.id,
        type: "folder",
        name: "目标目录",
        ownerUserId: admin.id,
      },
    });
    const moved = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/resources/${file.id}/move`,
      payload: { parentId: destinationFolder.id },
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(await readWorkflowStatus(app, adminToken, project.id), "unannotated");
    assert.equal(await readWorkflowStatus(app, adminToken, destinationProject.id), "annotated");

    const trashed = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/resources/${file.id}/trash`,
    });
    assert.equal(trashed.statusCode, 200, trashed.body);
    assert.equal(await readWorkflowStatus(app, adminToken, destinationProject.id), "unannotated");
    const restored = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/resources/${file.id}/restore`,
    });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(await readWorkflowStatus(app, adminToken, destinationProject.id), "annotated");

    const movedBack = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/resources/${file.id}/move`,
      payload: { parentId: folder.id },
    });
    assert.equal(movedBack.statusCode, 200, movedBack.body);
    assert.equal(await readWorkflowStatus(app, adminToken, project.id), "annotated");

    const copiedFileResponse = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/resources/${file.id}/copy`,
      payload: { parentId: folder.id, name: "标注副本.json" },
    });
    assert.equal(copiedFileResponse.statusCode, 200, copiedFileResponse.body);
    const copiedFile = dataOf(copiedFileResponse.json());
    assert.equal(copiedFile.workflowStatus, "unannotated");

    const copyTarget = await prisma.resourceEntry.create({
      data: {
        type: "folder",
        name: "项目副本目标",
        ownerUserId: admin.id,
      },
    });
    const copiedProjectResponse = await jsonRequest(app, adminToken, {
      method: "POST",
      url: `/api/resources/${project.id}/copy`,
      payload: { parentId: copyTarget.id, name: "工作流项目副本" },
    });
    assert.equal(copiedProjectResponse.statusCode, 200, copiedProjectResponse.body);
    const copiedProject = dataOf(copiedProjectResponse.json());
    const copiedGroups = await prisma.projectWorkflowMember.findMany({
      where: { projectResourceId: String(copiedProject.id) },
    });
    // 完成结论与人员分工都不能被复制为新工作的既成事实。
    assert.equal(copiedProject.workflowStatus, "unannotated");
    assert.deepEqual(copiedGroups, []);

    const workflowAudits = await prisma.auditLog.findMany({
      where: {
        resourceId: { in: [file.id, project.id] },
        action: {
          in: [
            "annotation_workflow_status_update",
            "project_workflow_groups_update",
          ],
        },
      },
    });
    assert.equal(workflowAudits.length, 4);
    assert.doesNotMatch(JSON.stringify(workflowAudits), /unchanged/);
  } finally {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await maintenancePool.end();
    await collaborationPool.end();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

async function createAnnotationFile(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  input: {
    parentId: string;
    ownerUserId: string;
    lastEditedBy: string;
    name: string;
    workflowStatus?: "unannotated" | "annotated" | "reviewed";
  },
) {
  return prisma.resourceEntry.create({
    data: {
      parentId: input.parentId,
      type: "annotation_file",
      name: input.name,
      ownerUserId: input.ownerUserId,
      annotationFile: {
        create: {
          payload: { marker: "unchanged" },
          lastEditedBy: input.lastEditedBy,
          workflowStatus: input.workflowStatus,
        },
      },
    },
  });
}

function updateStatus(
  app: FastifyInstance,
  token: string,
  resourceId: string,
  payload: { expectedStatus: string; status: string },
) {
  return jsonRequest(app, token, {
    method: "PATCH",
    url: `/api/annotation-files/${resourceId}/workflow-status`,
    payload,
  });
}

async function readWorkflowStatus(
  app: FastifyInstance,
  token: string,
  resourceId: string,
) {
  const response = await jsonRequest(app, token, {
    method: "GET",
    url: `/api/resources/${resourceId}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  return dataOf(response.json()).workflowStatus;
}

async function login(app: FastifyInstance, accountName: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { accountName, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  return dataOf(response.json()) as { accessToken: string };
}

function jsonRequest(app: FastifyInstance, token: string, options: InjectOptions) {
  return app.inject({
    ...options,
    headers: { ...options.headers, authorization: `Bearer ${token}` },
  });
}

function dataOf(value: unknown): JsonObject {
  const envelope = recordOf(value);
  assert.ok("data" in envelope);
  return recordOf(envelope.data);
}

function recordOf(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}
