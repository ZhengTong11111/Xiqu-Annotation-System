import assert from "node:assert/strict";
import test from "node:test";
import { ProcessingJobWorkerCoordinator } from "../src/processingJobWorkerCoordinator.js";

test("协调器轮转媒体、训练导出、强制对齐三类队列且汇总陈旧恢复数量", async () => {
  const calls: string[] = [];
  const pending = { media: 2, training: 2, alignment: 2 };
  const coordinator = new ProcessingJobWorkerCoordinator([
    {
      recoverStaleJobs: async () => 2,
      processNext: async () => {
        calls.push("media");
        if (pending.media === 0) return false;
        pending.media -= 1;
        return true;
      },
    },
    {
      recoverStaleJobs: async () => 4,
      processNext: async () => {
        calls.push("training");
        if (pending.training === 0) return false;
        pending.training -= 1;
        return true;
      },
    },
    {
      recoverStaleJobs: async () => 3,
      processNext: async () => {
        calls.push("alignment");
        if (pending.alignment === 0) return false;
        pending.alignment -= 1;
        return true;
      },
    },
  ]);

  assert.equal(await coordinator.recoverStaleJobs(), 9);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), false);
  assert.deepEqual(calls.slice(0, 6), [
    "media", "training", "alignment", "media", "training", "alignment",
  ]);
});
