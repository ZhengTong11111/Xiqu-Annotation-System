import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_CONTENT_UPDATE_COMMAND,
  assessAnnotationContentExecution,
  buildAnnotationContentUpdateEnvelope,
  MAX_ANNOTATION_CONTENT_LENGTH,
  ANNOTATION_COMMAND_ENVELOPE_VERSION,
  assessTimelineTimingExecution,
  buildTimelineTimingUpdateEnvelope,
  isValidAnnotationOperationPayload,
  invertAnnotationCommandEnvelope,
  MAX_TIMELINE_COMMAND_ITEMS,
  parseAnnotationCommandEnvelope,
  TIMELINE_TIMING_UPDATE_COMMAND,
} from "../dist/index.js";

// 内容命令严格保存稳定字段、track scope，并复用通用 inverse/action 合同。
test("内容领域命令可构建、反向并检查前置条件", () => {
  const envelope = buildAnnotationContentUpdateEnvelope([
    {
      entityType: "character",
      entityId: "char-content",
      field: "char",
      before: "原",
      after: "新",
    },
    {
      entityType: "custom-block",
      entityId: "block-content",
      trackId: "track-content",
      field: "type",
      before: "原类",
      after: "新类",
    },
  ]);
  assert.ok(envelope);
  assert.equal(envelope.command.type, ANNOTATION_CONTENT_UPDATE_COMMAND);
  assert.equal(isValidAnnotationOperationPayload(ANNOTATION_CONTENT_UPDATE_COMMAND, envelope), true);
  const ready = assessAnnotationContentExecution(envelope, [
    { entityType: "character", entityId: "char-content", field: "char", current: "原" },
    {
      entityType: "custom-block",
      entityId: "block-content",
      trackId: "track-content",
      field: "type",
      current: "原类",
    },
  ]);
  assert.equal(ready.status, "ready");
  assert.equal(invertAnnotationCommandEnvelope(envelope)?.command.items[0].before, "新");
});

// 字段与实体配对、track scope、额外字段和 no-op 都不能进入命令日志。
test("内容领域命令拒绝含糊字段和作用域", () => {
  for (const item of [
    { entityType: "character", entityId: "char-1", field: "label", before: "甲", after: "乙" },
    { entityType: "action", entityId: "action-1", field: "label", before: "甲", after: "乙" },
    { entityType: "sentence", entityId: "line-1", trackId: "bad-track", field: "text", before: "甲", after: "乙" },
    { entityType: "character", entityId: "char-1", field: "char", before: "甲", after: "甲" },
  ]) {
    assert.equal(buildAnnotationContentUpdateEnvelope([item]), null);
  }

  const duplicate = {
    entityType: "character",
    entityId: "char-duplicate",
    field: "char",
    before: "甲",
    after: "乙",
  };
  assert.equal(buildAnnotationContentUpdateEnvelope([duplicate, duplicate]), null);
  assert.equal(buildAnnotationContentUpdateEnvelope([{
    ...duplicate,
    extra: true,
  }]), null);
  assert.equal(buildAnnotationContentUpdateEnvelope([{
    ...duplicate,
    after: "字".repeat(MAX_ANNOTATION_CONTENT_LENGTH + 1),
  }]), null);
});

// 合法区间和点状目标应构成稳定排序、可再次解析的 version 1 envelope。
test("时间轴领域命令可稳定构建和解析", () => {
  const source = [
    {
      entityType: "attached-point",
      entityId: "point-2",
      trackId: "breath-track",
      before: { startTime: 3, endTime: 3 },
      after: { startTime: 4, endTime: 4 },
    },
    {
      entityType: "character",
      entityId: "char-1",
      before: { startTime: 1, endTime: 2 },
      after: { startTime: 1.5, endTime: 2.5 },
    },
  ];
  const envelope = buildTimelineTimingUpdateEnvelope(source);
  assert.ok(envelope);
  assert.equal(envelope.version, ANNOTATION_COMMAND_ENVELOPE_VERSION);
  assert.equal(envelope.command.type, TIMELINE_TIMING_UPDATE_COMMAND);
  assert.deepEqual(
    envelope.command.items.map((item) => item.entityId),
    ["point-2", "char-1"],
  );
  assert.deepEqual(parseAnnotationCommandEnvelope(envelope), envelope);

  // builder 返回独立副本，调用者后改原始数组不会篡改已排队 operation。
  source[0].after.startTime = 99;
  assert.equal(envelope.command.items[0].after.startTime, 4);
});

// inverse 交换 before/after 且不修改原 envelope，双重 inverse 回到同一规范命令。
test("领域命令可确定性反向并保持输入不可变", () => {
  const envelope = buildTimelineTimingUpdateEnvelope([{
    entityType: "character",
    entityId: "char-inverse",
    before: { startTime: 1, endTime: 2 },
    after: { startTime: 3, endTime: 4 },
  }]);
  assert.ok(envelope);
  const snapshot = structuredClone(envelope);
  const inverse = invertAnnotationCommandEnvelope(envelope);
  assert.deepEqual(inverse?.command.items[0].before, { startTime: 3, endTime: 4 });
  assert.deepEqual(invertAnnotationCommandEnvelope(inverse), envelope);
  assert.deepEqual(envelope, snapshot);
  assert.equal(invertAnnotationCommandEnvelope({ version: 99 }), null);
});

