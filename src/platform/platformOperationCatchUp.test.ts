import assert from "node:assert/strict";
import test from "node:test";
import type {
  AnnotationCommittedOperationPage,
  AnnotationOperationRecord,
} from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { ProjectData } from "../types";
import { buildProjectAnnotationContentCommand } from "../utils/annotationContentCommand";
import { buildProjectAnnotationLifecycleCommand } from "../utils/annotationLifecycleCommand";
import { buildProjectAnnotationStateCommand } from "../utils/annotationStateCommand";
import { buildProjectAnnotationTransactionCommand } from "../utils/annotationTransactionCommand";
import { buildProjectCustomTrackStructureCommand } from "../utils/customTrackStructureCommand";
import { buildProjectTrackStructureTransactionCommand } from "../utils/trackStructureTransactionCommand";
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

// 内容命令夹具只改变稳定逐字文本，用于验证 timing/content 可在同一 committed chain 中混合重放。
function createCharacterTextUpdate(base: ProjectData, text: string) {
  const next = structuredClone(base);
  const character = next.characterAnnotations[0];
  if (!character) throw new Error("mockProject 缺少逐字标注。 ");
  character.char = text;
  const envelope = buildProjectAnnotationContentCommand(base, next, [{
    entityType: "character",
    entityId: character.id,
    field: "char",
  }]);
  if (!envelope) throw new Error("未能建立内容命令。 ");
  return { next, envelope };
}

// 生命周期夹具在既有附属点轨中创建新点，父轨结构属于 snapshot 基线而不是命令的一部分。
function createAttachedPoint(base: ProjectData) {
  const next = structuredClone(base);
  const pointTrack = next.builtinTracks[0].attachedPointTracks[0];
  pointTrack.points.push({ id: "catch-up-point", time: 2, label: "呼吸" });
  const envelope = buildProjectAnnotationLifecycleCommand(base, next, [{
    entityType: "attached-point",
    entityId: "catch-up-point",
    trackId: pointTrack.id,
  }]);
  if (!envelope) throw new Error("未能建立生命周期命令。 ");
  return { next, envelope };
}

// 事务夹具同时创建句与逐字，验证 committed feed 把整个依赖闭包视为一个 revision 事实。
function createSentenceWithCharacter(base: ProjectData) {
  const next = structuredClone(base);
  next.subtitleLines.push({ id: "catch-up-line", text: "新", startTime: 8, endTime: 9 });
  next.characterAnnotations.push({
    id: "catch-up-character",
    lineId: "catch-up-line",
    char: "新",
    startTime: 8,
    endTime: 9,
    singingStyle: "普通唱",
    tone: null,
  });
  const envelope = buildProjectAnnotationTransactionCommand(base, next, {
    lifecycleTargets: [
      { entityType: "sentence", entityId: "catch-up-line" },
      { entityType: "character", entityId: "catch-up-character" },
    ],
  });
  if (!envelope) throw new Error("未能建立事务命令。 ");
  return { next, envelope };
}

