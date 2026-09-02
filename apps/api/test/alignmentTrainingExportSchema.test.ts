import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("FA-D3c2b migration 只追加训练冻结请求、样本和分组快照", async () => {
  const sql = await readFile(
    new URL("../../../prisma/migrations/20260902070000_alignment_training_export_freezes/migration.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE "alignment_training_exports"/u);
  assert.match(sql, /CREATE TABLE "alignment_training_export_items"/u);
  assert.match(sql, /CREATE TABLE "alignment_training_export_groups"/u);
  assert.match(sql, /alignment_training_export_freeze/u);
  assert.match(sql, /ON DELETE RESTRICT/u);
  assert.match(sql, /ON DELETE CASCADE/u);
  assert.doesNotMatch(
    sql,
    /^\s*(?:UPDATE\s|DELETE\s+FROM\s|DROP\s+(?:TABLE|COLUMN)\s|TRUNCATE\s)/imu,
  );
});
