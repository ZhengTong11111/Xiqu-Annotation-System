import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_COMMAND_ENVELOPE_VERSION,
  buildTimelineTimingUpdateEnvelope,
  isValidAnnotationOperationPayload,
  MAX_TIMELINE_COMMAND_ITEMS,
  parseAnnotationCommandEnvelope,
  TIMELINE_TIMING_UPDATE_COMMAND,
} from "../dist/index.js";

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
