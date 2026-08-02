import assert from "node:assert/strict";
import test from "node:test";
import { AuditAction } from "@prisma/client";
import { AUDIT_ACTIONS } from "@xiqu/shared";
import {
  AuditLogQueryError,
  buildAuditLogCsv,
  decodeAuditLogCursor,
  encodeAuditLogCursor,
  escapeCsvCell,
  normalizeAuditLogQuery,
  stableJsonStringify,
} from "../src/auditLogQuery.js";

// 时间规范化必须接受标准 ISO、拒绝宽松文本和倒置范围。
test("审计筛选严格规范化 ISO 时间范围", () => {
  const query = normalizeAuditLogQuery({
    resourceId: " resource-1 ",
    createdFrom: "2026-08-03T01:00:00.000Z",
    createdTo: "2026-08-03T02:00:00.000Z",
  });
  assert.equal(query.resourceId, "resource-1");
  assert.equal(query.createdFrom?.toISOString(), "2026-08-03T01:00:00.000Z");
  assert.equal(
    normalizeAuditLogQuery({
      createdFrom: "2026-08-03T09:00:00+08:00",
    }).createdFrom?.toISOString(),
    "2026-08-03T01:00:00.000Z",
  );
  assert.throws(
    () => normalizeAuditLogQuery({ createdFrom: "2026-08-03" }),
    AuditLogQueryError,
  );
  assert.throws(
    () => normalizeAuditLogQuery({
      createdFrom: "2026-08-03T03:00:00.000Z",
      createdTo: "2026-08-03T02:00:00.000Z",
    }),
    /开始时间不能晚于结束时间/,
  );
});

// 共享筛选列表必须与 Prisma enum 同步，新增数据库动作时测试会提示补齐前端标签。
test("共享审计动作与数据库枚举保持一致", () => {
  assert.deepEqual(
    [...AUDIT_ACTIONS].sort(),
    Object.values(AuditAction).sort(),
  );
});

// 游标必须保留同毫秒排序锚点，并拒绝坏格式和跨筛选复用。
test("审计游标绑定当前筛选和复合排序锚点", () => {
  const query = normalizeAuditLogQuery({ action: "resource_move" });
  const cursor = {
    createdAt: new Date("2026-08-03T01:02:03.456Z"),
    id: "audit-2",
  };
  const token = encodeAuditLogCursor(cursor, query);
  assert.deepEqual(decodeAuditLogCursor(token, query), cursor);
  assert.throws(
    () => decodeAuditLogCursor(
      token,
      normalizeAuditLogQuery({ action: "resource_copy" }),
    ),
    /不属于当前筛选/,
  );
  assert.throws(() => decodeAuditLogCursor("not-json", query), /格式无效/);
});

// CSV 字段统一引用并阻断常见表格公式前缀，同时保留中文、逗号和引号。
test("审计 CSV 转义公式与特殊字符", () => {
  assert.equal(escapeCsvCell("=1+1"), '"\'=1+1"');
  assert.equal(escapeCsvCell("  @SUM(A1)"), '"\'  @SUM(A1)"');
  assert.equal(escapeCsvCell('昆曲,"寻梦"'), '"昆曲,""寻梦"""');
  assert.equal(escapeCsvCell("a\0b"), '"ab"');
});

// detail 的对象键排序稳定，整份导出含 BOM、固定列和可追溯 id。
test("审计 CSV 使用稳定详情和固定表头", () => {
  assert.equal(stableJsonStringify({ z: 1, a: { d: 2, b: 1 } }), '{"a":{"b":1,"d":2},"z":1}');
  const csv = buildAuditLogCsv([{
    id: "audit-1",
    action: "resource_update",
    actorUserId: "user-1",
    detail: { formula: "=unsafe", z: 1 },
    createdAt: "2026-08-03T01:00:00.000Z",
    actor: { id: "user-1", accountName: "admin", displayName: "系统管理员" },
  }]);
  assert.ok(csv.startsWith("\uFEFF\"时间\""));
  assert.match(csv, /audit-1/);
  assert.match(csv, /系统管理员 \(admin\)/);
  assert.match(csv, /formula/);
});
