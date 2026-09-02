import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectAnnotationContentCommand,
  type ProjectData,
} from "@xiqu/document-model";
import { buildProjectSnapshotBoundaryEnvelope } from "@xiqu/shared";
import { createAnnotationHistoryCanonicalHash } from "../src/annotationHistoryCanonicalHash.js";
import { parseAnnotationHistoryCompactionCliOptions } from "../src/annotationHistoryCompactionCliOptions.js";
import {
  AnnotationHistoryCompactionPlanner,
  type AnnotationHistoryCompactionRepository,
  type AnnotationHistoryOperationFact,
  type AnnotationHistorySnapshotFact,
} from "../src/annotationHistoryCompactionPlanner.js";
import {
  ANNOTATION_HISTORY_HOUR_MS,
  selectRequiredInlineSnapshots,
  type AnnotationHistoryCompactionPolicy,
} from "../src/annotationHistoryCompactionPolicy.js";

const FILE_ID = "00000000-0000-4000-8000-000000000001";
const OLD_DATE = new Date("2026-01-01T00:00:00.000Z");
const PLAN_NOW = new Date("2026-09-01T00:00:00.000Z");
const TEST_POLICY: AnnotationHistoryCompactionPolicy = {
  hotWindowMs: ANNOTATION_HISTORY_HOUR_MS,
  recentSnapshotCount: 1,
  checkpointRevisionInterval: 1_000,
  checkpointOperationInterval: 10_000,
  checkpointTimeIntervalMs: 365 * 24 * ANNOTATION_HISTORY_HOUR_MS,
};

test("canonical hash 忽略对象 key 顺序但保留数组和值语义", () => {
  assert.equal(
    createAnnotationHistoryCanonicalHash({ b: 2, a: [1, null] }),
    createAnnotationHistoryCanonicalHash({ a: [1, null], b: 2 }),
  );
  assert.notEqual(
    createAnnotationHistoryCanonicalHash({ a: [1, 2] }),
    createAnnotationHistoryCanonicalHash({ a: [2, 1] }),
  );
  assert.notEqual(
    createAnnotationHistoryCanonicalHash({ value: null }),
    createAnnotationHistoryCanonicalHash({ value: 0 }),
  );
});

test("保留规则合并审核引用、特殊原因、周期阈值和非可重放边界", () => {
  const snapshots = createSnapshotFacts(6);
  snapshots[1] = { ...snapshots[1]!, reason: "before_snapshot_restore" };
  const reasons = selectRequiredInlineSnapshots({
    snapshots,
    revisions: [
      { revision: 2, operationCount: 2, requiresSnapshot: false },
      { revision: 3, operationCount: 2, requiresSnapshot: false },
      { revision: 4, operationCount: 2, requiresSnapshot: true },
      { revision: 5, operationCount: 2, requiresSnapshot: false },
      { revision: 6, operationCount: 2, requiresSnapshot: false },
    ],
    protectedRevisions: new Set([3]),
    now: PLAN_NOW,
    policy: { ...TEST_POLICY, recentSnapshotCount: 1, checkpointRevisionInterval: 2 },
  });
  assert.ok(reasons.get(1)?.has("first_snapshot"));
  assert.ok(reasons.get(2)?.has("special_reason"));
  assert.ok(reasons.get(3)?.has("review_reference"));
  assert.ok(reasons.get(3)?.has("before_non_replayable_boundary"));
  assert.ok(reasons.get(4)?.has("after_non_replayable_boundary"));
  assert.ok(reasons.get(6)?.has("last_snapshot"));
});

test("周期 operation 计数按相邻快照累计且在检查点后归零", () => {
  const reasons = selectRequiredInlineSnapshots({
    snapshots: createSnapshotFacts(5),
    revisions: [2, 3, 4, 5].map((revision) => ({
      revision,
      operationCount: 2,
      requiresSnapshot: false,
    })),
    protectedRevisions: new Set(),
    now: PLAN_NOW,
    policy: {
      ...TEST_POLICY,
      recentSnapshotCount: 1,
      checkpointOperationInterval: 3,
    },
  });
  assert.ok(reasons.get(3)?.has("periodic_operation_checkpoint"));
  assert.equal(reasons.get(4)?.has("periodic_operation_checkpoint") ?? false, false);
});

