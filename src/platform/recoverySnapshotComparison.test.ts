import assert from "node:assert/strict";
import test from "node:test";
import type {
  AnnotationFile,
  AnnotationRecoverySnapshotDetail,
} from "@xiqu/shared";
import { mockProject } from "../mockData";
import { buildRecoverySnapshotComparison } from "./recoverySnapshotComparison";

// 测试夹具只包装 payload 和 revision，避免把网络或资源树状态带入纯比较测试。
function fixture(payload: unknown, snapshotRevision = 2, currentRevision = 5) {
  const user = {
    id: "user-1",
    username: "researcher",
    accountName: "researcher",
    displayName: "研究员",
  };
  const snapshot: AnnotationRecoverySnapshotDetail<unknown> = {
    id: "snapshot-1",
    annotationFileId: "file-1",
    revision: snapshotRevision,
    creator: user,
    reason: "save",
    createdAt: "2026-08-02T00:00:00.000Z",
    payload,
  };
  const currentFile: AnnotationFile<unknown> = {
    resource: {} as AnnotationFile<unknown>["resource"],
    payload,
    revision: currentRevision,
    operationCursor: `cursor-${currentRevision}`,
    lastEditor: user,
    lastSavedAt: "2026-08-02T01:00:00.000Z",
  };
  return { snapshot, currentFile };
}

// 当前文件新增实体必须出现在右侧新增，固定方向不能随 UI 文案漂移。
test("快照固定在左侧且当前新增实体方向正确", () => {
  const historical = clone(mockProject);
  const current = clone(mockProject);
  current.subtitleLines.push({
    id: "current-line",
    text: "当前新增",
    startTime: 3,
    endTime: 4,
  });
  const input = fixture(historical);
  input.currentFile.payload = current;
  const result = buildRecoverySnapshotComparison(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshotRevision, 2);
  assert.equal(result.currentRevision, 5);
  const entry = result.diff.groups
    .find(({ domain }) => domain === "subtitle_lines")
    ?.entries.find(({ identity }) => identity === "current-line");
  assert.equal(entry?.changeType, "added");
  assert.equal(entry?.leftTimeRange, null);
  assert.deepEqual(entry?.rightTimeRange, { start: 3, end: 4 });
});

// 相同内容不应因为快照包装字段不同制造业务差异。
test("相同 payload 生成无差异结果", () => {
  const result = buildRecoverySnapshotComparison(fixture(clone(mockProject)));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.diff.hasDifferences, false);
});

// 两侧坏数据分别沿用普通 diff 的 left/right 错误，不吞掉或改写成空项目。
test("快照和当前文件迁移错误保持侧别", () => {
  const leftBad = fixture({});
  leftBad.currentFile.payload = clone(mockProject);
  const leftResult = buildRecoverySnapshotComparison(leftBad);
  assert.equal(leftResult.ok, false);
  if (!leftResult.ok) assert.deepEqual(leftResult.errors.map(({ side }) => side), ["left"]);

  const rightBad = fixture(clone(mockProject));
  rightBad.currentFile.payload = "broken";
  const rightResult = buildRecoverySnapshotComparison(rightBad);
  assert.equal(rightResult.ok, false);
  if (!rightResult.ok) assert.deepEqual(rightResult.errors.map(({ side }) => side), ["right"]);

  const bothResult = buildRecoverySnapshotComparison(fixture(null));
  assert.equal(bothResult.ok, false);
  if (!bothResult.ok) assert.deepEqual(bothResult.errors.map(({ side }) => side), ["left", "right"]);
});

// 重复 identity 警告和输入不可变性必须与普通比较完全一致。
test("保留重复标识警告且不修改输入", () => {
  const historical = clone(mockProject);
  historical.subtitleLines.push(clone(historical.subtitleLines[0]!));
  const current = clone(mockProject);
  const input = fixture(historical);
  input.currentFile.payload = current;
  const before = JSON.stringify(input);
  const result = buildRecoverySnapshotComparison(input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.diff.hasDuplicateIdentities, true);
    assert.ok(result.diff.warnings.some((warning) => warning.includes("重复")));
  }
  assert.equal(JSON.stringify(input), before);
});

// JSON 深拷贝确保测试数据修改不会污染共享 mockProject。
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
