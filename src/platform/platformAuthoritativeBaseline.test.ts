import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import {
  canReconcileSameRevisionAlreadySatisfied,
  classifyPlatformAuthoritativeBaseline,
} from "./platformAuthoritativeBaseline";

test("权威基线分类会识别同 revision 下的正文漂移", () => {
  const driftedProject = structuredClone(mockProject);
  driftedProject.subtitleLines[0]!.text = "服务器上的不同正文";

  assert.equal(classifyPlatformAuthoritativeBaseline({
    expectedRevision: 12,
    latestRevision: 12,
    expectedSavedProject: mockProject,
    latestServerProject: driftedProject,
  }), "same_revision_mismatch");
});

test("权威基线分类保留正常相同版本与更高版本语义", () => {
  assert.equal(classifyPlatformAuthoritativeBaseline({
    expectedRevision: 12,
    latestRevision: 12,
    expectedSavedProject: mockProject,
    latestServerProject: structuredClone(mockProject),
  }), "same_revision_match");
  assert.equal(classifyPlatformAuthoritativeBaseline({
    expectedRevision: 12,
    latestRevision: 13,
    expectedSavedProject: mockProject,
    latestServerProject: mockProject,
  }), "server_revision_advanced");
  assert.equal(classifyPlatformAuthoritativeBaseline({
    expectedRevision: 12,
    latestRevision: 11,
    expectedSavedProject: mockProject,
    latestServerProject: mockProject,
  }), "server_revision_behind");
});

test("只有同版本完整当前正文已在服务器时才允许自动收敛", () => {
  const currentProject = structuredClone(mockProject);
  currentProject.subtitleLines[0]!.text = "当前本地最终正文";

  assert.equal(canReconcileSameRevisionAlreadySatisfied({
    expectedRevision: 12,
    latestRevision: 12,
    expectedSavedProject: mockProject,
    currentProject,
    latestServerProject: structuredClone(currentProject),
  }), true);

  const partiallyDifferentServerProject = structuredClone(currentProject);
  partiallyDifferentServerProject.subtitleLines[1]!.text = "服务器额外差异";
  assert.equal(canReconcileSameRevisionAlreadySatisfied({
    expectedRevision: 12,
    latestRevision: 12,
    expectedSavedProject: mockProject,
    currentProject,
    latestServerProject: partiallyDifferentServerProject,
  }), false);
  assert.equal(canReconcileSameRevisionAlreadySatisfied({
    expectedRevision: 12,
    latestRevision: 13,
    expectedSavedProject: mockProject,
    currentProject,
    latestServerProject: currentProject,
  }), false);
});
