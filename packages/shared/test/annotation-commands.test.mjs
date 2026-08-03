import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOTATION_CONTENT_UPDATE_COMMAND,
  ANNOTATION_LIFECYCLE_UPDATE_COMMAND,
  ANNOTATION_TRANSACTION_APPLY_COMMAND,
  assessAnnotationContentExecution,
  assessAnnotationLifecycleExecution,
  buildAnnotationContentUpdateEnvelope,
  buildAnnotationLifecycleUpdateEnvelope,
  buildAnnotationTransactionEnvelope,
  MAX_ANNOTATION_CONTENT_LENGTH,
  ANNOTATION_COMMAND_ENVELOPE_VERSION,
  assessTimelineTimingExecution,
  buildTimelineTimingUpdateEnvelope,
  isValidAnnotationOperationPayload,
  invertAnnotationCommandEnvelope,
  MAX_TIMELINE_COMMAND_ITEMS,
  parseAnnotationCommandEnvelope,
  parseAnnotationTransactionCommandEnvelope,
  TIMELINE_TIMING_UPDATE_COMMAND,
} from "../dist/index.js";

test("原子事务严格组合叶命令并按逆序生成 inverse", () => {
  const content = buildAnnotationContentUpdateEnvelope([{
    entityType: "sentence",
    entityId: "line-transaction",
    field: "text",
    before: "甲",
    after: "甲乙",
  }]);
  const lifecycle = buildAnnotationLifecycleUpdateEnvelope([{
    entityType: "character",
    entityId: "char-transaction",
    before: null,
    after: {
      entity: {
        id: "char-transaction",
        lineId: "line-transaction",
        char: "乙",
        startTime: 2,
        endTime: 3,
        singingStyle: "普通唱",
        tone: null,
      },
      position: {
        index: 1,
        collectionLength: 2,
        previousEntityId: "char-existing",
        nextEntityId: null,
      },
    },
  }]);
  assert.ok(content && lifecycle);
  const transaction = buildAnnotationTransactionEnvelope([content, lifecycle]);
  assert.ok(transaction);
  assert.equal(transaction.command.type, ANNOTATION_TRANSACTION_APPLY_COMMAND);
  assert.equal(isValidAnnotationOperationPayload(ANNOTATION_TRANSACTION_APPLY_COMMAND, transaction), true);
  const inverse = invertAnnotationCommandEnvelope(transaction);
  assert.equal(inverse?.command.type, ANNOTATION_TRANSACTION_APPLY_COMMAND);
  assert.deepEqual(
    inverse?.command.commands.map((command) => command.type),
    [ANNOTATION_LIFECYCLE_UPDATE_COMMAND, ANNOTATION_CONTENT_UPDATE_COMMAND],
  );
  assert.deepEqual(invertAnnotationCommandEnvelope(inverse), transaction);
});

test("事务拒绝递归、额外字段和超出总实体上限的输入", () => {
  const leaf = buildAnnotationContentUpdateEnvelope([{
    entityType: "character",
    entityId: "char-leaf",
    field: "char",
    before: "甲",
    after: "乙",
  }]);
  assert.ok(leaf);
  const valid = buildAnnotationTransactionEnvelope([leaf]);
  assert.ok(valid);
  assert.equal(parseAnnotationTransactionCommandEnvelope({
    ...valid,
    command: { ...valid.command, extra: true },
  }), null);
  assert.equal(parseAnnotationTransactionCommandEnvelope({
    version: 1,
    command: { type: ANNOTATION_TRANSACTION_APPLY_COMMAND, commands: [valid.command] },
  }), null);
  const oversizedLeaf = {
    type: ANNOTATION_CONTENT_UPDATE_COMMAND,
    items: Array.from({ length: MAX_TIMELINE_COMMAND_ITEMS }, (_, index) => ({
      entityType: "character",
      entityId: `char-bulk-${index}`,
      field: "char",
      before: "甲",
      after: "乙",
    })),
  };
  assert.equal(parseAnnotationTransactionCommandEnvelope({
    version: 1,
    command: {
      type: ANNOTATION_TRANSACTION_APPLY_COMMAND,
      commands: [oversizedLeaf, leaf.command],
    },
  }), null);
});

