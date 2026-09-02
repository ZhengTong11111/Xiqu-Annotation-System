import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectSnapshotBoundaryEnvelope } from "@xiqu/shared";
import { mockProject } from "../mockData";
import type { ProjectDocumentOperation } from "../state/projectDocumentState";
import type { ProjectData } from "../types";
import { buildProjectAnnotationContentCommand } from "../utils/annotationContentCommand";
import { buildProjectTimelineTimingCommand } from "../utils/timelineTimingCommand";
import { planPlatformConflictRebase } from "./platformConflictRebase";

type Chain = {
  savedProject: ProjectData;
  currentProject: ProjectData;
  operations: ProjectDocumentOperation[];
};

function buildSentenceChain(
  edits: Array<{ lineId: string; text: string }>,
  savedProject: ProjectData = structuredClone(mockProject),
): Chain {
  let project = structuredClone(savedProject);
  const operations: ProjectDocumentOperation[] = [];
  for (const [index, edit] of edits.entries()) {
    const next = structuredClone(project);
    const line = next.subtitleLines.find((item) => item.id === edit.lineId);
    if (!line) throw new Error(`测试夹具找不到句：${edit.lineId}`);
    line.text = edit.text;
    const envelope = buildProjectAnnotationContentCommand(project, next, [{
      entityType: "sentence",
      entityId: edit.lineId,
      field: "text",
    }]);
    if (!envelope) throw new Error("测试夹具无法生成内容命令。");
    operations.push({
      id: `rebase-op-${index + 1}`,
      type: envelope.command.type,
      action: "edit",
      localRevision: index + 1,
      baseRevision: index,
      createdAt: 1_785_800_000_000 + index,
      syncState: "pending",
      commandEnvelope: envelope,
      summary: { hasProjectChange: true, hasTrackSnapChange: false },
    });
    project = next;
  }
  return { savedProject, currentProject: project, operations };
}

function plan(chain: Chain, latestServerProject: ProjectData, overrides: Partial<{
  baseRevision: number;
  latestRevision: number;
  savedLocalRevision: number;
  allowConcurrentValueResolution: boolean;
}> = {}) {
  return planPlatformConflictRebase({
    baseRevision: overrides.baseRevision ?? 7,
    latestRevision: overrides.latestRevision ?? 8,
    savedProject: chain.savedProject,
    currentProject: chain.currentProject,
    latestServerProject,
    savedLocalRevision: overrides.savedLocalRevision ?? 0,
    pendingOperations: chain.operations,
    allowConcurrentValueResolution: overrides.allowConcurrentValueResolution,
  });
}

test("不相交的远端与本地内容修改可在最新项目上完整重放", () => {
  const chain = buildSentenceChain([{ lineId: "line-1", text: "本地修改" }]);
  chain.operations[0] = {
    ...chain.operations[0],
    toolAttemptId: "55555555-5555-4555-8555-555555555555",
  };
  const latest = structuredClone(chain.savedProject);
  latest.subtitleLines.find((line) => line.id === "line-2")!.text = "远端修改";
  const original = structuredClone({ chain, latest });

  const result = plan(chain, latest);
  assert.equal(result.status, "rebase_ready");
  if (result.status !== "rebase_ready") return;
  assert.equal(result.rebasedProject.subtitleLines.find((line) => line.id === "line-1")?.text, "本地修改");
  assert.equal(result.rebasedProject.subtitleLines.find((line) => line.id === "line-2")?.text, "远端修改");
  assert.deepEqual(result.operations.map((operation) => operation.clientOperationId), ["rebase-op-1"]);
  assert.equal(result.operations[0]?.toolAttemptId, "55555555-5555-4555-8555-555555555555");
  assert.equal(
    result.rebasedPendingOperations[0]?.toolAttemptId,
    "55555555-5555-4555-8555-555555555555",
  );
  assert.equal(result.latestRevision, 8);
  assert.deepEqual({ chain, latest }, original);
});

test("同字段修改返回有界机器冲突摘要，不泄漏正文", () => {
  const chain = buildSentenceChain([{ lineId: "line-1", text: "本地正文" }]);
  const latest = structuredClone(chain.savedProject);
  latest.subtitleLines.find((line) => line.id === "line-1")!.text = "远端正文";

  const result = plan(chain, latest);
  assert.equal(result.status, "command_conflict");
  if (result.status !== "command_conflict") return;
  assert.equal(result.operationId, "rebase-op-1");
  assert.equal(result.operationIndex, 0);
  assert.deepEqual(result.issues, [{
    code: "before_mismatch",
    targetKey: '["sentence",null,"line-1","text"]',
  }]);
  assert.doesNotMatch(JSON.stringify(result), /本地正文|远端正文/);
});

