import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAuditAction,
  formatAuditResource,
  formatAuditUser,
  summarizeAuditDetail,
} from "./auditLogView";

// 动作和实体兜底必须在关联对象已删除后仍保留可追溯信息。
test("审计动作与缺失实体使用稳定兜底", () => {
  assert.equal(formatAuditAction("resource_move"), "移动资源");
  assert.equal(formatAuditAction("future_action"), "future_action");
  assert.match(formatAuditUser(null, "12345678901234567890"), /1234567…67890/);
  assert.match(formatAuditResource({
    id: "audit-1",
    action: "resource_move",
    resourceId: "resource-123456789012345",
    createdAt: "2026-08-03T00:00:00.000Z",
  }), /已不存在/);
});

// detail 摘要应单行、有界，并对不可序列化结构安全失败。
test("审计详情摘要保持单行和长度上限", () => {
  assert.equal(summarizeAuditDetail({ z: "第一行\n第二行" }), '{"z":"第一行\\n第二行"}');
  assert.equal(summarizeAuditDetail("123456", 5), "1234…");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(summarizeAuditDetail(circular), "无法显示详情");
});
