import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformUser, ProcessingJobRequestListItem, ProcessingJobSummary } from "@xiqu/shared";
import {
  canCancelProcessingJobRequest,
  canForceCancelProcessingJob,
  canRetryProcessingJobRequest,
  getActiveProcessingJobCount,
  getProcessingJobPollInterval,
} from "./processingJobCenterModel";

const user: PlatformUser = {
  id: "user-1",
  accountName: "teacher",
  displayName: "教师",
  roles: ["teacher"],
};
const admin: PlatformUser = { ...user, id: "admin-1", roles: ["admin"] };

test("任务中心活动数量与轮询间隔只识别活动状态", () => {
  const summary: ProcessingJobSummary = {
    scope: "mine",
    visibleRequestCount: 9,
    activeRequestCount: 4,
    byStatus: {
      queued: 2,
      running: 1,
      cancelling: 1,
      cancelled: 2,
      succeeded: 2,
      failed: 1,
    },
    isPartial: false,
  };
  assert.equal(getActiveProcessingJobCount(summary), 4);
  assert.equal(getProcessingJobPollInterval(false, 4), 15_000);
  assert.equal(getProcessingJobPollInterval(true, 4), 2_000);
  assert.equal(getProcessingJobPollInterval(true, 0), 8_000);
});

test("任务命令资格区分本人需求与管理员执行治理", () => {
  const item = createItem("running");
  assert.equal(canCancelProcessingJobRequest(item, user), true);
  assert.equal(canCancelProcessingJobRequest(item, admin), false);
  assert.equal(canForceCancelProcessingJob(item, user), false);
  assert.equal(canForceCancelProcessingJob(item, admin), true);
  assert.equal(canRetryProcessingJobRequest(createItem("failed"), user), true);
  assert.equal(canRetryProcessingJobRequest({
    ...createItem("failed"),
    requester: { id: "other", accountName: "other", displayName: "其他账号" },
  }, user), false);
  assert.equal(canRetryProcessingJobRequest({
    ...createItem("failed"),
    requester: { id: "other", accountName: "other", displayName: "其他账号" },
  }, admin), true);
  assert.equal(canRetryProcessingJobRequest({
    ...createItem("failed"),
    job: { ...createItem("failed").job, type: "force_alignment" },
  }, admin), false);
});

function createItem(status: ProcessingJobRequestListItem["job"]["status"]): ProcessingJobRequestListItem {
  return {
    requestId: "request-1",
    requestedAt: "2026-08-30T12:00:00.000Z",
    cancelledAt: null,
    requester: { id: user.id, accountName: user.accountName, displayName: user.displayName },
    contextResource: { id: "resource-1", name: "寻梦.json", type: "annotation_file" },
    job: {
      id: "job-1",
      type: "media_analysis",
      status,
      progress: 0.5,
      errorCode: null,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:01.000Z",
      finishedAt: null,
      cancelRequestedAt: null,
      cancellationMode: null,
    },
  };
}
