import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FA-D2d migration 只增加应用溯源且不改写既有业务事实", async () => {
  const sql = await readFile(
    new URL("../../../prisma/migrations/20260902040000_alignment_applications/migration.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "alignment_applications"/u);
  assert.match(sql, /ADD COLUMN "alignment_application_id" TEXT/u);
  assert.match(sql, /ON DELETE SET NULL/u);
  assert.match(sql, /operation_count" BETWEEN 1 AND 100/u);
  assert.match(sql, /applied_character_count" BETWEEN 1 AND 50000/u);
  // 外键必须允许 ON DELETE CASCADE/SET NULL；这里只拒绝真正以破坏性关键字开头的 SQL 语句。
  assert.doesNotMatch(
    sql,
    /^\s*(?:UPDATE\s|DELETE\s+FROM\s|DROP\s+(?:TABLE|COLUMN)\s|TRUNCATE\s)/imu,
  );
});