// 生命周期夹具显式携带集合位置，测试创建、删除和 inverse 是否保持同一稳定顺序事实。
function customBlockState(id, index, collectionLength, previousEntityId, nextEntityId) {
  return {
    entity: {
      id,
      startTime: index,
      endTime: index + 1,
      text: "文字",
      type: "类型",
      branchScope: { mode: "lanes", laneIds: ["lane-1"] },
      branchGroupId: null,
      branchParentBlockId: null,
    },
    position: { index, collectionLength, previousEntityId, nextEntityId },
  };
}

test("生命周期命令可创建、删除、反向并检查完整前置状态", () => {
  const created = customBlockState("block-new", 1, 3, "block-a", "block-b");
  const envelope = buildAnnotationLifecycleUpdateEnvelope([{
    entityType: "custom-block",
    entityId: "block-new",
    trackId: "track-1",
    before: null,
    after: created,
  }]);
  assert.ok(envelope);
  assert.equal(envelope.command.type, ANNOTATION_LIFECYCLE_UPDATE_COMMAND);
  assert.equal(isValidAnnotationOperationPayload(ANNOTATION_LIFECYCLE_UPDATE_COMMAND, envelope), true);
  assert.equal(assessAnnotationLifecycleExecution(envelope, [{
    entityType: "custom-block",
    entityId: "block-new",
    trackId: "track-1",
    parentExists: true,
    current: null,
  }]).status, "ready");

  const inverse = invertAnnotationCommandEnvelope(envelope);
  assert.deepEqual(inverse?.command.items[0].before, created);
  assert.equal(inverse?.command.items[0].after, null);
  assert.deepEqual(invertAnnotationCommandEnvelope(inverse), envelope);
  created.entity.branchScope.laneIds[0] = "lane-mutated";
  assert.deepEqual(envelope.command.items[0].after.entity.branchScope.laneIds, ["lane-1"]);
});

test("生命周期命令拒绝坏位置、宽松快照和重复目标", () => {
  const validItem = {
    entityType: "attached-point",
    entityId: "point-1",
    trackId: "point-track",
    before: {
      entity: { id: "point-1", time: 2, label: "呼吸" },
      position: { index: 0, collectionLength: 1, previousEntityId: null, nextEntityId: null },
    },
    after: null,
  };
  assert.ok(buildAnnotationLifecycleUpdateEnvelope([validItem]));
  assert.equal(buildAnnotationLifecycleUpdateEnvelope([validItem, validItem]), null);
  assert.equal(buildAnnotationLifecycleUpdateEnvelope([{ ...validItem, before: null }]), null);
  assert.equal(buildAnnotationLifecycleUpdateEnvelope([{
    ...validItem,
    before: {
      ...validItem.before,
      position: { ...validItem.before.position, previousEntityId: "impossible" },
    },
  }]), null);
  assert.equal(buildAnnotationLifecycleUpdateEnvelope([{
    ...validItem,
    before: {
      ...validItem.before,
      entity: { ...validItem.before.entity, extra: true },
    },
  }]), null);
});

test("生命周期前置检查区分父容器、存在性和状态冲突", () => {
  const state = customBlockState("block-delete", 0, 1, null, null);
  const envelope = buildAnnotationLifecycleUpdateEnvelope([{
    entityType: "custom-block",
    entityId: "block-delete",
    trackId: "track-delete",
    before: state,
    after: null,
  }]);
  assert.ok(envelope);
  const parentMissing = assessAnnotationLifecycleExecution(envelope, [{
    entityType: "custom-block",
    entityId: "block-delete",
    trackId: "track-delete",
    parentExists: false,
    current: null,
  }]);
  assert.equal(parentMissing.status, "blocked");
  assert.equal(parentMissing.status === "blocked" ? parentMissing.issues[0].code : null, "parent_missing");
  const stateMismatch = assessAnnotationLifecycleExecution(envelope, [{
    entityType: "custom-block",
    entityId: "block-delete",
    trackId: "track-delete",
    parentExists: true,
    current: { ...state, entity: { ...state.entity, type: "已变化" } },
  }]);
  assert.equal(stateMismatch.status, "blocked");
  assert.equal(stateMismatch.status === "blocked" ? stateMismatch.issues[0].code : null, "state_mismatch");
});

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