function createCatchUpProject() {
  const project = structuredClone(mockProject);
  project.builtinTracks[0].attachedPointTracks = [{
    id: "catch-up-point-track",
    name: "呼吸轨",
    typeOptions: ["呼吸"],
    points: [],
  }];
  return project;
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

test("clean 客户端顺序重放跨页 timing/content/lifecycle/transaction 连续 revision", async () => {
  const base = createCatchUpProject();
  const first = createCharacterMove(base, 0.1);
  const second = createCharacterTextUpdate(first.next, "新");
  const third = createAttachedPoint(second.next);
  const fourth = createSentenceWithCharacter(third.next);
  const reader = createPageReader([
    {
      items: [createOperation(1, 1, first.envelope)],
      nextCursor: "cursor-1",
      hasMore: true,
      currentRevision: 4,
    },
    {
      items: [
        createOperation(2, 2, second.envelope, { action: "annotation.items.content.update" }),
        createOperation(3, 3, third.envelope, { action: "annotation.items.lifecycle.update" }),
        createOperation(4, 4, fourth.envelope, { action: "annotation.transaction.apply" }),
      ],
      nextCursor: "cursor-4",
      hasMore: false,
      currentRevision: 4,
    },
  ]);
  const result = await catchUpCommittedAnnotationOperations({
    annotationFileId: FILE_ID,
    project: base,
    knownRevision: 0,
    cursor: "snapshot-0",
    listPage: reader.listPage,
  });
  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.equal(result.revision, 4);
  assert.equal(result.cursor, "cursor-4");
  assert.equal(result.operationCount, 4);
  assert.equal(
    result.project.characterAnnotations[0].startTime,
    second.next.characterAnnotations[0].startTime,
  );
  assert.equal(result.project.characterAnnotations[0].char, "新");
  assert.equal(result.project.builtinTracks[0].attachedPointTracks[0].points[0].id, "catch-up-point");
  assert.equal(
    result.project.characterAnnotations[result.project.characterAnnotations.length - 1]?.id,
    "catch-up-character",
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

test("committed feed 可重放复合实体 state 命令", async () => {
  const base = createCatchUpProject();
  const character = base.characterAnnotations[0];
  if (!character) throw new Error("catch-up 夹具缺少逐字标注。");
  base.gongcheAnnotations = [{
    id: "catch-up-gongche",
    parentTrackId: "character-track",
    parentBlockId: character.id,
    startTime: 1,
    endTime: 2,
    symbols: [{
      id: "catch-up-symbol",
      label: "上",
      notation: "",
      rawText: "上",
      parenthesized: false,
      startTime: 1,
      endTime: 2,
      assetUrl: null,
    }],
  }];
  const next = structuredClone(base);
  next.gongcheAnnotations[0].symbols[0] = {
    ...next.gongcheAnnotations[0].symbols[0],
    label: "尺",
    rawText: "尺",
  };
  const envelope = buildProjectAnnotationStateCommand(base, next, [{
    entityType: "gongche-symbol",
    entityId: "catch-up-symbol",
    trackId: "catch-up-gongche",
  }]);
  assert.ok(envelope);
  const result = await catchUpCommittedAnnotationOperations({
    annotationFileId: FILE_ID,
    project: base,
    knownRevision: 0,
    cursor: "snapshot-0",
    listPage: async () => ({
      items: [createOperation(1, 1, envelope, { action: "annotation.items.state.update" })],
      nextCursor: "cursor-state",
      hasMore: false,
      currentRevision: 1,
    }),
  });
  assert.equal(result.status, "applied");
  if (result.status === "applied") assert.deepEqual(result.project, next);
});

test("committed feed 可重放自定义轨道结构命令", async () => {
  const base = createCatchUpProject();
  const next = structuredClone(base);
  next.customTracks[0].name = "远端结构改名";
  next.customTracks[0].branching = {
    enabled: true,
    displayMode: "merged",
    lanes: [{ id: "lane-catch-up", name: "分支", parentId: null, children: [] }],
  };
  const envelope = buildProjectCustomTrackStructureCommand(
    base,
    next,
    [next.customTracks[0].id],
  );
  assert.ok(envelope);
  const result = await catchUpCommittedAnnotationOperations({
    annotationFileId: FILE_ID,
    project: base,
    knownRevision: 0,
    cursor: "snapshot-0",
    listPage: async () => ({
      items: [createOperation(1, 1, envelope, { action: "annotation.track.structure.update" })],
      nextCursor: "cursor-structure",
      hasMore: false,
      currentRevision: 1,
    }),
  });
  assert.equal(result.status, "applied");
  if (result.status === "applied") assert.deepEqual(result.project, next);
});

test("committed feed 可原子重放 typeOptions 与块类型结构事务", async () => {
  const base = createCatchUpProject();
  const next = structuredClone(base);
  const trackId = next.customTracks[0].id;
  const oldType = next.customTracks[0].typeOptions[0];
  next.customTracks[0].typeOptions[0] = "远端新类型";
  next.customTracks[0].blocks = next.customTracks[0].blocks.map((block) =>
    block.type === oldType ? { ...block, type: "远端新类型" } : block);
  const envelope = buildProjectTrackStructureTransactionCommand(base, next, {
    customTrackStructureIds: [trackId],
    contentTargets: base.customTracks[0].blocks.filter((block) => block.type === oldType).map((block) => ({
      entityType: "custom-block",
      entityId: block.id,
      trackId,
      field: "type",
    })),
  });
  assert.ok(envelope);
  const result = await catchUpCommittedAnnotationOperations({
    annotationFileId: FILE_ID,
    project: base,
    knownRevision: 0,
    cursor: "snapshot-0",
    listPage: async () => ({
      items: [createOperation(1, 1, envelope, {
        action: "annotation.track.structure.transaction.apply",
      })],
      nextCursor: "cursor-structure-transaction",
      hasMore: false,
      currentRevision: 1,
    }),
  });
  assert.equal(result.status, "applied");
  if (result.status === "applied") assert.deepEqual(result.project, next);
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