test("实时 409 恢复可让后提交端的同字段内容成为当前版本", () => {
  const chain = buildSentenceChain([{ lineId: "line-1", text: "本地正文" }]);
  const latest = structuredClone(chain.savedProject);
  latest.subtitleLines.find((line) => line.id === "line-1")!.text = "远端正文";

  const result = plan(chain, latest, { allowConcurrentValueResolution: true });
  assert.equal(result.status, "rebase_ready");
  if (result.status !== "rebase_ready") return;
  assert.equal(result.rebasedProject.subtitleLines.find((line) => line.id === "line-1")?.text, "本地正文");
  const payload = result.operations[0]?.payload;
  assert.equal(payload?.command.type, "annotation.items.content.update");
  if (payload?.command.type !== "annotation.items.content.update") return;
  assert.equal(payload.command.items[0]?.before, "远端正文");
  assert.equal(payload.command.items[0]?.after, "本地正文");
  assert.deepEqual(result.rebasedPendingOperations.map((operation) => operation.id), ["rebase-op-1"]);
  assert.equal(result.rebasedPendingOperations[0]?.commandEnvelope, payload);
});

function buildTimingChain(
  edit: (line: ProjectData["subtitleLines"][number]) => void,
): Chain {
  const savedProject = structuredClone(mockProject);
  const currentProject = structuredClone(savedProject);
  const localLine = currentProject.subtitleLines.find((line) => line.id === "line-1")!;
  edit(localLine);
  const envelope = buildProjectTimelineTimingCommand(savedProject, currentProject, [{
    entityType: "sentence",
    entityId: "line-1",
  }]);
  assert.ok(envelope);
  return {
    savedProject,
    currentProject,
    operations: [{
      id: "timing-op-1",
      type: envelope.command.type,
      action: "edit",
      localRevision: 1,
      baseRevision: 0,
      createdAt: 1_785_800_000_000,
      syncState: "pending",
      commandEnvelope: envelope,
      summary: { hasProjectChange: true, hasTrackSnapChange: false },
    }],
  };
}

test("实时 409 恢复对同一时间边界采用后提交端的绝对目标值", () => {
  const chain = buildTimingChain((line) => {
    line.startTime += 1;
  });
  const original = chain.savedProject.subtitleLines.find((line) => line.id === "line-1")!;
  const latest = structuredClone(chain.savedProject);
  const remoteLine = latest.subtitleLines.find((line) => line.id === "line-1")!;
  remoteLine.startTime += 2;

  const result = plan(chain, latest, { allowConcurrentValueResolution: true });
  assert.equal(result.status, "rebase_ready");
  if (result.status !== "rebase_ready") return;
  const merged = result.rebasedProject.subtitleLines.find((line) => line.id === "line-1")!;
  assert.equal(merged.startTime, original.startTime + 1);
  assert.equal(merged.endTime, original.endTime);
});

test("实时 409 恢复仍会组合双方对不同时间边界的修改", () => {
  const chain = buildTimingChain((line) => {
    line.endTime += 2;
  });
  const original = chain.savedProject.subtitleLines.find((line) => line.id === "line-1")!;
  const latest = structuredClone(chain.savedProject);
  latest.subtitleLines.find((line) => line.id === "line-1")!.startTime += 1;

  const result = plan(chain, latest, { allowConcurrentValueResolution: true });
  assert.equal(result.status, "rebase_ready");
  if (result.status !== "rebase_ready") return;
  const merged = result.rebasedProject.subtitleLines.find((line) => line.id === "line-1")!;
  assert.equal(merged.startTime, original.startTime + 1);
  assert.equal(merged.endTime, original.endTime + 2);
});

test("实时 409 恢复对整体拖动保留后提交端完整区间而不累计位移", () => {
  const chain = buildTimingChain((line) => {
    line.startTime += 1;
    line.endTime += 1;
  });
  const original = chain.savedProject.subtitleLines.find((line) => line.id === "line-1")!;
  const latest = structuredClone(chain.savedProject);
  const remoteLine = latest.subtitleLines.find((line) => line.id === "line-1")!;
  remoteLine.startTime += 2;
  remoteLine.endTime += 2;

  const result = plan(chain, latest, { allowConcurrentValueResolution: true });
  assert.equal(result.status, "rebase_ready");
  if (result.status !== "rebase_ready") return;
  const merged = result.rebasedProject.subtitleLines.find((line) => line.id === "line-1")!;
  assert.equal(merged.startTime, original.startTime + 1);
  assert.equal(merged.endTime, original.endTime + 1);
});

test("目标被远端删除时返回 target_missing", () => {
  const chain = buildSentenceChain([{ lineId: "line-1", text: "本地修改" }]);
  const latest = structuredClone(chain.savedProject);
  latest.subtitleLines = latest.subtitleLines.filter((line) => line.id !== "line-1");

  const result = plan(chain, latest);
  assert.equal(result.status, "command_conflict");
  if (result.status === "command_conflict") {
    assert.deepEqual(result.issues, [{
      code: "target_missing",
      targetKey: '["sentence",null,"line-1","text"]',
    }]);
  }
});

test("第二条命令冲突时不返回第一条已经应用的局部项目", () => {
  const chain = buildSentenceChain([
    { lineId: "line-1", text: "本地第一句" },
    { lineId: "line-2", text: "本地第二句" },
  ]);
  const latest = structuredClone(chain.savedProject);
  latest.subtitleLines.find((line) => line.id === "line-2")!.text = "远端第二句";

  const result = plan(chain, latest);
  assert.equal(result.status, "command_conflict");
  if (result.status !== "command_conflict") return;
  assert.equal(result.operationIndex, 1);
  assert.equal("rebasedProject" in result, false);
  assert.equal(latest.subtitleLines.find((line) => line.id === "line-1")?.text, "春江花月夜");
});

