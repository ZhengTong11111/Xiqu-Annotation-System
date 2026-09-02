import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { buildProjectAnnotationContentCommand, type ProjectData } from "@xiqu/document-model";
import { AnnotationHistoryCompactionPlanner } from "../src/annotationHistoryCompactionPlanner.js";
import { PrismaAnnotationHistoryCompactionRepository } from "../src/annotationHistoryCompactionRepository.js";
import { ANNOTATION_HISTORY_HOUR_MS } from "../src/annotationHistoryCompactionPolicy.js";
import type { createTestPrisma } from "./testEnvironment.js";

/** 为容量/影子集成测试建立同一份小型、完整、可重放历史。 */
export async function createAnnotationHistoryFixture(
  prisma: ReturnType<typeof createTestPrisma>["prisma"],
  accountSuffix = `${Date.now()}`,
) {
  const user = await prisma.user.create({
    data: {
      accountName: `history-shadow-${accountSuffix}`,
      displayName: "影子 recipe 测试",
      passwordHash: "not-used",
    },
  });
  const projects = ["甲", "乙", "丙", "丁"].map(createAnnotationHistoryProject);
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
        clientOperationId: `shadow-operation-${accountSuffix}-${index + 2}`,
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
  return { resourceId: resource.id, projects };
}

export function createColdAnnotationHistoryPlan(
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

export async function closeAnnotationHistoryTestConnections(
  connections: ReturnType<typeof createTestPrisma>,
) {
  await connections.prisma.$disconnect();
  await connections.pool.end();
  await connections.maintenancePool.end();
  await connections.collaborationPool.end();
}

export function createAnnotationHistoryProject(text: string): ProjectData {
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

export function toInputJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