// 前置条件穷举缺失与冲突目标；半毫秒内浮点误差仍视为同一时间事实。
test("领域命令前置条件返回可解释的 all-or-nothing 结果", () => {
  const envelope = buildTimelineTimingUpdateEnvelope([
    {
      entityType: "character",
      entityId: "char-ready",
      before: { startTime: 1, endTime: 2 },
      after: { startTime: 2, endTime: 3 },
    },
    {
      entityType: "banyan-mark",
      entityId: "mark-missing",
      before: { startTime: 4, endTime: 4 },
      after: { startTime: 5, endTime: 5 },
    },
  ]);
  assert.ok(envelope);
  const blocked = assessTimelineTimingExecution(envelope, [{
    entityType: "character",
    entityId: "char-ready",
    current: { startTime: 1.0004, endTime: 2.0004 },
  }]);
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.status === "blocked" ? blocked.issues : [], [{
    code: "target_missing",
    targetKey: "banyan-mark::mark-missing",
    expected: { startTime: 4, endTime: 4 },
  }]);

  const mismatch = assessTimelineTimingExecution(envelope, [
    {
      entityType: "character",
      entityId: "char-ready",
      current: { startTime: 1.001, endTime: 2 },
    },
    {
      entityType: "banyan-mark",
      entityId: "mark-missing",
      current: { startTime: 4, endTime: 4 },
    },
  ]);
  assert.equal(mismatch.status, "blocked");
  assert.equal(mismatch.status === "blocked" ? mismatch.issues[0]?.code : null, "before_mismatch");
  assert.deepEqual(assessTimelineTimingExecution({ bad: true }, []), { status: "invalid_command" });
});

// no-op 被剔除；全部无变化时不生成空 operation。
test("builder 删除无变化时间项", () => {
  assert.equal(buildTimelineTimingUpdateEnvelope([{
    entityType: "character",
    entityId: "char-1",
    before: { startTime: 1, endTime: 2 },
    after: { startTime: 1, endTime: 2 },
  }]), null);
  assert.equal(buildTimelineTimingUpdateEnvelope(Array.from(
    { length: MAX_TIMELINE_COMMAND_ITEMS + 1 },
    (_, index) => ({
      entityType: "character",
      entityId: `char-${index}`,
      before: { startTime: index, endTime: index + 1 },
      after: { startTime: index + 1, endTime: index + 2 },
    }),
  )), null);
  assert.equal(buildTimelineTimingUpdateEnvelope([{
    entityType: "character",
    entityId: "旧/非法/id",
    before: { startTime: 1, endTime: 2 },
    after: { startTime: 2, endTime: 3 },
  }]), null);
});

// unknown 边界拒绝结构、范围、点语义、重复目标和数量攻击。
test("领域命令解析严格拒绝坏输入", () => {
  const valid = {
    version: 1,
    command: {
      type: TIMELINE_TIMING_UPDATE_COMMAND,
      items: [{
        entityType: "custom-block",
        entityId: "block-1",
        trackId: "track-1",
        before: { startTime: 1, endTime: 2 },
        after: { startTime: 2, endTime: 3 },
      }],
    },
  };
  const invalidValues = [
    { ...valid, version: 2 },
    { ...valid, extra: true },
    { ...valid, command: { ...valid.command, type: "unknown" } },
    { ...valid, command: { ...valid.command, items: [] } },
    { ...valid, command: { ...valid.command, items: Array(MAX_TIMELINE_COMMAND_ITEMS + 1).fill(valid.command.items[0]) } },
    { ...valid, command: { ...valid.command, items: [{ ...valid.command.items[0], trackId: undefined }] } },
    { ...valid, command: { ...valid.command, items: [{ ...valid.command.items[0], entityId: "bad/id" }] } },
    { ...valid, command: { ...valid.command, items: [{ ...valid.command.items[0], before: { startTime: -1, endTime: 2 } }] } },
    { ...valid, command: { ...valid.command, items: [{ ...valid.command.items[0], after: { startTime: 4, endTime: 3 } }] } },
    { ...valid, command: { ...valid.command, items: [valid.command.items[0], valid.command.items[0]] } },
    {
      ...valid,
      command: {
        ...valid.command,
        items: [{
          entityType: "banyan-mark",
          entityId: "mark-1",
          before: { startTime: 1, endTime: 2 },
          after: { startTime: 2, endTime: 3 },
        }],
      },
    },
  ];
  for (const value of invalidValues) {
    assert.equal(parseAnnotationCommandEnvelope(value), null);
  }
});

// API allowlist 保留四类渐进迁移操作，但未知 action 与 action/envelope 不一致必须拒绝。
test("operation action 与领域 envelope 必须一致", () => {
  const envelope = buildTimelineTimingUpdateEnvelope([{
    entityType: "action",
    entityId: "action-1",
    trackId: "action-track",
    before: { startTime: 1, endTime: 2 },
    after: { startTime: 2, endTime: 3 },
  }]);
  assert.ok(envelope);
  assert.equal(isValidAnnotationOperationPayload(TIMELINE_TIMING_UPDATE_COMMAND, envelope), true);
  assert.equal(isValidAnnotationOperationPayload("project.commit", { legacy: true }), true);
  assert.equal(isValidAnnotationOperationPayload("project.commit", envelope), false);
  assert.equal(isValidAnnotationOperationPayload("unknown.action", envelope), false);
  assert.equal(isValidAnnotationOperationPayload("project.commit.extra", {}), false);
});
