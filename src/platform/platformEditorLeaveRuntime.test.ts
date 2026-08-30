import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformSaveOutcome } from "../utils/platformOperations";
import {
  preparePlatformEditorLeave,
  type PlatformEditorLeaveFacts,
} from "./platformEditorLeaveRuntime";

function createHarness(options: {
  facts?: PlatformEditorLeaveFacts[];
  outcomes?: PlatformSaveOutcome[];
  preparePendingEditors?: () => boolean;
}) {
  const facts = options.facts ?? [{ dirty: false, blockedReason: null }];
  const outcomes = options.outcomes ?? [];
  let factIndex = 0;
  let outcomeIndex = 0;
  let waitCount = 0;
  let saveCount = 0;
  let flushCount = 0;
  let finalizeCount = 0;
  return {
    dependencies: {
      preparePendingEditors: options.preparePendingEditors ?? (() => true),
      waitForActiveSave: async () => {
        waitCount += 1;
      },
      getFacts: () => facts[Math.min(factIndex++, facts.length - 1)]!,
      save: async () => {
        saveCount += 1;
        return outcomes[Math.min(outcomeIndex++, outcomes.length - 1)] ?? { status: "saved" as const };
      },
      flushDraft: async () => {
        flushCount += 1;
        return { ok: true };
      },
      finalizeCleanExit: async () => {
        finalizeCount += 1;
        return { ok: true };
      },
    },
    counts: () => ({ waitCount, saveCount, flushCount, finalizeCount }),
  };
}

test("干净文件等待既有保存屏障后可以直接离开", async () => {
  const harness = createHarness({});
  assert.deepEqual(await preparePlatformEditorLeave(harness.dependencies), { status: "ready" });
  assert.deepEqual(harness.counts(), {
    waitCount: 1,
    saveCount: 0,
    flushCount: 0,
    finalizeCount: 1,
  });
});

test("未保存内容提交成功并重新确认干净后才允许离开", async () => {
  const harness = createHarness({
    facts: [
      { dirty: true, blockedReason: null },
      { dirty: false, blockedReason: null },
    ],
    outcomes: [{ status: "saved" }],
  });
  assert.deepEqual(await preparePlatformEditorLeave(harness.dependencies), { status: "ready" });
  assert.deepEqual(harness.counts(), {
    waitCount: 2,
    saveCount: 1,
    flushCount: 0,
    finalizeCount: 1,
  });
});

test("保存期间新增编辑会进入下一批保存", async () => {
  const harness = createHarness({
    facts: [
      { dirty: true, blockedReason: null },
      { dirty: true, blockedReason: null },
      { dirty: false, blockedReason: null },
    ],
    outcomes: [{ status: "saved" }, { status: "saved" }],
  });
  assert.deepEqual(await preparePlatformEditorLeave(harness.dependencies), { status: "ready" });
  assert.equal(harness.counts().saveCount, 2);
});

test("并发协调只重建命令时继续保存而不提前离开", async () => {
  const harness = createHarness({
    facts: [
      { dirty: true, blockedReason: null },
      { dirty: true, blockedReason: null },
      { dirty: false, blockedReason: null },
    ],
    outcomes: [
      { status: "rebased", message: "已重建" },
      { status: "saved" },
    ],
  });
  assert.deepEqual(await preparePlatformEditorLeave(harness.dependencies), { status: "ready" });
  assert.equal(harness.counts().saveCount, 2);
});

test("离线或冲突时留在编辑器并保全恢复草稿", async () => {
  const harness = createHarness({
    facts: [{ dirty: true, blockedReason: null }],
    outcomes: [{ status: "offline", retryable: true, message: "网络不可用" }],
  });
  const result = await preparePlatformEditorLeave(harness.dependencies);
  assert.equal(result.status, "blocked");
  assert.match(result.status === "blocked" ? result.message : "", /网络不可用/);
  assert.match(result.status === "blocked" ? result.message : "", /恢复草稿/);
  assert.equal(harness.counts().flushCount, 1);
});

test("拖拽和无效行内输入不会被保存结果绕过", async () => {
  const blocked = createHarness({
    facts: [{ dirty: true, blockedReason: "当前拖拽尚未结束。" }],
  });
  assert.equal((await preparePlatformEditorLeave(blocked.dependencies)).status, "blocked");
  assert.equal(blocked.counts().saveCount, 0);

  const invalidInline = createHarness({ preparePendingEditors: () => false });
  assert.equal((await preparePlatformEditorLeave(invalidInline.dependencies)).status, "blocked");
  assert.equal(invalidInline.counts().waitCount, 0);
});

test("持续产生新修改时达到上限即停止而不是无限保存", async () => {
  const harness = createHarness({
    facts: [{ dirty: true, blockedReason: null }],
    outcomes: [{ status: "saved" }],
  });
  const result = await preparePlatformEditorLeave({
    ...harness.dependencies,
    maxSaveAttempts: 2,
  });
  assert.equal(result.status, "blocked");
  assert.equal(harness.counts().saveCount, 2);
  assert.equal(harness.counts().flushCount, 1);
});

test("busy 保存结果必须重检，不能被当成保存成功", async () => {
  const harness = createHarness({
    facts: [
      { dirty: true, blockedReason: null },
      { dirty: false, blockedReason: null },
    ],
    outcomes: [{ status: "skipped", reason: "busy" }],
  });
  assert.deepEqual(await preparePlatformEditorLeave(harness.dependencies), { status: "ready" });
  assert.equal(harness.counts().waitCount, 2);
});

test("保存依赖抛出合同外异常时仍保全草稿并返回阻断结果", async () => {
  let flushCount = 0;
  const result = await preparePlatformEditorLeave({
    preparePendingEditors: () => true,
    waitForActiveSave: async () => undefined,
    getFacts: () => ({ dirty: true, blockedReason: null }),
    save: async () => {
      throw new Error("保存运行时异常");
    },
    flushDraft: async () => {
      flushCount += 1;
      return { ok: true };
    },
    finalizeCleanExit: async () => ({ ok: true }),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.status === "blocked" ? result.message : "", /保存运行时异常/);
  assert.equal(flushCount, 1);
});

test("服务器 clean 后仍须等待草稿清场，清场失败不能离开", async () => {
  const harness = createHarness({});
  harness.dependencies.finalizeCleanExit = async () => ({
    ok: false,
    message: "IndexedDB 删除失败",
  });
  const result = await preparePlatformEditorLeave(harness.dependencies);
  assert.equal(result.status, "blocked");
  assert.match(result.status === "blocked" ? result.message : "", /IndexedDB 删除失败/);
  assert.equal(harness.counts().flushCount, 0);
});
