import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND } from "@xiqu/shared";
import { mockProject } from "../mockData";
import { buildProjectCustomTrackStructureCommand } from "../utils/customTrackStructureCommand";
import {
  useProjectDocumentState,
  type ProjectDocumentRecoveryState,
} from "./projectDocumentState";

// 服务端渲染一次 hook 宿主即可检查首次 render 的恢复状态，不需要伪造浏览器 effect 生命周期。
test("document hook 首次挂载原子恢复项目、revision 与 pending operation", () => {
  const currentProject = {
    ...mockProject,
    subtitleLines: mockProject.subtitleLines.map((line, index) => index === 0
      ? { ...line, text: "恢复后的本地文本" }
      : line),
  };
  const recoveryState: ProjectDocumentRecoveryState = {
    currentProject,
    savedProject: mockProject,
    currentTrackSnapEnabled: { "character-track": false },
    savedTrackSnapEnabled: { "character-track": true },
    pendingOperations: [{
      id: "op-restored",
      type: "project.commit",
      action: "edit",
      localRevision: 4,
      baseRevision: 3,
      createdAt: 1_785_700_000_000,
      syncState: "pending",
      summary: { hasProjectChange: true, hasTrackSnapChange: false },
    }],
    localRevision: 4,
    savedRevision: 3,
    lastChangedAt: 1_785_700_000_000,
    lastSavedAt: 1_785_699_000_000,
  };
  let captured: ReturnType<typeof useProjectDocumentState> | null = null;

  // Hook 宿主只负责捕获首次状态；序列化输出本身无产品语义。
  function Harness() {
    captured = useProjectDocumentState({
      initialProject: mockProject,
      initialTrackSnapEnabled: { "character-track": true },
      areProjectsEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      areTrackSnapStatesEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      initialRecoveryState: recoveryState,
    });
    return React.createElement("span", null, "draft");
  }

  renderToString(React.createElement(Harness));
  assert.ok(captured);
  const state = captured as ReturnType<typeof useProjectDocumentState>;
  assert.equal(state.project.subtitleLines[0].text, "恢复后的本地文本");
  assert.equal(state.hasUnsavedChanges, true);
  assert.equal(state.syncState.localRevision, 4);
  assert.equal(state.syncState.savedRevision, 3);
  assert.equal(state.pendingOperations[0].id, "op-restored");
  assert.deepEqual(state.getRecoveryState(), recoveryState);
});

test("结构命令随历史边界保存，undo 记录 inverse，redo 恢复原命令", () => {
  let captured: ReturnType<typeof useProjectDocumentState> | null = null;

  // SSR 宿主的 state setter 不触发二次渲染，但 hook 内部 refs 会同步推进，足以验证完整历史转换链。
  function Harness() {
    captured = useProjectDocumentState({
      initialProject: mockProject,
      initialTrackSnapEnabled: {},
      areProjectsEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      areTrackSnapStatesEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    });
    return React.createElement("span", null, "history");
  }

  renderToString(React.createElement(Harness));
  assert.ok(captured);
  const state = captured as ReturnType<typeof useProjectDocumentState>;
  const targetTrack = mockProject.customTracks[0];
  const renamedProject = {
    ...mockProject,
    customTracks: mockProject.customTracks.map((track) => track.id === targetTrack.id
      ? { ...track, name: "历史命令测试轨" }
      : track),
  };
  const commandEnvelope = buildProjectCustomTrackStructureCommand(
    mockProject,
    renamedProject,
    [targetTrack.id],
  );
  assert.ok(commandEnvelope);

  state.commitProject(renamedProject, mockProject, { commandEnvelope });
  let operations = state.getRecoveryState().pendingOperations;
  assert.equal(
    operations[operations.length - 1]?.type,
    CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND,
  );

  assert.equal(state.undoProject(), true);
  const afterUndo = state.getRecoveryState();
  assert.equal(afterUndo.currentProject.customTracks[0].name, targetTrack.name);
  operations = afterUndo.pendingOperations;
  const undoEnvelope = operations[operations.length - 1]?.commandEnvelope;
  assert.equal(undoEnvelope?.command.type, CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND);
  if (undoEnvelope?.command.type === CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND) {
    assert.equal(undoEnvelope.command.items[0].before.name, "历史命令测试轨");
    assert.equal(undoEnvelope.command.items[0].after.name, targetTrack.name);
  }

  assert.equal(state.redoProject(), true);
  const afterRedo = state.getRecoveryState();
  assert.equal(afterRedo.currentProject.customTracks[0].name, "历史命令测试轨");
  operations = afterRedo.pendingOperations;
  const redoEnvelope = operations[operations.length - 1]?.commandEnvelope;
  assert.equal(redoEnvelope?.command.type, CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND);
  if (redoEnvelope?.command.type === CUSTOM_TRACK_STRUCTURE_UPDATE_COMMAND) {
    assert.equal(redoEnvelope.command.items[0].before.name, targetTrack.name);
    assert.equal(redoEnvelope.command.items[0].after.name, "历史命令测试轨");
  }
});