test("完整领域命令链可重建，跨 revision 的合法 sequence 空档不会误判", async () => {
  const projects = createProjectSeries(["甲", "乙", "丙", "丁"]);
  const operations = [
    createContentOperation(projects[0]!, projects[1]!, 2, 1),
    createContentOperation(projects[1]!, projects[2]!, 3, 99),
    createContentOperation(projects[2]!, projects[3]!, 4, 100),
  ];
  const repository = new MemoryCompactionRepository(projects, operations);
  const plan = await new AnnotationHistoryCompactionPlanner(repository).plan({
    annotationFileId: FILE_ID,
    maxRevisionsPerFile: 100,
    maxOperationsPerFile: 100,
    policy: TEST_POLICY,
    now: PLAN_NOW,
  });
  assert.equal(plan.summary.reconstructibleCount, 2);
  assert.equal(plan.summary.blockedCount, 0);
  assert.equal(plan.files[0]?.decisions[1]?.decision, "reconstructible");
  assert.equal(plan.files[0]?.decisions[2]?.recipe?.operationSequenceStart, 1);
  assert.equal(plan.files[0]?.decisions[2]?.recipe?.operationSequenceEnd, 99);
});

test("缺失 revision 只阻断当前区间，原始 payload 会成为后续可信检查点", async () => {
  const projects = createProjectSeries(["甲", "乙", "丙", "丁"]);
  const operations = [
    createContentOperation(projects[1]!, projects[2]!, 3, 20),
    createContentOperation(projects[2]!, projects[3]!, 4, 21),
  ];
  const plan = await new AnnotationHistoryCompactionPlanner(
    new MemoryCompactionRepository(projects, operations),
  ).plan({
    annotationFileId: FILE_ID,
    maxRevisionsPerFile: 100,
    maxOperationsPerFile: 100,
    policy: TEST_POLICY,
    now: PLAN_NOW,
  });
  assert.equal(plan.files[0]?.decisions[1]?.decision, "blocked");
  assert.deepEqual(plan.files[0]?.decisions[1]?.blockCodes, ["operation_revision_missing"]);
  assert.equal(plan.files[0]?.decisions[2]?.decision, "reconstructible");
});

test("重复 sequence 会稳定阻断，跨 revision 的不连续 sequence 仍保持合法", async () => {
  const projects = createProjectSeries(["甲", "乙", "丙", "丁"]);
  const plan = await new AnnotationHistoryCompactionPlanner(
    new MemoryCompactionRepository(projects, [
      createContentOperation(projects[0]!, projects[1]!, 2, 7),
      createContentOperation(projects[1]!, projects[2]!, 3, 7),
      createContentOperation(projects[2]!, projects[3]!, 4, 20),
    ]),
  ).plan({
    annotationFileId: FILE_ID,
    maxRevisionsPerFile: 100,
    maxOperationsPerFile: 100,
    policy: TEST_POLICY,
    now: PLAN_NOW,
  });
  assert.ok(plan.files[0]?.decisions[1]?.blockCodes.includes("operation_sequence_duplicate"));
  assert.equal(plan.summary.blockCodeCounts.operation_sequence_duplicate, 2);
});

test("hash 不一致和 requires-snapshot 命令都不会生成 recipe", async () => {
  const projects = createProjectSeries(["甲", "乙", "丙", "丁"]);
  const mismatched = structuredClone(projects[1]!);
  mismatched.subtitleLines[0]!.text = "错误快照";
  const mismatchPlan = await new AnnotationHistoryCompactionPlanner(
    new MemoryCompactionRepository(
      [projects[0]!, mismatched, projects[2]!, projects[3]!],
      [
        createContentOperation(projects[0]!, projects[1]!, 2, 1),
        createContentOperation(projects[1]!, projects[2]!, 3, 2),
        createContentOperation(projects[2]!, projects[3]!, 4, 3),
      ],
    ),
  ).plan({
    annotationFileId: FILE_ID,
    maxRevisionsPerFile: 100,
    maxOperationsPerFile: 100,
    policy: TEST_POLICY,
    now: PLAN_NOW,
  });
  assert.ok(mismatchPlan.files[0]?.decisions[1]?.blockCodes.includes("canonical_hash_mismatch"));
  assert.equal(mismatchPlan.files[0]?.decisions[1]?.recipe, null);

  const boundary = buildProjectSnapshotBoundaryEnvelope("boundary-1", "import_project");
  assert.ok(boundary);
  const boundaryOperations = [
    createContentOperation(projects[0]!, projects[1]!, 2, 1),
    {
      id: "operation-3",
      annotationFileId: FILE_ID,
      sequence: 2,
      baseRevision: 2,
      action: boundary.command.type,
      payload: boundary,
      status: "accepted" as const,
      committedRevision: 3,
      committedAt: OLD_DATE,
    },
    createContentOperation(projects[2]!, projects[3]!, 4, 3),
  ];
  const boundaryPlan = await new AnnotationHistoryCompactionPlanner(
    new MemoryCompactionRepository(projects, boundaryOperations),
  ).plan({
    annotationFileId: FILE_ID,
    maxRevisionsPerFile: 100,
    maxOperationsPerFile: 100,
    policy: TEST_POLICY,
    now: PLAN_NOW,
  });
  assert.ok(boundaryPlan.files[0]?.decisions[1]?.keepReasons.includes("before_non_replayable_boundary"));
  assert.ok(boundaryPlan.files[0]?.decisions[2]?.keepReasons.includes("after_non_replayable_boundary"));
  assert.equal(boundaryPlan.files[0]?.decisions[2]?.recipe, null);
});