test("101 项本地命令全部参与重放判定，不受网络批次上限影响", () => {
  const edits = Array.from({ length: 101 }, (_, index) => ({
    lineId: "line-1",
    text: `本地-${index + 1}`,
  }));
  const chain = buildSentenceChain(edits);
  const latest = structuredClone(chain.savedProject);
  latest.subtitleLines.find((line) => line.id === "line-2")!.text = "远端修改";

  const result = plan(chain, latest);
  assert.equal(result.status, "rebase_ready");
  if (result.status !== "rebase_ready") return;
  assert.equal(result.operations.length, 101);
  assert.equal(result.rebasedProject.subtitleLines.find((line) => line.id === "line-1")?.text, "本地-101");
});

test("旧操作、track-snap、snapshot boundary 与 submitted 都进入人工审阅", () => {
  const chain = buildSentenceChain([{ lineId: "line-1", text: "本地修改" }]);
  const baseOperation = chain.operations[0]!;
  const cases: Array<[ProjectDocumentOperation, string]> = [
    [{ ...baseOperation, commandEnvelope: undefined }, "legacy_operation"],
    [{
      ...baseOperation,
      type: "track-snap.update",
      action: "track-snap",
      commandEnvelope: undefined,
      summary: { hasProjectChange: false, hasTrackSnapChange: true },
    }, "track_snap_operation"],
    [{
      ...baseOperation,
      type: "annotation.project.snapshot.boundary",
      commandEnvelope: buildProjectSnapshotBoundaryEnvelope("boundary-1", "import_project", "forward") ?? undefined,
    }, "snapshot_boundary"],
    [{ ...baseOperation, syncState: "submitted" }, "legacy_submitted_operation"],
  ];

  for (const [operation, reason] of cases) {
    const result = plan({ ...chain, operations: [operation] }, chain.savedProject);
    assert.equal(result.status, "manual_review_required");
    if (result.status === "manual_review_required") assert.equal(result.reason, reason);
  }
});

test("本地链缺口、重复 id、类型漂移和合同外变化全部 fail closed", () => {
  const chain = buildSentenceChain([
    { lineId: "line-1", text: "第一步" },
    { lineId: "line-2", text: "第二步" },
  ]);
  const missingRevision = structuredClone(chain);
  missingRevision.operations[1]!.baseRevision = 9;
  assert.equal(plan(missingRevision, chain.savedProject).status, "invalid_local_chain");

  const duplicate = structuredClone(chain);
  duplicate.operations[1]!.id = duplicate.operations[0]!.id;
  const duplicateResult = plan(duplicate, chain.savedProject);
  assert.equal(duplicateResult.status, "invalid_local_chain");
  if (duplicateResult.status === "invalid_local_chain") {
    assert.equal(duplicateResult.reason, "duplicate_operation_id");
  }

  const wrongType = structuredClone(chain);
  wrongType.operations[0]!.type = "timeline.items.timing.update";
  assert.equal(plan(wrongType, chain.savedProject).status, "invalid_local_chain");

  const unexplained = structuredClone(chain);
  unexplained.currentProject.activeTrackOrder = [...unexplained.currentProject.activeTrackOrder].reverse();
  const mismatch = plan(unexplained, chain.savedProject);
  assert.equal(mismatch.status, "invalid_local_chain");
  if (mismatch.status === "invalid_local_chain") assert.equal(mismatch.reason, "local_chain_mismatch");
});

test("revision 必须是数据库整数且 latest 严格更新", () => {
  const chain = buildSentenceChain([{ lineId: "line-1", text: "本地修改" }]);
  assert.deepEqual(plan(chain, chain.savedProject, { baseRevision: -1 }), {
    status: "invalid_revision",
    reason: "invalid_base_revision",
  });
  assert.deepEqual(plan(chain, chain.savedProject, { latestRevision: 2_147_483_648 }), {
    status: "invalid_revision",
    reason: "invalid_latest_revision",
  });
  assert.deepEqual(plan(chain, chain.savedProject, { baseRevision: 8, latestRevision: 8 }), {
    status: "invalid_revision",
    reason: "latest_revision_not_newer",
  });
  assert.deepEqual(plan(chain, chain.savedProject, { baseRevision: 9, latestRevision: 8 }), {
    status: "invalid_revision",
    reason: "latest_revision_not_newer",
  });
});

test("空 pending chain 不能伪装成一次冲突重放", () => {
  const project = structuredClone(mockProject);
  const result = planPlatformConflictRebase({
    baseRevision: 1,
    latestRevision: 2,
    savedProject: project,
    currentProject: project,
    latestServerProject: project,
    savedLocalRevision: 0,
    pendingOperations: [],
  });
  assert.deepEqual(result, { status: "invalid_local_chain", reason: "no_operations" });
});
