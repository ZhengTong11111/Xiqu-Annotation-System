import assert from "node:assert/strict";
import test from "node:test";
import { ProcessingJobWorkerCoordinator } from "../src/processingJobWorkerCoordinator.js";

test("协调器轮转两类队列且汇总陈旧恢复数量", async () => {
  const calls: string[] = [];
  const pending = { media: 2, alignment: 2 };
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
      recoverStaleJobs: async () => 3,
      processNext: async () => {
        calls.push("alignment");
        if (pending.alignment === 0) return false;
        pending.alignment -= 1;
        return true;
      },
    },
  ]);

  assert.equal(await coordinator.recoverStaleJobs(), 5);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), true);
  assert.equal(await coordinator.processNext("worker"), false);
  assert.deepEqual(calls.slice(0, 4), ["media", "alignment", "media", "alignment"]);
});
