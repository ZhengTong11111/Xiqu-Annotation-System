import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import type { ProjectDocumentOperation } from "../state/projectDocumentState";
import { buildProjectAnnotationContentCommand } from "../utils/annotationContentCommand";
import type { ProjectData } from "../types";
import {
  omitUnavailableToolAttemptBindings,
  planAtomicAnnotationCommandBatch,
} from "./platformAtomicCommandPlan";

function buildTextChain(count: number) {
  let project = structuredClone(mockProject);
  const operations: ProjectDocumentOperation[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = structuredClone(project);
    next.subtitleLines[0].text = `命令-${index + 1}`;
    const commandEnvelope = buildProjectAnnotationContentCommand(project, next, [{
      entityType: "sentence",
      entityId: project.subtitleLines[0].id,
      field: "text",
    }]);
    if (!commandEnvelope) throw new Error("测试夹具无法生成内容命令。");
    operations.push({
      id: `op-${index + 1}`,
      type: commandEnvelope.command.type,
      action: "edit",
      localRevision: index + 1,
      baseRevision: index,
      createdAt: 1_785_700_000_000 + index,
      syncState: "pending",
      commandEnvelope,
      summary: { hasProjectChange: true, hasTrackSnapChange: false },
    });
    project = next;
  }
  return { currentProject: project, operations };
}

function plan(currentProject: ProjectData, operations: ProjectDocumentOperation[], maxBatchSize?: number) {
  return planAtomicAnnotationCommandBatch({
    savedProject: mockProject,
    currentProject,
    serverRevision: 7,
    savedLocalRevision: 0,
    savedTrackSnapEnabled: { "character-track": false },
    pendingOperations: operations,
    maxBatchSize,
  });
}

test("完整审计有序命令链后生成首批与确认基线", () => {
  const chain = buildTextChain(2);
  chain.operations[0] = {
    ...chain.operations[0],
    toolAttemptId: "44444444-4444-4444-8444-444444444444",
  };
  const original = structuredClone(chain.operations);
  const result = plan(chain.currentProject, chain.operations, 1);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.deepEqual(result.plan.operationIds, ["op-1"]);
  assert.equal(result.plan.remainingCount, 1);
  assert.equal(result.plan.acknowledgedProject.subtitleLines[0].text, "命令-1");
  assert.equal(result.plan.request.baseRevision, 7);
  assert.equal(
    result.plan.request.operations[0]?.toolAttemptId,
    "44444444-4444-4444-8444-444444444444",
  );
  assert.equal(result.plan.acknowledgedTrackSnapEnabled["character-track"], false);
  assert.deepEqual(chain.operations, original);

  const downgraded = omitUnavailableToolAttemptBindings(
    result.plan,
    new Set(["44444444-4444-4444-8444-444444444444"]),
  );
  assert.equal(downgraded.request.operations[0]?.toolAttemptId, undefined);
  assert.equal(result.plan.request.operations[0]?.toolAttemptId, "44444444-4444-4444-8444-444444444444");
  assert.deepEqual(downgraded.operationIds, result.plan.operationIds);
});

test("101 项按 100 项切批，但后续命令仍参与完整链审计", () => {
  const chain = buildTextChain(101);
  const result = plan(chain.currentProject, chain.operations);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.plan.operationIds.length, 100);
  assert.equal(result.plan.remainingCount, 1);
  assert.equal(result.plan.acknowledgedProject.subtitleLines[0].text, "命令-100");

  const second = planAtomicAnnotationCommandBatch({
    savedProject: result.plan.acknowledgedProject,
    currentProject: chain.currentProject,
    serverRevision: 8,
    savedLocalRevision: 100,
    savedTrackSnapEnabled: result.plan.acknowledgedTrackSnapEnabled,
    pendingOperations: chain.operations.slice(100),
  });
  assert.equal(second.status, "ready");
  if (second.status === "ready") assert.deepEqual(second.plan.operationIds, ["op-101"]);
});

test("旧 submitted、track-snap 与 legacy 操作形成明确 barrier", () => {
  const chain = buildTextChain(1);
  const submitted = [{ ...chain.operations[0], syncState: "submitted" as const }];
  assert.deepEqual(plan(chain.currentProject, submitted), {
    status: "legacy_required",
    reason: "legacy_submitted_operation",
    operationId: "op-1",
    operationIndex: 0,
  });
  const trackSnap: ProjectDocumentOperation = {
    ...chain.operations[0],
    id: "op-snap",
    type: "track-snap.update",
    action: "track-snap",
    commandEnvelope: undefined,
    summary: { hasProjectChange: false, hasTrackSnapChange: true },
  };
  assert.equal(plan(chain.currentProject, [trackSnap]).status, "legacy_required");
  const legacy = { ...chain.operations[0], type: "project.commit" as const, commandEnvelope: undefined };
  assert.equal(plan(chain.currentProject, [legacy]).status, "legacy_required");
});

test("后续命令前置失败与合同外本地变化都不能返回半批", () => {
  const chain = buildTextChain(2);
  const broken = structuredClone(chain.operations);
  const envelope = broken[1].commandEnvelope;
  if (!envelope || envelope.command.type !== "annotation.items.content.update") {
    throw new Error("测试夹具命令类型错误。");
  }
  envelope.command.items[0].before = "不存在的旧文本";
  const blocked = plan(chain.currentProject, broken, 1);
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") assert.equal(blocked.reason, "command_precondition_failed");

  const unexplained = structuredClone(chain.currentProject);
  unexplained.activeTrackOrder = [...unexplained.activeTrackOrder].reverse();
  const mismatch = plan(unexplained, chain.operations);
  assert.equal(mismatch.status, "blocked");
  if (mismatch.status !== "blocked") return;
  assert.equal(mismatch.reason, "local_chain_mismatch");
  assert.deepEqual(
    (mismatch.issues as { mismatchedTopLevelFields: string[] }).mismatchedTopLevelFields,
    ["activeTrackOrder"],
  );
  assert.ok(
    (mismatch.issues as { mismatchDetails: Array<{ path: string }> }).mismatchDetails
      .some((detail) => detail.path.startsWith("/activeTrackOrder/")),
  );
});

test("operation 类型与 envelope 不一致时 fail closed", () => {
  const chain = buildTextChain(1);
  const invalid = [{
    ...chain.operations[0],
    type: "timeline.items.timing.update" as const,
  }];
  const result = plan(chain.currentProject, invalid);
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "invalid_operation");
});

test("local revision 缺口不能伪装成连续命令链", () => {
  const chain = buildTextChain(1);
  const invalid = [{ ...chain.operations[0], baseRevision: 3, localRevision: 4 }];
  const result = plan(chain.currentProject, invalid);
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "non_contiguous_local_revision");
});
