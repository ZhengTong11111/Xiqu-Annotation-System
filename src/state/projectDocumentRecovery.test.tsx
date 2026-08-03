import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { mockProject } from "../mockData";
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