test("原子确认只推进 pending 前缀并保留后续本地项目", () => {
  const firstProject = structuredClone(mockProject);
  firstProject.subtitleLines[0].text = "第一批";
  const currentProject = structuredClone(firstProject);
  currentProject.subtitleLines[0].text = "第二批";
  const recoveryState: ProjectDocumentRecoveryState = {
    currentProject,
    savedProject: mockProject,
    currentTrackSnapEnabled: {},
    savedTrackSnapEnabled: {},
    pendingOperations: [1, 2].map((revision) => ({
      id: `op-${revision}`,
      type: "project.commit" as const,
      action: "edit" as const,
      localRevision: revision,
      baseRevision: revision - 1,
      createdAt: 1_785_700_000_000 + revision,
      syncState: "pending" as const,
      summary: { hasProjectChange: true, hasTrackSnapChange: false },
    })),
    localRevision: 2,
    savedRevision: 0,
    lastChangedAt: 1_785_700_000_002,
    lastSavedAt: null,
  };
  let captured: ReturnType<typeof useProjectDocumentState> | null = null;
  function Harness() {
    captured = useProjectDocumentState({
      initialProject: mockProject,
      initialTrackSnapEnabled: {},
      areProjectsEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      areTrackSnapStatesEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      initialRecoveryState: recoveryState,
    });
    return React.createElement("span", null, "ack");
  }
  renderToString(React.createElement(Harness));
  const state = captured as unknown as ReturnType<typeof useProjectDocumentState>;
  state.setSyncStatus("dirty", { remoteRevision: 5 });
  const result = state.acknowledgeAtomicCommandBatch({
    operationIds: ["op-1"],
    acknowledgedProject: firstProject,
    acknowledgedTrackSnapEnabled: {},
    serverBaseRevision: 5,
    committedRevision: 6,
    expectedSavedLocalRevision: 0,
    acknowledgedLocalRevision: 1,
  });
  assert.deepEqual(result, {
    status: "applied",
    remainingOperationCount: 1,
    remoteRevision: 6,
    savedLocalRevision: 1,
    remainsDirty: true,
  });
  const after = state.getRecoveryState();
  assert.equal(after.savedProject.subtitleLines[0].text, "第一批");
  assert.equal(after.currentProject.subtitleLines[0].text, "第二批");
  assert.equal(after.savedRevision, 1);
  assert.deepEqual(after.pendingOperations.map((operation) => operation.id), ["op-2"]);

  const rejected = state.acknowledgeAtomicCommandBatch({
    operationIds: ["op-missing"],
    acknowledgedProject: currentProject,
    acknowledgedTrackSnapEnabled: {},
    serverBaseRevision: 6,
    committedRevision: 7,
    expectedSavedLocalRevision: 1,
    acknowledgedLocalRevision: 2,
  });
  assert.deepEqual(rejected, { status: "rejected", reason: "operation_prefix_mismatch" });
  assert.deepEqual(state.getRecoveryState().pendingOperations.map((operation) => operation.id), ["op-2"]);

  const finalResult = state.acknowledgeAtomicCommandBatch({
    operationIds: ["op-2"],
    acknowledgedProject: currentProject,
    acknowledgedTrackSnapEnabled: {},
    serverBaseRevision: 6,
    committedRevision: 7,
    expectedSavedLocalRevision: 1,
    acknowledgedLocalRevision: 2,
  });
  assert.deepEqual(finalResult, {
    status: "applied",
    remainingOperationCount: 0,
    remoteRevision: 7,
    savedLocalRevision: 2,
    remainsDirty: false,
  });
  assert.deepEqual(state.getRecoveryState().pendingOperations, []);
});

test("原子确认拒绝旧 remote revision 且不修改 pending", () => {
  const recoveryState = createAtomicRecoveryStateForRejection();
  let captured: ReturnType<typeof useProjectDocumentState> | null = null;
  function Harness() {
    captured = useProjectDocumentState({
      initialProject: mockProject,
      initialTrackSnapEnabled: {},
      areProjectsEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      areTrackSnapStatesEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
      initialRecoveryState: recoveryState,
    });
    return React.createElement("span", null, "stale-ack");
  }
  renderToString(React.createElement(Harness));
  const state = captured as unknown as ReturnType<typeof useProjectDocumentState>;
  state.setSyncStatus("dirty", { remoteRevision: 9 });
  const result = state.acknowledgeAtomicCommandBatch({
    operationIds: ["op-stale"],
    acknowledgedProject: recoveryState.currentProject,
    acknowledgedTrackSnapEnabled: {},
    serverBaseRevision: 8,
    committedRevision: 9,
    expectedSavedLocalRevision: 0,
    acknowledgedLocalRevision: 1,
  });
  assert.deepEqual(result, { status: "rejected", reason: "stale_remote_revision" });
  assert.deepEqual(state.getRecoveryState().pendingOperations.map((operation) => operation.id), ["op-stale"]);
});

function createAtomicRecoveryStateForRejection(): ProjectDocumentRecoveryState {
  const currentProject = structuredClone(mockProject);
  currentProject.subtitleLines[0].text = "待确认";
  return {
    currentProject,
    savedProject: mockProject,
    currentTrackSnapEnabled: {},
    savedTrackSnapEnabled: {},
    pendingOperations: [{
      id: "op-stale",
      type: "project.commit",
      action: "edit",
      localRevision: 1,
      baseRevision: 0,
      createdAt: 1_785_700_000_000,
      syncState: "pending",
      summary: { hasProjectChange: true, hasTrackSnapChange: false },
    }],
    localRevision: 1,
    savedRevision: 0,
    lastChangedAt: 1_785_700_000_000,
    lastSavedAt: null,
  };
}