test("CLI 必须显式选择单文件或全库并严格解析策略覆盖", () => {
  const single = parseAnnotationHistoryCompactionCliOptions([
    "--annotation-file-id",
    FILE_ID,
    "--recent-hours",
    "12",
    "--checkpoint-operations",
    "250",
  ]);
  assert.equal(single.annotationFileId, FILE_ID);
  assert.equal(single.policy.hotWindowMs, 12 * ANNOTATION_HISTORY_HOUR_MS);
  assert.equal(single.policy.checkpointOperationInterval, 250);
  const all = parseAnnotationHistoryCompactionCliOptions(["--all", "--limit-files", "5"]);
  assert.equal(all.scanAll, true);
  assert.equal(all.limitFiles, 5);
  assert.throws(() => parseAnnotationHistoryCompactionCliOptions([]), /必须且只能/u);
  assert.throws(() => parseAnnotationHistoryCompactionCliOptions([
    "--all",
    "--annotation-file-id",
    FILE_ID,
  ]), /必须且只能/u);
  assert.throws(() => parseAnnotationHistoryCompactionCliOptions([
    "--annotation-file-id",
    FILE_ID,
    "--unknown",
    "1",
  ]), /未知参数/u);
});

class MemoryCompactionRepository implements AnnotationHistoryCompactionRepository {
  private readonly snapshots: AnnotationHistorySnapshotFact[];
  private readonly payloads = new Map<string, unknown>();

  constructor(
    projects: readonly ProjectData[],
    private readonly operations: AnnotationHistoryOperationFact[],
  ) {
    this.snapshots = projects.map((project, index) => {
      const id = `snapshot-${index + 1}`;
      this.payloads.set(id, structuredClone(project));
      return {
        id,
        revision: index + 1,
        reason: "save",
        createdAt: new Date(OLD_DATE.getTime() + index * 1_000),
      };
    });
  }

  async listAnnotationFileIds() {
    return [FILE_ID];
  }

  async listSnapshots(input: { maxRevisions: number }) {
    return {
      items: this.snapshots.slice(0, input.maxRevisions),
      truncated: this.snapshots.length > input.maxRevisions,
    };
  }

  async listCommittedOperations(input: {
    fromRevisionExclusive: number;
    toRevisionInclusive: number;
    maxOperations: number;
  }) {
    const matching = this.operations.filter((operation) =>
      operation.committedRevision > input.fromRevisionExclusive &&
      operation.committedRevision <= input.toRevisionInclusive);
    return {
      items: matching.slice(0, input.maxOperations),
      truncated: matching.length > input.maxOperations,
    };
  }

  async listProtectedRevisions() {
    return { revisions: new Set<number>(), truncated: false };
  }

  async loadSnapshotPayload(input: { snapshotId: string }) {
    return structuredClone(this.payloads.get(input.snapshotId) ?? null);
  }
}

function createProjectSeries(texts: readonly string[]) {
  return texts.map((text) => createProject(text));
}

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

function createContentOperation(
  before: ProjectData,
  after: ProjectData,
  committedRevision: number,
  sequence: number,
): AnnotationHistoryOperationFact {
  const envelope = buildProjectAnnotationContentCommand(before, after, [{
    entityType: "sentence",
    entityId: "line-1",
    field: "text",
  }]);
  assert.ok(envelope);
  return {
    id: `operation-${committedRevision}`,
    annotationFileId: FILE_ID,
    sequence,
    baseRevision: committedRevision - 1,
    action: envelope.command.type,
    payload: envelope,
    status: "accepted",
    committedRevision,
    committedAt: OLD_DATE,
  };
}

function createSnapshotFacts(count: number): AnnotationHistorySnapshotFact[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `snapshot-${index + 1}`,
    revision: index + 1,
    reason: "save",
    createdAt: new Date(OLD_DATE.getTime() + index * ANNOTATION_HISTORY_HOUR_MS),
  }));
}
