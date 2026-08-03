import assert from "node:assert/strict";
import test from "node:test";
import type {
  AnnotationCommittedOperationPage,
  AnnotationOperationRecord,
} from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import { buildProjectTimelineTimingCommand } from "../utils/timelineTimingCommand";
import { catchUpCommittedAnnotationOperations } from "./platformOperationCatchUp";

const FILE_ID = "annotation-file-catch-up";

// 测试命令只移动一个稳定逐字实体，方便组合连续 revision 与 before mismatch 场景。
function createCharacterMove(
  base: ProjectData,
  delta: number,
) {
  const next = structuredClone(base);
  const character = next.characterAnnotations[0];
  if (!character) throw new Error("mockProject 缺少逐字标注。 ");
  character.startTime += delta;
  character.endTime += delta;
  const envelope = buildProjectTimelineTimingCommand(base, next, [{
    entityType: "character",
    entityId: character.id,
  }]);
  if (!envelope) throw new Error("未能建立时间命令。 ");
  return { next, envelope };
}

// operation 夹具完整满足 committed feed 合同，测试只覆盖 coordinator 自身判断。
function createOperation(
  revision: number,
  sequence: number,
  payload: unknown,
  overrides: Partial<AnnotationOperationRecord> = {},
): AnnotationOperationRecord {
  return {
    id: `server-operation-${sequence}`,
    annotationFileId: FILE_ID,
    actorUserId: "user-1",
    clientOperationId: `client-operation-${sequence}`,
    sequence,
    baseRevision: revision - 1,
    localRevision: sequence,
    action: "timeline.items.timing.update",
    payload,
    status: "accepted",
    commitState: "committed",
    committedRevision: revision,
    committedAt: "2026-08-03T00:00:00.000Z",
    replayability: "domain_command",
    createdAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

// 页 helper 记录 cursor，确保多页测试确实沿服务端游标前进。
function createPageReader(pages: AnnotationCommittedOperationPage[]) {
  const calls: string[] = [];
  return {
    calls,
    listPage: async (_fileId: string, options: { cursor: string }) => {
      calls.push(options.cursor);
      const page = pages.shift();
      if (!page) throw new Error("没有更多测试页。 ");
      return page;
    },
  };
}

test("clean 客户端顺序重放跨页连续 revision", async () => {
  const first = createCharacterMove(mockProject, 0.1);
  const second = createCharacterMove(first.next, 0.2);
  const reader = createPageReader([
    {
      items: [createOperation(1, 1, first.envelope)],
      nextCursor: "cursor-1",
      hasMore: true,
      currentRevision: 2,
    },
    {
      items: [createOperation(2, 2, second.envelope)],
      nextCursor: "cursor-2",
      hasMore: false,
      currentRevision: 2,
    },
  ]);
  const result = await catchUpCommittedAnnotationOperations({
    annotationFileId: FILE_ID,
    project: mockProject,
    knownRevision: 0,
    cursor: "snapshot-0",
    listPage: reader.listPage,
  });
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.equal(result.revision, 2);
  assert.equal(result.cursor, "cursor-2");
  assert.equal(result.operationCount, 2);
  assert.equal(
    result.project.characterAnnotations[0].startTime,
    second.next.characterAnnotations[0].startTime,
  );
  assert.deepEqual(reader.calls, ["snapshot-0", "cursor-1"]);
});

test("无新 revision 返回 up_to_date 并保留 snapshot cursor", async () => {
  const result = await catchUpCommittedAnnotationOperations({
    annotationFileId: FILE_ID,
    project: mockProject,
    knownRevision: 3,
    cursor: "snapshot-3",
    listPage: async () => ({
      items: [],
      nextCursor: "snapshot-3",
      hasMore: false,
      currentRevision: 3,
    }),
  });
  assert.deepEqual(result, {
    status: "up_to_date",
    revision: 3,
    cursor: "snapshot-3",
  });
});

test("revision 缺口和不可重放 operation 明确降级快照", async () => {
  const move = createCharacterMove(mockProject, 0.1);
  for (const expected of [
    {
      operation: createOperation(2, 1, move.envelope),
      reason: "revision_gap",
      currentRevision: 2,
    },
    {
      operation: createOperation(1, 1, { legacy: true }, {
        replayability: "requires_snapshot",
      }),
      reason: "requires_snapshot_operation",
      currentRevision: 1,
    },
  ] as const) {
    const result = await catchUpCommittedAnnotationOperations({
      annotationFileId: FILE_ID,
      project: mockProject,
      knownRevision: 0,
      cursor: "snapshot-0",
      listPage: async () => ({
        items: [expected.operation],
        nextCursor: "cursor-1",
        hasMore: false,
        currentRevision: expected.currentRevision,
      }),
    });
    assert.deepEqual(result, { status: "requires_snapshot", reason: expected.reason });
  }
});

test("命令前置条件失败不泄漏前一条已应用的半成品", async () => {
  const first = createCharacterMove(mockProject, 0.1);
  const badSecond = createCharacterMove(mockProject, 0.3);
  const result = await catchUpCommittedAnnotationOperations({
    annotationFileId: FILE_ID,
    project: mockProject,
    knownRevision: 0,
    cursor: "snapshot-0",
    listPage: async () => ({
      items: [
        createOperation(1, 1, first.envelope),
        createOperation(2, 2, badSecond.envelope),
      ],
      nextCursor: "cursor-2",
      hasMore: false,
      currentRevision: 2,
    }),
  });
  assert.deepEqual(result, {
    status: "requires_snapshot",
    reason: "command_precondition_failed",
  });
  assert.deepEqual(mockProject.characterAnnotations[0], structuredClone(mockProject).characterAnnotations[0]);
});

test("坏页顺序、跨文件记录和不前进游标 fail closed", async () => {
  const move = createCharacterMove(mockProject, 0.1);
  const invalidPages: AnnotationCommittedOperationPage[] = [
    {
      items: [createOperation(1, 1, move.envelope, { annotationFileId: "other-file" })],
      nextCursor: "cursor-1",
      hasMore: false,
      currentRevision: 1,
    },
    {
      items: [createOperation(1, 1, move.envelope)],
      nextCursor: "snapshot-0",
      hasMore: true,
      currentRevision: 1,
    },
  ];
  for (const page of invalidPages) {
    const result = await catchUpCommittedAnnotationOperations({
      annotationFileId: FILE_ID,
      project: mockProject,
      knownRevision: 0,
      cursor: "snapshot-0",
      listPage: async () => page,
    });
    assert.deepEqual(result, { status: "requires_snapshot", reason: "invalid_page" });
  }
});

test("分页超过单次预算时要求完整快照", async () => {
  const move = createCharacterMove(mockProject, 0.1);
  const result = await catchUpCommittedAnnotationOperations({
    annotationFileId: FILE_ID,
    project: mockProject,
    knownRevision: 0,
    cursor: "snapshot-0",
    maxPages: 1,
    listPage: async () => ({
      items: [createOperation(1, 1, move.envelope)],
      nextCursor: "cursor-1",
      hasMore: true,
      currentRevision: 2,
    }),
  });
  assert.deepEqual(result, { status: "requires_snapshot", reason: "pagination_limit" });
});
