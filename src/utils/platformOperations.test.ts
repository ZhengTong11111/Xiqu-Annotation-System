import assert from "node:assert/strict";
import test from "node:test";
import { PlatformApiError } from "../api/platformClient";
import type { ProjectDocumentOperation } from "../state/projectDocumentState";
import {
  buildServerOperationRequest,
  describeServerSaveError,
} from "./platformOperations";

// 客户端 builder 把本地 operation id 提升为一等幂等键，不再在摘要 payload 里重复保存。
test("平台 operation 请求使用本地稳定 id 作为 clientOperationId", () => {
  const operation: ProjectDocumentOperation = {
    id: "op-550e8400-e29b-41d4-a716-446655440000",
    type: "project.commit",
    action: "edit",
    localRevision: 4,
    baseRevision: 3,
    createdAt: 1_785_700_000_000,
    syncState: "pending",
    summary: {
      hasProjectChange: true,
      hasTrackSnapChange: false,
    },
  };
  const request = buildServerOperationRequest(operation, 9);
  assert.equal(request.clientOperationId, operation.id);
  assert.equal(request.baseRevision, 9);
  assert.equal(request.localRevision, 4);
  assert.equal("localOperationId" in (request.payload as Record<string, unknown>), false);
});

// 恢复后的精简吸附 operation 仍可生成与刷新前一致的服务器审计摘要。
test("平台 operation 请求直接使用持久化的吸附变化摘要", () => {
  const operation: ProjectDocumentOperation = {
    id: "op-track-snap",
    type: "track-snap.update",
    action: "track-snap",
    localRevision: 5,
    baseRevision: 4,
    createdAt: 1_785_700_000_100,
    syncState: "submitted",
    summary: {
      hasProjectChange: false,
      hasTrackSnapChange: true,
      changedTrackIds: ["character-track", "custom-1"],
    },
  };

  const request = buildServerOperationRequest(operation, 11);
  assert.deepEqual(request.payload, {
    localCreatedAt: operation.createdAt,
    type: "track-snap.update",
    historyAction: "track-snap",
    localBaseRevision: 4,
    hasProjectBeforeAfter: false,
    hasTrackSnapBeforeAfter: true,
    changedTrackIds: ["character-track", "custom-1"],
  });
});

// 已迁移 timing operation 直接发送版本化 envelope，不能退化成丢失目标的 legacy 摘要。
test("平台 operation 请求完整保留领域命令 envelope", () => {
  const commandEnvelope = {
    version: 1 as const,
    command: {
      type: "timeline.items.timing.update" as const,
      items: [{
        entityType: "character" as const,
        entityId: "char-1",
        before: { startTime: 1, endTime: 2 },
        after: { startTime: 2, endTime: 3 },
      }],
    },
  };
  const operation: ProjectDocumentOperation = {
    id: "op-domain-command",
    type: commandEnvelope.command.type,
    action: "edit",
    localRevision: 6,
    baseRevision: 5,
    createdAt: 1_785_700_000_200,
    syncState: "pending",
    commandEnvelope,
    summary: { hasProjectChange: true, hasTrackSnapChange: false },
  };

  assert.deepEqual(buildServerOperationRequest(operation, 12, "xiqu_lease_test"), {
    clientOperationId: "op-domain-command",
    baseRevision: 12,
    localRevision: 6,
    action: "timeline.items.timing.update",
    payload: commandEnvelope,
    mutationLeaseToken: "xiqu_lease_test",
  });
  assert.equal(
    JSON.stringify(buildServerOperationRequest(operation, 12, "xiqu_lease_test").payload)
      .includes("xiqu_lease_test"),
    false,
  );
});

// 自动保存只重试瞬时服务故障；revision/权限等确定业务错误必须停下等待用户处理。
test("服务器保存错误分类区分冲突、可重试与确定错误", () => {
  assert.deepEqual(describeServerSaveError(
    new PlatformApiError(409, "revision_conflict", "冲突", null),
  ), {
    status: "conflict",
    retryable: false,
    message: "服务器工作区已有更新，请刷新后处理冲突。",
  });
  assert.equal(describeServerSaveError(
    new PlatformApiError(503, "unavailable", "暂不可用", null),
  ).retryable, true);
  assert.deepEqual(describeServerSaveError(
    new PlatformApiError(503, "maintenance_mode", "维护中", null),
  ), {
    status: "error",
    retryable: false,
    message: "服务器正在维护，当前修改暂时无法自动保存到服务器；本地恢复草稿将继续保留。",
  });
  assert.equal(describeServerSaveError(
    new PlatformApiError(403, "forbidden", "禁止", null),
  ).retryable, false);
  assert.deepEqual(describeServerSaveError(
    new PlatformApiError(409, "conflict", "结构编辑租约已失效", {
      code: "annotation_mutation_lease_expired",
    }),
  ), {
    status: "error",
    retryable: false,
    message: "结构编辑租约已失效 本地草稿仍已保留，请重新取得结构编辑锁后再保存。",
  });
  assert.equal(describeServerSaveError(new TypeError("Failed to fetch")).retryable, true);
  assert.equal(describeServerSaveError(new Error("程序错误")).retryable, false);
});
