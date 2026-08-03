import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDocumentOperation } from "../state/projectDocumentState";
import { buildServerOperationRequest } from "./platformOperations";

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
  };
  const request = buildServerOperationRequest(operation, 9);
  assert.equal(request.clientOperationId, operation.id);
  assert.equal(request.baseRevision, 9);
  assert.equal(request.localRevision, 4);
  assert.equal("localOperationId" in (request.payload as Record<string, unknown>), false);
});
